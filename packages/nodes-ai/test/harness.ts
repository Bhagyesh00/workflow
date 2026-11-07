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

export const testNodes: NodeType[] = [triggerNode, fakeChatModelNode, fakeEmbeddingsNode];
export const nodeTypes = new NodeTypes([...nodes, ...testNodes]);
export const credentialTypes = new CredentialTypes(credentials);
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
