/**
 * P5-09 builder model: `loadBuilderModel` resolves the workspace setting through the chat node's own
 * `supplyData` (an `ai.agent` parent named Builder, `createWebhookSubNodes`), with the default AI
 * runtime loader. Refusals: no setting, no AI package, a credential of another type, a model without
 * tool calling, a completion model. One test per provider adapter through recorded replies (a
 * recording HTTP client answers; no request leaves the machine).
 */
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type {
  AiChatModel,
  DataObject,
  HttpFullResponse,
  HttpRequestOptions,
  NodePackage,
  NodeType,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BuilderModelError,
  CREDENTIAL_MISMATCH,
  loadBuilderModel,
  NO_AI_PACKAGE,
  NO_MODEL_SET,
  NO_TOOL_CALLING,
} from '../src/services/ai-builder/model';
import { createTestServer, resetDatabase, signup, type TestServer } from './helpers';

/** answers each request from `reply` by host; records what was sent after authentication */
class RecordingHttp extends HttpClient {
  readonly requests: HttpRequestOptions[] = [];
  reply: (options: HttpRequestOptions) => unknown = () => ({});

  override async request<T = unknown>(options: HttpRequestOptions): Promise<T | HttpFullResponse<T>> {
    this.requests.push(structuredClone(options));
    const body = this.reply(options) as T;
    if (options.returnFullResponse) return { body, headers: {}, statusCode: 200, statusMessage: 'OK' };
    return body;
  }
}

function modelNode(name: string, supply: () => unknown): NodeType {
  return {
    description: {
      name,
      displayName: name,
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name },
      inputs: [],
      outputs: ['ai_languageModel'],
      credentials: [{ name: 'openAiApi', required: true }],
      properties: [{ displayName: 'Model', name: 'model', type: 'string', default: '' }],
    },
    async supplyData() {
      return { response: supply() };
    },
  } as NodeType;
}

const testModels: NodePackage = {
  name: 'builder-model-tests',
  credentials: [],
  nodes: [
    // supplies something that is not a chat model with `chat`: no tool calling
    modelNode('ai.lmChatNoTools', () => ({ kind: 'chatModel', provider: 'test', model: 'x' })),
    modelNode('ai.lmChatCompletionOnly', () => ({
      kind: 'chatModel',
      provider: 'test',
      model: 'x',
      completion: true,
      chat: async () => ({ message: { role: 'assistant', content: '' } }),
    })),
  ],
};

const http = new RecordingHttp({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } });
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { AI_ENABLED: 'true' },
    { nodePackages: [nodesAiPackage, testModels], http },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  http.requests.length = 0;
  http.reply = () => ({});
});

/** a tenant whose builder model is `nodeType` with a credential of `credentialType` */
async function tenantWith(nodeType: string, credentialType: string, data: DataObject, model = 'm-1') {
  const owner = await signup(server.app);
  const credential = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/credentials', { name: `${credentialType} cred`, type: credentialType, data }),
  );
  await server.ctx.repos.tenants.updateSettings(owner.tenant.id, {
    ai: { credentialId: credential.id, nodeType, model },
  });
  return (await server.ctx.repos.tenants.get(owner.tenant.id))!;
}

const TOOLS = [
  {
    name: 'search_nodes',
    description: 'Find node types',
    parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } },
  },
];

async function ask(model: AiChatModel) {
  return model.chat({ messages: [{ role: 'user', content: 'Build a workflow' }], tools: TOOLS });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BuilderModelError);
  return (error as Error).message;
}

const bodyOf = (options: HttpRequestOptions): DataObject =>
  (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) as DataObject;

