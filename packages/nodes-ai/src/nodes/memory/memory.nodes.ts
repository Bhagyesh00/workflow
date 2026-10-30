/**
 * Chat memory sub-nodes. Each supplies an `AiMemory` bound to the session key of the current
 * item (`sessionId` on the supplied object). Every store is tenant-scoped: the in-process
 * buffer keys by tenant, Postgres rows carry `tenant_id`, Redis keys embed the tenant id.
 */
import {
  type AiChatMessage,
  type DataObject,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type NodeTypeDescription,
  type SupplyDataContext,
} from '@workflow/workflow';
import type { SessionMemory } from '../../shared/ai-inputs';
import { connectPostgres, connectRedis, quoteTableName } from '../../shared/connections';
import { TenantStore } from '../../shared/tenant-store';
import { messageText, truncate } from '../../shared/utils';

/** a single stored message is capped so one huge answer cannot bloat every later prompt */
const MAX_STORED_CHARS = 50_000;
const MAX_SESSION_KEY = 512;

const sessionKeyProperty: NodeProperty = {
  displayName: 'Session Key',
  name: 'sessionKey',
  type: 'string',
  default: '={{ $json.sessionId }}',
  required: true,
  description: 'Identifies the conversation. The Chat Trigger sends "sessionId".',
};

const windowProperty: NodeProperty = {
  displayName: 'Context Window Length',
  name: 'contextWindowLength',
  type: 'number',
  default: 5,
  typeOptions: { minValue: 1, maxValue: 200 },
  description: 'How many past exchanges (user message + answer) the model sees',
};

function memoryDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'credentials'>,
  properties: NodeProperty[],
): NodeTypeDescription {
  return {
    ...base,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: [],
    outputs: ['ai_memory'],
    outputNames: ['Memory'],
    categories: ['AI', 'Memory'],
    alias: ['chat history', 'conversation', 'remember'],
    properties,
  };
}

function readSessionKey(ctx: SupplyDataContext, itemIndex: number): string {
  const value = ctx.getNodeParameter('sessionKey', itemIndex, '');
  const key = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw new NodeOperationError(ctx.getNode(), 'The session key is empty', {
      itemIndex,
      description: 'Map a session id, e.g. {{ $json.sessionId }} from a Chat Trigger.',
      parameter: 'sessionKey',
    });
  }
  if (key.length > MAX_SESSION_KEY) {
    throw new NodeOperationError(
      ctx.getNode(),
      `The session key is longer than ${MAX_SESSION_KEY} characters`,
      {
        itemIndex,
      },
    );
  }
  return key;
}

function windowSize(ctx: SupplyDataContext, itemIndex: number): number {
  return Math.max(1, Math.min(200, Number(ctx.getNodeParameter('contextWindowLength', itemIndex, 5)) || 5));
}

/** Only role and text are stored: images and provider internals never reach memory. */
export function toStoredMessage(message: AiChatMessage): { role: string; content: string } {
  return { role: message.role, content: truncate(messageText(message.content), MAX_STORED_CHARS) };
}

export function fromStoredMessage(value: unknown): AiChatMessage | undefined {
  const v = (typeof value === 'string' ? safeParse(value) : value) as DataObject | undefined;
  if (!v || (v.role !== 'user' && v.role !== 'assistant' && v.role !== 'system')) return undefined;
  return { role: v.role, content: typeof v.content === 'string' ? v.content : '' };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function logged(ctx: SupplyDataContext, memory: SessionMemory): SessionMemory {
  return {
    kind: 'memory',
    sessionId: memory.sessionId,
    async load(sessionId) {
      const messages = await memory.load(sessionId);
      ctx.logSubNodeRun(
        { action: 'loadMemoryVariables', sessionId },
        { chatHistory: messages.map(toStoredMessage) },
      );
      return messages;
    },
    async append(sessionId, messages) {
      await memory.append(sessionId, messages);
      ctx.logSubNodeRun({ action: 'saveContext', sessionId }, { chatHistory: messages.map(toStoredMessage) });
    },
    clear: (sessionId) => memory.clear(sessionId),
  };
}

// ---------------------------------------------------------------------------------------------
// Window buffer (in-process)
// ---------------------------------------------------------------------------------------------

const bufferStore = new TenantStore<AiChatMessage[]>({ maxKeysPerTenant: 1000, maxTenants: 2000 });

/** test hook */
export function clearBufferMemory(): void {
  bufferStore.clear();
}

export const MemoryBufferWindowNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryBufferWindow',
      displayName: 'Simple Memory',
      description: 'Keeps the last messages of each conversation in the worker process (no database needed)',
      icon: 'lucide:brain',
    },
    [
      {
        displayName:
          'Stored in the memory of the process that runs the workflow: history is lost on restart and is not shared between queue workers. Use Postgres or Redis memory in production.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      sessionKeyProperty,
      windowProperty,
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const tenantId = ctx.getTenantId();
    const scope = ctx.getWorkflow().id ?? ctx.getWorkflow().name;
    const keyOf = (sessionId: string) => `${scope}\u0000${sessionId}`;
    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      async load(sessionId) {
        const stored = bufferStore.get(tenantId, keyOf(sessionId)) ?? [];
        return stored.slice(-2 * k).map((m) => ({ ...m }));
      },
      async append(sessionId, messages) {
        const stored = bufferStore.get(tenantId, keyOf(sessionId)) ?? [];
        const next = [...stored, ...messages.map((m) => toStoredMessage(m) as AiChatMessage)];
        // keep a little more than the window so a larger window later still has history
        bufferStore.set(tenantId, keyOf(sessionId), next.slice(-Math.max(2 * k, 40)));
      },
      async clear(sessionId) {
        bufferStore.delete(tenantId, keyOf(sessionId));
      },
    };
    return { response: logged(ctx, memory) };
  },
};

