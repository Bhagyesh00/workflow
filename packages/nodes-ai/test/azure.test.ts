/**
 * Phase 5 S1 P5-20: Microsoft Foundry and Azure OpenAI chat and embeddings. Replies are fixtures written from
 * the vendor docs; they prove the request we send after authentication, not the vendor's answer.
 */
import { randomUUID } from 'node:crypto';
import { applyAuthentication, createBaseContext, createCredentialHelpers } from '@workflow/core';
import {
  CredentialDomainError,
  type CredentialType,
  type DataObject,
  ExpressionEvaluator,
  getCredentialAllowedDomains,
  type HttpRequestOptions,
  type LoadOptionsContext,
  type NodeType,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { azureEntraCognitiveServicesOAuth2Api, azureOpenAiApi } from '../src/credentials/azure.credentials';
import { connect, FakeHttpClient, type FakeReply, node, nodeTypes, run, services } from './harness';

const KEY = 'azure-key-SECRET-123';
const CLASSIC = { endpointType: 'classic', resourceName: 'res1', apiKey: KEY };
const FOUNDRY = {
  endpointType: 'foundry',
  foundryEndpoint: 'https://res1.services.ai.azure.com/openai/v1',
  projectName: 'proj1',
  apiKey: KEY,
};
const ENTRA_FOUNDRY = {
  endpointType: 'foundry',
  foundryEndpoint: 'https://res1.services.ai.azure.com/openai/v1',
  projectName: 'proj1',
  tenantId: 'tenant-a',
  clientId: 'client-1',
};
const entra = (extra: DataObject = {}): DataObject => ({
  ...ENTRA_FOUNDRY,
  clientSecret: `entra-secret-${randomUUID()}`,
  ...extra,
});

const withCreds = (n: WorkflowNode, type = 'azureOpenAiApi'): WorkflowNode => ({
  ...n,
  credentials: { [type]: { id: 'cred-1', name: type } },
});

const tokenReply = (token: string, expires = 3600): FakeReply => ({
  body: { access_token: token, token_type: 'Bearer', expires_in: expires },
});

const completion = (content: string): FakeReply => ({
  body: {
    id: 'cmpl-1',
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
});

async function runAgent(
  http: FakeHttpClient,
  creds: Record<string, DataObject>,
  params: DataObject,
  authType = 'azureOpenAiApi',
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'What is 6 times 7?', options: {} }),
      withCreds(node('Azure', 'ai.lmChatAzureOpenAi', params), authType),
    ],
    connect(['Trigger', 'Agent'], ['Azure', 'Agent', 'ai_languageModel']),
    { services: services({ creds, http }) },
  );
}

const headerText = (http: FakeHttpClient) => JSON.stringify(http.requests.map((r) => r.headers ?? {}));

