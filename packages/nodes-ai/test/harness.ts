/**
 * Test harness: run AI nodes through the real engine with in-memory services, a scripted fake
 * chat model sub-node, deterministic fake embeddings and a fake HTTP client.
 */
import {
  CredentialTypes,
  type ExecutionServices,
  HttpClient,
  HttpError,
  InlineBinaryDataStore,
  IsolatedVmCodeRunner,
  NodeTypes,
  silentLogger,
  WorkflowExecute,
} from '@workflow/core';
import { credentials as baseCredentials, nodes as baseNodes } from '@workflow/nodes-base';
import {
  type AiChatRequest,
  type AiChatResponse,
  type AiDocument,
  type AiReranker,
  type Connections,
  type ConnectionType,
  type DataObject,
  type HttpFullResponse,
  type HttpRequestOptions,
  type Item,
  type NodeType,
  Workflow,
  type WorkflowNode,
  withToolVariants,
} from '@workflow/workflow';
import { credentials, nodes } from '../src';
import {
  cosineSimilarity,
  createVectorStoreNode,
  matchesFilter,
  type ScoredDocument,
  type VectorBackend,
} from '../src/nodes/vector-stores/vector-store-factory';

// ---------------------------------------------------------------------------------------------
// Fake HTTP
// ---------------------------------------------------------------------------------------------

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeHandler = (request: HttpRequestOptions, index: number) => FakeReply | Promise<FakeReply>;

/** HttpClient whose responses come from a handler; every request (after auth) is recorded. */
export class FakeHttpClient extends HttpClient {
  readonly requests: HttpRequestOptions[] = [];

  constructor(private readonly handler: FakeHandler) {
    super();
  }

  override async request<T = unknown>(options: HttpRequestOptions): Promise<T | HttpFullResponse<T>> {
    const index = this.requests.length;
    this.requests.push(structuredClone(options));
    const reply = await this.handler(options, index);
    const status = reply.status ?? 200;
    const headers = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (!options.ignoreHttpStatusErrors && (status < 200 || status >= 300)) {
      const url = new URL(options.url);
      throw new HttpError(`Request failed with status code ${status}`, status, 'Error', reply.body, headers, {
        method: options.method ?? 'GET',
        url: `${url.origin}${url.pathname}`,
      });
    }
    if (options.returnFullResponse) {
      return { body: reply.body as T, headers, statusCode: status, statusMessage: 'OK' };
    }
    return reply.body as T;
  }

  /** request bodies as sent */
  get bodies(): any[] {
    return this.requests.map((r) => r.body);
  }
}

/** Respond to requests in order. */
export function sequence(...replies: FakeReply[]): FakeHandler {
  return (_req, index) => {
    const reply = replies[index];
    if (!reply) throw new Error(`Unexpected request #${index + 1}`);
    return reply;
  };
}

// ---------------------------------------------------------------------------------------------
// Scripted fake chat model and fake embeddings
// ---------------------------------------------------------------------------------------------

export type ModelScript = (request: AiChatRequest, call: number) => AiChatResponse | Promise<AiChatResponse>;

/** scripts and recorded requests by model node name */
export const modelScripts = new Map<string, ModelScript>();
export const modelRequests = new Map<string, AiChatRequest[]>();
/** calls per model node name: a model is supplied per item, its script spans all of them */
const modelCalls = new Map<string, number>();

export function scriptModel(
  nodeName: string,
  script: ModelScript | Array<AiChatResponse | string>,
): AiChatRequest[] {
  const requests: AiChatRequest[] = [];
  modelRequests.set(nodeName, requests);
  modelCalls.set(nodeName, 0);
  if (Array.isArray(script)) {
    modelScripts.set(nodeName, (_req, call) => {
      const step = script[call];
      if (step === undefined)
        throw new Error(`Fake model "${nodeName}" has no response for call ${call + 1}`);
      return typeof step === 'string' ? reply(step) : step;
    });
  } else modelScripts.set(nodeName, script);
  return requests;
}

export function reply(text: string, usage = { inputTokens: 10, outputTokens: 5 }): AiChatResponse {
  return { message: { role: 'assistant', content: text }, usage, stopReason: 'end' };
}

