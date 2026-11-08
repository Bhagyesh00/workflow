/**
 * P5-09 AI workflow builder, the full flow on the local fake LLM (OpenAI-compatible credential pointed
 * at 127.0.0.1, scripted tool calls; no real key). A prompt builds a draft through the builder tools,
 * the chunks stream as NDJSON, the draft passes the builder lint and runs through `POST /run` with
 * `workflowData`, and the workflow row is unchanged before Accept. The seams run in their order before
 * the model call (plan.ts, web-fetch.ts and compaction.ts are spied on).
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import { type BuilderChunk, lintForBuilder, type WorkflowDefinition } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeCompact } from '../src/services/ai-builder/compaction';
import { applyPlanResume, planTools } from '../src/services/ai-builder/plan';
import { applyWebFetchResume, webFetchTools } from '../src/services/ai-builder/web-fetch';
import { type FakeLlm, type FakeLlmStep, startFakeLlm } from './fakes/fake-llm';
import {
  createTestServer,
  createWorkflow,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

vi.mock('../src/services/ai-builder/plan', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/ai-builder/plan')>();
  return { ...real, planTools: vi.fn(real.planTools), applyPlanResume: vi.fn(real.applyPlanResume) };
});
vi.mock('../src/services/ai-builder/web-fetch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/ai-builder/web-fetch')>();
  return {
    ...real,
    webFetchTools: vi.fn(real.webFetchTools),
    applyWebFetchResume: vi.fn(real.applyWebFetchResume),
  };
});
vi.mock('../src/services/ai-builder/compaction', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/ai-builder/compaction')>();
  return { ...real, maybeCompact: vi.fn(real.maybeCompact) };
});

let server: TestServer;
let fake: FakeLlm | undefined;

beforeAll(async () => {
  server = await createTestServer({ AI_ENABLED: 'true' }, { nodePackages: [nodesAiPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  vi.clearAllMocks();
});

/** an owner with the fake LLM as the workspace's builder model, and an empty workflow */
async function setup(script: FakeLlmStep[]) {
  fake = await startFakeLlm(script);
  const owner = await signup(server.app);
  const credential = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/credentials', {
      name: 'Builder model',
      type: 'openAiApi',
      data: { apiKey: 'sk-test-builder-key-000000000000', baseUrl: fake.baseUrl },
    }),
  );
  await owner.client.data(
    owner.client.patch('/rest/settings', {
      ai: { credentialId: credential.id, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' },
    }),
  );
  const workflow = await createWorkflow(owner.client, { name: 'Draft target', nodes: [] });
  return { owner, workflow };
}

async function build(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/rest/ai/build', body);
  const chunks =
    res.statusCode === 200
      ? res.body
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as BuilderChunk)
      : [];
  return { res, chunks };
}

const lastDraft = (chunks: BuilderChunk[]): WorkflowDefinition | undefined =>
  chunks.filter((c) => c.type === 'workflow-updated').at(-1)?.workflow;

