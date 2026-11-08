/**
 * The test webhook stores (memory and Redis): a claim removes only the registrations of its own listen, so a
 * listen that replaced them while a request was still inside the node keeps its own (P5-56).
 * Run with TEST_REDIS_URL=redis://127.0.0.1:6379/2.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryTestWebhookStore,
  RedisTestWebhookStore,
  type TestWebhookRegistration,
  type TestWebhookStore,
} from '../src/services/test-webhooks';
import { TEST_REDIS } from './helpers';

const prefix = `zz-store-${randomUUID()}`;
const redis = new RedisTestWebhookStore(TEST_REDIS, prefix);

afterAll(async () => {
  await redis.close();
});

const listen = (tenantId: string, listenId: string, expiresAt: number): TestWebhookRegistration[] =>
  ['GET', 'POST'].map((method) => ({
    tenantId,
    workflowId: 'wf1',
    nodeName: 'Chat',
    method,
    path: 'chat-hook/chat',
    workflow: { id: 'wf1', name: 'chat', nodes: [], connections: {} },
    listenId,
    expiresAt,
  }));

describe.each([
  ['memory', () => new MemoryTestWebhookStore() as TestWebhookStore],
  ['redis', () => redis as TestWebhookStore],
])('the %s test webhook store', (_name, make) => {
  it('a claim of an earlier listen removes nothing of the listen that replaced it', async () => {
    const store = make();
    const tenantId = randomUUID();
    const later = Date.now() + 120_000;
    const [oldGet] = listen(tenantId, 'L1', later - 5);
    for (const r of listen(tenantId, 'L1', later - 5)) await store.add(r);
    for (const r of listen(tenantId, 'L2', later)) await store.add(r);

    expect(await store.remove(oldGet)).toBe(false);
    expect(await store.removeForNode(tenantId, 'wf1', 'Chat', oldGet)).toBe(0);
    expect((await store.list(tenantId)).map((r) => r.listenId)).toEqual(['L2', 'L2']);
    await store.removeForNode(tenantId, 'wf1', 'Chat');
  });

  it('a claim of the current listen removes all of its registrations', async () => {
    const store = make();
    const tenantId = randomUUID();
    const [get] = listen(tenantId, 'L1', Date.now() + 120_000);
    for (const r of listen(tenantId, 'L1', get.expiresAt)) await store.add(r);
    // as handleTest finds it: the stored copy
    const found = (await store.list(tenantId)).find((r) => r.method === 'GET')!;

    expect(await store.remove(found)).toBe(true);
    expect(await store.remove(found)).toBe(false);
    expect(await store.removeForNode(tenantId, 'wf1', 'Chat', found)).toBe(1);
    expect(await store.list(tenantId)).toEqual([]);
  });

  it('without a listen, removeForNode removes every registration of the node', async () => {
    const store = make();
    const tenantId = randomUUID();
    for (const r of listen(tenantId, 'L1', Date.now() + 120_000)) await store.add(r);
    expect(await store.removeForNode(tenantId, 'wf1', 'Chat')).toBe(2);
    expect(await store.list(tenantId)).toEqual([]);
  });
});