export function toolCalls(...calls: Array<[name: string, args: DataObject, id?: string]>): AiChatResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      toolCalls: calls.map(([name, args, id], i) => ({
        id: id ?? `call_${name}_${i}`,
        name,
        arguments: args,
      })),
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_calls',
  };
}

const fakeChatModelNode: NodeType = {
  description: {
    name: 'test.fakeChatModel',
    displayName: 'Fake Chat Model',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Model' },
    inputs: [],
    outputs: ['ai_languageModel'],
    properties: [
      { displayName: 'Streaming', name: 'streaming', type: 'boolean', default: false },
      { displayName: 'Structured', name: 'structured', type: 'boolean', default: true },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const name = ctx.getNode().name;
    const structured = Boolean(ctx.getNodeParameter('structured', itemIndex, true));
    const run = async (request: AiChatRequest) => {
      const script = modelScripts.get(name);
      if (!script) throw new Error(`No script for fake model "${name}"`);
      // record a deep copy: the agent keeps appending to the same messages array
      modelRequests.get(name)?.push(structuredClone({ ...request, signal: undefined }));
      const call = modelCalls.get(name) ?? 0;
      modelCalls.set(name, call + 1);
      const response = await script(request, call);
      ctx.logSubNodeRun({ messages: request.messages.length }, { content: String(response.message.content) });
      return response;
    };
    return {
      response: {
        kind: 'chatModel',
        provider: 'fake',
        model: 'fake-1',
        capabilities: { structuredOutput: structured, structuredOutputWithTools: structured },
        chat: run,
        ...(ctx.getNodeParameter('streaming', itemIndex, false)
          ? {
              async stream(request: AiChatRequest, onDelta: (text: string) => void) {
                const response = await run(request);
                const text = String(response.message.content);
                for (const word of text.split(/(?<= )/)) if (word) onDelta(word);
                return response;
              },
            }
          : {}),
      },
    };
  },
};

/** Deterministic bag-of-words vectors over a small vocabulary (cosine similarity = word overlap). */
export const VOCABULARY = [
  'cat',
  'dog',
  'pet',
  'car',
  'engine',
  'road',
  'sun',
  'moon',
  'sky',
  'food',
  'pizza',
  'pasta',
];
export function fakeVector(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const v = VOCABULARY.map((w) => words.filter((x) => x === w || x === `${w}s`).length);
  return v.some(Boolean) ? v : VOCABULARY.map((_, i) => (i === VOCABULARY.length - 1 ? 0.01 : 0));
}

export const embeddingCalls: string[][] = [];

const fakeEmbeddingsNode: NodeType = {
  description: {
    name: 'test.fakeEmbeddings',
    displayName: 'Fake Embeddings',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings' },
    inputs: [],
    outputs: ['ai_embedding'],
    properties: [],
  },
  async supplyData() {
    return {
      response: {
        kind: 'embeddings',
        dimensions: VOCABULARY.length,
        async embedDocuments(texts: string[]) {
          embeddingCalls.push(texts);
          return texts.map(fakeVector);
        },
        async embedQuery(text: string) {
          return fakeVector(text);
        },
      },
    };
  },
};

const triggerNode: NodeType = {
  description: {
    name: 'test.trigger',
    displayName: 'Trigger',
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Trigger' },
    inputs: [],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    return [items.length ? items : [{ json: {} }]];
  },
};

// ---------------------------------------------------------------------------------------------
// Fake reranker and a Map-backed vector store with every mode
// ---------------------------------------------------------------------------------------------

/** every call of a `test.fakeReranker`, in order; clear it in `beforeEach` */
export const rerankerCalls: Array<{ node: string; query: string; documents: AiDocument[] }> = [];

/**
 * Reverses the order it gets, so a test sees the reranker win over the store's ranking. Scores come
 * from the new position: (n - position) / n, so best first is 1. Top N 0 keeps every document.
 */
const fakeRerankerNode: NodeType = {
  description: {
    name: 'test.fakeReranker',
    displayName: 'Fake Reranker',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Reranker' },
    inputs: [],
    outputs: ['ai_reranker'],
    properties: [{ displayName: 'Top N', name: 'topN', type: 'number', default: 0 }],
  },
  async supplyData(ctx, itemIndex) {
    const name = ctx.getNode().name;
    const topN = Number(ctx.getNodeParameter('topN', itemIndex, 0)) || 0;
    const reranker: AiReranker = {
      kind: 'reranker',
      async rerank(query, documents) {
        rerankerCalls.push({ node: name, query, documents: structuredClone(documents) });
        const reversed = [...documents].reverse();
        const kept = topN > 0 ? reversed.slice(0, topN) : reversed;
        const ranked = kept.map((document, position) => ({
          document,
          score: (reversed.length - position) / reversed.length,
        }));
        ctx.logSubNodeRun({ query, documents: documents.length }, { documents: ranked.length });
        return ranked;
      },
    };
    return { response: reranker };
  },
};

export interface StoredVector {
  document: AiDocument;
  vector: number[];
}

/** documents of every `test.vectorStoreMemory` by Memory Key, then by id; clear it in `beforeEach` */
export const vectorStoreMemoryData = new Map<string, Map<string, StoredVector>>();
let vectorStoreMemoryIds = 0;

/**
 * Upserts by id: the id given by the factory, else `metadata.id`, else a new `doc-<n>`. A second add
 * with the same id replaces the document (P5-06's update test).
 */
export class MapVectorBackend implements VectorBackend {
  constructor(private readonly entries: Map<string, StoredVector>) {}

  async add(documents: AiDocument[], vectors: number[][], ids?: string[]): Promise<void> {
    documents.forEach((document, i) => {
      const given = ids?.[i] ?? document.metadata?.id;
      const id =
        given === undefined || given === null || given === ''
          ? `doc-${++vectorStoreMemoryIds}`
          : String(given);
      this.entries.set(id, {
        document: { pageContent: document.pageContent, metadata: { ...document.metadata } },
        vector: [...(vectors[i] ?? [])],
      });
    });
  }

  async search(vector: number[], k: number, filter?: DataObject): Promise<ScoredDocument[]> {
    return [...this.entries.values()]
      .filter((e) => matchesFilter(e.document.metadata, filter))
      .map((e) => ({
        document: { pageContent: e.document.pageContent, metadata: { ...e.document.metadata } },
        score: cosineSimilarity(vector, e.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

const vectorStoreMemoryNode: NodeType = createVectorStoreNode({
  name: 'test.vectorStoreMemory',
  displayName: 'Test Vector Store',
  description: 'Map-backed store with every mode, update included',
  icon: 'lucide:database',
  modes: ['load', 'insert', 'retrieve', 'retrieve-as-tool', 'update'],
  filter: 'metadata',
  properties: [{ displayName: 'Memory Key', name: 'memoryKey', type: 'string', default: 'test' }],
  async open(ctx, itemIndex) {
    const key = String(ctx.getNodeParameter('memoryKey', itemIndex, 'test') || 'test');
    let entries = vectorStoreMemoryData.get(key);
    if (!entries) {
      entries = new Map();
      vectorStoreMemoryData.set(key, entries);
    }
    return { backend: new MapVectorBackend(entries) };
  },
});

export const testNodes: NodeType[] = [
  triggerNode,
  fakeChatModelNode,
  fakeEmbeddingsNode,
  fakeRerankerNode,
  vectorStoreMemoryNode,
];
export const nodeTypes = new NodeTypes([...nodes, ...testNodes]);
/**
 * nodes-ai's credentials plus nodes-base `oAuth2Api`, the parent of `mcpOAuth2Api`: `getResolved` drops a
 * missing parent without an error, so without it `mcpOAuth2Api` would lose its OAuth2 fields and `isA`
 */
export const credentialTypes = new CredentialTypes([
  ...credentials,
  ...baseCredentials.filter((c) => c.name === 'oAuth2Api'),
]);
/** nodes-ai, nodes-base and the test nodes with their tool variants, as a server registers them */
export const toolNodeTypes = new NodeTypes(withToolVariants([...nodes, ...baseNodes, ...testNodes]));
export const toolCredentialTypes = new CredentialTypes([...credentials, ...baseCredentials]);

// ---------------------------------------------------------------------------------------------
// Workflow building and execution
// ---------------------------------------------------------------------------------------------

export function node(
  name: string,
  type: string,
  parameters: DataObject = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id: name, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra };
}

export type Link = [from: string, to: string, type?: ConnectionType, outputIndex?: number];

export function connect(...links: Link[]): Connections {
  const c: Connections = {};
  for (const [from, to, type = 'main', output = 0] of links) {
    const outputs = ((c[from] ??= {})[type] ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output]!.push({ node: to, type, index: 0 });
  }
  return c;
}

export const PG_CREDENTIALS = {
  host: '127.0.0.1',
  port: 5432,
  database: 'ai_test',
  user: 'postgres',
  password: 'postgres',
};
export const REDIS_CREDENTIALS = { host: '127.0.0.1', port: 6379, database: 2 };
/** Redis database 0: only the Redis vector store (L14) uses it, as RediSearch indexes need db 0 */
export const REDIS_SEARCH_CREDENTIALS = { ...REDIS_CREDENTIALS, database: 0 };
/**
 * The atlas-local test server (docker-compose.dev.yml `mongodb`, profile brokers). It is a one-node
 * replica set that reports its container host name, so only `directConnection` reaches it from here.
 */
export const MONGO_TEST_URL = 'mongodb://127.0.0.1:27017/?directConnection=true';

export function services(
  options: {
    creds?: Record<string, DataObject>;
    http?: HttpClient;
    tenantId?: string;
  } & Partial<ExecutionServices> = {},
): ExecutionServices {
  // a custom node registry can reach credential types of both packages
  const { creds = {}, http, tenantId, nodeTypes: customNodeTypes, ...overrides } = options;
  return {
    tenantId: tenantId ?? 't1',
    projectId: 'p1',
    executionId: 'e1',
    mode: 'manual',
    timezone: 'UTC',
    variables: {},
    instanceBaseUrl: 'http://localhost:5678',
    nodeTypes: customNodeTypes ?? nodeTypes,
    credentialTypes: customNodeTypes ? toolCredentialTypes : credentialTypes,
    credentials: { get: async (_ref, type) => creds[type] ?? {}, update: async () => {} },
    binaryData: new InlineBinaryDataStore(),
    codeRunner: new IsolatedVmCodeRunner({ timeoutMs: 5000, memoryLimitMb: 64 }),
    http: http ?? new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }),
    logger: silentLogger,
    ...overrides,
  };
}

export interface RunResult {
  status: string;
  error?: DataObject & { message?: string; code?: string };
  /** json of every output of `nodeName` (last run) */
  output(nodeName: string, outputIndex?: number): DataObject[];
  outputs(nodeName: string): DataObject[][];
  runData: Record<string, any[]>;
}

/** Run a workflow from its trigger (first node) with the given trigger items. */
export async function run(
  workflowNodes: WorkflowNode[],
  connections: Connections,
  options: {
    triggerItems?: Item[];
    services?: ExecutionServices;
    startNode?: string;
    nodeTypes?: ExecutionServices['nodeTypes'];
  } = {},
): Promise<RunResult> {
  const placed = workflowNodes.map((n, i) => ({ ...n, position: [i * 200, 0] as [number, number] }));
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: placed, connections },
    options.nodeTypes ?? nodeTypes,
  );
  const svc = options.services ?? services(options.nodeTypes ? { nodeTypes: options.nodeTypes } : {});
  const result = await new WorkflowExecute(workflow, svc).run({
    triggerItems: options.triggerItems,
    startNode: options.startNode ?? placed[0].name,
  });
  const runData = result.state.resultData.runData as Record<string, any[]>;
  const outputs = (name: string): DataObject[][] => {
    const runs = runData[name] ?? [];
    const last = runs[runs.length - 1];
    return ((last?.data?.main ?? []) as Item[][]).map((items) => (items ?? []).map((i) => i.json));
  };
  return {
    status: result.status,
    error: result.state.resultData.error as RunResult['error'],
    output: (name, outputIndex = 0) => outputs(name)[outputIndex] ?? [],
    outputs,
    runData,
  };
}
