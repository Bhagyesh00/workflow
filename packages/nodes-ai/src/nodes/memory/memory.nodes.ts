/**
 * Chat memory sub-nodes. Each supplies an `AiMemory` bound to the session key of the current
 * item (`sessionId` on the supplied object). Every store is tenant-scoped: the in-process
 * buffer keys by tenant, Postgres rows carry `tenant_id`, Redis keys embed the tenant id.
 */
import type { AiChatMessage, NodeType } from '@workflow/workflow';
import type { SessionMemory } from '../../shared/ai-inputs';
import { quoteTableName, sharedPostgres, sharedRedis } from '../../shared/connections';
import { TenantStore } from '../../shared/tenant-store';
import { messageText } from '../../shared/utils';
import { MemoryLakebaseChatNode } from './MemoryLakebaseChat.node';
import { MemoryManagerNode } from './MemoryManager.node';
import { MemoryMongoDbChatNode } from './MemoryMongoDbChat.node';
import { MemoryXataNode } from './MemoryXata.node';
import {
  fromStoredMessage,
  logged,
  memoryDescription,
  toStoredMessage,
  windowProperty,
  windowSize,
} from './memory-shared';
import { readSessionKey, sessionProperties } from './session';

/** kept here for the existing tests and importers; the shared memory parts live in memory-shared.ts */
export { fromStoredMessage, toStoredMessage } from './memory-shared';

// ---------------------------------------------------------------------------------------------
// Window buffer (in-process)
// ---------------------------------------------------------------------------------------------

/** approximate bytes one workspace may hold across all its Simple Memory conversations */
export const MEMORY_BUFFER_MAX_BYTES_PER_TENANT = 64 * 1024 * 1024;

/** Approximate heap bytes of stored messages: 2 per text character plus a fixed cost per message. */
export function messagesBytes(messages: AiChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += 64 + messageText(m.content).length * 2;
  return total;
}

/**
 * Appends to a conversation and keeps the newest messages that fit both the window (a little more
 * than twice `k`) and the byte budget: the oldest messages are dropped first and the newest message
 * is always kept. Whole conversations are evicted by the store once a workspace passes its budget.
 */
export function appendWithinBudget(
  stored: AiChatMessage[],
  added: AiChatMessage[],
  k: number,
  maxBytes: number,
): AiChatMessage[] {
  const next = [...stored, ...added].slice(-Math.max(2 * k, 40));
  let bytes = messagesBytes(next);
  let drop = 0;
  while (bytes > maxBytes && drop < next.length - 1) {
    bytes -= messagesBytes([next[drop]]);
    drop++;
  }
  return drop > 0 ? next.slice(drop) : next;
}

const bufferStore = new TenantStore<AiChatMessage[]>({
  maxKeysPerTenant: 1000,
  maxTenants: 2000,
  maxBytesPerTenant: MEMORY_BUFFER_MAX_BYTES_PER_TENANT,
  sizeOf: messagesBytes,
});

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
          'Stored in the memory of the process that runs the workflow: history is lost on restart, is not shared between queue workers, and only the 1,000 most recent conversations (up to about 64 MB) per workspace are kept. Use Postgres or Redis memory in production.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      ...sessionProperties,
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
        // keep a little more than the window so a larger window later still has history
        const next = appendWithinBudget(
          stored,
          messages.map((m) => toStoredMessage(m) as AiChatMessage),
          k,
          MEMORY_BUFFER_MAX_BYTES_PER_TENANT,
        );
        bufferStore.set(tenantId, keyOf(sessionId), next);
      },
      async loadAll(sessionId) {
        return (bufferStore.get(tenantId, keyOf(sessionId)) ?? []).map((m) => ({ ...m }));
      },
      async replace(sessionId, messages) {
        // the byte budget still applies; the window does not, a rewrite keeps every message that fits
        const next = appendWithinBudget(
          [],
          messages.map((m) => toStoredMessage(m) as AiChatMessage),
          Math.max(messages.length, 1),
          MEMORY_BUFFER_MAX_BYTES_PER_TENANT,
        );
        if (next.length) bufferStore.set(tenantId, keyOf(sessionId), next);
        else bufferStore.delete(tenantId, keyOf(sessionId));
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
      ...sessionProperties,
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
    const { value: client, release } = await sharedPostgres(ctx, itemIndex);
    try {
      await ensureChatTable(client, table);
    } catch (error) {
      await release();
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
      async loadAll(sessionId) {
        const result = await client.query(
          `SELECT message FROM ${table} WHERE tenant_id = $1 AND session_id = $2 ORDER BY id`,
          [tenantId, sessionId],
        );
        return result.rows
          .map((r) => fromStoredMessage(r.message))
          .filter((m): m is AiChatMessage => Boolean(m));
      },
      async replace(sessionId, messages) {
        // one statement, so a failure or a second writer never sees a half-rewritten history
        await client.query(
          `WITH del AS (DELETE FROM ${table} WHERE tenant_id = $1 AND session_id = $2)
           INSERT INTO ${table} (tenant_id, session_id, message)
           SELECT $1::text, $2::text, u.m::jsonb FROM unnest($3::text[]) WITH ORDINALITY AS u(m, ord) ORDER BY u.ord`,
          [tenantId, sessionId, messages.map((m) => JSON.stringify(toStoredMessage(m)))],
        );
      },
      async clear(sessionId) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND session_id = $2`, [
          tenantId,
          sessionId,
        ]);
      },
    };
    return { response: logged(ctx, memory), closeFunction: release };
  },
};

async function ensureChatTable(client: import('pg').Client, table: string): Promise<void> {
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
      ...sessionProperties,
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
    const { value: client, release } = await sharedRedis(ctx, itemIndex);
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
      async loadAll(sessionId) {
        const raw = await client.lrange(keyOf(sessionId), 0, -1);
        return raw.map(fromStoredMessage).filter((m): m is AiChatMessage => Boolean(m));
      },
      async replace(sessionId, messages) {
        const key = keyOf(sessionId);
        const tx = client.multi().del(key);
        if (messages.length) {
          tx.rpush(key, ...messages.map((m) => JSON.stringify(toStoredMessage(m))));
          tx.ltrim(key, -REDIS_MAX_MESSAGES, -1);
          if (ttl > 0) tx.expire(key, ttl);
        }
        await tx.exec();
      },
      async clear(sessionId) {
        await client.del(keyOf(sessionId));
      },
    };
    return { response: logged(ctx, memory), closeFunction: release };
  },
};

export const memoryNodes: NodeType[] = [
  MemoryBufferWindowNode,
  MemoryPostgresChatNode,
  MemoryRedisChatNode,
  MemoryMongoDbChatNode,
  MemoryXataNode,
  MemoryLakebaseChatNode,
  MemoryManagerNode,
];
