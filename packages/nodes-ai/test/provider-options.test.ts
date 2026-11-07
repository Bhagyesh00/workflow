/**
 * Phase 5 S1 P5-25: Anthropic thinking, top K and top P; the Ollama options; the custom header of the
 * OpenAI and Anthropic credentials. Replies are fixtures written from the vendor docs; they prove the
 * request we send.
 */
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { LmChatAnthropicNode } from '../src/nodes/models/LmChatAnthropic.node';
import { LmChatOllamaNode } from '../src/nodes/models/LmChatOllama.node';
import { textCompletionNodes } from '../src/nodes/models/text-completion.nodes';
import { anthropicSampling } from '../src/providers/anthropic';
import { connect, FakeHttpClient, node, run, sequence, services } from './harness';

const withCreds = (n: WorkflowNode, type: string): WorkflowNode => ({
  ...n,
  credentials: { [type]: { id: 'cred-1', name: type } },
});

async function runAgent(
  model: WorkflowNode,
  http: FakeHttpClient,
  creds: Record<string, DataObject>,
  agentOptions: DataObject = {},
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'What is 6 times 7?',
        options: { enableStreaming: false, ...agentOptions },
      }),
      node('Calculator', 'ai.toolCalculator'),
      model,
    ],
    connect(
      ['Trigger', 'Agent'],
      ['Calculator', 'Agent', 'ai_tool'],
      [model.name, 'Agent', 'ai_languageModel'],
    ),
    { services: services({ creds, http }) },
  );
}

const ANTHROPIC = { anthropicApi: { apiKey: 'ant-test-key', baseUrl: 'https://api.anthropic.com' } };
const anthropicReply = {
  body: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '42' }] },
};
const claude = (options: DataObject, model?: string) =>
  withCreds(node('Claude', 'ai.lmChatAnthropic', { options, ...(model ? { model } : {}) }), 'anthropicApi');

async function anthropicRequest(options: DataObject, agentOptions: DataObject = {}, model?: string) {
  const http = new FakeHttpClient(sequence(anthropicReply));
  const r = await runAgent(claude(options, model), http, ANTHROPIC, agentOptions);
  expect(r.status).toBe('success');
  return { body: http.bodies[0] as Record<string, any>, request: http.requests[0] };
}

const claudeOptionList = () =>
  (LmChatAnthropicNode.description.properties.find((p) => p.name === 'options')?.options ?? []) as Array<{
    name: string;
    default: unknown;
  }>;

