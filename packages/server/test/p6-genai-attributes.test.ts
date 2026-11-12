/**
 * P6-70 (S5 L14): GenAI attributes on AI node spans. A model call span holds the operation, provider, request
 * and response model and the token counts, and no message text; an agent span sums the token counts of its model
 * runs; a node with no model data gets none. Unit cases on task data, one real run on the Phase 5 fake LLM
 * through the tracing observer and L9's in-process OTLP fake. Fixed fake values only.
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { Connections, RunData, TaskData, WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { genAiAttributes } from '../src/services/tracing/gen-ai';
import { type FakeLlm, startFakeLlm } from './fakes/fake-llm';
import { type OtlpCollector, startOtlpCollector } from './fakes/otlp';
import {
  createTestServer,
  createWorkflow,
  enableTracing,
  node,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

const SECRET_PROMPT = 'PROMPT-TEXT-MUST-NOT-LEAK-7731';
const SECRET_ANSWER = 'ANSWER-TEXT-MUST-NOT-LEAK-4419';

function wf(name: string, type: string, id = `${name}-id`): WorkflowNode {
  return { id, name, type, typeVersion: 1, position: [0, 0], parameters: {} };
}

function modelTask(
  parent: string,
  startTime: number,
  request: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): TaskData {
  return {
    startTime,
    executionTime: 0,
    executionStatus: 'success',
    inputOverride: request ? { ai_languageModel: [[{ json: request as never }]] } : undefined,
    data: output ? { ai_languageModel: [[{ json: output as never }]] } : undefined,
    source: [{ previousNode: parent }],
  } as TaskData;
}

const wired: Connections = {
  'Model A': { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
  'Model B': { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
  'Other Model': { ai_languageModel: [[{ node: 'Elsewhere', type: 'ai_languageModel', index: 0 }]] },
};

describe('model sub-node attributes', () => {
  it('holds the models, provider and token counts and no message text', () => {
    const model = wf('Model A', 'ai.lmChatAnthropic');
    const task = modelTask(
      'Agent',
      1000,
      { model: 'claude-test', messages: [{ role: 'user', content: SECRET_PROMPT }] },
      {
        response: { role: 'assistant', content: SECRET_ANSWER },
        tokenUsage: { inputTokens: 11, outputTokens: 7 },
        model: 'claude-test-2024',
        stopReason: 'stop',
      },
    );
    const attributes = genAiAttributes(model, task, { 'Model A': [task] }, wired);
    expect(attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-test',
      'gen_ai.response.model': 'claude-test-2024',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
    });
    const text = JSON.stringify(attributes);
    expect(text).not.toContain(SECRET_PROMPT);
    expect(text).not.toContain(SECRET_ANSWER);
  });

  it('names the provider from the node type', () => {
    const task = modelTask('Agent', 1, { model: 'm' }, { model: 'm' });
    const of = (type: string) => genAiAttributes(wf('M', type), task, {}, {})?.['gen_ai.provider.name'];
    expect(of('ai.lmChatOpenAi')).toBe('openai');
    expect(of('ai.lmChatAwsBedrock')).toBe('aws.bedrock');
    expect(of('ai.lmChatGoogleGemini')).toBe('gcp.gemini');
    expect(of('ai.lmChatMoonshot')).toBe('moonshot');
  });

  it('leaves out a count or model the run did not log, and ignores bad values', () => {
    const model = wf('Model A', 'ai.lmChatOpenAi');
    const only = modelTask('Agent', 1, { model: 'gpt-x' }, { tokenUsage: { inputTokens: 5 } });
    expect(genAiAttributes(model, only, {}, {})).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.usage.input_tokens': 5,
    });
    const bad = modelTask(
      'Agent',
      1,
      { model: 7 },
      { tokenUsage: { inputTokens: 'many', outputTokens: -1 } },
    );
    expect(genAiAttributes(model, bad, {}, {})).toBeUndefined();
  });

  it('gives a node with no model data none', () => {
    const empty = modelTask('Agent', 1, undefined, undefined);
    expect(genAiAttributes(wf('Model A', 'ai.lmChatOpenAi'), empty, {}, {})).toBeUndefined();
    const plain: TaskData = { startTime: 1, executionTime: 1, executionStatus: 'success', source: [] };
    expect(genAiAttributes(wf('Set', 'core.set'), plain, {}, {})).toBeUndefined();
    // an AI node that is neither a chat model nor an agent
    const memory = modelTask('Agent', 1, { model: 'm' }, { tokenUsage: { inputTokens: 1, outputTokens: 1 } });
    expect(genAiAttributes(wf('Memory', 'ai.memoryRedisChat'), memory, {}, {})).toBeUndefined();
  });
});

describe('agent attributes', () => {
  const agent = wf('Agent', 'ai.agent', 'agent-node-id');
  const usage = (i: number, o: number) => ({ tokenUsage: { inputTokens: i, outputTokens: o }, model: 'm' });

  it('sums two model calls', () => {
    const task: TaskData = { startTime: 1000, executionTime: 500, executionStatus: 'success', source: [] };
    const runData: RunData = {
      'Model A': [
        modelTask('Agent', 1100, { model: 'm' }, usage(10, 3)),
        modelTask('Agent', 1200, { model: 'm' }, usage(20, 4)),
      ],
      'Model B': [modelTask('Agent', 1300, { model: 'm' }, usage(5, 1))],
      'Other Model': [modelTask('Elsewhere', 1100, { model: 'm' }, usage(900, 900))],
      Agent: [task],
    };
    expect(genAiAttributes(agent, task, runData, wired)).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Agent',
      'gen_ai.agent.id': 'agent-node-id',
      'gen_ai.usage.input_tokens': 35,
      'gen_ai.usage.output_tokens': 8,
    });
  });

  it('counts only the model runs inside this agent run', () => {
    const first: TaskData = { startTime: 1000, executionTime: 200, executionStatus: 'success', source: [] };
    const second: TaskData = { startTime: 2000, executionTime: 200, executionStatus: 'success', source: [] };
    const runData: RunData = {
      'Model A': [
        modelTask('Agent', 1100, { model: 'm' }, usage(10, 3)),
        modelTask('Agent', 2100, { model: 'm' }, usage(7, 2)),
      ],
      Agent: [first, second],
    };
    expect(genAiAttributes(agent, second, runData, wired)).toMatchObject({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 2,
    });
  });

  it('has the agent identity and no token sums when no model run logged any', () => {
    const task: TaskData = { startTime: 1, executionTime: 1, executionStatus: 'success', source: [] };
    const attributes = genAiAttributes(agent, task, { Agent: [task] }, wired);
    expect(attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Agent',
      'gen_ai.agent.id': 'agent-node-id',
    });
  });
});

describe('spans of a real run on the fake LLM', () => {
  let server: TestServer;
  let owner: Awaited<ReturnType<typeof signup>>;
  let collector: OtlpCollector;
  let fake: FakeLlm | undefined;

  beforeAll(async () => {
    server = await createTestServer({}, { nodePackages: [nodesAiPackage] });
    owner = await signup(server.app);
    collector = await startOtlpCollector();
    await enableTracing(server, owner.tenant.id, {
      exporterEndpoint: collector.url,
      productionExecutionsOnly: false,
    });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await collector?.close();
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('the model span has tokens and models and no text; the agent span has the sum', async () => {
    fake = await startFakeLlm([
      { text: SECRET_ANSWER, usage: { promptTokens: 21, completionTokens: 9 }, model: 'fake-model-reply' },
    ]);
    const credential = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', {
        name: 'Fake model',
        type: 'openAiApi',
        data: { apiKey: 'sk-test-genai-key-0000000000000000', baseUrl: fake.baseUrl },
      }),
    );
    const workflow = await createWorkflow(owner.client, {
      name: 'Ask the model',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: SECRET_PROMPT }),
        node('Model', 'ai.lmChatOpenAi', { model: 'gpt-4o-mini', maxRetries: 0 }, [0, 0], {
          credentials: { openAiApi: { id: credential.id, name: 'Fake model' } },
        }),
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      },
    });
    const { executionId } = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const spans = await waitFor(
      async () => {
        await server.ctx.tracing.flush();
        const all = collector.spans().filter((s) => s.attributes['execution.id'] === executionId);
        const both =
          all.some((s) => s.attributes['node.name'] === 'Agent') &&
          all.some((s) => s.attributes['node.name'] === 'Model');
        return both ? all : undefined;
      },
      { timeout: 15_000, message: 'agent and model spans' },
    );
    const model = spans.find((s) => s.attributes['node.name'] === 'Model');
    const agent = spans.find((s) => s.attributes['node.name'] === 'Agent');
    expect(model?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.response.model': 'fake-model-reply',
    });
    expect(Number(model?.attributes['gen_ai.usage.input_tokens'])).toBe(21);
    expect(Number(model?.attributes['gen_ai.usage.output_tokens'])).toBe(9);
    expect(agent?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Agent',
    });
    expect(Number(agent?.attributes['gen_ai.usage.input_tokens'])).toBe(21);
    expect(Number(agent?.attributes['gen_ai.usage.output_tokens'])).toBe(9);
    const wire = JSON.stringify(
      spans.map((s) => s.attributes),
      (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    );
    expect(wire).not.toContain(SECRET_PROMPT);
    expect(wire).not.toContain(SECRET_ANSWER);
    expect(wire).not.toContain('sk-test-genai-key');
    const plain = spans.find((s) => s.attributes['node.name'] === 'Start');
    expect(Object.keys(plain?.attributes ?? {}).filter((k) => k.startsWith('gen_ai.'))).toEqual([]);
  });
});
