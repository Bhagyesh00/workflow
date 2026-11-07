/**
 * Xata memory: chat history in a Xata table, over Xata's REST records API (query, bulk insert,
 * delete). The session key of a record holds `<tenantId>:<sessionId>`, so workspaces that share one
 * database never see each other's history. The table is named after the database in the endpoint.
 */
import { type AiChatMessage, NodeOperationError, type NodeType, type SupplyDataContext } from '@workflow/workflow';
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
const BULK_SIZE = 100;
const SESSION_FIELD = 'sessionId';

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
    const call = <T>(method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      ctx.helpers.httpRequestWithAuthentication<T>(
        'xataApi',
        { method, url: `${tableUrl}${path}`, ...(body === undefined ? {} : { body: body as never, json: true }) },
        itemIndex,
      ) as Promise<T>;

    /** records of one session, newest first when `desc`, at most `limit` of them */
    async function records(sessionId: string, desc: boolean, limit: number) {
      const out: Array<{ id: string; [key: string]: unknown }> = [];
      let cursor: string | undefined;
      while (out.length < limit) {
        const size = Math.min(PAGE_SIZE, limit - out.length);
        const res = await call<{
          records?: Array<{ id: string }>;
          meta?: { page?: { cursor?: string; more?: boolean } };
        }>('POST', '/query', {
          filter: { [SESSION_FIELD]: { $is: keyOf(sessionId) } },
          sort: { 'xata.createdAt': desc ? 'desc' : 'asc' },
          page: { size, ...(cursor ? { after: cursor } : {}) },
        });
        out.push(...(res?.records ?? []));
        cursor = res?.meta?.page?.cursor;
        if (!res?.meta?.page?.more || !cursor) break;
      }
      return out;
    }
    const toMessages = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => fromStoredMessage(r)).filter((m): m is AiChatMessage => Boolean(m));

    async function insert(sessionId: string, messages: AiChatMessage[]) {
      for (let i = 0; i < messages.length; i += BULK_SIZE) {
        await call('POST', '/bulk', {
          records: messages
            .slice(i, i + BULK_SIZE)
            .map((m) => ({ [SESSION_FIELD]: keyOf(sessionId), ...toStoredMessage(m) })),
        });
      }
    }
    async function remove(sessionId: string) {
      for (;;) {
        const rows = await records(sessionId, false, PAGE_SIZE);
        if (!rows.length) return;
        for (const row of rows) await call('DELETE', `/data/${encodeURIComponent(row.id)}`);
      }
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
