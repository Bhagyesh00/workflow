/**
 * P6-59 (S5 L2): the 14 `ai.*` events on the event stream. A run with an agent and a model on the Phase 5 fake
 * LLM emits `ai.llm.generated` (and `ai.llm.error` on a model error) with n8n's payload; a run whose redaction
 * applies sends an empty `msg`; `msg` is cut at 256 KB; the observer is lazy and tenant-scoped. No real model call.
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import { AI_EVENT_NAMES, type WorkflowDefinition } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { capAiMsg, createAiEventsObserver, MAX_AI_MSG_BYTES } from '../src/services/events/ai-events';
import type { AiEventContext } from '../src/services/observability/lifecycle';
import { type FakeLlm, type FakeLlmStep, startFakeLlm } from './fakes/fake-llm';
import {
  captureEvents,
  createTestServer,
  createWorkflow,
  node,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let capture: ReturnType<typeof captureEvents>;
let fake: FakeLlm | undefined;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage] });
  capture = captureEvents(server.ctx);
}, 120_000);
afterAll(async () => {
  capture?.stop();
  await server?.close();
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** an owner with a workflow of Start -> Agent <- Model, the model on the fake LLM */
async function agentFlow(script: FakeLlmStep[], settings: Record<string, unknown> = {}) {
  fake = await startFakeLlm(script);
  const owner = await signup(server.app);
  const credential = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/credentials', {
      name: 'Fake model',
      type: 'openAiApi',
      data: { apiKey: 'sk-test-ai-events-key-000000000000', baseUrl: fake.baseUrl },
    }),
  );
  const workflow = await createWorkflow(owner.client, {
    name: 'Ask the model',
    settings,
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'say hello' }),
      node('Model', 'ai.lmChatOpenAi', { model: 'gpt-4o-mini', maxRetries: 0 }, [0, 0], {
        credentials: { openAiApi: { id: credential.id, name: 'Fake model' } },
      }),
    ],
    connections: {
      Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
    },
  });
  return { owner, workflow };
}

async function runAndCollect(owner: Awaited<ReturnType<typeof signup>>, workflowId: string) {
  const from = capture.events.length;
  const { executionId } = await owner.client.data<{ executionId: string }>(
    owner.client.post(`/rest/workflows/${workflowId}/run`, {}),
  );
  const row = await waitForExecution(server.ctx, owner.tenant.id, executionId);
  await server.ctx.events.flush();
  const events = capture.events
    .slice(from)
    .filter((e) => e.tenantId === owner.tenant.id && e.eventName.startsWith('ai.'));
  return { executionId, row, events };
}

describe('ai.llm.generated and ai.llm.error from a real run', () => {
  it("an agent and a model on the fake LLM emit ai.llm.generated with n8n's payload", async () => {
    const { owner, workflow } = await agentFlow([{ text: 'Hello from the fake model' }]);
    const { executionId, row, events } = await runAndCollect(owner, workflow.id);
    expect(row.status).toBe('success');
    const generated = events.filter((e) => e.eventName === 'ai.llm.generated');
    expect(generated).toHaveLength(1);
    const event = generated[0];
    expect(event.message).toBe('ai.llm.generated');
    expect(Object.keys(event.payload).sort()).toEqual(
      ['executionId', 'msg', 'nodeName', 'nodeType', 'workflowId', 'workflowName'].sort(),
    );
    expect(event.payload).toMatchObject({
      executionId,
      workflowId: workflow.id,
      workflowName: 'Ask the model',
      nodeName: 'Model',
      nodeType: 'ai.lmChatOpenAi',
    });
    const msg = JSON.parse(String(event.payload.msg)) as {
      messages: Array<{ content: string }>;
      response: { content: string };
    };
    expect(JSON.stringify(msg.messages)).toContain('say hello');
    expect(msg.response.content).toBe('Hello from the fake model');
    // the credential's key is in no event
    expect(JSON.stringify(capture.events.slice(-20))).not.toContain('sk-test-ai-events-key');
  });

  it('a model error emits ai.llm.error with the error text', async () => {
    const { owner, workflow } = await agentFlow([{ status: 400, error: 'The model refused this input' }]);
    const { row, events } = await runAndCollect(owner, workflow.id);
    expect(row.status).toBe('error');
    const failed = events.filter((e) => e.eventName === 'ai.llm.error');
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.nodeName).toBe('Model');
    expect(String(failed[0].payload.msg)).toContain('The model refused this input');
    expect(events.some((e) => e.eventName === 'ai.llm.generated')).toBe(false);
  });

  it('a run with policy all emits ai.llm.generated with an empty msg', async () => {
    const { owner, workflow } = await agentFlow([{ text: 'secret answer text' }], { redactionPolicy: 'all' });
    const { row, events } = await runAndCollect(owner, workflow.id);
    expect(row.status).toBe('success');
    const generated = events.filter((e) => e.eventName === 'ai.llm.generated');
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.msg).toBe('');
    expect(generated[0].payload.nodeName).toBe('Model');
    expect(JSON.stringify(generated[0])).not.toContain('secret answer text');
  });
});

