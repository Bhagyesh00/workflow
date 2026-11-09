/** Test harness: run a node (or small workflow) through the real engine with in-memory services. */
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
import {
  type Connections,
  type DataObject,
  type HttpFullResponse,
  type HttpRequestOptions,
  type Item,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { credentials, nodes } from '../src';

export const nodeTypes = new NodeTypes(nodes);
export const credentialTypes = new CredentialTypes(credentials);

export function testServices(
  creds: Record<string, DataObject> = {},
  overrides: Partial<ExecutionServices> = {},
): ExecutionServices {
  return {
    tenantId: 't1',
    projectId: 'p1',
    executionId: 'e1',
    mode: 'manual',
    timezone: 'UTC',
    variables: {},
    instanceBaseUrl: 'http://localhost:5678',
    nodeTypes,
    credentialTypes,
    credentials: { get: async (_ref, type) => creds[type] ?? {}, update: async () => {} },
    binaryData: new InlineBinaryDataStore(),
    codeRunner: new IsolatedVmCodeRunner({ timeoutMs: 3000 }),
    http: new HttpClient(),
    logger: silentLogger,
    ...overrides,
  };
}

/** Execute one node with the given input items; returns its outputs (json only). */
export async function runNode(
  type: string,
  parameters: DataObject,
  input: Item[] = [{ json: {} }],
  options: {
    creds?: Record<string, DataObject>;
    node?: Partial<WorkflowNode>;
    services?: Partial<ExecutionServices>;
  } = {},
) {
  const workflow = new Workflow(
    {
      name: 'test',
      nodes: [
        {
          id: 'start',
          name: 'Start',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'n',
          name: 'Node',
          type,
          typeVersion: 1,
          position: [200, 0],
          parameters,
          credentials: Object.fromEntries(
            Object.keys(options.creds ?? {}).map((k) => [k, { id: k, name: k }]),
          ),
          ...options.node,
        },
      ],
      connections: { Start: { main: [[{ node: 'Node', type: 'main', index: 0 }]] } },
    },
    nodeTypes,
  );
  const engine = new WorkflowExecute(workflow, testServices(options.creds, options.services));
  const result = await engine.run({ triggerItems: input });
  const task = result.state.resultData.runData.Node?.[0];
  return {
    status: result.status,
    error: result.state.resultData.error,
    outputs: (task?.data?.main ?? []).map((items) => (items ?? []).map((i) => i.json)),
    items: (task?.data?.main ?? []) as Item[][],
    result,
    workflow,
  };
}

export function node(
  name: string,
  type: string,
  parameters: DataObject = {},
  position: [number, number] = [0, 0],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id: name, name, type, typeVersion: 1, position, parameters, ...extra };
}

/** connect(['A', 'B'], ['B', 'C', outputIndex, inputIndex]) */
export function connect(...pairs: Array<[string, string, number?, number?]>): Connections {
  const c: Connections = {};
  for (const [from, to, output = 0, input = 0] of pairs) {
    const outputs = ((c[from] ??= {}).main ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output]!.push({ node: to, type: 'main', index: input });
  }
  return c;
}

/** Run a small workflow from its trigger; `json(name, output?, run?)` reads a node's output. */
export async function runWorkflow(
  nodesList: WorkflowNode[],
  connections: Connections,
  input?: Item[],
  options: { creds?: Record<string, DataObject>; services?: Partial<ExecutionServices> } = {},
) {
  const workflow = new Workflow({ name: 'test', nodes: nodesList, connections }, nodeTypes);
  const engine = new WorkflowExecute(workflow, testServices(options.creds, options.services));
  const result = await engine.run({ triggerItems: input });
  const runData = result.state.resultData.runData;
  return {
    result,
    status: result.status,
    error: result.state.resultData.error,
    runData,
    json: (name: string, output = 0, run = -1) => {
      const runs = runData[name] ?? [];
      const task = runs[run < 0 ? runs.length - 1 : run];
      return (task?.data?.main?.[output] ?? []).map((i) => i.json);
    },
    items: (name: string, output = 0, run = -1) => {
      const runs = runData[name] ?? [];
      const task = runs[run < 0 ? runs.length - 1 : run];
      return (task?.data?.main?.[output] ?? []) as Item[];
    },
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  qs: Record<string, unknown>;
  body: unknown;
  bodyType?: string;
  options: HttpRequestOptions;
}

type Responder = (
  req: RecordedRequest,
) => unknown | { __status: number; body: unknown; headers?: Record<string, string> };

/**
 * HttpClient double for SaaS integrations: records every request (after credentials were
 * applied) and answers from a list of route handlers. A handler may return
 * `{ __status, body }` to simulate an error status.
 */
export class FakeHttpClient extends HttpClient {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: string; match: RegExp | string; respond: Responder }> = [];

  on(method: string, match: RegExp | string, respond: Responder): this {
    this.routes.push({ method: method.toUpperCase(), match, respond });
    return this;
  }

  override async request<T = unknown>(options: HttpRequestOptions): Promise<T | HttpFullResponse<T>> {
    const url = new URL(options.url);
    for (const [k, v] of Object.entries(options.qs ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const e of v) url.searchParams.append(k, String(e));
      else url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const headers: Record<string, string | string[]> = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (options.auth) {
      headers.authorization = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
    }
    const method = (options.method ?? 'GET').toUpperCase();
    const recorded: RecordedRequest = {
      method,
      url: url.toString(),
      headers,
      qs: { ...(options.qs ?? {}) },
      body: options.body,
      bodyType: options.bodyType,
      options,
    };
    this.requests.push(recorded);
    const route = this.routes.find(
      (r) =>
        (r.method === '*' || r.method === method) &&
        (typeof r.match === 'string' ? url.toString().startsWith(r.match) : r.match.test(url.toString())),
    );
    if (!route) throw new Error(`FakeHttpClient: no route for ${method} ${url.toString()}`);
    let answer = await route.respond(recorded);
    let status = 200;
    let responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
    if (answer && typeof answer === 'object' && '__status' in (answer as object)) {
      const a = answer as { __status: number; body: unknown; headers?: Record<string, string> };
      status = a.__status;
      answer = a.body;
      responseHeaders = { ...responseHeaders, ...(a.headers ?? {}) };
    }
    if ((status < 200 || status >= 300) && !options.ignoreHttpStatusErrors) {
      throw new HttpError(
        `Request failed with status code ${status}`,
        status,
        'Error',
        answer,
        responseHeaders,
        {
          method,
          url: `${url.origin}${url.pathname}`,
        },
      );
    }
    let body: unknown = answer;
    if (options.responseType === 'arraybuffer') {
      body =
        answer instanceof Uint8Array
          ? answer
          : Buffer.from(typeof answer === 'string' ? answer : JSON.stringify(answer));
    }
    if (options.returnFullResponse) {
      return { body: body as T, headers: responseHeaders, statusCode: status, statusMessage: 'OK' };
    }
    return body as T;
  }
}
