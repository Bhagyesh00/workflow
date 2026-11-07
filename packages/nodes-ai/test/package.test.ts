import { createBaseContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type LoadOptionsContext,
  type NodeType,
  portType,
  resolveNodeParameters,
  Workflow,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { credentials, nodes, nodesAiPackage } from '../src';
import { FakeHttpClient, node, nodeTypes, services } from './harness';

/** credential types used by AI nodes but owned by other packages (nodes-base) */
const EXTERNAL_CREDENTIALS = new Set([
  'postgres',
  'redis',
  'httpBasicAuth',
  'httpHeaderAuth',
  'httpBearerAuth',
  'aws',
  'awsAssumeRole',
  'googleApi',
  'databricksOAuth2Api',
  'mongoDb',
  'supabaseApi',
]);

/** no `test` request, as n8n: Vertex is tested by its node, Azure and SearXNG have no test */
const NO_TEST = new Set([
  'azureOpenAiApi',
  'azureEntraCognitiveServicesOAuth2Api',
  'googleVertexAiApi',
  'searXngApi',
]);

describe('package', () => {
  it('exports nodes and credentials', () => {
    expect(nodesAiPackage).toEqual({ name: '@workflow/nodes-ai', nodes, credentials });
    const required = [
      'agent',
      'chainLlm',
      'informationExtractor',
      'textClassifier',
      'sentimentAnalysis',
      'chainSummarization',
      'chainRetrievalQa',
      'chatTrigger',
      'vectorStoreInMemory',
      'vectorStorePGVector',
      'vectorStoreQdrant',
      'lmChatOpenAi',
      'lmChatAnthropic',
      'lmChatGoogleGemini',
      'lmChatOllama',
      'lmChatOpenAiCompatible',
      'memoryBufferWindow',
      'memoryPostgresChat',
      'memoryRedisChat',
      'toolCalculator',
      'toolCode',
      'toolHttpRequest',
      'toolWorkflow',
      'toolThink',
      'toolVectorStore',
      'mcpClientTool',
      'embeddingsOpenAi',
      'embeddingsGoogleGemini',
      'embeddingsOllama',
      'documentDefaultDataLoader',
      'textSplitterRecursiveCharacter',
      'textSplitterCharacter',
      'outputParserStructured',
      'outputParserItemList',
      'outputParserAutofixing',
      // S2: stores, reranker, retrievers, memories, tools, vendors
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
    expect(nodes.map((n) => n.description.name)).toEqual(expect.arrayContaining(required));
    expect(credentials.map((c) => c.name).sort()).toEqual(
      [
        'anthropicApi',
        'googleGeminiApi',
        'ollamaApi',
        'openAiApi',
        'openAiCompatibleApi',
        'qdrantApi',
        'mistralCloudApi',
        'cohereApi',
        'deepSeekApi',
        'groqApi',
        'xAiApi',
        'openRouterApi',
        'vercelAiGatewayApi',
        'nvidiaApi',
        'moonshotApi',
        'minimaxApi',
        'alibabaCloudApi',
        'lemonadeApi',
        'huggingFaceApi',
        'azureOpenAiApi',
        'azureEntraCognitiveServicesOAuth2Api',
        'googleVertexAiApi',
        'pineconeApi',
        'weaviateApi',
        'azureAiSearchApi',
        'chromaSelfHostedApi',
        'chromaCloudApi',
        'milvusApi',
        'xataApi',
        'searXngApi',
        'wolframAlphaApi',
      ].sort(),
    );
  });

  it('node descriptions follow the conventions', () => {
    const names = new Set<string>();
    const credentialNames = new Set(credentials.map((c) => c.name));
    for (const type of nodes) {
      const d = type.description;
      expect(d.name, d.name).toMatch(/^ai\.[a-z][A-Za-z0-9]*$/);
      expect(names.has(d.name), `duplicate ${d.name}`).toBe(false);
      names.add(d.name);
      expect(d.categories?.[0], d.name).toBe('AI');
      expect(d.categories?.length, d.name).toBe(2);
      expect(d.icon, d.name).toMatch(/^(lucide|simple):[a-z0-9-]+$/);
      for (const c of d.credentials ?? []) {
        expect(credentialNames.has(c.name) || EXTERNAL_CREDENTIALS.has(c.name), `${d.name}: ${c.name}`).toBe(
          true,
        );
      }
      // sub-nodes supply data, or execute as a tool; root nodes execute (or are triggers)
      const outputs = Array.isArray(d.outputs) ? d.outputs.map(portType) : [];
      if (outputs.length && outputs.every((o) => o !== 'main'))
        expect(Boolean(type.supplyData || (type.execute && outputs.includes('ai_tool'))), d.name).toBe(true);
      else expect(Boolean(type.execute || type.webhook), d.name).toBe(true);
      // defaults resolve without throwing
      expect(() => resolveNodeParameters(d.properties, {})).not.toThrow();
    }
  });

  it('credential types authenticate requests', async () => {
    const apply = async (name: string, data: DataObject) => {
      const type = credentials.find((c) => c.name === name)!;
      const { applyAuthentication } = await import('@workflow/core');
      return applyAuthentication(type, data, { url: 'https://x.test', headers: { a: '1' } });
    };
    expect((await apply('openAiApi', { apiKey: 'k' })).headers).toEqual({
      a: '1',
      authorization: 'Bearer k',
    });
    expect((await apply('anthropicApi', { apiKey: 'k' })).headers).toEqual({ a: '1', 'x-api-key': 'k' });
    expect((await apply('googleGeminiApi', { apiKey: 'k' })).headers).toEqual({
      a: '1',
      'x-goog-api-key': 'k',
    });
    expect((await apply('ollamaApi', {})).headers).toEqual({ a: '1' });
    expect((await apply('openAiCompatibleApi', { apiKey: 'k' })).headers).toEqual({
      a: '1',
      authorization: 'Bearer k',
    });
    expect((await apply('qdrantApi', { apiKey: 'k' })).headers).toEqual({ a: '1', 'api-key': 'k' });
    for (const c of credentials) {
      if (NO_TEST.has(c.name)) continue;
      // Xata's test URL is the endpoint and the branch: `={{$credentials.databaseEndpoint}}:{{...branch}}`
      expect(c.test?.request.url, c.name).toMatch(
        /^(=\{\{\$credentials\.\w+\}\}\/|=\{\{\$credentials\.databaseEndpoint\}\}:|https:\/\/)/,
      );
    }
  });
});

function loadOptionsContext(
  type: NodeType,
  parameters: DataObject,
  svc: ExecutionServices,
  credentialType: string,
): LoadOptionsContext {
  const n = node('Node', type.description.name, parameters, {
    credentials: { [credentialType]: { id: 'c', name: 'c' } },
  });
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
  const base = createBaseContext({
    workflow,
    node: n,
    services: svc,
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
  const { getNodeParameter: _omit, ...rest } = base;
  return { ...rest, getCurrentNodeParameter: (name) => parameters[name] };
}

describe('model lists (loadOptions)', () => {
  it('Anthropic pages through /v1/models', async () => {
    const http = new FakeHttpClient((req) =>
      req.qs?.after_id
        ? { body: { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false } }
        : {
            body: {
              data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }],
              has_more: true,
              last_id: 'claude-sonnet-5-5',
            },
          },
    );
    const type = nodeTypes.get('ai.lmChatAnthropic')!;
    const ctx = loadOptionsContext(
      type,
      {},
      services({ http, creds: { anthropicApi: { apiKey: 'k' } } }),
      'anthropicApi',
    );
    const options = await type.methods!.loadOptions!.listModels(ctx);
    expect(options).toEqual([
      { name: 'Claude Sonnet 5.5', value: 'claude-sonnet-5-5' },
      { name: 'Claude Haiku 5.5', value: 'claude-haiku-5-5' },
    ]);
    expect(http.requests[0].url).toBe('https://api.anthropic.com/v1/models');
    expect(http.requests[0].headers).toMatchObject({ 'anthropic-version': '2026-10-21', 'x-api-key': 'k' });
  });

  it('OpenAI lists chat models only', async () => {
    const http = new FakeHttpClient(() => ({
      body: {
        data: [
          { id: 'text-embedding-3-small' },
          { id: 'gpt-5' },
          { id: 'dall-e-3' },
          { id: 'gpt-5-mini' },
          { id: 'whisper-1' },
        ],
      },
    }));
    const type = nodeTypes.get('ai.lmChatOpenAi')!;
    const ctx = loadOptionsContext(
      type,
      {},
      services({ http, creds: { openAiApi: { apiKey: 'k' } } }),
      'openAiApi',
    );
    expect((await type.methods!.loadOptions!.listModels(ctx)).map((o) => o.value)).toEqual([
      'gpt-5',
      'gpt-5-mini',
    ]);
  });

  it('Gemini lists generateContent models without the models/ prefix', async () => {
    const http = new FakeHttpClient(() => ({
      body: {
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
      },
    }));
    const type = nodeTypes.get('ai.lmChatGoogleGemini')!;
    const ctx = loadOptionsContext(
      type,
      {},
      services({ http, creds: { googleGeminiApi: { apiKey: 'k' } } }),
      'googleGeminiApi',
    );
    expect(await type.methods!.loadOptions!.listModels(ctx)).toEqual([
      { name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    ]);
  });
});

describe('embeddings', () => {
  it('OpenAI embeddings batch inputs and keep result order', async () => {
    const http = new FakeHttpClient((req) => {
      const input = (req.body as { input: string[] }).input;
      // answer in reverse order: the client sorts by index
      return { body: { data: input.map((t, index) => ({ index, embedding: [t.length] })).reverse() } };
    });
    const type = nodeTypes.get('ai.embeddingsOpenAi')!;
    const svc = services({ http, creds: { openAiApi: { apiKey: 'k' } } });
    const n = node(
      'Emb',
      'ai.embeddingsOpenAi',
      { options: { batchSize: 2, dimensions: 256 } },
      { credentials: { openAiApi: { id: 'c', name: 'c' } } },
    );
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: svc,
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const logs: unknown[] = [];
    const ctx = {
      ...base,
      getInputData: () => [],
      getInputConnectionData: async () => undefined,
      runCode: async () => [],
      executeWorkflow: async () => ({ executionId: '', data: null }),
      getToolParameter: () => undefined,
      logSubNodeRun: (input: DataObject, output: DataObject) => void logs.push({ input, output }),
      getParentNodes: () => [],
    };
    const { response } = await type.supplyData!(ctx, 0);
    const embeddings = response as {
      embedDocuments(t: string[]): Promise<number[][]>;
      embedQuery(t: string): Promise<number[]>;
    };
    expect(await embeddings.embedDocuments(['a', 'bb', 'ccc'])).toEqual([[1], [2], [3]]);
    expect(await embeddings.embedQuery('dddd')).toEqual([4]);
    expect(http.bodies.map((b) => b.input)).toEqual([['a', 'bb'], ['ccc'], ['dddd']]);
    expect(http.bodies[0]).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 256,
      encoding_format: 'float',
    });
    expect(http.requests[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(logs).toHaveLength(3);
  });

  it('Gemini embeddings use task types per purpose', async () => {
    const http = new FakeHttpClient((req) => ({
      body: {
        embeddings: (req.body as { requests: unknown[] }).requests.map(() => ({ values: [0.1, 0.2] })),
      },
    }));
    const type = nodeTypes.get('ai.embeddingsGoogleGemini')!;
    const svc = services({ http, creds: { googleGeminiApi: { apiKey: 'k' } } });
    const n = node(
      'Emb',
      'ai.embeddingsGoogleGemini',
      {},
      { credentials: { googleGeminiApi: { id: 'c', name: 'c' } } },
    );
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: svc,
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
      logSubNodeRun: () => {},
      getParentNodes: () => [],
    };
    const embeddings = (await type.supplyData!(ctx, 0)).response as {
      embedDocuments(t: string[]): Promise<number[][]>;
      embedQuery(t: string): Promise<number[]>;
    };
    await embeddings.embedDocuments(['doc']);
    await embeddings.embedQuery('q');
    expect(http.requests[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect((http.bodies[0] as any).requests[0]).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'doc' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
    });
    expect((http.bodies[1] as any).requests[0].taskType).toBe('RETRIEVAL_QUERY');
  });
});
