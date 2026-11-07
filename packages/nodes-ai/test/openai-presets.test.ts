/**
 * Phase 5 S1 P5-27: the eleven named OpenAI-compatible chat models. Replies are fixtures written from the
 * providers' chat completions references; they prove the request we send, not the vendor's answer.
 */
import { createBaseContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type LoadOptionsContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  connect,
  FakeHttpClient,
  node,
  nodeTypes,
  run,
  sequence,
  services,
  toolNodeTypes,
} from './harness';

const completion = (content: string): { body: unknown } => ({
  body: {
    id: 'cmpl-1',
    model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
});

const withCred = (n: WorkflowNode, type: string): WorkflowNode => ({
  ...n,
  credentials: { [type]: { id: 'cred-1', name: type } },
});

async function runAgent(
  type: string,
  credType: string,
  creds: DataObject,
  params: DataObject,
  http: FakeHttpClient,
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'What is 6 times 7?', options: {} }),
      withCred(node('Model', type, params), credType),
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel']),
    {
      nodeTypes: toolNodeTypes,
      services: services({ creds: { [credType]: creds }, http, nodeTypes: toolNodeTypes }),
    },
  );
}

const KEY = { apiKey: 'preset-test-key' };

const PRESETS: Array<{
  type: string;
  cred: string;
  creds: DataObject;
  url: string;
  model: string;
}> = [
  {
    type: 'ai.lmChatDeepSeek',
    cred: 'deepSeekApi',
    creds: KEY,
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
  {
    type: 'ai.lmChatXAiGrok',
    cred: 'xAiApi',
    creds: KEY,
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-2-vision-1212',
  },
  {
    type: 'ai.lmChatOpenRouter',
    cred: 'openRouterApi',
    creds: KEY,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4.1-mini',
  },
  {
    type: 'ai.lmChatVercelAiGateway',
    cred: 'vercelAiGatewayApi',
    creds: KEY,
    url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    model: 'openai/gpt-4o',
  },
  {
    type: 'ai.lmChatNvidia',
    cred: 'nvidiaApi',
    creds: KEY,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
  },
  {
    type: 'ai.lmChatMoonshot',
    cred: 'moonshotApi',
    creds: KEY,
    url: 'https://api.moonshot.ai/v1/chat/completions',
    model: 'kimi-k2.5',
  },
  {
    type: 'ai.lmChatMinimax',
    cred: 'minimaxApi',
    creds: KEY,
    url: 'https://api.minimax.io/v1/chat/completions',
    model: 'MiniMax-M2',
  },
  {
    type: 'ai.lmChatAlibabaCloud',
    cred: 'alibabaCloudApi',
    creds: KEY,
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
  },
  {
    type: 'ai.lmChatLemonade',
    cred: 'lemonadeApi',
    creds: KEY,
    url: 'http://localhost:8000/api/v1/chat/completions',
    model: 'Llama-3.2-1B-Instruct-Hybrid',
  },
  {
    type: 'ai.lmChatGroq',
    cred: 'groqApi',
    creds: KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama3-8b-8192',
  },
];

const noPartner = (http: FakeHttpClient) => {
  for (const r of http.requests) {
    const text = JSON.stringify(r.headers).toLowerCase();
    expect(text).not.toContain('openai-platform');
    expect(text).not.toContain('n8n');
  }
};

describe('named models call their own default URL with their default model', () => {
  it.each(PRESETS)('$type', async ({ type, cred, creds, url, model }) => {
    const http = new FakeHttpClient(sequence(completion('42')));
    const r = await runAgent(type, cred, creds, {}, http);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    expect(http.requests).toHaveLength(1);
    const [req] = http.requests;
    expect(req.url).toBe(url);
    expect(req.headers?.authorization).toBe('Bearer preset-test-key');
    expect(req.body).toMatchObject({ model });
    noPartner(http);
  });
});

describe('a node reads the credential URL', () => {
  it('Moonshot takes the China region', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent(
      'ai.lmChatMoonshot',
      'moonshotApi',
      { ...KEY, url: 'https://api.moonshot.cn/v1' },
      { model: 'kimi-k2.6' },
      http,
    );
    expect(http.requests[0].url).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(http.requests[0].body).toMatchObject({ model: 'kimi-k2.6' });
  });

  it('MiniMax takes the China region', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent('ai.lmChatMinimax', 'minimaxApi', { ...KEY, url: 'https://api.minimaxi.com/v1' }, {}, http);
    expect(http.requests[0].url).toBe('https://api.minimaxi.com/v1/chat/completions');
  });

  it('Qwen adds the compatible-mode suffix to the region host', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent(
      'ai.lmChatAlibabaCloud',
      'alibabaCloudApi',
      { ...KEY, url: 'https://dashscope-us.aliyuncs.com/' },
      {},
      http,
    );
    expect(http.requests[0].url).toBe('https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions');
  });

  it('Lemonade sends no Authorization header without a key', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent(
      'ai.lmChatLemonade',
      'lemonadeApi',
      { baseUrl: 'http://127.0.0.1:8000/api/v1' },
      { model: 'local-model' },
      http,
    );
    expect(http.requests[0].url).toBe('http://127.0.0.1:8000/api/v1/chat/completions');
    expect(http.requests[0].headers?.authorization).toBeUndefined();
  });

  it('Lemonade sends the key when there is one', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent('ai.lmChatLemonade', 'lemonadeApi', { ...KEY, baseUrl: 'http://127.0.0.1:8000/api/v1' }, {}, http);
    expect(http.requests[0].headers?.authorization).toBe('Bearer preset-test-key');
  });
});

