import {
  createNodeAsTool,
  type ExecutionServices,
  type HttpClient,
  NodeTypes,
  type ToolRunHost,
} from '@workflow/core';
import { nodes as baseNodes } from '@workflow/nodes-base';
import {
  type AiTool,
  type DataObject,
  type ExecuteData,
  type HttpRequestOptions,
  type Item,
  isToolSuspension,
  type NodeType,
  type WorkflowNode,
  withToolVariants,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import {
  connect,
  FakeHttpClient,
  type Link,
  modelRequests,
  node,
  reply,
  run,
  scriptModel,
  services,
  testNodes,
  toolCalls,
  toolNodeTypes,
} from './harness';

const SECRET = 'cred-value-do-not-leak';
const CREDENTIAL = { httpHeaderAuth: { name: 'X-Api-Key', value: SECRET } };

/** a tool test node: its parameter `value` is read with `$fromAI` and given back */
const echoNode: NodeType = {
  description: {
    name: 'test.echo',
    displayName: 'Echo',
    description: 'Gives back what it reads',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Echo' },
    inputs: ['main'],
    outputs: ['main'],
    usableAsTool: true,
    properties: [{ displayName: 'Value', name: 'value', type: 'string', default: '' }],
  },
  async execute(ctx) {
    const value = ctx.getNodeParameter('value', 0, '');
    ctx.addExecutionHints({ message: `hint for ${String(value)}` });
    ctx.setMetadata({ seen: String(value) });
    return [[{ json: { value: value as DataObject[string], input: ctx.getInputData()[0].json } }]];
  },
};

let failures = 0;
let attempts = 0;
const flakyNode: NodeType = {
  description: {
    ...echoNode.description,
    name: 'test.flaky',
    displayName: 'Flaky',
    defaults: { name: 'Flaky' },
  },
  async execute() {
    attempts++;
    if (attempts <= failures) throw new Error(`failure ${attempts}`);
    return [[{ json: { attempts } }]];
  },
};

const binaryNode: NodeType = {
  description: {
    ...echoNode.description,
    name: 'test.binary',
    displayName: 'Binary',
    defaults: { name: 'Binary' },
    properties: [{ displayName: 'Mode', name: 'mode', type: 'string', default: 'only' }],
  },
  async execute(ctx) {
    const binary = { data: { data: 'aGk=', mimeType: 'text/plain' } };
    return ctx.getNodeParameter('mode', 0) === 'only'
      ? [[{ json: {}, binary }]]
      : [[{ json: { kept: true }, binary }, { json: { other: 1 } }]];
  },
};

const waitNode: NodeType = {
  description: {
    ...echoNode.description,
    name: 'test.wait',
    displayName: 'Wait',
    defaults: { name: 'Wait' },
    webhooks: [
      { name: 'default', httpMethod: 'GET', path: 'answer', isFullPath: false, restartWebhook: true },
    ],
  },
  async execute(ctx) {
    await ctx.putExecutionToWait(new Date('2030-01-02T03:04:05Z'));
    return [ctx.getInputData()];
  },
};

const emptyNode: NodeType = {
  description: {
    ...echoNode.description,
    name: 'test.empty',
    displayName: 'Empty',
    defaults: { name: 'Empty' },
  },
  async execute() {
    return null;
  },
};

const twoItemsNode: NodeType = {
  description: { ...echoNode.description, name: 'test.two', displayName: 'Two', defaults: { name: 'Two' } },
  async execute() {
    return [[{ json: { n: 1 } }, { json: { n: 2 } }]];
  },
};

const notToolNode: NodeType = {
  description: {
    ...echoNode.description,
    name: 'test.notTool',
    displayName: 'Not Tool',
    defaults: { name: 'Not Tool' },
    usableAsTool: undefined,
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
};

const types = new NodeTypes(
  withToolVariants([
    ...nodes,
    ...baseNodes,
    ...testNodes,
    echoNode,
    flakyNode,
    binaryNode,
    waitNode,
    emptyNode,
    twoItemsNode,
    notToolNode,
  ]),
);

function toolServices(overrides: Partial<ExecutionServices> & { http?: HttpClient } = {}) {
  return services({ creds: CREDENTIAL, nodeTypes: types, ...overrides });
}

/** an agent on a scripted model with the given tool nodes, after a Trigger that sends `items` */
async function agentRun(
  tools: WorkflowNode[],
  script: Parameters<typeof scriptModel>[1],
  options: {
    services?: ExecutionServices;
    items?: Item[];
    agentOptions?: DataObject;
    extraNodes?: WorkflowNode[];
    extraLinks?: Link[];
  } = {},
) {
  const requests = scriptModel('Model', script);
  const svc = options.services ?? toolServices();
  const links: Link[] = options.extraLinks ?? [['Trigger', 'Agent']];
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      ...(options.extraNodes ?? []),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'go',
        options: { returnIntermediateSteps: true, ...options.agentOptions },
      }),
      node('Model', 'test.fakeChatModel'),
      ...tools,
    ],
    connect(
      ...links,
      ['Model', 'Agent', 'ai_languageModel'],
      ...tools.map((t): Link => [t.name, 'Agent', 'ai_tool']),
    ),
    { services: svc, nodeTypes: types, triggerItems: options.items },
  );
  return { result, requests, svc };
}

