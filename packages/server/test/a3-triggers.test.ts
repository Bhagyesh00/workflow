/**
 * A3 trigger and activation findings: R21 (binary data of polls, triggers and manual runs),
 * R39 (push streams after logout or member removal), R41 (third-party webhooks on save),
 * R49 (listen for test event registers the test URL with the provider).
 */
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { Item, NodePackage, NodeType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import { PING_INTERVAL_MS } from '../src/routes/push';
import { TEST_WEBHOOK_TTL_MS } from '../src/services/test-webhooks';
import {
  createWorkflow,
  executionsOf,
  hookRegistry,
  node,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

const BIG = 100 * 1024;
const polled = { withItems: 0, empty: 0 };

const binaryNode = (name: string, extra: Partial<NodeType>): NodeType => ({
  description: {
    name,
    displayName: name,
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name },
    inputs: [],
    outputs: ['main'],
    properties: [],
  },
  ...extra,
});

const a3Package: NodePackage = {
  name: 'a3-tests',
  nodes: [
    binaryNode('a3.binaryPoll', {
      description: {
        name: 'a3.binaryPoll',
        displayName: 'Binary poll',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Binary poll' },
        inputs: [],
        outputs: ['main'],
        polling: true,
        properties: [],
      },
      async poll(ctx) {
        const data = await ctx.helpers.prepareBinaryData(
          Buffer.alloc(BIG, 1),
          'a.bin',
          'application/octet-stream',
        );
        polled.withItems++;
        return [[{ json: { n: polled.withItems }, binary: { data } }]];
      },
    }),
    binaryNode('a3.emptyPoll', {
      description: {
        name: 'a3.emptyPoll',
        displayName: 'Empty poll',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Empty poll' },
        inputs: [],
        outputs: ['main'],
        polling: true,
        properties: [],
      },
      async poll(ctx) {
        await ctx.helpers.prepareBinaryData(Buffer.alloc(BIG, 2), 'b.bin', 'application/octet-stream');
        polled.empty++;
        return null;
      },
    }),
    binaryNode('a3.binaryTrigger', {
      async trigger(ctx) {
        if (ctx.getMode() === 'manual') return {};
        const data = await ctx.helpers.prepareBinaryData(
          Buffer.alloc(BIG, 3),
          'c.bin',
          'application/octet-stream',
        );
        const timer = setTimeout(
          () => ctx.emit([[{ json: { fromTrigger: true }, binary: { data } } as Item]]),
          50,
        );
        return { closeFunction: async () => clearTimeout(timer) };
      },
    }),
    binaryNode('a3.hookRefuse', {
      description: {
        name: 'a3.hookRefuse',
        displayName: 'Refusing third-party trigger',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Refusing' },
        inputs: [],
        outputs: ['main'],
        properties: [],
        webhooks: [{ name: 'default', httpMethod: 'POST', path: 'events' }],
      },
      webhookMethods: {
        default: {
          async checkExists() {
            return false;
          },
          async create() {
            return false;
          },
          async delete() {
            return true;
          },
        },
      },
      async webhook(ctx) {
        return { workflowData: [[{ json: { event: ctx.getBodyData() } }]] };
      },
    }),
    binaryNode('a3.failTrigger', {
      async trigger() {
        throw new Error('trigger refused to start');
      },
    }),
  ],
  credentials: [],
};

let server: TestServer;
let baseUrl = '';

beforeAll(async () => {
  const config = testConfig();
  const ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, a3Package],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  const app = await buildApp(ctx);
  await app.ready();
  await ctx.startMain();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  server = {
    ctx,
    app,
    async close() {
      await app.close();
      await ctx.close();
    },
  };
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  hookRegistry.length = 0;
  polled.withItems = 0;
  polled.empty = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

const tenantDir = (tenantId: string) => path.join(server.ctx.config.binaryData.dir, tenantId);
const DAY = 86_400_000;
const EVERY_SECOND = { pollTimes: { item: [{ mode: 'everyX', unit: 'seconds', value: 1 }] } };

async function activate(client: Awaited<ReturnType<typeof signup>>['client'], id: string) {
  return client.data(client.post(`/rest/workflows/${id}/activate`));
}

async function finishAll(tenantId: string, workflowId: string) {
  for (const row of await executionsOf(server.ctx, tenantId, workflowId)) {
    await waitForExecution(server.ctx, tenantId, row.id, ['success', 'error']);
  }
}

describe('R21: binary data of activation-time contexts', () => {
  it('stores poll binaries in the execution directory so pruning removes them', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Poller', 'a3.binaryPoll', EVERY_SECOND)] });
    await activate(client, wf.id);
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id)).length >= 1, {
      timeout: 5000,
      message: 'a poll execution',
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    await new Promise((r) => setTimeout(r, 300));
    await finishAll(tenant.id, wf.id);

    const executions = await executionsOf(server.ctx, tenant.id, wf.id);
    const files = await filesUnder(tenantDir(tenant.id));
    expect(files.length).toBeGreaterThanOrEqual(executions.length);
    const ids = new Set(executions.map((e) => e.id));
    for (const file of files) expect(ids).toContain(path.basename(path.dirname(file)));

    await server.ctx.pruner.prune(new Date(Date.now() + 400 * DAY));
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);
    expect(await filesUnder(tenantDir(tenant.id))).toEqual([]);
  });

  it('removes the binaries of a poll that returns nothing', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Poller', 'a3.emptyPoll', EVERY_SECOND)] });
    await activate(client, wf.id);
    await waitFor(async () => polled.empty >= 1, { timeout: 5000, message: 'a poll' });
    await waitFor(async () => (await filesUnder(tenantDir(tenant.id))).length === 0, {
      timeout: 2000,
      message: 'the unused binary to be removed',
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('stores binaries emitted by trigger() in the execution directory', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Trigger', 'a3.binaryTrigger')] });
    await activate(client, wf.id);
    const run = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id))[0], {
      message: 'a trigger execution',
    });
    await waitForExecution(server.ctx, tenant.id, run.id, ['success']);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));

    const files = await filesUnder(tenantDir(tenant.id));
    expect(files).toHaveLength(1);
    expect(path.basename(path.dirname(files[0]))).toBe(run.id);

    await server.ctx.pruner.prune(new Date(Date.now() + 400 * DAY));
    expect(await filesUnder(tenantDir(tenant.id))).toEqual([]);
  });

  it('stores manual-run poll binaries in the execution directory and removes them with the workflow', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Poller', 'a3.binaryPoll', EVERY_SECOND)] });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const files = await filesUnder(tenantDir(tenant.id));
    expect(files).toHaveLength(1);
    expect(path.basename(path.dirname(files[0]))).toBe(executionId);

    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    await client.data(client.delete(`/rest/workflows/${wf.id}`));
    expect(await filesUnder(tenantDir(tenant.id))).toEqual([]);
  });

  it('sweeps old files of the shared activation directory when pruning', async () => {
    const { tenant } = await signup(server.app);
    const dir = path.join(tenantDir(tenant.id), 'activation');
    await mkdir(dir, { recursive: true });
    const old = path.join(dir, 'old');
    const fresh = path.join(dir, 'fresh');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    const past = new Date(Date.now() - 3 * DAY);
    await utimes(old, past, past);

    await server.ctx.pruner.prune();
    expect((await stat(fresh)).isFile()).toBe(true);
    expect(await filesUnder(dir)).toEqual([fresh]);
  });
});