describe('Azure OpenAI classic chat', () => {
  it('calls the deployment path with the default api-version and the api-key header', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    const r = await runAgent(
      http,
      { azureOpenAiApi: CLASSIC },
      {
        model: { __rl: true, mode: 'id', value: 'my gpt/4o' },
        options: { maxTokens: 300, temperature: 0.2, topP: 0.9, frequencyPenalty: 0.5 },
      },
    );
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.openai.azure.com/openai/deployments/my%20gpt%2F4o/chat/completions');
    expect(req.qs).toEqual({ 'api-version': '2025-03-01-preview' });
    expect(req.headers?.['api-key']).toBe(KEY);
    expect(req.headers?.['x-api-key']).toBeUndefined();
    expect(req.headers?.authorization).toBeUndefined();
    expect(req.body).toMatchObject({
      max_completion_tokens: 300,
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0.5,
    });
  });

  it('uses the credential api version and custom endpoint, a plain string model, -1 tokens and extra body', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    await runAgent(
      http,
      {
        azureOpenAiApi: { ...CLASSIC, apiVersion: '2024-10-21', endpoint: 'https://gw.example.com/azure/' },
      },
      {
        model: 'gpt-4o',
        options: {
          maxTokens: -1,
          responseFormat: 'json_object',
          extraBody: '{"seed": 7, "max_completion_tokens": 9}',
        },
      },
    );
    const [req] = http.requests;
    expect(req.url).toBe('https://gw.example.com/azure/openai/deployments/gpt-4o/chat/completions');
    expect(req.qs).toEqual({ 'api-version': '2024-10-21' });
    expect(req.body).toMatchObject({
      seed: 7,
      max_completion_tokens: 9,
      response_format: { type: 'json_object' },
    });
  });

  it('refuses a Claude deployment and the Responses API with the two messages', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    const claude = await runAgent(
      http,
      { azureOpenAiApi: CLASSIC },
      { model: 'claude-1', modelFamily: 'anthropic' },
    );
    expect(claude.status).not.toBe('success');
    expect(claude.error?.message).toBe(
      'Claude deployments need a credential using the Microsoft Foundry endpoint type',
    );
    const responses = await runAgent(
      http,
      { azureOpenAiApi: CLASSIC },
      { model: 'gpt-4o', useResponsesApi: true },
    );
    expect(responses.error?.message).toBe(
      'The Responses API needs a credential using the Microsoft Foundry endpoint type',
    );
    expect(http.requests).toHaveLength(0);
  });

  it('needs a deployment, and a bad endpoint is a node error that names no key', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    const empty = await runAgent(
      http,
      { azureOpenAiApi: CLASSIC },
      { model: { __rl: true, mode: 'id', value: ' ' } },
    );
    expect(empty.error?.message).toBe('Choose a deployment');
    const bad = await runAgent(
      http,
      { azureOpenAiApi: { ...CLASSIC, resourceName: 'a.evil.test/x' } },
      { model: 'gpt-4o' },
    );
    expect(bad.error?.message).toBe('The resource name must use letters, digits and hyphens only');
    expect(JSON.stringify(bad.error)).not.toContain(KEY);
    const plain = await runAgent(
      http,
      { azureOpenAiApi: { ...FOUNDRY, foundryEndpoint: 'http://res1.services.ai.azure.com/openai/v1' } },
      { model: 'gpt-4o' },
    );
    expect(plain.error?.message).toContain('must be an https URL');
    expect(http.requests).toHaveLength(0);
  });
});