describe('the observer', () => {
  const definition = {
    id: 'wf-1',
    name: 'Flow',
    nodes: [],
    connections: {},
  } as unknown as WorkflowDefinition;
  const context = (over: Partial<AiEventContext> = {}): AiEventContext =>
    ({
      tenantId: 'tenant-a',
      executionId: 'exec-1',
      row: { workflowId: 'wf-1', mode: 'manual' },
      definition,
      options: {},
      kind: 'run',
      name: 'ai.tool.called',
      nodeName: 'Tool',
      nodeType: 'ai.toolCode',
      msg: '{"a":1}',
      redaction: {},
      redacted: false,
      ...over,
    }) as unknown as AiEventContext;

  function harness() {
    const emitted: Array<{ tenantId: string; name: string; payload: () => unknown }> = [];
    const deps = {
      context: () => ({
        events: {
          emit: (tenantId: string, name: string, payload: () => unknown) => {
            emitted.push({ tenantId, name, payload });
          },
        },
      }),
    };
    return { emitted, observer: createAiEventsObserver(deps as never) };
  }

  it('emits the event name for the tenant with the six payload fields, built lazily', async () => {
    const { emitted, observer } = harness();
    await observer.aiEvent!(context());
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tenantId).toBe('tenant-a');
    expect(emitted[0].name).toBe('ai.tool.called');
    expect(emitted[0].payload()).toEqual({
      msg: '{"a":1}',
      workflowName: 'Flow',
      executionId: 'exec-1',
      nodeName: 'Tool',
      workflowId: 'wf-1',
      nodeType: 'ai.toolCode',
    });
  });

  it('sends an empty msg when the run is redacted, whatever the node sent', async () => {
    const { emitted, observer } = harness();
    await observer.aiEvent!(context({ redacted: true, msg: 'a prompt with a customer name' }));
    expect((emitted[0].payload() as { msg: string }).msg).toBe('');
  });

  it('cuts msg at 256 KB without a broken character', () => {
    expect(MAX_AI_MSG_BYTES).toBe(262144);
    expect(capAiMsg('short')).toBe('short');
    const long = 'a'.repeat(MAX_AI_MSG_BYTES + 100);
    expect(Buffer.byteLength(capAiMsg(long))).toBe(MAX_AI_MSG_BYTES);
    const wide = '€'.repeat(MAX_AI_MSG_BYTES); // three bytes each
    const cut = capAiMsg(wide);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_AI_MSG_BYTES);
    expect(cut).not.toContain('�');
  });

  it('does not throw before the context is ready', async () => {
    const observer = createAiEventsObserver({
      context: () => {
        throw new Error('not ready');
      },
    } as never);
    await expect(Promise.resolve(observer.aiEvent!(context()))).resolves.toBeUndefined();
  });

  it('every one of the 14 names is a catalog name the stream can carry', () => {
    expect(AI_EVENT_NAMES).toHaveLength(14);
    expect(new Set(AI_EVENT_NAMES).size).toBe(14);
  });
});