describe('loadBuilderModel', () => {
  it('uses the default AI runtime loader (the installed package)', async () => {
    const runtime = await server.ctx.aiBuilder.runtime();
    expect(typeof runtime?.runAgent).toBe('function');
    expect(typeof runtime?.capabilitiesOf).toBe('function');
  });

  it('refuses without a setting, with a mismatched credential, a tool-less model and a completion model', async () => {
    const owner = await signup(server.app);
    const bare = (await server.ctx.repos.tenants.get(owner.tenant.id))!;
    const signal = new AbortController().signal;
    expect(await refusal(loadBuilderModel(server.ctx, bare, signal))).toBe(NO_MODEL_SET);

    const mismatch = await tenantWith('ai.lmChatOpenAi', 'anthropicApi', { apiKey: 'k' });
    expect(await refusal(loadBuilderModel(server.ctx, mismatch, signal))).toBe(CREDENTIAL_MISMATCH);

    const noTools = await tenantWith('ai.lmChatNoTools', 'openAiApi', { apiKey: 'k' });
    expect(await refusal(loadBuilderModel(server.ctx, noTools, signal))).toBe(NO_TOOL_CALLING);

    const completion = await tenantWith('ai.lmChatCompletionOnly', 'openAiApi', { apiKey: 'k' });
    expect(await refusal(loadBuilderModel(server.ctx, completion, signal))).toBe(NO_TOOL_CALLING);

    // a credential that was deleted reads as no setting
    const gone = await tenantWith('ai.lmChatOpenAi', 'openAiApi', { apiKey: 'k' });
    const ai = (gone.settings as { ai: { credentialId: string } }).ai;
    await server.ctx.repos.credentials.delete(gone.id, ai.credentialId);
    expect(await refusal(loadBuilderModel(server.ctx, gone, signal))).toBe(NO_MODEL_SET);
    expect(http.requests).toEqual([]);
  });

  it('PATCH /settings refuses a credential that does not fit the model node, with the same text', async () => {
    const owner = await signup(server.app);
    const credentialOf = async (type: string) =>
      (
        await owner.client.data<{ id: string }>(
          owner.client.post('/rest/credentials', { name: `${type} cred`, type, data: { apiKey: 'k' } }),
        )
      ).id;
    const anthropic = await credentialOf('anthropicApi');
    const res = await owner.client.patch('/rest/settings', {
      ai: { credentialId: anthropic, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(CREDENTIAL_MISMATCH);
    const settings = await owner.client.data(owner.client.get('/rest/settings'));
    expect(settings.ai).toBeUndefined();
    // a fitting credential is saved
    const openAi = await credentialOf('openAiApi');
    const ok = await owner.client.patch('/rest/settings', {
      ai: { credentialId: openAi, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses when the AI nodes are not installed', async () => {
    const bare = await createTestServer({ AI_ENABLED: 'true' }, { reset: false, startMain: false });
    try {
      const owner = await signup(bare.app);
      await bare.ctx.repos.tenants.updateSettings(owner.tenant.id, {
        ai: { credentialId: '00000000-0000-4000-8000-000000000000', nodeType: 'ai.lmChatOpenAi', model: 'm' },
      });
      const tenant = (await bare.ctx.repos.tenants.get(owner.tenant.id))!;
      expect(await refusal(loadBuilderModel(bare.ctx, tenant, new AbortController().signal))).toBe(
        NO_AI_PACKAGE,
      );
    } finally {
      await bare.close();
    }
  });
});

describe('one recorded reply per provider adapter', () => {
  const signal = () => new AbortController().signal;

  it('OpenAI (chat completions)', async () => {
    const tenant = await tenantWith(
      'ai.lmChatOpenAi',
      'openAiApi',
      { apiKey: 'sk-openai-test' },
      'gpt-4o-mini',
    );
    http.reply = () => ({
      id: 'c1',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'From OpenAI' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect(model.provider).toBeTruthy();
      expect((await ask(model)).message.content).toBe('From OpenAI');
    } finally {
      await close();
    }
    const [request] = http.requests;
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.headers?.authorization).toBe('Bearer sk-openai-test');
    expect(bodyOf(request)).toMatchObject({ model: 'gpt-4o-mini' });
    expect(JSON.stringify(bodyOf(request))).toContain('search_nodes');
  });

  it('Anthropic', async () => {
    const tenant = await tenantWith(
      'ai.lmChatAnthropic',
      'anthropicApi',
      { apiKey: 'anthropic-test' },
      'claude-x',
    );
    http.reply = () => ({
      model: 'claude-x',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'From Claude' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Claude');
    } finally {
      await close();
    }
    const [request] = http.requests;
    expect(request.url).toMatch(/\/v1\/messages$/);
    expect(bodyOf(request)).toMatchObject({ model: 'claude-x' });
    expect(JSON.stringify(bodyOf(request))).toContain('search_nodes');
  });

  it('Google Gemini (model in modelName)', async () => {
    const tenant = await tenantWith(
      'ai.lmChatGoogleGemini',
      'googleGeminiApi',
      { apiKey: 'gemini-test' },
      'gemini-x',
    );
    http.reply = () => ({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'From Gemini' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Gemini');
    } finally {
      await close();
    }
    expect(http.requests[0].url).toContain('gemini-x');
    expect(JSON.stringify(bodyOf(http.requests[0]))).toContain('search_nodes');
  });

  it('Ollama', async () => {
    const tenant = await tenantWith(
      'ai.lmChatOllama',
      'ollamaApi',
      { baseUrl: 'https://ollama.example.com' },
      'llama-x',
    );
    http.reply = () => ({
      model: 'llama-x',
      message: { role: 'assistant', content: 'From Ollama' },
      done_reason: 'stop',
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Ollama');
    } finally {
      await close();
    }
    expect(http.requests[0].url).toBe('https://ollama.example.com/api/chat');
    expect(bodyOf(http.requests[0])).toMatchObject({ model: 'llama-x' });
  });

  it('Cohere', async () => {
    const tenant = await tenantWith('ai.lmChatCohere', 'cohereApi', { apiKey: 'cohere-test' }, 'command-x');
    http.reply = () => ({
      id: 'c1',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: 'From Cohere' }] },
      usage: { tokens: { input_tokens: 5, output_tokens: 2 } },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Cohere');
    } finally {
      await close();
    }
    expect(http.requests[0].url).toBe('https://api.cohere.ai/v2/chat');
    expect(bodyOf(http.requests[0])).toMatchObject({ model: 'command-x' });
  });

  it('Mistral Cloud', async () => {
    const tenant = await tenantWith(
      'ai.lmChatMistralCloud',
      'mistralCloudApi',
      { apiKey: 'mistral-test' },
      'mistral-x',
    );
    http.reply = () => ({
      id: 'm1',
      model: 'mistral-x',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'From Mistral' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Mistral');
    } finally {
      await close();
    }
    expect(http.requests[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(bodyOf(http.requests[0])).toMatchObject({ model: 'mistral-x' });
  });

  it('AWS Bedrock (Converse)', async () => {
    const tenant = await tenantWith(
      'ai.lmChatAwsBedrock',
      'aws',
      { region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'bedrock-secret-test' },
      'anthropic.claude-x-v1:0',
    );
    http.reply = () => ({
      output: { message: { role: 'assistant', content: [{ text: 'From Bedrock' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    const { model, close } = await loadBuilderModel(server.ctx, tenant, signal());
    try {
      expect((await ask(model)).message.content).toBe('From Bedrock');
    } finally {
      await close();
    }
    expect(http.requests[0].url).toMatch(
      /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/.+\/converse$/,
    );
    expect(String(http.requests[0].headers?.authorization)).toMatch(/^AWS4-HMAC-SHA256 /);
  });
});