describe('provider extras', () => {
  it('xAI sends priority and the reasoning effort', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent(
      'ai.lmChatXAiGrok',
      'xAiApi',
      KEY,
      { options: { priority: true, reasoningEffort: 'high' } },
      http,
    );
    expect(http.requests[0].body).toMatchObject({ service_tier: 'priority', reasoning_effort: 'high' });
  });

  it('xAI sends neither when they are off', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent('ai.lmChatXAiGrok', 'xAiApi', KEY, {}, http);
    expect(http.requests[0].body).not.toHaveProperty('service_tier');
    expect(http.requests[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('OpenRouter sends the reasoning effort and the provider routing', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent(
      'ai.lmChatOpenRouter',
      'openRouterApi',
      KEY,
      {
        options: {
          reasoningEffort: 'high',
          providerRouting: {
            order: 'anthropic, openai',
            only: 'anthropic',
            ignore: 'azure',
            allowFallbacks: false,
            requireParameters: true,
            dataCollection: 'deny',
            zdr: true,
            sort: 'latency',
          },
        },
      },
      http,
    );
    expect(http.requests[0].body).toMatchObject({
      reasoning: { effort: 'high' },
      provider: {
        order: ['anthropic', 'openai'],
        only: ['anthropic'],
        ignore: ['azure'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
        sort: 'latency',
      },
    });
  });

  it('MiniMax hides the thinking by default and keeps it when asked', async () => {
    const thought = completion('<think>weigh it</think>\n\n42');
    const hidden = new FakeHttpClient(sequence(thought));
    const r = await runAgent('ai.lmChatMinimax', 'minimaxApi', KEY, {}, hidden);
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    expect(hidden.requests[0].body).toMatchObject({ reasoning_split: true });

    const kept = new FakeHttpClient(sequence(thought));
    const k = await runAgent('ai.lmChatMinimax', 'minimaxApi', KEY, { options: { hideThinking: false } }, kept);
    expect(String(k.output('Agent')[0].output)).toContain('<think>');
    expect(kept.requests[0].body).not.toHaveProperty('reasoning_split');
  });

  it('common options reach the request: penalties, JSON format, a limit of tokens', async () => {
    const http = new FakeHttpClient(sequence(completion('{}')));
    await runAgent(
      'ai.lmChatDeepSeek',
      'deepSeekApi',
      KEY,
      {
        options: {
          frequencyPenalty: 0.5,
          presencePenalty: 0.25,
          temperature: 0.1,
          topP: 0.9,
          maxTokens: 300,
          responseFormat: 'json_object',
        },
      },
      http,
    );
    expect(http.requests[0].body).toMatchObject({
      frequency_penalty: 0.5,
      presence_penalty: 0.25,
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 300,
    });
  });

  it('a max tokens of -1 sends no limit', async () => {
    const http = new FakeHttpClient(sequence(completion('ok')));
    await runAgent('ai.lmChatDeepSeek', 'deepSeekApi', KEY, { options: { maxTokens: -1 } }, http);
    expect(http.requests[0].body).not.toHaveProperty('max_tokens');
  });

  it('Groq shows only max tokens and temperature', () => {
    const groq = nodeTypes.get('ai.lmChatGroq');
    const options = groq?.description.properties.find((p) => p.name === 'options')?.options ?? [];
    expect(options.map((o) => (o as { name: string }).name)).toEqual(['maxTokens', 'temperature']);
  });
});

describe('Databricks', () => {
  const HOST = 'https://adb-42.azuredatabricks.net';
  const clientCreds = (extra: DataObject = {}): DataObject => ({
    host: HOST,
    grantType: 'clientCredentials',
    clientId: 'sp-1',
    clientSecret: `dbx-secret-${Math.random()}`,
    ...extra,
  });
  const fakeHost = () =>
    new FakeHttpClient((req) =>
      req.url.endsWith('/oidc/v1/token')
        ? { body: { access_token: 'cc-token', expires_in: 3600 } }
        : completion('42'),
    );

  it('calls <host>/ai-gateway/openai/v1 with a client credentials token', async () => {
    const http = fakeHost();
    const r = await runAgent('ai.lmChatDatabricks', 'databricksOAuth2Api', clientCreds(), {}, http);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    expect(http.requests.map((q) => q.url)).toEqual([
      `${HOST}/oidc/v1/token`,
      `${HOST}/ai-gateway/openai/v1/chat/completions`,
    ]);
    expect(http.requests[1].headers?.authorization).toBe('Bearer cc-token');
    noPartner(http);
  });

  it('calls with the stored token of the user grant, and asks no token host', async () => {
    const http = fakeHost();
    const creds = clientCreds({
      grantType: 'pkce',
      oauthTokenData: { access_token: 'user-token', expires_at: Date.now() + 3_600_000 },
    });
    const r = await runAgent('ai.lmChatDatabricks', 'databricksOAuth2Api', creds, {}, http);
    expect(r.status).toBe('success');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe(`${HOST}/ai-gateway/openai/v1/chat/completions`);
    expect(http.requests[0].headers?.authorization).toBe('Bearer user-token');
  });

  it.each(['client credentials', 'user grant'])('refuses an http host, %s, and sends nothing', async (grant) => {
    const http = fakeHost();
    const creds = clientCreds({
      host: 'http://adb-42.azuredatabricks.net',
      grantType: grant === 'user grant' ? 'pkce' : 'clientCredentials',
      oauthTokenData: { access_token: 'user-token', expires_at: Date.now() + 3_600_000 },
    });
    const r = await runAgent('ai.lmChatDatabricks', 'databricksOAuth2Api', creds, {}, http);
    expect(r.status).not.toBe('success');
    expect(String(r.error?.message)).toContain('https');
    expect(http.requests).toEqual([]);
  });

  it('lists the chat serving endpoints of the workspace', async () => {
    const http = new FakeHttpClient((req) =>
      req.url.endsWith('/oidc/v1/token')
        ? { body: { access_token: 'cc-token', expires_in: 3600 } }
        : {
            body: {
              endpoints: [
                { name: 'databricks-llama', task: 'llm/v1/chat' },
                { name: 'my-embedder', task: 'llm/v1/embeddings' },
                { name: 'custom-model' },
              ],
            },
          },
    );
    const svc: ExecutionServices = services({
      creds: { databricksOAuth2Api: clientCreds() },
      http,
      nodeTypes: toolNodeTypes,
    });
    const n = withCred(node('Node', 'ai.lmChatDatabricks'), 'databricksOAuth2Api');
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, toolNodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: svc,
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const { getNodeParameter: _omit, ...rest } = base;
    const ctx: LoadOptionsContext = { ...rest, getCurrentNodeParameter: () => undefined };
    const type = toolNodeTypes.get('ai.lmChatDatabricks');
    const options = await type?.methods?.loadOptions?.listModels(ctx);
    expect(options?.map((o) => o.value)).toEqual(['custom-model', 'databricks-llama']);
    expect(http.requests.some((q) => q.url === `${HOST}/api/2.0/serving-endpoints`)).toBe(true);
  });
});

describe('model lists', () => {
  it('lists the models of an OpenAI-style /models endpoint at the provider URL', async () => {
    const http = new FakeHttpClient(() => ({
      body: { data: [{ id: 'grok-3' }, { id: 'text-embedding-x' }, { id: 'grok-2' }] },
    }));
    const svc = services({ creds: { xAiApi: KEY }, http });
    const n = withCred(node('Node', 'ai.lmChatXAiGrok'), 'xAiApi');
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: svc,
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const { getNodeParameter: _omit, ...rest } = base;
    const ctx: LoadOptionsContext = { ...rest, getCurrentNodeParameter: () => undefined };
    const options = await nodeTypes.get('ai.lmChatXAiGrok')?.methods?.loadOptions?.listModels(ctx);
    expect(options?.map((o) => o.value)).toEqual(['grok-2', 'grok-3']);
    expect(http.requests[0].url).toBe('https://api.x.ai/v1/models');
  });
});
