/**
 * "Listen for test event" registrations: one-shot, 2-minute listeners on
 * `/webhook-test/<tenantSlug>/<path>`. Kept in memory in regular mode and in Redis in queue mode
 * so that any main can receive the call.
 */
import type { WorkflowDefinition } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { matchDynamic, sortDynamic } from './webhook-paths';

export const TEST_WEBHOOK_TTL_MS = 120_000;
/** how long a trigger without a URL listens for a test event (P4-21); as long as a test webhook */
export const TEST_TRIGGER_TTL_MS = TEST_WEBHOOK_TTL_MS;

export interface TestWebhookRegistration {
  tenantId: string;
  workflowId: string;
  nodeName: string;
  method: string;
  path: string;
  workflow: WorkflowDefinition;
  userId?: string;
  /** P5-56: a chat trigger's registration id; the `chatTestToken` of the listen reply is bound to it */
  listenId?: string;
  /** P5-59: the test run stops at this node (the canvas chat runs up to the node it was opened from) */
  destinationNode?: string;
  /** epoch ms */
  expiresAt: number;
}

export interface TestWebhookStore {
  add(registration: TestWebhookRegistration): Promise<void>;
  list(tenantId: string): Promise<TestWebhookRegistration[]>;
  /**
   * remove this registration; returns false when it was already consumed (another request won) or a newer
   * listen replaced it (the newer one stays)
   */
  remove(registration: TestWebhookRegistration): Promise<boolean>;
  /**
   * remove every registration of one node of one workflow, or with `listen` only those of that listen;
   * returns how many were removed
   */
  removeForNode(tenantId: string, workflowId: string, nodeName: string, listen?: ListenRef): Promise<number>;
  close(): Promise<void>;
}

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

/** one listen: its registrations share the chat's `listenId` and the time they expire */
export type ListenRef = Pick<TestWebhookRegistration, 'listenId' | 'expiresAt'>;

const sameListen = (a: ListenRef, b: ListenRef) => a.listenId === b.listenId && a.expiresAt === b.expiresAt;

/** HDEL a field only while it holds a registration of the same listen (KEYS[1] hash; ARGV field, listenId, expiresAt) */
const REMOVE_SAME_LISTEN = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local r = cjson.decode(raw)
local id = r.listenId
if type(id) ~= 'string' then id = '' end
if id ~= ARGV[2] or tonumber(r.expiresAt) ~= tonumber(ARGV[3]) then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;

export class MemoryTestWebhookStore implements TestWebhookStore {
  private readonly byTenant = new Map<string, Map<string, TestWebhookRegistration>>();

  async add(registration: TestWebhookRegistration): Promise<void> {
    const map = this.byTenant.get(registration.tenantId) ?? new Map();
    map.set(keyOf(registration), registration);
    this.byTenant.set(registration.tenantId, map);
  }

  async list(tenantId: string): Promise<TestWebhookRegistration[]> {
    const map = this.byTenant.get(tenantId);
    if (!map) return [];
    const now = Date.now();
    for (const [k, r] of map) if (r.expiresAt <= now) map.delete(k);
    return [...map.values()];
  }

  async remove(registration: TestWebhookRegistration): Promise<boolean> {
    const map = this.byTenant.get(registration.tenantId);
    const stored = map?.get(keyOf(registration));
    if (!map || !stored || !sameListen(stored, registration)) return false;
    return map.delete(keyOf(registration));
  }

  async removeForNode(
    tenantId: string,
    workflowId: string,
    nodeName: string,
    listen?: ListenRef,
  ): Promise<number> {
    const map = this.byTenant.get(tenantId);
    if (!map) return 0;
    let removed = 0;
    for (const [k, r] of map) {
      if (r.workflowId !== workflowId || r.nodeName !== nodeName) continue;
      if (listen && !sameListen(r, listen)) continue;
      map.delete(k);
      removed++;
    }
    return removed;
  }

  async close(): Promise<void> {
    this.byTenant.clear();
  }
}

export class RedisTestWebhookStore implements TestWebhookStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix: string,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', () => {});
  }

  private key(tenantId: string) {
    return `${this.prefix}:test-webhooks:${tenantId}`;
  }

  async add(registration: TestWebhookRegistration): Promise<void> {
    const key = this.key(registration.tenantId);
    await this.redis.hset(key, keyOf(registration), JSON.stringify(registration));
    await this.redis.pexpire(key, TEST_WEBHOOK_TTL_MS);
  }

  async list(tenantId: string): Promise<TestWebhookRegistration[]> {
    const entries = await this.redis.hgetall(this.key(tenantId));
    const now = Date.now();
    const out: TestWebhookRegistration[] = [];
    for (const [field, raw] of Object.entries(entries)) {
      const r = JSON.parse(raw) as TestWebhookRegistration;
      if (r.expiresAt <= now) await this.redis.hdel(this.key(tenantId), field);
      else out.push(r);
    }
    return out;
  }

  async remove(registration: TestWebhookRegistration): Promise<boolean> {
    const removed = await this.redis.eval(
      REMOVE_SAME_LISTEN,
      1,
      this.key(registration.tenantId),
      keyOf(registration),
      registration.listenId ?? '',
      String(registration.expiresAt),
    );
    return Number(removed) > 0;
  }

  async removeForNode(
    tenantId: string,
    workflowId: string,
    nodeName: string,
    listen?: ListenRef,
  ): Promise<number> {
    const key = this.key(tenantId);
    const entries = await this.redis.hgetall(key);
    const matches = Object.entries(entries).filter(([, raw]) => {
      const r = JSON.parse(raw) as TestWebhookRegistration;
      return r.workflowId === workflowId && r.nodeName === nodeName && (!listen || sameListen(r, listen));
    });
    if (!listen) {
      const fields = matches.map(([field]) => field);
      return fields.length ? await this.redis.hdel(key, ...fields) : 0;
    }
    // each field only while it still holds this listen: a newer listen may have replaced it meanwhile
    let removed = 0;
    for (const [field] of matches) {
      const done = await this.redis.eval(
        REMOVE_SAME_LISTEN,
        1,
        key,
        field,
        listen.listenId ?? '',
        String(listen.expiresAt),
      );
      removed += Number(done);
    }
    return removed;
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }
}

/** find the registration matching method + path (static first, then dynamic) */
export async function findTestWebhook(
  store: TestWebhookStore,
  tenantId: string,
  method: string,
  path: string,
): Promise<{ registration: TestWebhookRegistration; params: Record<string, string> } | undefined> {
  const all = (await store.list(tenantId)).filter((r) => r.method === method);
  const exact = all.find((r) => r.path === path);
  if (exact) return { registration: exact, params: {} };
  for (const r of sortDynamic(all.filter((x) => x.path.includes(':')))) {
    const params = matchDynamic(r.path, path);
    if (params) return { registration: r, params };
  }
  return undefined;
}
