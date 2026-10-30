/**
 * "Listen for test event" registrations: one-shot, 2-minute listeners on
 * `/webhook-test/<tenantSlug>/<path>`. Kept in memory in regular mode and in Redis in queue mode
 * so that any main can receive the call.
 */
import type { WorkflowDefinition } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { matchDynamic, sortDynamic } from './webhook-paths';

export const TEST_WEBHOOK_TTL_MS = 120_000;

export interface TestWebhookRegistration {
  tenantId: string;
  workflowId: string;
  nodeName: string;
  method: string;
  path: string;
  workflow: WorkflowDefinition;
  userId?: string;
  /** epoch ms */
  expiresAt: number;
}

export interface TestWebhookStore {
  add(registration: TestWebhookRegistration): Promise<void>;
  list(tenantId: string): Promise<TestWebhookRegistration[]>;
  /** remove; returns false when it was already consumed (another request won) */
  remove(registration: TestWebhookRegistration): Promise<boolean>;
  close(): Promise<void>;
}

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

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
    return this.byTenant.get(registration.tenantId)?.delete(keyOf(registration)) ?? false;
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
    return (await this.redis.hdel(this.key(registration.tenantId), keyOf(registration))) > 0;
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
