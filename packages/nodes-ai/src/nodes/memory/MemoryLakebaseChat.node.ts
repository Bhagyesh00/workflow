/**
 * Lakebase Chat Memory: chat history in a Databricks Lakebase table, over the Lakebase Data API (PostgREST).
 * Rows hold `session_id` and `message` (jsonb). The session id column holds `<tenantId>:<sessionId>`, so
 * workspaces that share one table never see each other's history; the table needs no extra column.
 * The node cannot create the table: when it is missing, the error shows the SQL to run.
 */
import {
  type AiChatMessage,
  NodeApiError,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
import {
  LAKEBASE_MAX_PAGES,
  LAKEBASE_PAGE_SIZE,
  type LakebaseTarget,
  lakebaseListSearch,
  lakebaseLocatorProperties,
  lakebaseRequest,
  lakebaseSelectAll,
  lakebaseTableUrl,
} from '@workflow/nodes-base/utils/databricks-lakebase';
import type { SessionMemory } from '../../shared/ai-inputs';
import {
  fromStoredMessage,
  logged,
  memoryDescription,
  toStoredMessage,
  windowProperty,
  windowSize,
} from './memory-shared';
import { readSessionKey, sessionProperties } from './session';

const DEFAULT_TABLE = 'ai_chat_histories';

interface Row {
  id?: number;
  session_id?: string;
  message?: unknown;
}

/** the SQL that makes the table, shown when the table is missing or not readable */
function tableSql(schema: string, table: string): string {
  const name = `"${schema.replace(/"/g, '""')}"."${table}"`;
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, message JSONB NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS "${table}_session_idx" ON ${name} (session_id, id);`,
    `GRANT SELECT, INSERT, DELETE ON ${name} TO <your role>;`,
    `GRANT USAGE ON SEQUENCE "${schema.replace(/"/g, '""')}"."${table}_id_seq" TO <your role>;`,
  ].join('\n');
}

function locator(ctx: SupplyDataContext, itemIndex: number, name: string): string {
  const value = ctx.getNodeParameter(name, itemIndex, '', { extractValue: true });
  return typeof value === 'string' ? value.trim() : '';
}

function readTarget(ctx: SupplyDataContext, itemIndex: number): LakebaseTarget {
  const target: LakebaseTarget = {
    project: locator(ctx, itemIndex, 'project'),
    branch: locator(ctx, itemIndex, 'branch'),
    database: locator(ctx, itemIndex, 'database'),
    schema: locator(ctx, itemIndex, 'schema'),
    table: String(ctx.getNodeParameter('lakebaseTable', itemIndex, DEFAULT_TABLE) || DEFAULT_TABLE).trim(),
  };
  for (const [name, value] of Object.entries(target)) {
    if (!value) {
      throw new NodeOperationError(ctx.getNode(), `The Lakebase ${name} is empty`, {
        itemIndex,
        description: `Select or enter the ${name}.`,
      });
    }
  }
  return target;
}

/** the PostgREST error code or message of a failed call, whatever shape the body has */
function remoteCode(error: unknown): { status: number; code: string } {
  const e = error as { httpCode?: string; responseBody?: unknown };
  const body = e?.responseBody as { code?: unknown } | string | undefined;
  const code = typeof body === 'object' && body && typeof body.code === 'string' ? body.code : '';
  return { status: Number(e?.httpCode ?? 0), code };
}

/** n8n-style errors for a missing table and a missing grant, with the SQL as the hint; others pass through */
function explain(ctx: SupplyDataContext, itemIndex: number, target: LakebaseTarget, error: unknown): never {
  if (error instanceof NodeApiError) {
    const { status, code } = remoteCode(error);
    if (code === '42P01' || code === 'PGRST205' || status === 404) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Table "${target.table}" doesn't exist in schema "${target.schema}"`,
        { itemIndex, description: `Create the table first, for example:\n${tableSql(target.schema, target.table)}` },
      );
    }
    if (code === '42501' || status === 401 || status === 403) {
      throw new NodeOperationError(
        ctx.getNode(),
        `No permission to use table "${target.table}" in schema "${target.schema}"`,
        {
          itemIndex,
          description: `Grant the role of the Databricks credential access to the table, for example:\n${tableSql(target.schema, target.table)}`,
        },
      );
    }
  }
  throw error;
}

