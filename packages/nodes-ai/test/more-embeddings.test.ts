/**
 * Phase 5 S1 P5-28: NVIDIA, Databricks, Lemonade and Hugging Face embeddings, and the OpenAI embeddings
 * options. Replies are fixtures written from the vendors' references; they prove the request we send.
 */
import { createBaseContext } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, Workflow, type WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { FakeHttpClient, node, nodeTypes, services, toolNodeTypes } from './harness';

interface Embedder {
  embedDocuments(t: string[]): Promise<number[][]>;
  embedQuery(t: string): Promise<number[]>;
}

async function embedder(
  type: string,
  credType: string,
  creds: DataObject,
  params: DataObject,
  http: FakeHttpClient,
): Promise<Embedder> {
  const n: WorkflowNode = node('Emb', type, params, { credentials: { [credType]: { id: 'c', name: 'c' } } });
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
  const base = createBaseContext({
    workflow,
    node: n,
    services: services({ http, creds: { [credType]: creds }, nodeTypes: toolNodeTypes }),
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
  const { response } = await nodeTypes.get(type)!.supplyData!(ctx as never, 0);
  return response as Embedder;
}

const vectors = (req: { body?: unknown }) => ({
  body: {
    data: (req.body as { input: string[] }).input.map((t, index) => ({ index, embedding: [t.length, 1] })),
  },
});

const noPartnerHeaders = (http: FakeHttpClient) => {
  const text = JSON.stringify(http.requests.map((r) => r.headers ?? {})).toLowerCase();
  expect(text).not.toContain('openai-platform');
  expect(text).not.toContain('n8n');
};

describe('NVIDIA embeddings', () => {
  it('posts to the default URL with a bearer key', async () => {
    const http = new FakeHttpClient(vectors);
    const e = await embedder('ai.embeddingsNvidia', 'nvidiaApi', { apiKey: 'nv-key' }, {}, http);
    expect(await e.embedQuery('abc')).toEqual([3, 1]);
    expect(http.requests[0].url).toBe('https://integrate.api.nvidia.com/v1/embeddings');
    expect(http.requests[0].body).toMatchObject({ model: 'nvidia/nv-embedqa-e5-v5', input: ['abc'] });
    noPartnerHeaders(http);
  });

  it('uses the credential URL', async () => {
    const http = new FakeHttpClient(vectors);
    const e = await embedder(
      'ai.embeddingsNvidia',
      'nvidiaApi',
      { url: 'https://nim.example.com/v1/' },
      { model: 'm1' },
      http,
    );
    await e.embedDocuments(['a']);
    expect(http.requests[0].url).toBe('https://nim.example.com/v1/embeddings');
  });
});

describe('Lemonade embeddings', () => {
  it('posts to the credential base URL', async () => {
    const http = new FakeHttpClient(vectors);
    const e = await embedder('ai.embeddingsLemonade', 'lemonadeApi', {}, { model: 'nomic' }, http);
    expect(await e.embedDocuments(['aa', 'b'])).toEqual([
      [2, 1],
      [1, 1],
    ]);
    expect(http.requests[0].url).toBe('http://localhost:8000/api/v1/embeddings');
    expect(http.requests[0].body).toMatchObject({ model: 'nomic', input: ['aa', 'b'] });
    noPartnerHeaders(http);
  });
});

describe('Databricks embeddings', () => {
  const HOST = 'https://adb-42.azuredatabricks.net';
  const clientCreds = (host = HOST): DataObject => ({
    host,
    grantType: 'clientCredentials',
    clientId: 'sp-1',
    clientSecret: 'dbx-secret-xyz',
  });

  it('calls <host>/ai-gateway/openai/v1 with the token', async () => {
    const http = new FakeHttpClient((req) =>
      req.url.endsWith('/oidc/v1/token') ? { body: { access_token: 'cc-token', expires_in: 3600 } } : vectors(req),
    );
    const e = await embedder('ai.embeddingsDatabricks', 'databricksOAuth2Api', clientCreds(), {}, http);
    expect(await e.embedQuery('hello')).toEqual([5, 1]);
    const call = http.requests.find((r) => r.url.includes('/embeddings'))!;
    expect(call.url).toBe(`${HOST}/ai-gateway/openai/v1/embeddings`);
    expect(JSON.stringify(call.headers)).toContain('cc-token');
    noPartnerHeaders(http);
  });

  it('refuses an http host before any request', async () => {
    const http = new FakeHttpClient(vectors);
    await expect(
      embedder(
        'ai.embeddingsDatabricks',
        'databricksOAuth2Api',
        clientCreds('http://adb-42.azuredatabricks.net'),
        {},
        http,
      ),
    ).rejects.toThrow(/https/);
    expect(http.requests).toHaveLength(0);
  });
});

describe('Hugging Face embeddings', () => {
  const featureExtraction = (req: { body?: unknown }) => ({
    body: (req.body as { inputs: string[] }).inputs.map((t) => [t.length, 0.5]),
  });

  it('uses the router with provider auto by default', async () => {
    const http = new FakeHttpClient(featureExtraction);
    const e = await embedder(
      'ai.embeddingsHuggingFaceInference',
      'huggingFaceApi',
      { apiKey: 'hf_k' },
      { model: 'BAAI/bge-small' },
      http,
    );
    expect(await e.embedDocuments(['ab', 'c'])).toEqual([
      [2, 0.5],
      [1, 0.5],
    ]);
    expect(http.requests[0].url).toBe(
      'https://router.huggingface.co/hf-inference/models/BAAI/bge-small/pipeline/feature-extraction',
    );
    expect(http.requests[0].body).toEqual({ inputs: ['ab', 'c'] });
    noPartnerHeaders(http);
  });

  it('sends to a custom endpoint when set', async () => {
    const http = new FakeHttpClient(featureExtraction);
    const e = await embedder(
      'ai.embeddingsHuggingFaceInference',
      'huggingFaceApi',
      { apiKey: 'hf_k' },
      { options: { endpointUrl: 'https://x.endpoints.huggingface.cloud/' } },
      http,
    );
    await e.embedQuery('q');
    expect(http.requests[0].url).toBe('https://x.endpoints.huggingface.cloud');
  });
});

describe('OpenAI embeddings options', () => {
  const run = async (params: DataObject, creds: DataObject = { apiKey: 'k' }) => {
    const http = new FakeHttpClient(vectors);
    const e = await embedder('ai.embeddingsOpenAi', 'openAiApi', creds, params, http);
    return { e, http };
  };

  it('strips new lines by default and keeps them when off', async () => {
    const a = await run({});
    await a.e.embedQuery('one\ntwo\r\nthree');
    expect((a.http.requests[0].body as { input: string[] }).input).toEqual(['one two three']);
    const b = await run({ options: { stripNewLines: false } });
    await b.e.embedQuery('one\ntwo');
    expect((b.http.requests[0].body as { input: string[] }).input).toEqual(['one\ntwo']);
  });

  it('overrides the base URL and the timeout', async () => {
    const { e, http } = await run({ options: { baseURL: 'https://proxy.example.com/v1/', timeout: 5000 } });
    await e.embedQuery('x');
    expect(http.requests[0].url).toBe('https://proxy.example.com/v1/embeddings');
    expect(http.requests[0].timeout).toBe(5000);
  });

  it('asks for base64 and decodes it', async () => {
    const buf = Buffer.alloc(8);
    buf.writeFloatLE(1.5, 0);
    buf.writeFloatLE(-2, 4);
    const http = new FakeHttpClient(() => ({ body: { data: [{ index: 0, embedding: buf.toString('base64') }] } }));
    const e = await embedder(
      'ai.embeddingsOpenAi',
      'openAiApi',
      { apiKey: 'k' },
      { options: { encodingFormat: 'base64' } },
      http,
    );
    expect(await e.embedQuery('x')).toEqual([1.5, -2]);
    expect(http.requests[0].body).toMatchObject({ encoding_format: 'base64' });
  });
});