function httpTool(parameters: DataObject, name = 'Call API'): WorkflowNode {
  return node(
    name,
    'core.httpRequestTool',
    { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...parameters },
    { credentials: { httpHeaderAuth: { id: 'c1', name: 'c1' } } },
  );
}

const headerOf = (request: HttpRequestOptions, name: string) =>
  Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

beforeEach(() => {
  failures = 0;
  attempts = 0;
});

describe('an agent calls a node as a tool', () => {
  it('core.httpRequestTool: values and credential go out, the model gets the JSON result', async () => {
    const http = new FakeHttpClient(() => ({
      body: { temperature: 21 },
      headers: { 'content-type': 'application/json' },
    }));
    const { result, requests } = await agentRun(
      [
        httpTool({
          method: 'POST',
          url: `=https://api.test/cities/{{ $fromAI('city', 'The city', 'string') }}`,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: `={{ JSON.stringify({ unit: $fromAI('unit', 'The unit', 'string'), days: $fromAI('days', 'How many', 'number') }) }}`,
        }),
      ],
      [toolCalls(['Call_API', { city: 'Pune', unit: 'C', days: 3 }, 'call-1']), reply('It is warm')],
      { services: toolServices({ http }) },
    );

    expect(result.status).toBe('success');
    expect(result.output('Agent')[0].output).toBe('It is warm');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe('https://api.test/cities/Pune');
    expect(http.requests[0].method).toBe('POST');
    expect(http.requests[0].body).toEqual({ unit: 'C', days: 3 });
    expect(headerOf(http.requests[0], 'X-Api-Key')).toBe(SECRET);

    const tools = requests[0].tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Call_API');
    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city' },
        unit: { type: 'string', description: 'The unit' },
        days: { type: 'number', description: 'How many' },
      },
      required: ['city', 'unit', 'days'],
    });

    const toolMessage = requests[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe(JSON.stringify([{ temperature: 21 }]));
    expect(toolMessage?.toolCallId).toBe('call-1');
  });

  it('the model never sees the credential, nor does the run data of the call', async () => {
    const http = new FakeHttpClient(() => ({ body: { ok: true } }));
    const { result } = await agentRun(
      [httpTool({ url: `=https://api.test/{{ $fromAI('path') }}` })],
      [toolCalls(['Call_API', { path: 'a' }]), reply('done')],
      { services: toolServices({ http }) },
    );
    expect(headerOf(http.requests[0], 'X-Api-Key')).toBe(SECRET);
    const seenByModel = JSON.stringify(modelRequests.get('Model'));
    expect(seenByModel).not.toContain(SECRET);
    expect(JSON.stringify(result.runData['Call API'])).not.toContain(SECRET);
  });

  it('a model reply that looks like an expression goes out as literal text', async () => {
    const http = new FakeHttpClient(() => ({ body: { ok: true } }));
    process.env.P5_FROM_AI_SECRET = 'env-secret';
    try {
      await agentRun(
        [
          httpTool({
            method: 'POST',
            url: `={{ $fromAI('address') }}`,
            sendBody: true,
            contentType: 'raw',
            rawContentType: 'text/plain',
            body: `={{ $fromAI('text') }}`,
          }),
        ],
        [
          toolCalls([
            'Call_API',
            { address: 'https://api.test/x', text: '={{ $env.P5_FROM_AI_SECRET }}{{ 1 + 1 }}' },
          ]),
          reply('done'),
        ],
        { services: toolServices({ http }) },
      );
    } finally {
      delete process.env.P5_FROM_AI_SECRET;
    }
    expect(http.requests[0].body).toBe('={{ $env.P5_FROM_AI_SECRET }}{{ 1 + 1 }}');
  });

  it('an argument the schema does not declare is dropped and cannot shadow $json.x', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $json.x }}|{{ $fromAI('y') }}` })],
      [toolCalls(['Echo', { y: 'declared', x: 'from the model' }]), reply('done')],
      { items: [{ json: { x: 'from the item' } }] },
    );
    const [item] = JSON.parse(String(requests[1].messages.find((m) => m.role === 'tool')?.content));
    expect(item.value).toBe('from the item|declared');
    expect(item.input.x).toBe('from the item');
  });

  it('the merged item holds the agent item, the arguments and the toolCallId, and no binary', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $json.toolCallId }}|{{ $fromAI('toolCallId') }}` })],
      [toolCalls(['Echo', { toolCallId: 'from the model' }, 'real-id']), reply('done')],
      { items: [{ json: { x: 1 }, binary: { data: { data: 'aGk=', mimeType: 'text/plain' } } }] },
    );
    const [item] = JSON.parse(String(requests[1].messages.find((m) => m.role === 'tool')?.content));
    expect(item.input).toEqual({ x: 1, toolCallId: 'real-id' });
    // the item holds the call's id, while $fromAI still reads what the model sent
    expect(item.value).toBe('real-id|from the model');
  });

  it('a declared default is used when the model leaves the key out', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('limit', 'How many', 'number', 10) }}` })],
      [toolCalls(['Echo', {}]), reply('done')],
    );
    const tool = requests[0].tools?.[0];
    expect(tool?.parameters.required).toBeUndefined();
    const [item] = JSON.parse(String(requests[1].messages.find((m) => m.role === 'tool')?.content));
    expect(item.value).toBe(10);
    expect(item.input.limit).toBe(10);
  });

  it(`$('Node').item in a tool parameter follows the agent's item`, async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $('Set').item.json.who }}` })],
      [toolCalls(['Echo', {}]), reply('one'), toolCalls(['Echo', {}]), reply('two')],
      {
        items: [{ json: { who: 'first' } }, { json: { who: 'second' } }],
        extraNodes: [node('Set', 'test.notTool')],
        extraLinks: [
          ['Trigger', 'Set'],
          ['Set', 'Agent'],
        ],
      },
    );
    const results = requests
      .flatMap((r) => r.messages.filter((m) => m.role === 'tool'))
      .map((m) => JSON.parse(String(m.content))[0].value);
    expect(new Set(results)).toEqual(new Set(['first', 'second']));
  });

  it('$json in a tool parameter of a later item reads that item', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $json.who }}/{{ $fromAI('k') }}` })],
      [toolCalls(['Echo', { k: 'a' }]), reply('one'), toolCalls(['Echo', { k: 'b' }]), reply('two')],
      { items: [{ json: { who: 'first' } }, { json: { who: 'second' } }] },
    );
    const results = requests
      .flatMap((r) => r.messages.filter((m) => m.role === 'tool'))
      .map((m) => JSON.parse(String(m.content))[0].value);
    expect(new Set(results)).toEqual(new Set(['first/a', 'second/b']));
  });

  it('parallel calls keep their own hints and metadata, and none reach the agent', async () => {
    const { result } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('k') }}` })],
      [toolCalls(['Echo', { k: 'a' }, 'id-a'], ['Echo', { k: 'b' }, 'id-b']), reply('done')],
    );
    const runs = result.runData.Echo;
    expect(runs).toHaveLength(2);
    const byArg = Object.fromEntries(
      runs.map((task) => [task.inputOverride.ai_tool[0][0].json.k, task.data.ai_tool[0][0].json]),
    );
    expect(byArg.a.hints).toEqual([{ message: 'hint for a' }]);
    expect(byArg.b.hints).toEqual([{ message: 'hint for b' }]);
    expect(byArg.a.metadata).toEqual({ seen: 'a' });
    expect(byArg.b.metadata).toEqual({ seen: 'b' });
    const agentTask = result.runData.Agent[0];
    expect(JSON.stringify(agentTask.hints ?? [])).not.toContain('hint for');
    expect(JSON.stringify(agentTask.metadata ?? {})).not.toContain('seen');
  });

  it('one run per call, input as the arguments under ai_tool, output under ai_tool, source the agent', async () => {
    const { result } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('k') }}` })],
      [toolCalls(['Echo', { k: 'a', dropped: 1 }]), reply('done')],
    );
    const [task, ...rest] = result.runData.Echo;
    expect(rest).toEqual([]);
    expect(task.executionStatus).toBe('success');
    expect(task.inputOverride).toEqual({ ai_tool: [[{ json: { k: 'a' } }]] });
    expect(task.data.ai_tool[0][0].json.response).toEqual([
      { value: 'a', input: { k: 'a', toolCallId: expect.any(String) } },
    ]);
    expect(task.source).toEqual([{ previousNode: 'Agent' }]);
  });

  it('a failed call logs an error run and the model gets the error', async () => {
    failures = 99;
    const { requests, result } = await agentRun(
      [node('Flaky', 'test.flakyTool')],
      [toolCalls(['Flaky', {}]), reply('sorry')],
    );
    expect(attempts).toBe(1);
    expect(result.runData.Flaky[0].executionStatus).toBe('error');
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('failure 1');
  });

  it('a scan error stops the agent with the error users see', async () => {
    const { result } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('k', 'one') }}{{ $fromAI('k', 'two') }}` })],
      [reply('never')],
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain(`Duplicate key 'k' found with different description or type`);
  });

  it('a reserved key is refused at run time', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('getPrototypeOf') }}` })],
      [toolCalls(['Echo', { getPrototypeOf: 'x' }]), reply('done')],
    );
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('Invalid parameter key');
  });

  it('a call with __proto__ pollutes nothing', async () => {
    const { requests } = await agentRun(
      [node('Echo', 'test.echoTool', { value: `={{ $fromAI('k') }}` })],
      [
        toolCalls(['Echo', JSON.parse('{"k":"a","__proto__":{"polluted":true}}') as DataObject]),
        reply('done'),
      ],
    );
    expect(({} as DataObject).polluted).toBeUndefined();
    const [item] = JSON.parse(String(requests[1].messages.find((m) => m.role === 'tool')?.content));
    expect(item.input.polluted).toBeUndefined();
    expect(Object.keys(item.input)).toEqual(['k', 'toolCallId']);
  });

  it('a node without the flag has no tool variant, and is refused as a tool', async () => {
    expect(types.get('test.notToolTool')).toBeUndefined();
    const { result } = await agentRun([node('Plain', 'test.notTool')], [reply('never')]);
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('cannot be used as a ai_tool sub-node');
  });

  it('the description the model sees: an expression in the text is resolved', async () => {
    const { requests } = await agentRun(
      [
        node('Echo', 'test.echoTool', {
          toolDescription: '=Echo for {{ $json.who }}',
          value: 'x',
        }),
      ],
      [reply('done')],
      { items: [{ json: { who: 'me' } }] },
    );
    expect(requests[0].tools?.[0].description).toBe('Echo for me');
  });

  it('the description defaults to the node description, and to the action on an operation node', async () => {
    const { requests } = await agentRun(
      [
        node('Echo', 'test.echoTool', { value: 'x' }),
        node('Tok', 'core.jwtTool', { operation: 'decode', token: 'x' }),
      ],
      [reply('done')],
    );
    const tools = requests[0].tools ?? [];
    expect(tools.find((t) => t.name === 'Echo')?.description).toBe('Gives back what it reads');
    expect(tools.find((t) => t.name === 'Tok')?.description).toMatch(/ in JWT$/);
  });
});

describe('result to the model', () => {
  it('gives every item as JSON', async () => {
    const { requests } = await agentRun(
      [node('Two', 'test.twoTool')],
      [toolCalls(['Two', {}]), reply('done')],
    );
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toBe(
      JSON.stringify([{ n: 1 }, { n: 2 }]),
    );
  });

  it('no output gives an empty list', async () => {
    const { requests } = await agentRun(
      [node('Empty', 'test.emptyTool')],
      [toolCalls(['Empty', {}]), reply('done')],
    );
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toBe('[]');
  });

  it('binary only gives the error text', async () => {
    const { requests } = await agentRun(
      [node('Binary', 'test.binaryTool', { mode: 'only' })],
      [toolCalls(['Binary', {}]), reply('done')],
    );
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toBe(
      'Error: The Tool attempted to return binary data, which is not supported in Agents',
    );
  });

  it('mixed warns and drops the binary', async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => warnings.push(m) };
    const { requests } = await agentRun(
      [node('Binary', 'test.binaryTool', { mode: 'mixed' })],
      [toolCalls(['Binary', {}]), reply('done')],
      { services: toolServices({ logger: logger as ExecutionServices['logger'] }) },
    );
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toBe(
      JSON.stringify([{ kept: true }, { other: 1 }]),
    );
    expect(warnings.some((w) => w.includes('binary data'))).toBe(true);
  });
});

describe('retry', () => {
  const flaky = (extra: Partial<WorkflowNode>) =>
    node('Flaky', 'test.flakyTool', {}, { retryOnFail: true, waitBetweenTries: 0, ...extra });

  it('honours retryOnFail', async () => {
    failures = 2;
    const { requests } = await agentRun([flaky({ maxTries: 3 })], [toolCalls(['Flaky', {}]), reply('done')]);
    expect(attempts).toBe(3);
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toBe(
      JSON.stringify([{ attempts: 3 }]),
    );
  });

  it('clamps the tries to at least 2', async () => {
    failures = 99;
    await agentRun([flaky({ maxTries: 1 })], [toolCalls(['Flaky', {}]), reply('done')]);
    expect(attempts).toBe(2);
  });

  it('clamps the tries to at most 5', async () => {
    failures = 99;
    await agentRun([flaky({ maxTries: 50 })], [toolCalls(['Flaky', {}]), reply('done')]);
    expect(attempts).toBe(5);
  });

  it('logs one run for the call, however many tries it took', async () => {
    failures = 1;
    const { result } = await agentRun([flaky({ maxTries: 2 })], [toolCalls(['Flaky', {}]), reply('done')]);
    expect(result.runData.Flaky).toHaveLength(1);
    expect(result.runData.Flaky[0].executionStatus).toBe('success');
  });

  it('waits up to 5000 ms between tries', async () => {
    failures = 1;
    const started = Date.now();
    const timers: number[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number' && ms >= 1000) timers.push(ms);
      return original(fn, ms === 5000 ? 0 : ms, ...(rest as []));
    }) as typeof setTimeout;
    try {
      await agentRun(
        [flaky({ maxTries: 2, waitBetweenTries: 60_000 })],
        [toolCalls(['Flaky', {}]), reply('done')],
      );
    } finally {
      globalThis.setTimeout = original;
    }
    expect(timers).toContain(5000);
    expect(timers).not.toContain(60_000);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('the signal', () => {
  it('the tool timeout aborts the request of the node', async () => {
    let requestSignal: AbortSignal | undefined;
    let aborted = false;
    class HangingHttp extends FakeHttpClient {
      constructor() {
        super(() => ({ body: {} }));
      }
      override request<T = unknown>(_options: HttpRequestOptions, signal?: AbortSignal): Promise<T> {
        requestSignal = signal;
        return new Promise<T>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          });
        });
      }
    }
    const { requests, result } = await agentRun(
      [httpTool({ url: 'https://api.test/slow' })],
      [toolCalls(['Call_API', {}]), reply('gave up')],
      {
        services: toolServices({ http: new HangingHttp() as HttpClient }),
        agentOptions: { toolTimeout: 30 },
      },
    );
    expect(requestSignal).toBeDefined();
    expect(aborted).toBe(true);
    expect(result.status).toBe('success');
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toMatch(/^Error: /);
  });
});

/** a host with no engine: the things the engine's own tests cover are not what these tests read */
function hostFor(
  tool: WorkflowNode,
  logged: unknown[] = [],
): { host: ToolRunHost; parent: WorkflowNode; exec: ExecuteData } {
  const parent = node('Agent', 'ai.agent');
  const svc = toolServices();
  const host: ToolRunHost = {
    workflow: {
      id: 'wf',
      name: 'wf',
      active: false,
      nodes: { [tool.name]: tool, Agent: parent },
      settings: {},
      staticData: {},
      nodeTypes: types,
      getNodeType: (n: WorkflowNode) => types.get(n.type),
      getParentNodes: () => [],
      getChildNodes: () => [],
    } as unknown as ToolRunHost['workflow'],
    services: svc,
    evaluator: {
      resolve: (value: unknown) => value,
      evaluate: () => undefined,
    } as unknown as ToolRunHost['evaluator'],
    state: {
      resultData: { runData: {} },
      executionData: { contextData: {} },
    } as unknown as ToolRunHost['state'],
    contextDeps: (n, exec, runIndex, signal) => ({
      workflow: host.workflow,
      node: n,
      services: svc,
      evaluator: host.evaluator,
      signal,
      state: host.state,
      runIndex,
      executeData: exec,
    }),
    supplySubNodes: async () => [],
    logSubNodeRun: (...args) => {
      logged.push(args);
    },
  };
  const exec: ExecuteData = { node: 'Agent', data: { main: [[{ json: { x: 1 } }]] }, source: null };
  return { host, parent, exec };
}

function toolFor(tool: WorkflowNode, logged?: unknown[], signal = new AbortController().signal): AiTool {
  const { host, parent, exec } = hostFor(tool, logged);
  return createNodeAsTool(host, tool, types.get(tool.type) as NodeType, parent, exec, 0, signal);
}

describe('createNodeAsTool', () => {
  it('is a tool with the name, schema and kind the agent reads', () => {
    const tool = toolFor(node('My Echo!', 'test.echoTool', { value: `$fromAI('k', 'A key')` }));
    expect(tool.kind).toBe('tool');
    expect(tool.name).toBe('My_Echo');
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { k: { type: 'string', description: 'A key' } },
      required: ['k'],
    });
  });

  it('canWait is true when the type has webhooks', () => {
    expect(toolFor(node('Echo', 'test.echoTool')).canWait).toBe(false);
    expect(toolFor(node('Wait', 'test.waitTool')).canWait).toBe(true);
  });

  it('a node that puts the run to wait makes the tool throw ToolSuspension, and logs no run', async () => {
    const logged: unknown[] = [];
    const tool = toolFor(node('Wait', 'test.waitTool'), logged);
    const error = await tool.invoke({}, { toolCallId: 'call-9' }).catch((e: unknown) => e);
    expect(isToolSuspension(error)).toBe(true);
    expect(error).toMatchObject({
      toolNode: 'Wait',
      toolName: 'Wait',
      toolCallId: 'call-9',
      waitTill: new Date('2030-01-02T03:04:05Z'),
    });
    expect((error as { gatedTool?: unknown }).gatedTool).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it('a suspension is not retried', async () => {
    let calls = 0;
    const counting: NodeType = {
      ...waitNode,
      async execute(ctx) {
        calls++;
        return waitNode.execute!(ctx);
      },
    };
    const toolNode = node('Wait', 'test.waitTool', {}, { retryOnFail: true, maxTries: 3 });
    const { host, parent, exec } = hostFor(toolNode);
    const tool = createNodeAsTool(host, toolNode, counting, parent, exec, 0, new AbortController().signal);
    await expect(tool.invoke({})).rejects.toSatisfy(isToolSuspension);
    expect(calls).toBe(1);
  });

  it('without a call id it still holds one, and an argument named toolCallId does not win', async () => {
    const seen: DataObject[] = [];
    const reader: NodeType = {
      ...echoNode,
      async execute(ctx) {
        seen.push(ctx.getInputData()[0].json);
        return [[{ json: {} }]];
      },
    };
    const toolNode = node('Echo', 'test.echoTool', { value: `$fromAI('toolCallId')` });
    const { host, parent, exec } = hostFor(toolNode);
    const tool = createNodeAsTool(host, toolNode, reader, parent, exec, 0, new AbortController().signal);
    await tool.invoke({ toolCallId: 'from the model' });
    expect(seen[0].toolCallId).toEqual(expect.any(String));
    expect(seen[0].toolCallId).not.toBe('from the model');
  });

  it('an empty value for a json key gives the text of the rule', async () => {
    const tool = toolFor(node('Echo', 'test.echoTool', { value: `$fromAI('data', 'd', 'json')` }));
    for (const data of [{}, [], 'text', 5]) {
      await expect(tool.invoke({ data } as DataObject)).rejects.toThrow(
        'Value must be a non-empty object or a non-empty array',
      );
    }
  });

  it('the outer signal aborts the call as well', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    let seen: AbortSignal | undefined;
    const reader: NodeType = {
      ...echoNode,
      async execute(ctx) {
        seen = ctx.signal;
        return [[{ json: {} }]];
      },
    };
    const toolNode = node('Echo', 'test.echoTool');
    const { host, parent, exec } = hostFor(toolNode);
    const tool = createNodeAsTool(host, toolNode, reader, parent, exec, 0, controller.signal);
    await tool.invoke({}).catch(() => undefined);
    expect(seen?.aborted).toBe(true);
  });
});

describe('registry', () => {
  it('the harness has the variants of the eight nodes this item flags', () => {
    for (const name of [
      'core.dateTime',
      'core.compression',
      'core.jwt',
      'core.totp',
      'app.redis',
      'app.mqtt',
      'app.rabbitmq',
      'app.amqp',
    ]) {
      const base = toolNodeTypes.get(name);
      expect(base?.description.usableAsTool, name).toBe(true);
      const variant = toolNodeTypes.get(`${name}Tool`);
      expect(variant?.description.inputs, name).toEqual([]);
      expect(variant?.description.outputs, name).toEqual(['ai_tool']);
      expect(variant?.execute, name).toBe(base?.execute);
    }
  });

  it('the send and wait nodes have their Human review copies by the rule', () => {
    for (const name of ['app.slack', 'app.gmail', 'app.telegram', 'core.sendEmail']) {
      const base = baseNodes.find((n) =>
        n.description.name.toLowerCase().includes(name.split('.')[1].toLowerCase()),
      );
      expect(base, name).toBeDefined();
      expect(toolNodeTypes.get(`${base?.description.name}HitlTool`), name).toBeDefined();
    }
    expect(toolNodeTypes.get('core.httpRequestHitlTool')).toBeUndefined();
  });
});