describe('Microsoft Foundry chat', () => {
  it('calls /openai/v1 with the deployment as the model and no api-version', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    const r = await runAgent(http, { azureOpenAiApi: FOUNDRY }, { model: 'gpt-4o-prod' });
    expect(r.status).toBe('success');
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.services.ai.azure.com/openai/v1/chat/completions');
    expect(req.qs).toBeUndefined();
    expect(req.headers?.['api-key']).toBe(KEY);
    expect(req.body).toMatchObject({ model: 'gpt-4o-prod' });
  });

  it('calls the Responses API on /openai/v1/responses', async () => {
    const http = new FakeHttpClient(() => ({
      body: {
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-4o',
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: '42', annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    }));
    const r = await runAgent(
      http,
      { azureOpenAiApi: FOUNDRY },
      { model: 'gpt-4o-prod', useResponsesApi: true, options: { maxTokens: 200 } },
    );
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.services.ai.azure.com/openai/v1/responses');
    expect(req.headers?.['api-key']).toBe(KEY);
    expect(req.body).toMatchObject({ model: 'gpt-4o-prod' });
    expect(JSON.stringify(req.body)).toContain('What is 6 times 7?');
  });

  it('calls Claude on <origin>/anthropic/v1/messages with both key headers', async () => {
    const http = new FakeHttpClient(() => ({
      body: {
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '42' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }));
    const r = await runAgent(
      http,
      { azureOpenAiApi: FOUNDRY },
      { model: 'claude-prod', modelFamily: 'anthropic', options: { maxTokens: 500 } },
    );
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.services.ai.azure.com/anthropic/v1/messages');
    expect(req.headers?.['x-api-key']).toBe(KEY);
    expect(req.headers?.['api-key']).toBeUndefined();
    expect(req.headers?.authorization).toBeUndefined();
    expect(req.headers?.['anthropic-version']).toBeTruthy();
    expect(req.body).toMatchObject({ model: 'claude-prod', max_tokens: 500 });
  });

  it('sends no partner or n8n header on any call', async () => {
    const http = new FakeHttpClient(() => completion('42'));
    await runAgent(http, { azureOpenAiApi: FOUNDRY }, { model: 'm' });
    await runAgent(http, { azureOpenAiApi: CLASSIC }, { model: 'm' });
    expect(http.requests).toHaveLength(2);
    expect(headerText(http)).not.toMatch(/openai-platform|n8n/i);
  });
});

describe('Entra ID', () => {
  const tokenHttp = (chat: () => FakeReply = () => completion('42')) => {
    let counter = 0;
    return new FakeHttpClient((req) =>
      req.url.startsWith('https://login.microsoftonline.com/') ? tokenReply(`tok-${++counter}`) : chat(),
    );
  };

  it('gets a client-credentials token with the resource in the form and sends it as a bearer', async () => {
    const http = tokenHttp();
    const creds = entra();
    const r = await runAgent(
      http,
      { azureEntraCognitiveServicesOAuth2Api: creds },
      { model: 'gpt-4o', authentication: 'azureEntraCognitiveServicesOAuth2Api' },
      'azureEntraCognitiveServicesOAuth2Api',
    );
    expect(r.status).toBe('success');
    const [token, chat] = http.requests;
    expect(token.url).toBe('https://login.microsoftonline.com/tenant-a/oauth2/token');
    expect(token.method).toBe('POST');
    expect(token.body).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: creds.clientSecret,
      resource: 'https://cognitiveservices.azure.com/',
    });
    expect(chat.url).toBe('https://res1.services.ai.azure.com/openai/v1/chat/completions');
    expect(chat.headers?.authorization).toBe('Bearer tok-1');
    expect(chat.headers?.['api-key']).toBeUndefined();
  });

  /** an `authenticate` and the send after it, as httpRequestWithAuthentication does them */
  async function send(
    fake: FakeHttpClient,
    type: CredentialType,
    data: DataObject,
    request: HttpRequestOptions,
  ) {
    const helpers = createCredentialHelpers(fake, getCredentialAllowedDomains(data, { userUrl: false }));
    const authed = await applyAuthentication(type, data, request, helpers);
    await fake.request(authed);
    return authed;
  }
  const CHAT = { url: 'https://res1.services.ai.azure.com/openai/v1/chat/completions' };
  const tokenCalls = (fake: FakeHttpClient) =>
    fake.requests.filter((r) => r.url.includes('login.microsoftonline.com'));

  it('fetches the token once for the same secret and tenant', async () => {
    const fake = tokenHttp();
    const creds = entra();
    await send(fake, azureEntraCognitiveServicesOAuth2Api, creds, CHAT);
    await send(fake, azureEntraCognitiveServicesOAuth2Api, creds, CHAT);
    expect(tokenCalls(fake)).toHaveLength(1);
    expect(fake.requests).toHaveLength(3);
  });

  it('fetches a new token for the same secret with another tenant or client', async () => {
    const fake = tokenHttp();
    const creds = entra();
    await send(fake, azureEntraCognitiveServicesOAuth2Api, creds, CHAT);
    const other = await send(
      fake,
      azureEntraCognitiveServicesOAuth2Api,
      { ...creds, tenantId: 'tenant-b' },
      CHAT,
    );
    await send(fake, azureEntraCognitiveServicesOAuth2Api, { ...creds, clientId: 'client-2' }, CHAT);
    expect(tokenCalls(fake).map((t) => t.url)).toEqual([
      'https://login.microsoftonline.com/tenant-a/oauth2/token',
      'https://login.microsoftonline.com/tenant-b/oauth2/token',
      'https://login.microsoftonline.com/tenant-a/oauth2/token',
    ]);
    expect(other.headers?.authorization).toBe('Bearer tok-2');
  });

  it('asks for the project audience on the deployment list and the cognitive services audience elsewhere', async () => {
    const fake = tokenHttp();
    const creds = entra();
    await send(fake, azureEntraCognitiveServicesOAuth2Api, creds, {
      url: 'https://res1.services.ai.azure.com/api/projects/proj1/deployments',
    });
    await send(fake, azureEntraCognitiveServicesOAuth2Api, creds, CHAT);
    expect(tokenCalls(fake).map((t) => (t.body as DataObject).resource)).toEqual([
      'https://ai.azure.com/',
      'https://cognitiveservices.azure.com/',
    ]);
  });

  it('refuses a bad tenant id and an empty secret before any call', async () => {
    const fake = tokenHttp();
    await expect(
      send(fake, azureEntraCognitiveServicesOAuth2Api, entra({ tenantId: 'a/../b' }), CHAT),
    ).rejects.toThrow('tenant ID');
    await expect(
      send(fake, azureEntraCognitiveServicesOAuth2Api, entra({ clientSecret: '' }), CHAT),
    ).rejects.toThrow('client secret');
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a token host outside the allowed domains, before any call', async () => {
    const fake = tokenHttp();
    const creds = entra({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'res1.services.ai.azure.com',
    });
    await expect(send(fake, azureEntraCognitiveServicesOAuth2Api, creds, CHAT)).rejects.toBeInstanceOf(
      CredentialDomainError,
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe('API key request', () => {
  const sign = (url: string, headers: Record<string, string> = {}) =>
    applyAuthentication(azureOpenAiApi, FOUNDRY, { url, headers });

  it('follows no redirect: a fetch would carry the key to the next host', async () => {
    for (const url of [
      'https://res1.services.ai.azure.com/openai/v1/chat/completions',
      'https://res1.services.ai.azure.com/anthropic/v1/messages',
    ]) {
      expect((await sign(url)).followRedirects).toBe(false);
    }
  });

  it('sends one token header: x-api-key for Claude, api-key for the rest', async () => {
    const preset = { Authorization: 'Bearer other', 'API-KEY': 'other', 'X-Api-Key': 'other' };
    const claude = await sign('https://res1.services.ai.azure.com/anthropic/v1/messages', preset);
    expect(claude.headers).toEqual({ 'x-api-key': KEY });
    const chat = await sign('https://res1.services.ai.azure.com/openai/v1/chat/completions', preset);
    expect(chat.headers).toEqual({ 'api-key': KEY });
  });

  it('Entra ID sends only the bearer token', async () => {
    const fake = new FakeHttpClient(() => ({ body: { access_token: 'tok-1', expires_in: 3600 } }));
    const signed = await applyAuthentication(
      azureEntraCognitiveServicesOAuth2Api,
      entra(),
      {
        url: 'https://res1.services.ai.azure.com/anthropic/v1/messages',
        headers: { 'x-api-key': 'other', 'api-key': 'other' },
      },
      createCredentialHelpers(fake, undefined),
    );
    expect(signed.headers).toEqual({ authorization: 'Bearer tok-1' });
  });
});

describe('credential host rule', () => {
  it('signs no request to another host, for either credential', async () => {
    const fake = new FakeHttpClient(() => ({ body: {} }));
    const helpers = createCredentialHelpers(fake, []);
    const other = { url: 'https://evil.example.com/openai/v1/chat/completions' };
    await expect(applyAuthentication(azureOpenAiApi, FOUNDRY, other, helpers)).rejects.toThrow(
      'its own endpoint',
    );
    await expect(
      applyAuthentication(azureEntraCognitiveServicesOAuth2Api, entra(), other, helpers),
    ).rejects.toThrow('its own endpoint');
    await expect(
      applyAuthentication(
        azureOpenAiApi,
        FOUNDRY,
        { url: 'http://res1.services.ai.azure.com/openai/v1/x' },
        helpers,
      ),
    ).rejects.toThrow('its own endpoint');
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps the key out of its error texts', async () => {
    const helpers = createCredentialHelpers(new FakeHttpClient(() => ({ body: {} })), []);
    const error = await applyAuthentication(
      azureOpenAiApi,
      FOUNDRY,
      { url: 'https://evil.example.com/x' },
      helpers,
    ).catch((e) => e as Error);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('has no test request and no stub left', () => {
    expect(azureOpenAiApi.test).toBeUndefined();
    expect(azureEntraCognitiveServicesOAuth2Api.test).toBeUndefined();
    expect(azureOpenAiApi.properties.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'endpointType',
        'resourceName',
        'apiVersion',
        'foundryEndpoint',
        'projectName',
        'apiKey',
      ]),
    );
  });
});

describe('Embeddings Microsoft Foundry', () => {
  async function embeddingsFor(
    http: FakeHttpClient,
    creds: Record<string, DataObject>,
    params: DataObject,
    authType = 'azureOpenAiApi',
  ) {
    const type = nodeTypes.get('ai.embeddingsAzureOpenAi')!;
    const n = withCreds(node('Emb', 'ai.embeddingsAzureOpenAi', params), authType);
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: services({ creds, http }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const ctx = {
      ...base,
      getInputData: () => [],
      getInputConnectionData: async () => undefined,
      runCode: async () => [],
      executeWorkflow: async () => ({ executionId: '', data: null }),
      getToolParameter: () => undefined,
      logSubNodeRun: () => undefined,
    };
    const { response } = await type.supplyData!(ctx, 0);
    return response as {
      dimensions?: number;
      embedDocuments(t: string[]): Promise<number[][]>;
      embedQuery(t: string): Promise<number[]>;
    };
  }

  const vectors = (req: HttpRequestOptions) => ({
    body: {
      data: (req.body as { input: string[] }).input
        .map((_t, index) => ({ index, embedding: [index, 1] }))
        .reverse(),
    },
  });

  it('classic: deployment path, api-version, api-key, new lines stripped, order kept', async () => {
    const http = new FakeHttpClient(vectors);
    const emb = await embeddingsFor(
      http,
      { azureOpenAiApi: CLASSIC },
      { model: 'embed-3', options: { dimensions: 256 } },
    );
    expect(await emb.embedDocuments(['a\nb', 'c\r\nd'])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(emb.dimensions).toBe(256);
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.openai.azure.com/openai/deployments/embed-3/embeddings');
    expect(req.qs).toEqual({ 'api-version': '2025-03-01-preview' });
    expect(req.headers?.['api-key']).toBe(KEY);
    expect(req.body).toEqual({ input: ['a b', 'c d'], dimensions: 256 });
  });

  it('keeps new lines when asked and sends no dimensions by default', async () => {
    const http = new FakeHttpClient(vectors);
    const emb = await embeddingsFor(
      http,
      { azureOpenAiApi: CLASSIC },
      { model: 'embed-3', options: { stripNewLines: false } },
    );
    await emb.embedQuery('a\nb');
    expect(http.bodies[0]).toEqual({ input: ['a\nb'] });
  });

  it('Foundry: /openai/v1/embeddings with the deployment as the model', async () => {
    const http = new FakeHttpClient(vectors);
    const emb = await embeddingsFor(http, { azureOpenAiApi: FOUNDRY }, { model: 'embed-3' });
    await emb.embedQuery('hello');
    const [req] = http.requests;
    expect(req.url).toBe('https://res1.services.ai.azure.com/openai/v1/embeddings');
    expect(req.qs).toBeUndefined();
    expect(req.body).toEqual({ model: 'embed-3', input: ['hello'] });
    expect(headerText(http)).not.toMatch(/openai-platform|n8n/i);
  });

  it('batches by 512 and caps a larger batch size', async () => {
    const http = new FakeHttpClient(vectors);
    const emb = await embeddingsFor(
      http,
      { azureOpenAiApi: FOUNDRY },
      { model: 'embed-3', options: { batchSize: 5000 } },
    );
    const out = await emb.embedDocuments(Array.from({ length: 1100 }, (_v, i) => `t${i}`));
    expect(out).toHaveLength(1100);
    expect(http.bodies.map((b) => b.input.length)).toEqual([512, 512, 76]);
  });

  it('uses the Entra bearer token', async () => {
    let tokens = 0;
    const http = new FakeHttpClient((req) =>
      req.url.includes('login.microsoftonline.com') ? tokenReply(`tok-${++tokens}`) : vectors(req),
    );
    const emb = await embeddingsFor(
      http,
      { azureEntraCognitiveServicesOAuth2Api: entra() },
      { model: 'embed-3', authentication: 'azureEntraCognitiveServicesOAuth2Api' },
      'azureEntraCognitiveServicesOAuth2Api',
    );
    await emb.embedQuery('a');
    await emb.embedQuery('b');
    expect(tokens).toBe(1);
    expect(http.requests.at(-1)?.headers?.authorization).toBe('Bearer tok-1');
  });

  it('refuses an empty deployment', async () => {
    await expect(
      embeddingsFor(new FakeHttpClient(vectors), { azureOpenAiApi: CLASSIC }, { model: '' }),
    ).rejects.toThrow('Choose a deployment');
  });
});

describe('deployment list', () => {
  function listContext(
    type: NodeType,
    creds: Record<string, DataObject>,
    http: FakeHttpClient,
    current: DataObject = {},
  ) {
    const credType = Object.keys(creds)[0];
    const n = withCreds(node('Node', type.description.name), credType);
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: services({ creds, http }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const { getNodeParameter: _omit, ...rest } = base;
    return { ...rest, getCurrentNodeParameter: (name: string) => current[name] } as LoadOptionsContext;
  }

  const DEPLOYMENTS = [
    { name: 'gpt-4o-prod', modelName: 'gpt-4o', capabilities: { chat_completion: 'true' } },
    { name: 'embed-3', modelName: 'text-embedding-3-small', capabilities: { embeddings: 'true' } },
    { name: 'claude-prod', modelName: 'claude-sonnet-5-5', capabilities: { chat_completion: true } },
    { name: 'gpt-mini', modelName: 'gpt-4o-mini', capabilities: { chatCompletion: 'True' } },
    { name: 'audio-1', modelName: 'gpt-audio', capabilities: { chat_completion: 'false' } },
    { name: 'no-caps', modelName: 'gpt-x' },
  ];

  it('lists the chat deployments of the project, filtered by name', async () => {
    const http = new FakeHttpClient(() => ({ body: { value: DEPLOYMENTS } }));
    const chat = nodeTypes.get('ai.lmChatAzureOpenAi')!;
    const search = chat.methods!.listSearch!.searchDeployments;
    const ctx = listContext(chat, { azureOpenAiApi: FOUNDRY }, http);
    expect((await search(ctx)).results).toEqual([
      { name: 'claude-prod (claude-sonnet-5-5)', value: 'claude-prod' },
      { name: 'gpt-4o-prod (gpt-4o)', value: 'gpt-4o-prod' },
      { name: 'gpt-mini (gpt-4o-mini)', value: 'gpt-mini' },
    ]);
    expect((await search(ctx, 'MINI')).results).toEqual([
      { name: 'gpt-mini (gpt-4o-mini)', value: 'gpt-mini' },
    ]);
    expect(http.requests[0].url).toBe('https://res1.services.ai.azure.com/api/projects/proj1/deployments');
    expect(http.requests[0].qs).toEqual({ 'api-version': 'v1' });
    expect(http.requests[0].headers?.['api-key']).toBe(KEY);
  });

  it('lists the same chat deployments for both families, and embedding deployments for the embeddings node', async () => {
    const http = new FakeHttpClient(() => ({ body: { value: DEPLOYMENTS } }));
    const chat = nodeTypes.get('ai.lmChatAzureOpenAi')!;
    const claude = await chat.methods!.listSearch!.searchDeployments(
      listContext(chat, { azureOpenAiApi: FOUNDRY }, http, { modelFamily: 'anthropic' }),
    );
    expect(claude.results.map((r) => r.value)).toEqual(['claude-prod', 'gpt-4o-prod', 'gpt-mini']);
    const embeddings = nodeTypes.get('ai.embeddingsAzureOpenAi')!;
    const embed = await embeddings.methods!.listSearch!.searchDeployments(
      listContext(embeddings, { azureOpenAiApi: FOUNDRY }, http),
    );
    expect(embed.results.map((r) => r.value)).toEqual(['embed-3']);
  });

  it('follows a next link on the same host only', async () => {
    const http = new FakeHttpClient((req, index) => {
      if (index === 0)
        return {
          body: {
            value: [DEPLOYMENTS[0]],
            nextLink: 'https://res1.services.ai.azure.com/api/projects/proj1/deployments?page=2',
          },
        };
      if (index === 1)
        return { body: { value: [DEPLOYMENTS[3]], nextLink: 'https://evil.example.com/steal' } };
      throw new Error(`unexpected ${req.url}`);
    });
    const chat = nodeTypes.get('ai.lmChatAzureOpenAi')!;
    const out = await chat.methods!.listSearch!.searchDeployments(
      listContext(chat, { azureOpenAiApi: FOUNDRY }, http),
    );
    expect(out.results.map((r) => r.value)).toEqual(['gpt-4o-prod', 'gpt-mini']);
    expect(http.requests.map((r) => new URL(r.url).hostname)).toEqual([
      'res1.services.ai.azure.com',
      'res1.services.ai.azure.com',
    ]);
  });

  it('needs a Foundry credential with a project', async () => {
    const http = new FakeHttpClient(() => ({ body: { value: [] } }));
    const chat = nodeTypes.get('ai.lmChatAzureOpenAi')!;
    const search = chat.methods!.listSearch!.searchDeployments;
    await expect(search(listContext(chat, { azureOpenAiApi: CLASSIC }, http))).rejects.toThrow(
      'Microsoft Foundry endpoint type',
    );
    await expect(
      search(listContext(chat, { azureOpenAiApi: { ...FOUNDRY, projectName: '' } }, http)),
    ).rejects.toThrow('project name');
    expect(http.requests).toHaveLength(0);
  });
});