const toolNames = (request: unknown): string[] =>
  ((request as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
    (t) => t.function?.name ?? '',
  );

const SET_PARAMETERS = {
  mode: 'manual',
  assignments: { assignments: [{ id: 'a1', name: 'greeting', value: 'hello', type: 'string' }] },
};

const BUILD_SCRIPT: FakeLlmStep[] = [
  {
    text: 'Let me look.',
    toolCalls: [{ name: 'search_nodes', arguments: { queries: ['manual trigger', 'edit fields set'] } }],
  },
  {
    toolCalls: [
      {
        name: 'add_nodes',
        arguments: {
          nodes: [
            { type: 'core.manualTrigger', name: 'Start' },
            { type: 'core.set', name: 'Greet', parameters: SET_PARAMETERS },
          ],
        },
      },
    ],
  },
  { toolCalls: [{ name: 'connect_nodes', arguments: { items: [{ from: 'Start', to: 'Greet' }] } }] },
  { toolCalls: [{ name: 'validate_workflow', arguments: {} }] },
  { text: 'Done: Start runs Greet, which sets a greeting.' },
];

describe('POST /rest/ai/build: full flow', () => {
  it('streams the turn, builds a draft that passes the lint and runs, and saves nothing before Accept', async () => {
    const { owner, workflow } = await setup(BUILD_SCRIPT);
    const before = await owner.client.data(owner.client.get(`/rest/workflows/${workflow.id}`));

    const { res, chunks } = await build(owner.client, { workflowId: workflow.id, text: 'Greet the world' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);

    // progress for every tool, a delta per streamed piece
    const tools = chunks.filter((c) => c.type === 'tool');
    for (const name of ['search_nodes', 'add_nodes', 'connect_nodes', 'validate_workflow']) {
      expect(tools).toContainEqual({ type: 'tool', toolName: name, status: 'running' });
      expect(tools).toContainEqual({ type: 'tool', toolName: name, status: 'done' });
    }
    const messages = chunks.filter((c) => c.type === 'message');
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((m) => m.type === 'message' && m.delta === true)).toBe(true);
    expect(messages.map((m) => (m.type === 'message' ? m.text : '')).join('')).toContain(
      'Done: Start runs Greet',
    );
    expect(new Set(messages.map((m) => (m.type === 'message' ? m.id : ''))).size).toBe(1);

    // the draft: two nodes with server-made ids, connected, passing the builder lint
    const draft = lastDraft(chunks)!;
    expect(draft.nodes.map((n) => n.name)).toEqual(['Start', 'Greet']);
    expect(draft.nodes.every((n) => /^[0-9a-f-]{36}$/.test(n.id))).toBe(true);
    expect(draft.connections.Start.main?.[0]?.[0]).toMatchObject({ node: 'Greet', index: 0 });
    const issues = lintForBuilder(draft, { get: (t) => server.ctx.registries.nodeTypes.get(t)?.description });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    // validate_workflow told the model it was valid
    const validated = JSON.stringify(fake!.requests[4]);
    expect(validated).toContain('The draft is valid.');

    // nothing saved: same version, same (empty) nodes
    const after = await owner.client.data(owner.client.get(`/rest/workflows/${workflow.id}`));
    expect(after.versionId).toBe(before.versionId);
    expect(after.nodes).toEqual([]);

    // the draft runs as unsaved workflow data
    const run = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${workflow.id}/run`, {
        workflowData: { name: draft.name, nodes: draft.nodes, connections: draft.connections },
      }),
    );
    const execution = await waitForExecution(server.ctx, owner.tenant.id, run.executionId);
    expect(execution.status).toBe('success');

    // the session holds the user's message and the reply
    const session = await server.ctx.repos.builderSessions.get(owner.tenant.id, workflow.id, owner.user.id);
    expect(session?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(session?.messages[0].text).toBe('Greet the world');
    expect(session?.messages[1].text).toContain('Done: Start runs Greet');
  });

  it('starts from the unsaved workflowData and sends the earlier conversation next time', async () => {
    const { owner, workflow } = await setup([{ text: 'First answer' }, { text: 'Second answer' }]);
    const workflowData = {
      name: 'Draft target',
      nodes: [
        {
          id: 'n1',
          name: 'Kick',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };
    await build(owner.client, { workflowId: workflow.id, text: 'Hello builder', workflowData });
    expect(JSON.stringify(fake!.requests[0])).toContain('Kick');
    await build(owner.client, { workflowId: workflow.id, text: 'And again' });
    const second = fake!.requests[1] as { messages: Array<{ role: string; content: unknown }> };
    const roles = second.messages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(second.messages.some((m) => m.role === 'assistant' && m.content === 'First answer')).toBe(true);
    expect(second.messages.some((m) => m.role === 'user' && m.content === 'Hello builder')).toBe(true);
    // the saved row has no Kick: the unsaved data stayed unsaved
    const after = await owner.client.data(owner.client.get(`/rest/workflows/${workflow.id}`));
    expect(after.nodes).toEqual([]);
  });

  it('refuses without a model in Settings', async () => {
    const owner = await signup(server.app);
    const workflow = await createWorkflow(owner.client, { nodes: [] });
    const { res, chunks } = await build(owner.client, { workflowId: workflow.id, text: 'Hi' });
    expect(res.statusCode).toBe(200);
    expect(chunks).toEqual([
      { type: 'error', title: 'Workflow update failed', message: 'Set an AI model in Settings first' },
    ]);
  });

  it('usage-settings writes allowSendingParameterValues (admin)', async () => {
    const { owner } = await setup([]);
    const res = await owner.client.data(
      owner.client.post('/rest/ai/usage-settings', { allowSendingParameterValues: false }),
    );
    expect(res).toEqual({ allowSendingParameterValues: false });
    const settings = await owner.client.data(owner.client.get('/rest/settings'));
    expect(settings.ai.allowSendingParameterValues).toBe(false);
  });
});

describe('seams', () => {
  it('run in order before the model call; mode is read after them and promptNotes reach the model', async () => {
    const { owner, workflow } = await setup([{ text: 'ok' }]);
    const order: string[] = [];
    vi.mocked(applyPlanResume).mockImplementationOnce((state) => {
      order.push('plan');
      // an approved plan moves the turn to build mode
      state.mode = 'build';
      state.promptNotes.push('NOTE-FROM-PLAN-SEAM');
    });
    vi.mocked(applyWebFetchResume).mockImplementationOnce(async () => {
      order.push('web-fetch');
    });
    vi.mocked(maybeCompact).mockImplementationOnce(async () => {
      order.push('compact');
    });
    const resumeData = { planDecision: 'approve' };
    const { chunks } = await build(owner.client, {
      workflowId: workflow.id,
      text: 'Go',
      mode: 'plan',
      resumeData,
    });
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
    expect(order).toEqual(['plan', 'web-fetch', 'compact']);
    expect(vi.mocked(applyPlanResume).mock.calls[0][1]).toEqual(resumeData);
    expect(vi.mocked(applyWebFetchResume).mock.calls[0][1]).toEqual(resumeData);
    // build mode after the seam: edit tools offered, planTools never asked
    expect(toolNames(fake!.requests[0])).toContain('add_nodes');
    expect(planTools).not.toHaveBeenCalled();
    expect(webFetchTools).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fake!.requests[0])).toContain('NOTE-FROM-PLAN-SEAM');
  });

  it('a seam that stops the turn ends it before any model call, with no error chunk', async () => {
    const { owner, workflow } = await setup([{ text: 'never' }]);
    vi.mocked(applyPlanResume).mockImplementationOnce((state) => state.stopTurn());
    const { res, chunks } = await build(owner.client, { workflowId: workflow.id, text: 'Stop early' });
    expect(res.statusCode).toBe(200);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
    expect(fake!.requests).toEqual([]);
    expect(maybeCompact).not.toHaveBeenCalled();
    const session = await server.ctx.repos.builderSessions.get(owner.tenant.id, workflow.id, owner.user.id);
    expect(session?.messages.map((m) => m.text)).toEqual(['Stop early']);
  });

  it('a tool that calls stopTurn ends the turn cleanly and the turn is saved', async () => {
    const { owner, workflow } = await setup([
      { toolCalls: [{ name: 'stop_here', arguments: {} }] },
      { text: 'never asked' },
    ]);
    vi.mocked(webFetchTools).mockImplementationOnce((state) => [
      {
        kind: 'tool',
        name: 'stop_here',
        description: 'stops the turn',
        parameters: { type: 'object', properties: {} },
        async invoke() {
          state.session.messages.push({
            id: 'q1',
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString(),
            questions: [{ id: 'k', question: 'Which channel?', type: 'text' }],
          });
          state.stopTurn();
          return 'stopped';
        },
      },
    ]);
    const { chunks } = await build(owner.client, { workflowId: workflow.id, text: 'Post to chat' });
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
    expect(fake!.requests).toHaveLength(1);
    const session = await server.ctx.repos.builderSessions.get(owner.tenant.id, workflow.id, owner.user.id);
    expect(session?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(session?.messages[1].questions?.[0].question).toBe('Which channel?');
  });

  it("plan mode's request offers the read tools only: no edit tool, no web fetch", async () => {
    const { owner, workflow } = await setup([{ text: 'Here is my plan' }]);
    const { chunks } = await build(owner.client, { workflowId: workflow.id, text: 'Plan it', mode: 'plan' });
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
    expect(toolNames(fake!.requests[0]).sort()).toEqual([
      'get_node_details',
      'get_workflow_overview',
      'search_nodes',
    ]);
    expect(planTools).toHaveBeenCalledTimes(1);
    expect(webFetchTools).not.toHaveBeenCalled();
    const system = (fake!.requests[0] as { messages: Array<{ role: string; content: string }> }).messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('plan mode');
    expect(system.content).toContain('untrusted_data');
  });
});
