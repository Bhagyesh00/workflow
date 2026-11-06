/**
 * Phase 4 contract step, C0a: Python routing in runCode, task metadata, graph lookups, the WebhookContext
 * additions, the trigger's third emit argument and open-ended HTTP streams.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type DataObject,
  type DataTableAccess,
  ExpressionEvaluator,
  type FormAuthHelper,
  type HttpResponseStream,
  NodeOperationError,
  type NodeType,
  type RunCodeOptions,
  type WebhookRequest,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CodeRunner,
  type CodeRunnerInput,
  createBaseContext,
  createExecuteContext,
  createTriggerContext,
  createWebhookContext,
  type ExecutionServices,
  HttpClient,
  NodeTypes,
  PYTHON_DISABLED_MESSAGE,
  PyodideCodeRunner,
  type PyodideRunnerOptions,
  WorkflowExecute,
} from '../src';
import { connect, node, services, testNodes } from './helpers';

const callbacks = {
  getInputConnectionData: async () => undefined,
  putExecutionToWait: () => {},
  continueOnFail: () => false,
  addExecutionHints: () => {},
};

function recordingRunner() {
  const seen: CodeRunnerInput[] = [];
  const runner: CodeRunner = {
    async run(input) {
      seen.push(input);
      return [{ json: { ran: true } }];
    },
  };
  return { seen, runner };
}

function depsFor(
  overrides: Partial<ExecutionServices> = {},
  definition?: Partial<WorkflowDefinition>,
  nodeName = 'Set',
) {
  const nodes = definition?.nodes ?? [node('Set', 'test.set')];
  const workflow = new Workflow(
    { name: 'w', connections: {}, ...definition, nodes },
    new NodeTypes(testNodes),
  );
  return {
    workflow,
    node: nodes.find((n) => n.name === nodeName) as WorkflowNode,
    services: services(overrides),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  };
}

const run = (options: RunCodeOptions, overrides: Partial<ExecutionServices>) =>
  createExecuteContext(depsFor(overrides), callbacks).runCode(options);
const code = { code: 'return _items', mode: 'runOnceForAllItems' } as const;

describe('python in runCode', () => {
  it('without a python runner gives the disabled text naming PYTHON_ENABLED', async () => {
    const js = recordingRunner();
    for (const language of ['pythonNative', 'python']) {
      const options = { ...code, language } as RunCodeOptions;
      const error = await run(options, { codeRunner: js.runner }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NodeOperationError);
      expect((error as Error).message).toBe(PYTHON_DISABLED_MESSAGE);
      expect((error as Error).message).toContain('`PYTHON_ENABLED`');
      expect((error as Error).message).not.toContain('N8N_');
    }
    expect(js.seen).toHaveLength(0);
  });

  it('a python runner gets language and query, and the alias python arrives as pythonNative', async () => {
    const js = recordingRunner();
    const py = recordingRunner();
    const overrides = { codeRunner: js.runner, pythonRunner: py.runner };
    await expect(run({ ...code, language: 'pythonNative', query: 'hi' }, overrides)).resolves.toEqual([
      { json: { ran: true } },
    ]);
    await run({ ...code, language: 'python', query: { a: 1 } } as unknown as RunCodeOptions, overrides);
    expect(py.seen.map((i) => [i.language, i.query])).toEqual([
      ['pythonNative', 'hi'],
      ['pythonNative', { a: 1 }],
    ]);
    expect(py.seen[0]?.code).toBe(code.code);
    expect(js.seen).toHaveLength(0);
  });

  it('JavaScript stays on the code runner and gets the same fields', async () => {
    const js = recordingRunner();
    const py = recordingRunner();
    const overrides = { codeRunner: js.runner, pythonRunner: py.runner };
    await run({ ...code, query: 'q' }, overrides);
    await run({ ...code, language: 'javaScript' }, overrides);
    expect(js.seen.map((i) => [i.language, i.query])).toEqual([
      [undefined, 'q'],
      ['javaScript', undefined],
    ]);
    expect(py.seen).toHaveLength(0);
  });
});

describe('helpers and expressions read the new services', () => {
  it('helpers.dataTables is the host access, undefined without one', () => {
    const dataTables = { rowsExist: async () => true } as unknown as DataTableAccess;
    expect(createBaseContext(depsFor({ dataTables })).helpers.dataTables).toBe(dataTables);
    expect(createBaseContext(depsFor()).helpers.dataTables).toBeUndefined();
  });

  it('$execution.resumeFormUrl comes from the services', () => {
    const url = '/form-waiting/e1?signature=abc';
    const ctx = createBaseContext(depsFor({ resumeFormUrl: url }));
    expect(ctx.evaluateExpression('={{ $execution.resumeFormUrl }}', 0)).toBe(url);
  });
});

describe('setMetadata lands on the task', () => {
  const metaNodes: NodeType[] = [
    {
      description: {
        name: 'test.meta',
        displayName: 'Meta',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Meta' },
        inputs: ['main'],
        outputs: ['main'],
        properties: [],
      },
      async execute(ctx) {
        ctx.setMetadata({ first: 1, shared: 'a' });
        ctx.setMetadata({ shared: 'b' });
        const fail = ctx.getNode().parameters.fail;
        if (fail === 'always' || (fail === 'once' && ctx.getContext('flow').failed !== true)) {
          ctx.getContext('flow').failed = true;
          ctx.setMetadata({ onlyInFailedTry: true });
          throw new Error('boom');
        }
        return [ctx.getInputData()];
      },
    },
  ];
  const runMeta = (metaNode: WorkflowNode) => {
    const nodeTypes = new NodeTypes([...testNodes, ...metaNodes]);
    const workflow = new Workflow(
      {
        name: 'w',
        nodes: [node('Trigger', 'test.trigger'), metaNode, node('After', 'test.set', [400, 0])],
        connections: connect(['Trigger', 'Meta'], ['Meta', 'After']),
      },
      nodeTypes,
    );
    return new WorkflowExecute(workflow, services({ nodeTypes })).run({ triggerItems: [{ json: {} }] });
  };

  it('merges calls, and a node that sets nothing has no metadata', async () => {
    const result = await runMeta(node('Meta', 'test.meta', [200, 0]));
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Meta?.[0]?.metadata).toEqual({ first: 1, shared: 'b' });
    expect(result.state.resultData.runData.After?.[0]?.metadata).toBeUndefined();
    expect(result.state.resultData.runData.Trigger?.[0]?.metadata).toBeUndefined();
  });

  it('a failed node keeps what it set', async () => {
    const result = await runMeta(node('Meta', 'test.meta', [200, 0], { parameters: { fail: 'always' } }));
    expect(result.status).toBe('error');
    expect(result.state.resultData.runData.Meta?.[0]?.metadata).toEqual({
      first: 1,
      shared: 'b',
      onlyInFailedTry: true,
    });
  });

  it('a retry starts clean and the attempt number stays the engine value', async () => {
    const result = await runMeta(
      node('Meta', 'test.meta', [200, 0], {
        parameters: { fail: 'once' },
        retryOnFail: true,
        maxTries: 2,
        waitBetweenTries: 0,
      }),
    );
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Meta?.[0]?.metadata).toEqual({
      first: 1,
      shared: 'b',
      attempt: 2,
    });
  });
});

describe('getParentNodes and getChildNodes', () => {
  const definition = {
    nodes: [
      node('A', 'test.trigger'),
      node('B', 'test.set', [200, 0]),
      node('C', 'test.if', [400, 0]),
      node('Other', 'test.set', [0, 300]),
    ],
    connections: connect(['A', 'B'], ['B', 'C']),
  };
  const request: WebhookRequest = { method: 'GET', headers: {}, query: {}, params: {}, body: {} };

  it('walk the graph with name and type on the execute context', () => {
    const ctx = createExecuteContext(depsFor({}, definition, 'B'), callbacks);
    expect(ctx.getChildNodes()).toEqual([{ name: 'C', type: 'test.if' }]);
    expect(ctx.getParentNodes()).toEqual([{ name: 'A', type: 'test.trigger' }]);
  });

  it('reach every level, nearest first, on the webhook context', () => {
    const first = createWebhookContext(depsFor({}, definition, 'A'), request, 'default');
    expect(first.getChildNodes()).toEqual([
      { name: 'B', type: 'test.set' },
      { name: 'C', type: 'test.if' },
    ]);
    expect(first.getParentNodes()).toEqual([]);
    const last = createWebhookContext(depsFor({}, definition, 'C'), request, 'default');
    expect(last.getParentNodes()).toEqual([
      { name: 'B', type: 'test.set' },
      { name: 'A', type: 'test.trigger' },
    ]);
    expect(last.getChildNodes()).toEqual([]);
  });
});

describe('WebhookContext form additions', () => {
  const request: WebhookRequest = { method: 'GET', headers: {}, query: {}, params: {}, body: {} };
  const context = (overrides: Partial<ExecutionServices> = {}) =>
    createWebhookContext(depsFor(overrides), request, 'default');

  it('read the services', async () => {
    const formAuth = { signInUrl: () => '/form-auth' } as unknown as FormAuthHelper;
    const seen: Array<[DataObject, number]> = [];
    const ctx = context({
      resumeFormUrl: '/form-waiting/e1',
      formAuth,
      formTokens: {
        sign(payload, ttlSeconds) {
          seen.push([payload, ttlSeconds]);
          return 'signed';
        },
        verify: (token) => (token === 'signed' ? { page: 2 } : null),
      },
    });
    expect(ctx.getResumeFormUrl()).toBe('/form-waiting/e1');
    expect(ctx.getFormAuth()).toBe(formAuth);
    expect(ctx.signFormToken({ page: 2 }, 60)).toBe('signed');
    expect(seen).toEqual([[{ page: 2 }, 60]]);
    expect(ctx.verifyFormToken('signed')).toEqual({ page: 2 });
    expect(ctx.verifyFormToken('forged')).toBeNull();
  });

  it('getBinaryBuffer reads the binary store', async () => {
    const ctx = context();
    const stored = await ctx.helpers.prepareBinaryData(new Uint8Array([1, 2, 3]), 'a.bin');
    expect([...(await ctx.getBinaryBuffer(stored))]).toEqual([1, 2, 3]);
  });

  it('with no host support: nothing verifies, signing throws, the rest is undefined', () => {
    const ctx = context();
    expect(ctx.getResumeFormUrl()).toBeUndefined();
    expect(ctx.getFormAuth()).toBeUndefined();
    expect(ctx.verifyFormToken('anything')).toBeNull();
    expect(() => ctx.signFormToken({}, 60)).toThrow(NodeOperationError);
  });
});

describe('TriggerContext.emit', () => {
  it('hands all three arguments to the host', () => {
    const calls: unknown[][] = [];
    const ctx = createTriggerContext(depsFor(), {
      emit: (...args) => calls.push(args),
      emitError: () => {},
      activationMode: 'init',
    });
    const data = [[{ json: { a: 1 } }]];
    const done = { resolve: () => {}, reject: () => {} };
    const responseHook = () => {};
    ctx.emit(data, done, responseHook);
    expect(calls).toEqual([[data, done, responseHook]]);
    expect(calls[0]?.[2]).toBe(responseHook);
  });
});

describe('HttpClient streamNoTotalTimeout', () => {
  /** `/slow` sends its headers and first chunk at once and the rest after 500 ms, `/slow-long` after 1500 ms */
  const server = http.createServer((req, res) => {
    if (req.url === '/slow' || req.url === '/slow-long') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('first');
      const timer = setTimeout(() => res.end('-last'), req.url === '/slow' ? 500 : 1500);
      res.once('close', () => clearTimeout(timer));
    } else if (req.url === '/forever') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('open');
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('0123456789012345678901234567890123456789');
    } else if (req.url === '/no-headers') {
      // never answers
    } else if (req.url === '/failing-slow-body') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.write('partial');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  let base = '';
  const client = (maxResponseBytes?: number) =>
    new HttpClient({ ssrf: { allow: ['localhost'] }, maxResponseBytes });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const text = async (stream: HttpResponseStream) => {
    let out = '';
    for await (const chunk of stream) out += Buffer.from(chunk).toString();
    return out;
  };

  it('a stream outlives the timeout once the headers are in', async () => {
    // the timeout is for the headers, so it is long enough for a busy machine; the body takes longer
    const stream = (await client().request<HttpResponseStream>({
      url: `${base}/slow-long`,
      responseType: 'stream',
      streamNoTotalTimeout: true,
      timeout: 700,
    })) as HttpResponseStream;
    await expect(text(stream)).resolves.toBe('first-last');
  });

  it('without the option the same stream still ends at the timeout', async () => {
    const stream = (await client().request<HttpResponseStream>({
      url: `${base}/slow`,
      responseType: 'stream',
      timeout: 150,
    })) as HttpResponseStream;
    await expect(text(stream)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a normal request still times out', async () => {
    await expect(
      client().request({ url: `${base}/slow`, responseType: 'text', timeout: 150 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the option ignored without responseType stream keeps the timeout', async () => {
    await expect(
      client().request({
        url: `${base}/slow`,
        responseType: 'text',
        streamNoTotalTimeout: true,
        timeout: 150,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the timeout still runs until the headers', async () => {
    await expect(
      client().request({
        url: `${base}/no-headers`,
        responseType: 'stream',
        streamNoTotalTimeout: true,
        timeout: 150,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the byte cap does not apply to the stream, and still does without the option', async () => {
    const options = { url: `${base}/big`, responseType: 'stream' } as const;
    const open = await client(10).request<HttpResponseStream>({ ...options, streamNoTotalTimeout: true });
    await expect(text(open as HttpResponseStream)).resolves.toHaveLength(40);
    const capped = await client(10).request<HttpResponseStream>(options);
    await expect(text(capped as HttpResponseStream)).rejects.toThrow(/maximum size/);
  });

  it('the abort signal still ends the stream', async () => {
    const controller = new AbortController();
    const stream = (await client().request<HttpResponseStream>(
      { url: `${base}/forever`, responseType: 'stream', streamNoTotalTimeout: true, timeout: 150 },
      controller.signal,
    )) as HttpResponseStream;
    const read = text(stream);
    setTimeout(() => controller.abort(new Error('stopped')), 300);
    await expect(read).rejects.toThrow('stopped');
  });

  it('an error answer is still read under the timeout, so a stalled error body cannot hang', async () => {
    await expect(
      client().request({
        url: `${base}/failing-slow-body`,
        responseType: 'stream',
        streamNoTotalTimeout: true,
        timeout: 150,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the guard still blocks a private address', async () => {
    await expect(
      new HttpClient().request({
        url: `${base}/slow`,
        responseType: 'stream',
        streamNoTotalTimeout: true,
      }),
    ).rejects.toThrow(/fetch failed|blocked|not allowed/i);
  });
});

describe('PyodideCodeRunner stub', () => {
  it('is exported with its options shape', () => {
    const options: PyodideRunnerOptions = {
      memoryLimitMb: 256,
      timeoutMs: 1000,
      maxConcurrency: 5,
      stdlibAllow: [],
      externalAllow: [],
      builtinsDeny: [],
      allowTransitiveImports: false,
    };
    const runner: CodeRunner = new PyodideCodeRunner(options);
    expect(runner).toBeInstanceOf(PyodideCodeRunner);
  });
});
