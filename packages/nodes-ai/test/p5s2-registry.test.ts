/**
 * Phase 5 S2 C0g: the RAG credentials, the package registry of the new nodes, and the harness fakes
 * and constants the lanes use. Nothing here asserts a stub's behaviour.
 */
import { applyAuthentication } from '@workflow/core';
import type {
  AiDocument,
  AiReranker,
  CredentialType,
  DataObject,
  HttpRequestOptions,
  Item,
  SupplyDataContext,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { credentials, nodes, nodesAiPackage } from '../src';
import { ragCredentials } from '../src/credentials/rag.credentials';
import {
  connect,
  MapVectorBackend,
  MONGO_TEST_URL,
  node,
  nodeTypes,
  REDIS_CREDENTIALS,
  REDIS_SEARCH_CREDENTIALS,
  rerankerCalls,
  run,
  type StoredVector,
  testNodes,
  toolNodeTypes,
  vectorStoreMemoryData,
} from './harness';

const NEW_NODES = [
  'vectorStorePinecone',
  'vectorStoreSupabase',
  'vectorStoreWeaviate',
  'vectorStoreMongoDBAtlas',
  'vectorStoreRedis',
  'vectorStoreAzureAISearch',
  'vectorStoreChromaDB',
  'vectorStoreMilvus',
  'vectorStoreDatabricks',
  'rerankerCohere',
  'retrieverVectorStore',
  'retrieverContextualCompression',
  'retrieverMultiQuery',
  'retrieverWorkflow',
  'memoryManager',
  'memoryMongoDbChat',
  'memoryXata',
  'memoryLakebaseChat',
  'toolSearXng',
  'toolWikipedia',
  'toolWolframAlpha',
  'openAi',
  'anthropic',
  'googleGemini',
  'ollama',
  'moonshot',
  'alibabaCloud',
  'minimax',
  'databricksAiAgent',
].map((n) => `ai.${n}`);

const NEW_CREDENTIALS = [
  'pineconeApi',
  'weaviateApi',
  'azureAiSearchApi',
  'chromaSelfHostedApi',
  'chromaCloudApi',
  'milvusApi',
  'xataApi',
  'searXngApi',
  'wolframAlphaApi',
];

/** every secret field of the new credential types, by type */
const SECRET_FIELDS: Record<string, string[]> = {
  pineconeApi: ['apiKey'],
  weaviateApi: ['apiKey'],
  azureAiSearchApi: ['apiKey'],
  chromaSelfHostedApi: ['apiKey', 'token'],
  chromaCloudApi: ['apiKey'],
  milvusApi: ['password'],
  xataApi: ['apiKey'],
  searXngApi: [],
  wolframAlphaApi: ['appId'],
};

function credential(name: string): CredentialType {
  const type = credentials.find((c) => c.name === name);
  if (!type) throw new Error(`credential ${name} is not registered`);
  return type;
}

const SAMPLE: HttpRequestOptions = { url: 'https://x.test/path', headers: { a: '1' }, qs: { q: 'v' } };

async function apply(name: string, data: DataObject, request: HttpRequestOptions = SAMPLE) {
  return applyAuthentication(credential(name), data, structuredClone(request));
}

describe('registry', () => {
  it('registers every new node once', () => {
    const names = nodes.map((n) => n.description.name);
    for (const name of NEW_NODES)
      expect(
        names.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    expect(nodesAiPackage.nodes).toBe(nodes);
    for (const name of NEW_NODES) expect(nodeTypes.get(name), name).toBeDefined();
  });

  it('registers every new credential once, through aiCredentials', () => {
    const names = credentials.map((c) => c.name);
    for (const name of NEW_CREDENTIALS)
      expect(
        names.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    expect(ragCredentials.map((c) => c.name)).toEqual(NEW_CREDENTIALS);
    expect(nodesAiPackage.credentials).toBe(credentials);
  });

  it('keeps the field names of n8n (one URL field on Weaviate)', () => {
    const fields = (name: string) => credential(name).properties.map((p) => p.name);
    expect(fields('pineconeApi')).toEqual(['apiKey']);
    expect(fields('weaviateApi')).toEqual(['connection_type', 'url', 'apiKey']);
    expect(fields('azureAiSearchApi')).toEqual(['endpoint', 'apiKey']);
    expect(fields('chromaSelfHostedApi')).toEqual(['baseUrl', 'authentication', 'apiKey', 'token']);
    expect(fields('chromaCloudApi')).toEqual(['apiKey', 'tenant', 'database', 'baseUrl']);
    expect(fields('milvusApi')).toEqual(['baseUrl', 'username', 'password']);
    expect(fields('xataApi')).toEqual(['databaseEndpoint', 'branch', 'apiKey']);
    expect(fields('searXngApi')).toEqual(['apiUrl']);
    expect(fields('wolframAlphaApi')).toEqual(['appId']);
    const defaults = (name: string) =>
      Object.fromEntries(credential(name).properties.map((p) => [p.name, p.default]));
    expect(defaults('chromaSelfHostedApi')).toMatchObject({
      baseUrl: 'http://localhost:8000',
      authentication: 'none',
    });
    expect(defaults('chromaCloudApi').baseUrl).toBe('https://api.trychroma.com');
    expect(defaults('milvusApi').baseUrl).toBe('http://localhost:19530');
    expect(defaults('xataApi').branch).toBe('main');
    expect(defaults('weaviateApi').connection_type).toBe('weaviate_cloud');
  });

  it('test requests: n8n URLs, none for SearXNG', () => {
    const test = (name: string) => credential(name).test?.request;
    expect(test('pineconeApi')?.url).toBe('https://api.pinecone.io/indexes');
    expect(test('weaviateApi')?.url).toBe('={{$credentials.url}}/v1/nodes');
    expect(test('azureAiSearchApi')).toMatchObject({
      url: '={{$credentials.endpoint}}/indexes',
      qs: { 'api-version': '2024-07-01' },
    });
    expect(test('chromaSelfHostedApi')?.url).toBe('={{$credentials.baseUrl}}/api/v2/heartbeat');
    expect(test('chromaCloudApi')?.url).toBe('={{$credentials.baseUrl}}/api/v2');
    expect(test('milvusApi')?.url).toBe('={{$credentials.baseUrl}}/v1/vector/collections');
    expect(test('xataApi')?.url).toBe('={{$credentials.databaseEndpoint}}:{{$credentials.branch}}');
    expect(test('searXngApi')).toBeUndefined();
    expect(credential('searXngApi').authenticate).toBeUndefined();
  });
});

describe('credential authentication', () => {
  it('header keys', async () => {
    expect((await apply('pineconeApi', { apiKey: 'k' })).headers).toEqual({ a: '1', 'api-key': 'k' });
    expect((await apply('azureAiSearchApi', { apiKey: 'k' })).headers).toEqual({ a: '1', 'api-key': 'k' });
    expect((await apply('chromaCloudApi', { apiKey: 'k' })).headers).toEqual({
      a: '1',
      'x-chroma-token': 'k',
    });
    expect((await apply('xataApi', { apiKey: 'k' })).headers).toEqual({ a: '1', authorization: 'Bearer k' });
  });

  it('Weaviate sends a Bearer token only when a key is set', async () => {
    expect((await apply('weaviateApi', { url: 'https://w.test', apiKey: 'k' })).headers).toEqual({
      a: '1',
      authorization: 'Bearer k',
    });
    expect((await apply('weaviateApi', { url: 'https://w.test', apiKey: '' })).headers).toEqual({ a: '1' });
  });

  it('Chroma Self-Hosted: none, API key as Bearer, or token header', async () => {
    expect((await apply('chromaSelfHostedApi', { authentication: 'none', apiKey: 'k' })).headers).toEqual({
      a: '1',
    });
    expect((await apply('chromaSelfHostedApi', { authentication: 'apiKey', apiKey: 'k' })).headers).toEqual({
      a: '1',
      authorization: 'Bearer k',
    });
    expect((await apply('chromaSelfHostedApi', { authentication: 'token', token: 't' })).headers).toEqual({
      a: '1',
      'x-chroma-token': 't',
    });
    // a secret of the other mode is never sent
    expect((await apply('chromaSelfHostedApi', { authentication: 'apiKey', token: 't' })).headers).toEqual({
      a: '1',
    });
    expect((await apply('chromaSelfHostedApi', {})).headers).toEqual({ a: '1' });
  });

  it('Milvus sends Bearer user:password, nothing when both are empty', async () => {
    expect((await apply('milvusApi', { username: 'u', password: 'p' })).headers).toEqual({
      a: '1',
      authorization: 'Bearer u:p',
    });
    expect((await apply('milvusApi', { username: '', password: '' })).headers).toEqual({ a: '1' });
  });

  it('SearXNG changes nothing', async () => {
    expect(await apply('searXngApi', { apiUrl: 'https://s.test' })).toEqual(SAMPLE);
  });

  it('Wolfram Alpha sends the App ID as a header, never in the query string', async () => {
    const out = await apply('wolframAlphaApi', { appId: 'APP-SECRET' });
    expect(out.headers).toEqual({ a: '1', authorization: 'Bearer APP-SECRET' });
    expect(out.qs).toEqual({ q: 'v' });
    expect(out.url).toBe(SAMPLE.url);
    const bare = await apply('wolframAlphaApi', { appId: 'APP-SECRET' }, { url: 'https://x.test' });
    expect(bare.qs).toBeUndefined();
  });

  it("Wolfram Alpha's test request holds no App ID, and its authenticated form keeps it out of the URL", async () => {
    const test = credential('wolframAlphaApi').test!.request;
    expect(test.url).toBe('https://www.wolframalpha.com/api/v1/llm-api');
    expect(test.qs).toEqual({ input: '1+1' });
    expect(JSON.stringify(test)).not.toMatch(/appid|appId|\$credentials/i);
    const sent = await apply('wolframAlphaApi', { appId: 'APP-SECRET' }, test);
    expect(JSON.stringify({ url: sent.url, qs: sent.qs })).not.toContain('APP-SECRET');
    expect(sent.headers).toEqual({ authorization: 'Bearer APP-SECRET' });
  });
});

describe('secret fields', () => {
  it('every secret field has the password flag, and no other field has it', () => {
    for (const [name, secrets] of Object.entries(SECRET_FIELDS)) {
      const flagged = credential(name)
        .properties.filter((p) => p.typeOptions?.password === true)
        .map((p) => p.name);
      expect(flagged, name).toEqual(secrets);
      for (const field of secrets) {
        const property = credential(name).properties.find((p) => p.name === field);
        expect(property?.typeOptions?.password, `${name}.${field}`).toBe(true);
      }
    }
  });
});

describe('harness', () => {
  beforeEach(() => {
    rerankerCalls.length = 0;
    vectorStoreMemoryData.clear();
  });

  it('constants for the lanes', () => {
    expect(REDIS_SEARCH_CREDENTIALS).toEqual({ ...REDIS_CREDENTIALS, database: 0 });
    expect(REDIS_CREDENTIALS.database).toBe(2);
    expect(MONGO_TEST_URL).toBe('mongodb://127.0.0.1:27017/?directConnection=true');
  });

  it('the two fakes are test nodes, so they reach nodeTypes and toolNodeTypes', () => {
    const names = testNodes.map((n) => n.description.name);
    expect(names).toEqual(expect.arrayContaining(['test.fakeReranker', 'test.vectorStoreMemory']));
    for (const name of ['test.fakeReranker', 'test.vectorStoreMemory']) {
      expect(nodeTypes.get(name), name).toBeDefined();
      expect(toolNodeTypes.get(name), name).toBeDefined();
    }
    expect(nodeTypes.get('test.fakeReranker')!.description.outputs).toEqual(['ai_reranker']);
  });

  it('test.fakeReranker reverses the order, scores by position, records calls and keeps Top N', async () => {
    const docs: AiDocument[] = ['a', 'b', 'c', 'd'].map((t) => ({ pageContent: t, metadata: { t } }));
    const logged: unknown[] = [];
    const supply = async (topN: number) => {
      const ctx = {
        getNode: () => ({ name: 'Reranker' }),
        getNodeParameter: (name: string, _i: number, fallback: unknown) =>
          name === 'topN' ? topN : fallback,
        logSubNodeRun: (...args: unknown[]) => void logged.push(args),
      } as unknown as SupplyDataContext;
      return (await nodeTypes.get('test.fakeReranker')!.supplyData!(ctx, 0)).response as AiReranker;
    };
    const all = await (await supply(0)).rerank('q', docs);
    expect(all.map((r) => r.document.pageContent)).toEqual(['d', 'c', 'b', 'a']);
    expect(all.map((r) => r.score)).toEqual([1, 0.75, 0.5, 0.25]);
    const top = await (await supply(2)).rerank('q2', docs);
    expect(top.map((r) => r.document.pageContent)).toEqual(['d', 'c']);
    expect(rerankerCalls.map((c) => [c.node, c.query, c.documents.length])).toEqual([
      ['Reranker', 'q', 4],
      ['Reranker', 'q2', 4],
    ]);
    expect(logged).toHaveLength(2);
  });

  it('MapVectorBackend upserts by id, then metadata.id, then a new id', async () => {
    const entries = new Map<string, StoredVector>();
    const backend = new MapVectorBackend(entries);
    await backend.add(
      [
        { pageContent: 'one', metadata: {} },
        { pageContent: 'two', metadata: { id: 'm-2' } },
        { pageContent: 'three', metadata: {} },
      ],
      [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      ['x-1'],
    );
    expect(entries.size).toBe(3);
    expect(entries.get('x-1')?.document.pageContent).toBe('one');
    expect(entries.get('m-2')?.document.pageContent).toBe('two');
    await backend.add([{ pageContent: 'one again', metadata: { v: 2 } }], [[1, 0]], ['x-1']);
    expect(entries.size).toBe(3);
    expect(entries.get('x-1')?.document).toEqual({ pageContent: 'one again', metadata: { v: 2 } });
    const found = await backend.search([1, 0], 1);
    expect(found[0].document.pageContent).toBe('one again');
    expect(await backend.search([1, 0], 5, { v: 2 })).toHaveLength(1);
    await backend.clear();
    expect(entries.size).toBe(0);
  });

  it('test.vectorStoreMemory inserts and loads through the engine, by Memory Key', async () => {
    const items: Item[] = [
      { json: { text: 'Cats and dogs are pets' } },
      { json: { text: 'Pizza and pasta are food' } },
    ];
    const store = (mode: string, extra: DataObject = {}) =>
      node('Store', 'test.vectorStoreMemory', { mode, memoryKey: 'k1', ...extra });
    const inserted = await run(
      [
        node('Trigger', 'test.trigger'),
        store('insert'),
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
        }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: items },
    );
    expect(inserted.status).toBe('success');
    expect(vectorStoreMemoryData.get('k1')?.size).toBe(2);
    const loaded = await run(
      [
        node('Trigger', 'test.trigger'),
        store('load', { topK: 1 }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      { triggerItems: [{ json: { chatInput: 'my pizza' } }] },
    );
    expect(loaded.status).toBe('success');
    expect(loaded.output('Store').map((o) => (o.document as DataObject).pageContent)).toEqual([
      'Pizza and pasta are food',
    ]);
  });
});
