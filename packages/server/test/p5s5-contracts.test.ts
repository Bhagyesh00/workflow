/**
 * Phase 5 S5 contract step C0e: the Assistant's server wiring. Env defaults, the on/off gate,
 * `features.assistant`, the five route files (401 signed out, 404 while off, 403 by role), the moved
 * `/node-types/options` (`loadNodeOptions`), the context's Assistant services and test seam, the two
 * leader timers (fake clock, spies), and C0c's FULL run helper: `runAndCollect` (mode `manual`, no
 * `workflowId`, `waiting`, timeout), `previewOutput` and `triggerPinData`.
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { NodePackage, NodeType, RunData, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ASSISTANT_SWEEP_INTERVAL_MS, startAssistantTimers } from '../src/context';
import type { TenantRow, UserRow } from '../src/db/schema';
import {
  previewOutput,
  type RunOutcome,
  runAndCollect,
  TRIGGER_PIN_KINDS,
  triggerPinData,
} from '../src/services/assistant/run-helper';
import { effectiveAssistantSettings } from '../src/services/assistant/settings';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { loadNodeOptions, nodeOptionsSchema } from '../src/services/node-options';
import {
  chain,
  createTestServer,
  node,
  ORIGIN,
  setNode,
  signup,
  TestClient,
  type TestServer,
  testConfig,
  waitFor,
} from './helpers';

const optionsNode: NodeType = {
  description: {
    name: 'test.p5s5Options',
    displayName: 'Options',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Options' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'Prefix', name: 'prefix', type: 'string', default: 'c' }],
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
  methods: {
    loadOptions: {
      async colors(ctx) {
        const prefix = String(ctx.getCurrentNodeParameter('prefix') ?? '');
        return [
          { name: `${prefix}-red`, value: 'red' },
          { name: `${prefix}-blue`, value: 'blue' },
        ];
      },
    },
    listSearch: {
      async workflows(ctx, filter) {
        const page = await ctx.listWorkflows?.({ filter });
        return { results: (page?.workflows ?? []).map((w) => ({ name: w.name, value: w.id })) };
      },
    },
  },
};

const optionsPackage: NodePackage = { name: 'p5s5-contracts', nodes: [optionsNode], credentials: [] };

const echoTool: AssistantToolDefinition = {
  name: 'harness_echo',
  description: 'Echo the input (test seam)',
  input: z.object({ text: z.string() }),
  minRole: 'viewer',
  async handler(_ctx, _run, input) {
    return input;
  },
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    {},
    { nodePackages: [nodesAiPackage, optionsPackage], assistantTools: [echoTool] },
  );
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function inviteMember(owner: Awaited<ReturnType<typeof signup>>, role: 'admin' | 'editor' | 'viewer') {
  const invite = await owner.client.data<{ token: string }>(
    owner.client.post('/rest/members/invite', {
      email: `${role}-${Date.now()}-${Math.random()}@example.com`,
      role,
    }),
  );
  const client = new TestClient(server.app, ORIGIN);
  const accepted = await client.data<{ user: { id: string } }>(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: role, password: 'Passw0rd!' }),
  );
  return { client, userId: accepted.user.id };
}

async function saveAssistant(tenantId: string, assistant: Record<string, unknown> | undefined) {
  const row = await server.ctx.repos.tenants.get(tenantId);
  await server.ctx.repos.tenants.updateSettings(tenantId, { ...(row?.settings ?? {}), assistant });
}

async function scopeOf(owner: Awaited<ReturnType<typeof signup>>, signal = new AbortController().signal) {
  const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id)) as TenantRow;
  const user = (await server.ctx.repos.users.get(owner.user.id)) as UserRow;
  return { tenant, user, signal };
}

describe('config and the on/off gate', () => {
  it('has the INSTANCE_AI defaults', () => {
    expect(testConfig().assistant).toMatchObject({
      enabled: undefined,
      confirmationTimeoutMs: 86_400_000,
      threadTtlDays: 30,
      pruneIntervalMs: 3_600_000,
      maxConcurrentRuns: -1,
      maxConcurrentRunsPerUser: -1,
    });
    expect(testConfig({ INSTANCE_AI_PRUNE_INTERVAL: '0' }).assistant.pruneIntervalMs).toBe(0);
  });

  it('is on when unset, a saved false wins, INSTANCE_AI_ENABLED=false applies with no saved choice', () => {
    const on = testConfig();
    const off = testConfig({ INSTANCE_AI_ENABLED: 'false' });
    expect(effectiveAssistantSettings(on, {}).enabled).toBe(true);
    expect(effectiveAssistantSettings(on, null).enabled).toBe(true);
    expect(effectiveAssistantSettings(on, { assistant: { enabled: false } }).enabled).toBe(false);
    expect(effectiveAssistantSettings(off, {}).enabled).toBe(false);
    expect(effectiveAssistantSettings(off, { assistant: { enabled: true } }).enabled).toBe(true);
    expect(
      effectiveAssistantSettings(testConfig({ INSTANCE_AI_ENABLED: 'true' }), {
        assistant: { enabled: false },
      }).enabled,
    ).toBe(false);
  });

  it('does not read AI_ENABLED', () => {
    for (const value of ['true', 'false']) {
      const config = testConfig({ AI_ENABLED: value });
      expect(effectiveAssistantSettings(config, {}).enabled).toBe(true);
      expect(effectiveAssistantSettings(config, { assistant: { enabled: false } }).enabled).toBe(false);
    }
  });
});

describe('features.assistant', () => {
  it('shows on/off and modelSet, never a credential id', async () => {
    const owner = await signup(server.app);
    const credential = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', {
        name: 'Model',
        type: 'openAiApi',
        data: { apiKey: 'sk-test-0000000000000000000000' },
      }),
    );
    const features = async () =>
      (await owner.client.data<{ features: Record<string, unknown> }>(owner.client.get('/rest/settings')))
        .features;

    expect((await features()).assistant).toEqual({ enabled: true, modelSet: false });
    // S4's builder feature is still there beside it
    expect((await features()).aiBuilder).toBeDefined();

    await saveAssistant(owner.tenant.id, {
      credentialId: credential.id,
      nodeType: 'ai.lmChatOpenAi',
      model: 'gpt-4o-mini',
    });
    const set = await features();
    expect(set.assistant).toEqual({ enabled: true, modelSet: true });
    expect(JSON.stringify(set.assistant)).not.toContain(credential.id);

    await saveAssistant(owner.tenant.id, { credentialId: credential.id, nodeType: 'core.set', model: 'x' });
    expect((await features()).assistant).toEqual({ enabled: true, modelSet: false });

    await saveAssistant(owner.tenant.id, { enabled: false });
    expect((await features()).assistant).toEqual({ enabled: false, modelSet: false });

    // signed out: the instance default, no tenant
    const anonymous = await server.app.inject({ url: '/rest/settings' });
    expect(anonymous.json().data.features.assistant).toEqual({ enabled: true, modelSet: false });
  });
});

describe('the Assistant routes', () => {
  it('answer 401 signed out in every route file', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const anonymous = new TestClient(server.app);
    for (const [method, url] of [
      ['GET', '/rest/assistant/threads'],
      ['POST', `/rest/assistant/chat/${id}`],
      ['GET', `/rest/assistant/events/${id}`],
      ['POST', `/rest/assistant/confirm/${id}`],
      ['GET', `/rest/assistant/threads/${id}/drafts/${id}`],
      ['GET', '/rest/assistant/settings'],
      ['GET', '/rest/assistant/mcp-connections'],
    ] as const) {
      const res = await anonymous.request(method, url, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('answer 404 while off and 403 below the role', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const owner = await signup(server.app);
    const viewer = await inviteMember(owner, 'viewer');
    const editor = await inviteMember(owner, 'editor');

    // drafts: accept and discard are editor
    const accept = await viewer.client.post(`/rest/assistant/threads/${id}/drafts/${id}/accept`, {});
    expect(accept.statusCode).toBe(403);
    const discard = await viewer.client.post(`/rest/assistant/threads/${id}/drafts/${id}/discard`, {});
    expect(discard.statusCode).toBe(403);
    // settings are admin
    expect((await viewer.client.get('/rest/assistant/settings')).statusCode).toBe(403);
    expect((await editor.client.patch('/rest/assistant/settings', { enabled: false })).statusCode).toBe(403);
    // MCP: 404 while MCP access is off, then admin for changes
    expect((await owner.client.get('/rest/assistant/mcp-connections')).statusCode).toBe(404);
    await saveAssistant(owner.tenant.id, { mcpAccessEnabled: true });
    expect((await viewer.client.post('/rest/assistant/mcp-connections', {})).statusCode).toBe(403);
    expect((await editor.client.delete(`/rest/assistant/mcp-connections/${id}`)).statusCode).toBe(403);

    // off for the workspace: threads, chat, confirm and drafts are 404 before the role check
    await saveAssistant(owner.tenant.id, { enabled: false });
    expect((await owner.client.get('/rest/assistant/threads')).statusCode).toBe(404);
    expect((await viewer.client.post(`/rest/assistant/chat/${id}`, { message: 'hi' })).statusCode).toBe(404);
    expect((await viewer.client.post(`/rest/assistant/confirm/${id}`, {})).statusCode).toBe(404);
    expect(
      (await viewer.client.post(`/rest/assistant/threads/${id}/drafts/${id}/accept`, {})).statusCode,
    ).toBe(404);
    // the settings route stays reachable for the viewer's 403 (an admin turns it back on there)
    expect((await viewer.client.get('/rest/assistant/settings')).statusCode).toBe(403);
  });
});

describe('POST /rest/node-types/options (moved to services/node-options.ts)', () => {
  it('still answers through the route', async () => {
    const owner = await signup(server.app);
    const viewer = await inviteMember(owner, 'viewer');
    const body = {
      nodeType: 'test.p5s5Options',
      method: 'colors',
      kind: 'loadOptions',
      node: node('Options', 'test.p5s5Options', { prefix: 'x' }),
    };
    const colors = await owner.client.data(owner.client.post('/rest/node-types/options', body));
    expect(colors).toEqual([
      { name: 'x-red', value: 'red' },
      { name: 'x-blue', value: 'blue' },
    ]);
    expect((await viewer.client.post('/rest/node-types/options', body)).statusCode).toBe(403);
    const unknown = await owner.client.post('/rest/node-types/options', { ...body, nodeType: 'test.nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('Unknown node type "test.nope"');
    const bad = await owner.client.post('/rest/node-types/options', { ...body, kind: 'nope' });
    expect(bad.statusCode).toBe(400);
  });

  it("is callable from a service with the caller's tenant (L6)", async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    await owner.client.data(
      owner.client.post('/rest/workflows', { name: 'Mine', nodes: [], connections: {} }),
    );
    await other.client.data(
      other.client.post('/rest/workflows', { name: 'Theirs', nodes: [], connections: {} }),
    );
    const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id)) as TenantRow;
    const user = (await server.ctx.repos.users.get(owner.user.id)) as UserRow;
    const auth = { tenant, user, role: 'owner' } as unknown as Parameters<typeof loadNodeOptions>[1];
    const result = (await loadNodeOptions(server.ctx, auth, {
      nodeType: 'test.p5s5Options',
      method: 'workflows',
      kind: 'listSearch',
      node: node('Options', 'test.p5s5Options'),
    })) as { results: Array<{ name: string }> };
    expect(result.results.map((r) => r.name)).toEqual(['Mine']);
    expect(nodeOptionsSchema.safeParse({ nodeType: 'x' }).success).toBe(false);
  });
});

describe('the context', () => {
  it('holds the Assistant services and passes the test seam', async () => {
    const { ctx } = server;
    expect(ctx.assistant.extraTools).toEqual([echoTool]);
    expect(ctx.assistantApprovals).toBeDefined();
    expect(ctx.assistantDrafts).toBeDefined();
    const owner = await signup(server.app);
    const tenant = (await ctx.repos.tenants.get(owner.tenant.id)) as TenantRow;
    const settings = await ctx.assistantSettings.read(tenant);
    expect(settings).toMatchObject({ enabled: true, modelSet: false, mcpAccessEnabled: false });
    // C0 gate: a tool with no permission proceeds, a write tool is refused until L3
    const scope = { ...(await scopeOf(owner)), settings } as never;
    expect(await ctx.assistantApprovals.gate(scope, echoTool, { text: 'x' }, 'call_1')).toEqual({
      decision: 'proceed',
    });
  });

  it('runs the sweep at leader start and stops the timers in close', async () => {
    const own = await createTestServer(
      { INSTANCE_AI_PRUNE_INTERVAL: '0' },
      { startMain: false, reset: false },
    );
    try {
      const sweep = vi.spyOn(own.ctx.assistant, 'sweep');
      const prune = vi.spyOn(own.ctx.assistant, 'pruneThreads');
      const close = vi.spyOn(own.ctx.assistant, 'close');
      await own.ctx.startMain();
      await waitFor(async () => sweep.mock.calls.length >= 1, { message: 'the first sweep' });
      expect(sweep.mock.calls[0][0]).toBeInstanceOf(Date);
      expect(prune).not.toHaveBeenCalled();
      await own.ctx.close();
      expect(close).toHaveBeenCalledTimes(1);
      const after = sweep.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sweep.mock.calls.length).toBe(after);
    } finally {
      await own.close();
    }
  });
});

describe('the leader timers (fake clock)', () => {
  const logger = { warn: vi.fn() };

  it('with INSTANCE_AI_PRUNE_INTERVAL=0 the 30 s sweep ticks and pruneThreads never does', async () => {
    vi.useFakeTimers();
    const assistant = { sweep: vi.fn(async () => {}), pruneThreads: vi.fn(async () => {}) };
    const pruneIntervalMs = testConfig({ INSTANCE_AI_PRUNE_INTERVAL: '0' }).assistant.pruneIntervalMs;
    const timers = startAssistantTimers(assistant, { pruneIntervalMs, logger });
    expect(ASSISTANT_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(assistant.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(assistant.sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(assistant.sweep).toHaveBeenCalledTimes(2 + 360);
    expect(assistant.pruneThreads).not.toHaveBeenCalled();
    await timers.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(assistant.sweep).toHaveBeenCalledTimes(362);
  });

  it('prunes at the configured interval, never overlaps a slow run and logs errors', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const assistant = {
      sweep: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
      pruneThreads: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const warn = vi.fn();
    const timers = startAssistantTimers(assistant, {
      pruneIntervalMs: testConfig().assistant.pruneIntervalMs,
      logger: { warn },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    // the first sweep still runs: the ticks are skipped
    expect(assistant.sweep).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(assistant.sweep).toHaveBeenCalledTimes(2);
    release();
    expect(assistant.pruneThreads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(assistant.pruneThreads).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Assistant thread pruning failed');
    release();
    await timers.stop();
  });
});

describe('runAndCollect', () => {
  it('runs a one-node definition with no workflowId in mode manual', async () => {
    const owner = await signup(server.app);
    const run = await scopeOf(owner);
    const outcome = await runAndCollect(
      server.ctx,
      run,
      { workflow: { name: 'Draft', nodes: [setNode('Set', 'greeting', 'hello', [0, 0])], connections: {} } },
      10_000,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.aborted).toBe(false);
    expect(outcome.lastNodeExecuted).toBe('Set');
    expect(outcome.runData.Set?.[0]?.data?.main?.[0]?.[0]?.json).toMatchObject({ greeting: 'hello' });
    const row = await server.ctx.repos.executions.get(owner.tenant.id, outcome.executionId);
    expect(row?.mode).toBe('manual');
    expect(row?.workflowId ?? null).toBeNull();
  });

  it('reports a parked run as waiting and stops one past its timeout', async () => {
    const owner = await signup(server.app);
    const waiting = await runAndCollect(
      server.ctx,
      await scopeOf(owner),
      {
        workflow: {
          name: 'Parks',
          nodes: [
            node('Start', 'core.manualTrigger'),
            node('Wait', 'test.wait', { ms: 3_600_000 }, [200, 0]),
          ],
          connections: chain('Start', 'Wait'),
        },
      },
      10_000,
    );
    expect(waiting.status).toBe('waiting');

    const started = Date.now();
    const slow = await runAndCollect(
      server.ctx,
      await scopeOf(owner),
      {
        workflow: {
          name: 'Slow',
          nodes: [node('Start', 'core.manualTrigger'), node('Sleep', 'test.sleep', { ms: 20_000 }, [200, 0])],
          connections: chain('Start', 'Sleep'),
        },
      },
      300,
    );
    expect(slow.status).toBe('timedOut');
    expect(slow.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runAndCollect(
        server.ctx,
        await scopeOf(owner, controller.signal),
        { workflow: { name: 'x', nodes: [], connections: {} } },
        1000,
      ),
    ).rejects.toThrow();
  });
});

describe('previewOutput', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';
  const outcome: RunOutcome = {
    executionId: 'exec-1',
    status: 'success',
    aborted: false,
    lastNodeExecuted: 'Fetch',
    runData: {
      Fetch: [
        {
          startTime: 0,
          executionTime: 1,
          executionStatus: 'success',
          source: [],
          data: {
            main: [
              [
                { json: { name: 'Ann', token: secret } },
                { json: { name: 'Bob' } },
                { json: { name: 'Cid' } },
                { json: { name: 'Dee' } },
                {
                  json: { name: 'Eve' },
                  binary: { data: { data: 'AAAA', mimeType: 'text/plain', fileName: 'a.txt', fileSize: 4 } },
                },
              ],
            ],
          },
        },
      ],
    } as unknown as RunData,
  };

  it('keeps a secret-shaped value out and shows at most 3 items', () => {
    const text = previewOutput(outcome, true);
    expect(text).toContain('source="execution-output"');
    expect(text).not.toContain(secret);
    expect(text).toContain('[redacted]');
    expect(text).toContain('Ann');
    expect(text).not.toContain('Dee');
    expect(text).toContain('"itemCount":5');
  });

  it('suppresses items when sendValues is false', () => {
    const text = previewOutput(outcome, false);
    expect(text).not.toContain('Ann');
    expect(text).not.toContain(secret);
    expect(text).toContain('"itemCount":5');
    expect(text).toContain('hidden');
  });
});

describe('triggerPinData', () => {
  const definition: WorkflowDefinition = {
    name: 'Triggers',
    nodes: [
      node('Form', 'core.formTrigger'),
      node('Hook', 'core.webhook'),
      node('Chat', 'ai.chatTrigger'),
      node('Schedule', 'core.scheduleTrigger'),
      node('Manual', 'core.manualTrigger'),
    ],
    connections: {},
    settings: { timezone: 'Europe/Berlin' },
  };

  it("builds each trigger's items", () => {
    expect(Object.keys(TRIGGER_PIN_KINDS).sort()).toEqual(
      ['ai.chatTrigger', 'core.formTrigger', 'core.scheduleTrigger', 'core.webhook'].sort(),
    );
    const form = triggerPinData(definition, 'Form', { email: 'a@b.c' }).Form[0].json;
    expect(form).toMatchObject({ email: 'a@b.c', formMode: 'test' });
    expect(typeof form.submittedAt).toBe('string');

    const hook = triggerPinData(definition, 'Hook', { id: 7 }).Hook[0].json;
    expect(hook).toMatchObject({
      body: { id: 7 },
      headers: {},
      query: {},
      params: {},
      executionMode: 'test',
    });
    const envelope = triggerPinData(definition, 'Hook', { query: { q: '1' }, body: { a: 1 } }).Hook[0].json;
    expect(envelope).toMatchObject({ query: { q: '1' }, body: { a: 1 } });

    const chat = triggerPinData(definition, 'Chat', 'hello').Chat[0].json;
    expect(chat).toMatchObject({ action: 'sendMessage', chatInput: 'hello' });
    expect(typeof chat.sessionId).toBe('string');

    const schedule = triggerPinData(definition, 'Schedule').Schedule[0].json;
    expect(schedule).toHaveProperty('Readable date');
    expect(String(schedule.Timezone)).toContain('Europe/Berlin');

    expect(triggerPinData(definition, 'Manual', [{ a: 1 }, { a: 2 }]).Manual.map((i) => i.json)).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    expect(triggerPinData(definition, 'Manual').Manual).toEqual([{ json: {} }]);
    expect(() => triggerPinData(definition, 'Missing')).toThrow(/Missing/);
  });
});