interface Stream {
  ended: () => boolean;
  frames: string[];
  close: () => void;
}

async function openStream(cookie: string): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/rest/push`, { headers: { cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const frames: string[] = [];
  let done = false;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        frames.push(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      /* aborted */
    }
    done = true;
  })();
  await waitFor(async () => frames.join('').includes('event: connected'), { message: 'SSE connection' });
  return { ended: () => done, frames, close: () => controller.abort() };
}

async function invitedViewer(owner: Awaited<ReturnType<typeof signup>>) {
  const invite = await owner.client.data(
    owner.client.post('/rest/members/invite', { email: `viewer-${Date.now()}@example.com`, role: 'viewer' }),
  );
  const viewer = new TestClient(server.app);
  const accepted = await viewer.data(
    viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'Viewer', password: 'Passw0rd!' }),
  );
  return { viewer, userId: accepted.user.id as string };
}

describe('R39: push streams are re-validated', () => {
  it('ends the stream after the member is removed', async () => {
    const owner = await signup(server.app);
    const { viewer, userId } = await invitedViewer(owner);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = await openStream(viewer.cookie!);
    try {
      await owner.client.data(owner.client.delete(`/rest/members/${userId}`));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await waitFor(async () => stream.ended(), { message: 'the stream to end' });
    } finally {
      stream.close();
    }
  });

  it('ends the stream after logout', async () => {
    const owner = await signup(server.app);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = await openStream(owner.client.cookie!);
    try {
      await owner.client.data(owner.client.post('/rest/auth/logout'));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await waitFor(async () => stream.ended(), { message: 'the stream to end' });
    } finally {
      stream.close();
    }
  });

  it('keeps a valid stream open and pings it', async () => {
    const owner = await signup(server.app);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = await openStream(owner.client.cookie!);
    try {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await waitFor(async () => stream.frames.join('').includes('event: ping'), { message: 'a ping' });
      expect(stream.ended()).toBe(false);
    } finally {
      stream.close();
    }
  });
});

const hookNode = (parameters: Record<string, unknown> = {}) =>
  node('Remote', 'test.hookRegister', parameters, [0, 0], { webhookId: 'remote-hook' });
const plainWebhook = () =>
  node('Webhook', 'core.webhook', { httpMethod: 'POST', path: 'plain' }, [200, 0], { webhookId: 'plain-id' });

describe('R41: third-party webhooks on publish (P3-10: a save writes the draft only)', () => {
  /** save a draft; nothing is registered or removed until it is published */
  async function saveDraft(
    client: Awaited<ReturnType<typeof signup>>['client'],
    id: string,
    nodes: unknown[],
  ) {
    const current = await client.data(client.get(`/rest/workflows/${id}`));
    const saved = await client.data(
      client.patch(`/rest/workflows/${id}`, { versionId: current.versionId, nodes }),
    );
    expect(saved.active).toBe(true);
    expect(saved.publishedVersionId).toBe(current.publishedVersionId);
    return saved;
  }

  it('unregisters the hooks of a removed third-party node when the draft is published', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode(), plainWebhook()] });
    await activate(client, wf.id);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create']);
    await saveDraft(client, wf.id, [plainWebhook()]);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create']);
    const published = await activate(client, wf.id);
    expect(published.active).toBe(true);
    expect(hookRegistry).toEqual([
      { action: 'create', url: `http://localhost:5678/webhook/${tenant.slug}/remote-hook/events` },
      { action: 'delete', url: `http://localhost:5678/webhook/${tenant.slug}/remote-hook/events` },
    ]);
  });

  it('re-registers a third-party node whose settings changed when the draft is published', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode({ note: 'a' })] });
    await activate(client, wf.id);
    await saveDraft(client, wf.id, [hookNode({ note: 'b' })]);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create']);
    await activate(client, wf.id);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create', 'delete', 'create']);
  });

  it('unregisters the hooks created by an activation that fails afterwards', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode(), node('Broken', 'a3.failTrigger')] });
    const res = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(400);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create', 'delete']);
  });

  it('restores the published version and its hooks when publishing a draft fails afterwards', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode()] });
    await activate(client, wf.id);
    await saveDraft(client, wf.id, [hookNode({ note: 'b' }), node('Broken', 'a3.failTrigger')]);
    const res = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('activation_failed');
    // the new hook goes, the old one is registered again and stays published
    expect(hookRegistry.map((h) => h.action)).toEqual(['create', 'delete', 'create', 'delete', 'create']);
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    expect(row).toMatchObject({ active: true, publishedVersionId: wf.versionId });
    expect((await server.ctx.repos.webhooks.listForWorkflow(tenant.id, wf.id)).length).toBe(1);
  });

  it('keeps the published version and its hooks when the draft fails validation', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode()] });
    await activate(client, wf.id);
    await saveDraft(client, wf.id, [node('Noop', 'core.noOp')]);
    const res = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(400);
    expect(hookRegistry).toEqual([
      { action: 'create', url: `http://localhost:5678/webhook/${tenant.slug}/remote-hook/events` },
    ]);
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    expect(row).toMatchObject({ active: true, publishedVersionId: wf.versionId });
  });
});