describe('Anthropic options', () => {
  it('sends nothing for thinking, top K or top P by default', async () => {
    const { body } = await anthropicRequest({});
    expect(body.thinking).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('sends a fixed thinking budget and keeps max_tokens above it', async () => {
    const { body } = await anthropicRequest({
      thinking: true,
      thinkingMode: 'budget',
      thinkingBudget: 4000,
      maxTokens: 2000,
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
    expect(body.max_tokens).toBeGreaterThan(4000);
  });

  it('sends adaptive thinking without a budget', async () => {
    const { body } = await anthropicRequest({
      thinking: true,
      thinkingMode: 'adaptive',
      thinkingBudget: 5000,
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('thinking is adaptive when the mode is left alone, and the node shows that default', async () => {
    const { body } = await anthropicRequest({ thinking: true });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    const options = claudeOptionList();
    expect(options.find((o) => o.name === 'thinkingMode')?.default).toBe('adaptive');
  });

  it('floors the budget at 1024 and sends nothing when thinking is off', async () => {
    expect(
      (await anthropicRequest({ thinking: true, thinkingMode: 'budget', thinkingBudget: 10 })).body.thinking,
    ).toEqual({
      type: 'enabled',
      budget_tokens: 1024,
    });
    expect((await anthropicRequest({ thinking: false, thinkingBudget: 4000 })).body.thinking).toBeUndefined();
  });

  it('leaves top K and top P out on the default model and keeps the current API version', async () => {
    const { body, request } = await anthropicRequest({ topK: 20, topP: 0.9 });
    expect(body.top_k).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(request.headers?.['anthropic-version']).toBe('2026-10-21');
  });

  it('sends top K and top P to a model that takes them, on the older API version', async () => {
    const { body, request } = await anthropicRequest({ topK: 20, topP: 0.9 }, {}, 'claude-sonnet-4-6');
    expect(body.top_k).toBe(20);
    expect(body.top_p).toBe(0.9);
    expect(request.headers?.['anthropic-version']).toBe('2023-06-01');
  });

  it('thinking on sends neither field and keeps the current API version', async () => {
    const { body, request } = await anthropicRequest(
      { topK: 20, topP: 0.9, thinking: true, thinkingMode: 'budget' },
      {},
      'claude-sonnet-4-6',
    );
    expect(body.top_k).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(request.headers?.['anthropic-version']).toBe('2026-10-21');
  });

  it('a top K of -1 alone sends nothing and keeps the current API version', async () => {
    const { body, request } = await anthropicRequest({ topK: -1 }, {}, 'claude-sonnet-4-6');
    expect(body.top_k).toBeUndefined();
    expect(request.headers?.['anthropic-version']).toBe('2026-10-21');
  });

  it.each([
    ['my-gateway-model', true],
    ['claude', true],
    ['claude-2.1', true],
    ['claude-instant-1.2', true],
    ['claude-3-5-sonnet-20241022', true],
    ['claude-sonnet-4-6', true],
    ['claude-haiku-4-5', true],
    ['claude-opus-4', true],
    ['claude-opus-4-20250514', true],
    ['claude-opus-4-5-20251101', true],
    ['claude-opus-4-6', true],
    ['claude-opus-4-7', false],
    ['claude-opus-4-8', false],
    ['claude-opus-5-5', false],
    ['claude-sonnet-5-5', false],
    ['claude-sonnet-5', false],
    ['claude-haiku-5-5', false],
    ['claude-fable-5-1', false],
  ])('sampling rule: %s takes top P: %s', (model, takes) => {
    const { fields, version } = anthropicSampling({ model, topP: 0.5 });
    expect(fields).toEqual(takes ? { top_p: 0.5 } : {});
    expect(version).toBe(takes ? '2023-06-01' : '2026-10-21');
  });

  it('drops the forced tool choice while thinking is on', async () => {
    const forced = { forceToolCallOnFirstIteration: true };
    const model = 'claude-opus-4-8';
    expect((await anthropicRequest({}, forced, model)).body.tool_choice).toEqual({ type: 'any' });
    expect((await anthropicRequest({ thinking: true }, forced, model)).body.tool_choice).toBeUndefined();
  });

  it.each(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'])(
    'never forces a tool call on %s, which refuses it',
    async (model) => {
      const forced = { forceToolCallOnFirstIteration: true };
      expect((await anthropicRequest({}, forced, model)).body.tool_choice).toBeUndefined();
    },
  );

  it('sends the custom header of the credential and no n8n header', async () => {
    const http = new FakeHttpClient(sequence(anthropicReply));
    await runAgent(claude({}), http, {
      anthropicApi: {
        ...ANTHROPIC.anthropicApi,
        header: true,
        headerName: ' X-Gateway-Key ',
        headerValue: 'gw-1',
      },
    });
    const headers = http.requests[0].headers ?? {};
    expect(headers['x-gateway-key']).toBe('gw-1');
    expect(headers['x-api-key']).toBe('ant-test-key');
    expect(JSON.stringify(headers)).not.toMatch(/n8n|openai-platform/);
  });
});

describe('OpenAI custom header', () => {
  const OPENAI = {
    openAiApi: {
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
      header: true,
      headerName: 'X-Proxy-Auth',
      headerValue: 'px-1',
    },
  };
  it('sends the custom header with the key', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: {
          model: 'gpt-5-mini',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '42' } }],
        },
      }),
    );
    const r = await runAgent(withCreds(node('OpenAI', 'ai.lmChatOpenAi'), 'openAiApi'), http, OPENAI);
    expect(r.status).toBe('success');
    const headers = http.requests[0].headers ?? {};
    expect(headers['x-proxy-auth']).toBe('px-1');
    expect(headers.authorization).toBe('Bearer sk-test-key');
    expect(JSON.stringify(headers)).not.toMatch(/n8n|openai-platform/);
  });
});

describe('Ollama options', () => {
  const OLLAMA = { ollamaApi: { baseUrl: 'https://ollama.example.com' } };
  const reply = {
    body: { model: 'llama3.2', message: { role: 'assistant', content: '42' }, done_reason: 'stop' },
  };
  async function ollamaBody(options: DataObject) {
    const http = new FakeHttpClient(sequence(reply));
    const r = await runAgent(
      withCreds(node('Ollama', 'ai.lmChatOllama', { options }), 'ollamaApi'),
      http,
      OLLAMA,
    );
    expect(r.status).toBe('success');
    return http.bodies[0] as Record<string, any>;
  }

  it('sends each option under its Ollama name', async () => {
    const body = await ollamaBody({
      temperature: 0.3,
      topP: 0.8,
      numPredict: 300,
      numCtx: 8192,
      keepAlive: '10m',
      topK: 30,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
      repeatPenalty: 1.3,
      penalizeNewline: true,
      lowVram: true,
      mainGpu: 1,
      numBatch: 256,
      numGpu: 12,
      numThread: 6,
      useMLock: true,
      useMMap: false,
      vocabOnly: false,
      format: 'json',
      think: false,
    });
    expect(body.options).toEqual({
      temperature: 0.3,
      top_p: 0.8,
      num_predict: 300,
      num_ctx: 8192,
      top_k: 30,
      frequency_penalty: 0.5,
      presence_penalty: 0.25,
      repeat_penalty: 1.3,
      penalize_newline: true,
      low_vram: true,
      main_gpu: 1,
      num_batch: 256,
      num_gpu: 12,
      num_thread: 6,
      use_mlock: true,
      use_mmap: false,
      vocab_only: false,
    });
    expect(body.keep_alive).toBe('10m');
    expect(body.format).toBe('json');
    expect(body.think).toBe(false);
  });

  it('sends no options, format or think by default', async () => {
    const body = await ollamaBody({});
    expect(body.options).toBeUndefined();
    expect(body.format).toBeUndefined();
    expect(body.think).toBeUndefined();
    expect(body.keep_alive).toBeUndefined();
  });

  it('keeps the default output format out of the request', async () => {
    expect((await ollamaBody({ format: 'default' })).format).toBeUndefined();
  });

  it('sends a num_predict and a top K of -1 when they are added', async () => {
    const body = await ollamaBody({ numPredict: -1, topK: -1 });
    expect(body.options).toEqual({ num_predict: -1, top_k: -1 });
  });

  it('the chat and the text node show the same options, with the defaults people know', () => {
    const list = (description: typeof LmChatOllamaNode.description) =>
      Object.fromEntries(
        (description.properties.find((p) => p.name === 'options')?.options ?? []).map((o) => {
          const option = o as { name: string; default: unknown };
          return [option.name, option.default];
        }),
      );
    const expected = {
      think: true,
      temperature: 0.7,
      topK: -1,
      topP: 1,
      frequencyPenalty: 0,
      keepAlive: '5m',
      lowVram: false,
      mainGpu: 0,
      numBatch: 512,
      numCtx: 2048,
      numGpu: -1,
      numPredict: -1,
      numThread: 0,
      penalizeNewline: true,
      presencePenalty: 0,
      repeatPenalty: 1,
      useMLock: false,
      useMMap: true,
      vocabOnly: false,
      format: 'default',
    };
    expect(list(LmChatOllamaNode.description)).toEqual(expected);
    const text = textCompletionNodes.find((n) => n.description.name === 'ai.lmOllama');
    expect(list(text!.description)).toEqual(expected);
  });
});