// ---------------------------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------------------------

const ensuredTables = new Set<string>();

export const MemoryPostgresChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryPostgresChat',
      displayName: 'Postgres Chat Memory',
      description: 'Stores chat history in a PostgreSQL table',
      icon: 'simple:postgresql',
      credentials: [{ name: 'postgres', required: true }],
    },
    [
      sessionKeyProperty,
      {
        displayName: 'Table Name',
        name: 'tableName',
        type: 'string',
        default: 'ai_chat_histories',
        description:
          'Created automatically when missing (columns: tenant_id, session_id, message, created_at)',
      },
      windowProperty,
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const table = quoteTableName(String(ctx.getNodeParameter('tableName', itemIndex, 'ai_chat_histories')));
    const tenantId = ctx.getTenantId();
    const client = await connectPostgres(ctx);
    try {
      await ensureChatTable(client, table);
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      async load(sessionId) {
        const result = await client.query(
          `SELECT message FROM ${table} WHERE tenant_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT $3`,
          [tenantId, sessionId, 2 * k],
        );
        return result.rows
          .reverse()
          .map((r) => fromStoredMessage(r.message))
          .filter((m): m is AiChatMessage => Boolean(m));
      },
      async append(sessionId, messages) {
        if (!messages.length) return;
        const values: unknown[] = [];
        const rows = messages.map((m, i) => {
          values.push(tenantId, sessionId, JSON.stringify(toStoredMessage(m)));
          return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}::jsonb)`;
        });
        await client.query(
          `INSERT INTO ${table} (tenant_id, session_id, message) VALUES ${rows.join(', ')}`,
          values,
        );
      },
      async clear(sessionId) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND session_id = $2`, [
          tenantId,
          sessionId,
        ]);
      },
    };
    return { response: logged(ctx, memory), closeFunction: () => client.end() };
  },
};

async function ensureChatTable(client: import('pg').Client, table: string): Promise<void> {
  const cacheKey = `${(client as unknown as { host?: string }).host}:${(client as unknown as { database?: string }).database}:${table}`;
  if (ensuredTables.has(cacheKey)) return;
  const indexName = `"${table.replace(/"/g, '').split('.').pop()!.slice(0, 40)}_tenant_session_idx"`;
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (tenant_id, session_id, id)`);
  } catch (error) {
    // concurrent creation by another execution: the table exists now
    const code = (error as { code?: string }).code;
    if (code !== '23505' && code !== '42P07') throw error;
  }
  ensuredTables.add(cacheKey);
}

// ---------------------------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------------------------

/** messages kept per session in Redis (the window decides how many the model sees) */
const REDIS_MAX_MESSAGES = 1000;

export const MemoryRedisChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryRedisChat',
      displayName: 'Redis Chat Memory',
      description: 'Stores chat history in Redis lists with an optional expiry',
      icon: 'simple:redis',
      credentials: [{ name: 'redis', required: true }],
    },
    [
      sessionKeyProperty,
      {
        displayName: 'Session Time To Live (s)',
        name: 'sessionTTL',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Delete a conversation this many seconds after its last message (0 = keep)',
      },
      windowProperty,
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const ttl = Math.max(0, Number(ctx.getNodeParameter('sessionTTL', itemIndex, 0)) || 0);
    const tenantId = ctx.getTenantId();
    const keyOf = (sessionId: string) => `wf:ai:chat:${tenantId}:${sessionId}`;
    const client = await connectRedis(ctx);
    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      async load(sessionId) {
        const raw = await client.lrange(keyOf(sessionId), -2 * k, -1);
        return raw.map(fromStoredMessage).filter((m): m is AiChatMessage => Boolean(m));
      },
      async append(sessionId, messages) {
        if (!messages.length) return;
        const key = keyOf(sessionId);
        const tx = client
          .multi()
          .rpush(key, ...messages.map((m) => JSON.stringify(toStoredMessage(m))))
          .ltrim(key, -REDIS_MAX_MESSAGES, -1);
        if (ttl > 0) tx.expire(key, ttl);
        await tx.exec();
      },
      async clear(sessionId) {
        await client.del(keyOf(sessionId));
      },
    };
    return {
      response: logged(ctx, memory),
      closeFunction: async () => {
        await client.quit().catch(() => client.disconnect());
      },
    };
  },
};

export const memoryNodes: NodeType[] = [MemoryBufferWindowNode, MemoryPostgresChatNode, MemoryRedisChatNode];
