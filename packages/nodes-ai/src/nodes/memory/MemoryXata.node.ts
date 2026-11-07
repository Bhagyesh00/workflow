/**
 * Xata memory: chat history in a Xata table, over Xata's REST API (create table, query, insert one
 * record per message, delete). Like n8n, the node creates the table on first use with the columns
 * sessionId, type, role, content, name and additionalKwargs, and keeps the hide flag of a message in
 * additionalKwargs. The session key of a record holds `<tenantId>:<sessionId>`, so workspaces that
 * share one database never see each other's history. The table is named after the database in the endpoint.
 */
import {
  type AiChatMessage,
  NodeApiError,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
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

const PAGE_SIZE = 200;
/** pages read at most (500 x 200 = 100000 records, the same bound as the Lakebase memory) */
const MAX_PAGES = 500;
const SESSION_FIELD = 'sessionId';

/** the columns of the history table, as the table n8n makes */
const TABLE_COLUMNS = [
  { name: 'sessionId', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'role', type: 'string' },
  { name: 'content', type: 'text' },
  { name: 'name', type: 'string' },
  { name: 'additionalKwargs', type: 'text' },
];
const TYPE_OF_ROLE: Record<string, string> = {
  user: 'human',
  assistant: 'ai',
  system: 'system',
  tool: 'tool',
};
const ROLE_OF_TYPE: Record<string, string> = { human: 'user', ai: 'assistant', system: 'system' };

type XataRecord = { id: string; [key: string]: unknown };

/** the record a message is stored as: the hide flag lives in `additionalKwargs`, as n8n keeps it */
function toRecord(sessionKey: string, message: AiChatMessage): Record<string, unknown> {
  const stored = toStoredMessage(message);
  return {
    [SESSION_FIELD]: sessionKey,
    type: TYPE_OF_ROLE[stored.role] ?? stored.role,
    content: stored.content,
    additionalKwargs: JSON.stringify(stored.hideFromUI ? { hideFromUI: true } : {}),
  };
}

function fromRecord(row: XataRecord): AiChatMessage | undefined {
  let hideFromUI = false;
  try {
    hideFromUI =
      (JSON.parse(String(row.additionalKwargs ?? '{}')) as { hideFromUI?: unknown })?.hideFromUI === true;
  } catch {
    // a record without readable additionalKwargs is a plain message
  }
  return fromStoredMessage({ role: ROLE_OF_TYPE[String(row.type)], content: row.content, hideFromUI });
}

function httpStatus(error: unknown): number {
  return error instanceof NodeApiError ? Number(error.httpCode ?? 0) : 0;
}

interface XataTarget {
  base: string;
  table: string;
}

/** `https://ws.region.xata.sh/db/<database>` gives the table `<database>`, as n8n does */
function extractTable(endpoint: string): string | undefined {
  const match = /^https:\/\/[^./]+\.[^./]+\.xata\.sh\/db\/([^:/?#]+)/.exec(endpoint.trim());
  return match?.[1];
}

async function target(ctx: SupplyDataContext, itemIndex: number): Promise<XataTarget> {
  const creds = await ctx.getCredentials('xataApi', itemIndex);
  const endpoint = String(creds.databaseEndpoint ?? '')
    .trim()
    .replace(/\/+$/, '');
  const table = extractTable(endpoint);
  if (!table) {
    throw new NodeOperationError(
      ctx.getNode(),
      'It was not possible to extract the table from the Database Endpoint.',
      { itemIndex },
    );
  }
  const branch = String(creds.branch ?? 'main').trim() || 'main';
  return { base: `${endpoint}:${encodeURIComponent(branch)}`, table };
}

export const MemoryXataNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryXata',
      displayName: 'Xata',
      description: 'Stores chat history in a Xata database table',
      icon: 'simple:xata',
      credentials: [{ name: 'xataApi', required: true }],
    },
    [...sessionProperties, windowProperty],
  ),
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const { base, table } = await target(ctx, itemIndex);
    const tenantId = ctx.getTenantId();
    const tableUrl = `${base}/tables/${encodeURIComponent(table)}`;
    const keyOf = (sessionId: string) => `${tenantId}:${sessionId}`;
    const call = <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
      ctx.helpers.httpRequestWithAuthentication<T>(
        'xataApi',
        {
          method,
          url: `${tableUrl}${path}`,
          ...(body === undefined ? {} : { body: body as never, json: true }),
        },
        itemIndex,
      ) as Promise<T>;

    const tooMany = () =>
      new NodeOperationError(ctx.getNode(), `The session holds more than ${PAGE_SIZE * MAX_PAGES} records`, {
        itemIndex,
        description: 'Clear the session with the Memory Manager node or use a new Session ID.',
      });

    const stuck = (message: string) => new NodeOperationError(ctx.getNode(), message, { itemIndex });

    /** makes the table with its columns when it is missing, once per run of the node, as n8n does */
    let ready: Promise<void> | undefined;
    const ensureTable = () =>
      (ready ??= (async () => {
        try {
          await call('GET', '/schema');
          return;
        } catch (error) {
          if (httpStatus(error) !== 404) throw error;
        }
        await call('PUT', '');
        await call('PUT', '/schema', { columns: TABLE_COLUMNS });
      })().catch((error) => {
        ready = undefined;
        throw error;
      }));

    /** records of one session, newest first when `desc`, at most `limit` of them; more than the page cap is an error */
    async function records(sessionId: string, desc: boolean, limit: number) {
      await ensureTable();
      const out: XataRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; out.length < limit; page++) {
        if (page >= MAX_PAGES) throw tooMany();
        const size = Math.min(PAGE_SIZE, limit - out.length);
        const res = await call<{
          records?: XataRecord[];
          meta?: { page?: { cursor?: string; more?: boolean } };
        }>('POST', '/query', {
          filter: { [SESSION_FIELD]: { $is: keyOf(sessionId) } },
          sort: { 'xata.createdAt': desc ? 'desc' : 'asc' },
          page: { size, ...(cursor ? { after: cursor } : {}) },
        });
        out.push(...(res?.records ?? []));
        const next = res?.meta?.page?.cursor;
        if (!res?.meta?.page?.more || !next) break;
        if (next === cursor) throw stuck("Couldn't read the session: Xata sent the same page cursor twice");
        cursor = next;
      }
      return out;
    }
    const toMessages = (rows: XataRecord[]) =>
      rows.map(fromRecord).filter((m): m is AiChatMessage => Boolean(m));

    /** one record per message, in order, so `xata.createdAt` grows with each message of a turn */
    async function insert(sessionId: string, messages: AiChatMessage[]) {
      await ensureTable();
      for (const message of messages) await call('POST', '/data', toRecord(keyOf(sessionId), message));
    }
    async function remove(sessionId: string) {
      let previous: string | undefined;
      for (let round = 0; round < MAX_PAGES; round++) {
        const rows = await records(sessionId, false, PAGE_SIZE);
        if (!rows.length) return;
        // the same first record again means the delete did not take effect
        if (rows[0].id === previous)
          throw stuck("Couldn't clear the session: Xata did not delete the records");
        previous = rows[0].id;
        for (const row of rows) await call('DELETE', `/data/${encodeURIComponent(row.id)}`);
      }
      throw tooMany();
    }

    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      async load(sessionId) {
        return toMessages(await records(sessionId, true, 2 * k)).reverse();
      },
      async append(sessionId, messages) {
        if (messages.length) await insert(sessionId, messages);
      },
      async loadAll(sessionId) {
        return toMessages(await records(sessionId, false, Number.MAX_SAFE_INTEGER));
      },
      async replace(sessionId, messages) {
        await remove(sessionId);
        if (messages.length) await insert(sessionId, messages);
      },
      clear: remove,
    };
    return { response: logged(ctx, memory) };
  },
};