export const MemoryLakebaseChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryLakebaseChat',
      displayName: 'Lakebase Chat Memory',
      description: 'Stores chat history in a Databricks Lakebase table',
      icon: 'simple:databricks',
      credentials: [{ name: 'databricksOAuth2Api', required: true }],
    },
    [
      ...lakebaseLocatorProperties,
      {
        displayName: 'Table Name',
        name: 'lakebaseTable',
        type: 'string',
        default: DEFAULT_TABLE,
        required: true,
        description:
          'The table must exist already, with the columns id, session_id and message. The error of a missing table shows the SQL.',
      },
      ...sessionProperties,
      windowProperty,
    ],
  ),
  methods: { listSearch: { ...lakebaseListSearch } },
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const target = readTarget(ctx, itemIndex);
    const tenantId = ctx.getTenantId();
    const keyOf = (sessionId: string) => `${tenantId}:${sessionId}`;
    let tableUrl: string | undefined;

    async function guarded<T>(fn: (url: string) => Promise<T>): Promise<T> {
      tableUrl ??= await lakebaseTableUrl(ctx, itemIndex, target);
      try {
        return await fn(tableUrl as string);
      } catch (error) {
        return explain(ctx, itemIndex, target, error);
      }
    }
    const toMessages = (rows: Row[]) =>
      rows.map((r) => fromStoredMessage(r.message)).filter((m): m is AiChatMessage => Boolean(m));

    /** the session filter goes through `qs`, so an `&`, `=` or `#` in the id stays one value */
    const sessionFilter = (sessionId: string) => ({ session_id: `eq.${keyOf(sessionId)}` });

    async function insert(url: string, sessionId: string, messages: AiChatMessage[]) {
      await lakebaseRequest(ctx, itemIndex, {
        method: 'POST',
        url,
        headers: { prefer: 'return=minimal' },
        body: messages.map((m) => ({ session_id: keyOf(sessionId), message: toStoredMessage(m) })),
        bodyType: 'json',
      });
    }
    const remove = (url: string, sessionId: string) =>
      lakebaseRequest(ctx, itemIndex, {
        method: 'DELETE',
        url,
        qs: sessionFilter(sessionId),
        headers: { prefer: 'return=minimal' },
      });

    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      load: (sessionId) =>
        guarded(async (url) => {
          const res = await lakebaseRequest<Row[]>(ctx, itemIndex, {
            method: 'GET',
            url,
            qs: { ...sessionFilter(sessionId), order: 'id.desc', limit: 2 * k },
          });
          return toMessages(Array.isArray(res) ? res : []).reverse();
        }),
      append: (sessionId, messages) =>
        guarded(async (url) => {
          if (messages.length) await insert(url, sessionId, messages);
        }),
      loadAll: (sessionId) =>
        guarded(async (url) => {
          const { rows, truncated } = await lakebaseSelectAll<Row>(ctx, itemIndex, url, {
            ...sessionFilter(sessionId),
            order: 'id.asc',
          });
          if (truncated) {
            throw new NodeOperationError(
              ctx.getNode(),
              `The session holds more than ${LAKEBASE_PAGE_SIZE * LAKEBASE_MAX_PAGES} rows`,
              {
                itemIndex,
                description: 'Clear the session, or use a shorter-lived session ID, so the history stays readable.',
              },
            );
          }
          return toMessages(rows);
        }),
      // n8n's order: delete the session's rows, then write the new ones in one array POST
      replace: (sessionId, messages) =>
        guarded(async (url) => {
          await remove(url, sessionId);
          if (messages.length) await insert(url, sessionId, messages);
        }),
      clear: (sessionId) =>
        guarded(async (url) => {
          await remove(url, sessionId);
        }),
    };
    return { response: logged(ctx, memory) };
  },
};