describe('R49: listen for test event with webhookMethods', () => {
  it('registers the test URL with the provider and removes it when the listener expires', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode()] });
    // capture the expiry timer instead of waiting two minutes for it
    const expiry: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== TEST_WEBHOOK_TTL_MS) return realSetTimeout(fn, ms);
      expiry.push(fn);
      return realSetTimeout(() => {}, 0);
    }) as unknown as typeof setTimeout);
    const listen = await client.data(
      client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Remote' }),
    );
    const testUrl = `http://localhost:5678/webhook-test/${tenant.slug}/remote-hook/events`;
    expect(listen.testUrl).toBe(testUrl);
    expect(hookRegistry).toEqual([{ action: 'create', url: testUrl }]);

    expect(expiry).toHaveLength(1);
    expiry[0]();
    await waitFor(async () => hookRegistry.length === 2, { message: 'the test hook to be removed' });
    expect(hookRegistry).toEqual([
      { action: 'create', url: testUrl },
      { action: 'delete', url: testUrl },
    ]);
  });

  it('removes the previous registration when the same node is listened to again', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode()] });
    for (let i = 0; i < 2; i++) {
      await client.data(client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Remote' }));
    }
    expect(hookRegistry.map((h) => h.action)).toEqual(['create', 'delete', 'create']);
  });

  it('refuses to listen on a third-party trigger of an active workflow', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [hookNode()] });
    await activate(client, wf.id);
    const res = await client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Remote' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(
      'Deactivate the workflow to listen for test events on this trigger',
    );
    expect(hookRegistry.map((h) => h.action)).toEqual(['create']);
    expect(await server.ctx.testWebhooks.list(tenant.id)).toEqual([]);
  });

  it('still listens on a plain webhook of an active workflow', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [plainWebhook()] });
    await activate(client, wf.id);
    const res = await client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Webhook' });
    expect(res.statusCode).toBe(200);
  });

  it('answers 400 when the provider refuses the registration', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Refusing', 'a3.hookRefuse')] });
    const res = await client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Refusing' });
    expect(res.statusCode).toBe(400);
    expect(await server.ctx.testWebhooks.list(tenant.id)).toEqual([]);
  });
});
