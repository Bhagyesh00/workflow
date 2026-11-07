/** Phase 5 S1 contract step, C0a: tool suspension, `$fromAI` at run time, slots, highlighted keys, new types. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AccessToken,
  type AiChatModel,
  type AiChatRequest,
  type AiContentPart,
  type AiTool,
  type AwsSignInput,
  type ClientCredentialsInput,
  type CredentialAuthHelpers,
  type CredentialType,
  createDataProxy,
  type ExecuteContext,
  type ExecutionState,
  type ExpressionDataContext,
  ExpressionError,
  ExpressionEvaluator,
  extractFromAiArguments,
  FROM_AI_MARKER,
  FromAiError,
  fromAiSchema,
  fromAiValue,
  fromAiVariables,
  HIGHLIGHTED_SESSION_KEY,
  hasSendAndWaitOperation,
  highlightedInputKey,
  highlightedResponseKey,
  hitlApproved,
  type InstanceLimits,
  type Item,
  isHitlVariant,
  isToolNode,
  isToolSuspension,
  isToolVariant,
  type JwtBearerInput,
  type LoadOptionsContext,
  type NodeInputConfig,
  type NodeOutputConfig,
  type NodeProperty,
  type NodeType,
  type NodeTypeDescription,
  type ResourceMapperFields,
  type ResourceMapperValue,
  type SupplyDataContext,
  ToolSuspension,
  type ToolSuspensionState,
  toHitlVariant,
  toolDescriptionFor,
  toolNameOf,
  toToolVariant,
  Workflow,
  type WorkflowNode,
  withToolVariants,
} from '../src';

const WAIT = new Date('2026-11-07T00:00:00.000Z');
const LONG_KEY_TEXT =
  'Invalid parameter key, must be between 1 and 64 characters long and only contain lowercase letters, uppercase letters, numbers, underscores, and hyphens';

function context(json: Record<string, unknown>, extra?: Record<string, unknown>): ExpressionDataContext {
  return {
    workflow: { name: 'w', active: false, nodes: {} },
    runData: {},
    activeNodeName: 'Set',
    connectionInputData: [{ json } as Item],
    itemIndex: 0,
    runIndex: 0,
    mode: 'manual',
    executionId: 'e1',
    timezone: 'UTC',
    extra,
  };
}

describe('ToolSuspension', () => {
  const fields = { toolNode: 'Slack', waitTill: WAIT, toolName: 'Slack', toolCallId: 'c1' };

  it('carries its fields and is an Error', () => {
    const gatedTool = { name: 'delete_row', arguments: { id: 1 } };
    const e = new ToolSuspension({ ...fields, gatedTool });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ToolSuspension');
    expect(e).toMatchObject({ ...fields, gatedTool });
    expect(new ToolSuspension(fields).gatedTool).toBeUndefined();
  });

  it('isToolSuspension checks a brand, not the class of this copy', () => {
    expect(isToolSuspension(new ToolSuspension(fields))).toBe(true);
    const fromOtherCopy = new Error('x');
    Object.defineProperty(fromOtherCopy, Symbol.for('@workflow/workflow.ToolSuspension'), { value: true });
    expect(isToolSuspension(fromOtherCopy)).toBe(true);
  });

  it('isToolSuspension refuses look-alikes', () => {
    for (const other of [
      new Error('x'),
      { ...fields },
      Object.assign(new Error('x'), fields, { name: 'ToolSuspension' }),
      null,
      undefined,
      'ToolSuspension',
    ]) {
      expect(isToolSuspension(other)).toBe(false);
    }
  });

  it('the suspended state is on the execution and survives JSON', () => {
    const suspended: ToolSuspensionState = {
      agentNode: 'Agent',
      exec: { node: 'Agent', data: { main: [[{ json: {} }]] }, source: null },
      toolNode: 'Slack',
      toolRunIndex: 0,
      toolCallId: 'c1',
      checkpoint: { steps: 1 },
    };
    expectTypeOf<ExecutionState['executionData']['suspended']>().toEqualTypeOf<
      ToolSuspensionState | undefined
    >();
    expect(JSON.parse(JSON.stringify(suspended))).toEqual(suspended);
  });
});

describe('hitlApproved', () => {
  const answer = (json: unknown): Item[][] => [[{ json } as Item]];

  it('approves only a true approved on the first item', () => {
    expect(hitlApproved(answer({ approved: true }))).toBe(true);
    expect(hitlApproved(answer({ data: { approved: true } }))).toBe(true);
  });

  it.each([
    ['null answer', null],
    ['no outputs', []],
    ['no items', [[]]],
    ['false', answer({ approved: false })],
    ['text', answer({ approved: 'true' })],
    ['number', answer({ approved: 1 })],
    ['data false', answer({ data: { approved: false } })],
    ['data text', answer({ data: 'approved' })],
    ['data null', answer({ data: null })],
    ['data array', answer({ data: [{ approved: true }] })],
    ['second item only', [[{ json: {} }, { json: { approved: true } }]]],
    ['second output only', [[{ json: {} }], [{ json: { approved: true } }]]],
  ] as Array<[string, Item[][] | null]>)('declines %s', (_name, value) => {
    expect(hitlApproved(value)).toBe(false);
  });
});

describe('fromAiValue', () => {
  it('reads query, then the arguments, then the default', () => {
    expect(fromAiValue({ query: { k: 'q' }, k: 'a' }, 'k', '', 'string', 'd')).toBe('q');
    expect(fromAiValue({ query: {}, k: 'a' }, 'k', '', 'string', 'd')).toBe('a');
    expect(fromAiValue({ query: 'text', k: 'a' }, 'k')).toBe('a');
    expect(fromAiValue({ k: null }, 'k', '', 'string', 'd')).toBe('d');
    expect(fromAiValue({}, 'k', '', 'string', 'd')).toBe('d');
    expect(fromAiValue({}, 'k')).toBeUndefined();
    expect(fromAiValue({ k: 0 }, 'k', '', 'number', 5)).toBe(0);
    expect(fromAiValue({ k: false }, 'k', '', 'boolean', true)).toBe(false);
  });

  it('reads own keys only', () => {
    const inherited = Object.create({ k: 'proto', query: { k: 'proto query' } });
    expect(fromAiValue(inherited, 'k', '', 'string', 'd')).toBe('d');
    const queryInherited = { query: Object.create({ k: 'proto' }) };
    expect(fromAiValue(queryInherited, 'k', '', 'string', 'd')).toBe('d');
    expect(fromAiValue({}, 'toString', '', 'string', 'd')).toBe('d');
    expect(fromAiValue({}, 'hasOwnProperty')).toBeUndefined();
  });

  it('gives the run-time texts', () => {
    for (const key of [undefined, null, '', 0]) {
      expect(() => fromAiValue({}, key)).toThrow("Add a key, e.g. $fromAI('placeholder_name')");
    }
    for (const key of ['has space', 'a.b', 'x'.repeat(65), 5, {}]) {
      expect(() => fromAiValue({}, key)).toThrow(LONG_KEY_TEXT);
    }
    expect(fromAiValue({ ['x'.repeat(64)]: 1 }, 'x'.repeat(64))).toBe(1);
    expect(() => fromAiValue(undefined, 'k')).toThrow('No execution data available');
  });

  it('refuses reserved keys, even when the arguments hold them', () => {
    const source = JSON.parse('{"__proto__":"x","constructor":"y","prototype":"z"}');
    for (const key of ['__proto__', 'constructor', 'prototype', 'getPrototypeOf']) {
      let error: unknown;
      try {
        fromAiValue(source, key);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(FromAiError);
      expect((error as Error).message).toBe('Invalid parameter key');
    }
  });

  it('FromAiError is an ExpressionError', () => {
    expect(new FromAiError('x')).toBeInstanceOf(ExpressionError);
    expect(new FromAiError('x').name).toBe('FromAiError');
  });
});

describe('fromAiVariables', () => {
  it('binds the three spellings to the arguments', () => {
    const vars = fromAiVariables({ query: { a: 1 }, b: 2 });
    expect(Object.keys(vars).sort()).toEqual(['$fromAI', '$fromAi', '$fromai']);
    for (const read of Object.values(vars) as Array<(...args: unknown[]) => unknown>) {
      expect(read('a')).toBe(1);
      expect(read('b')).toBe(2);
      expect(read('c', 'text', 'string', 'd')).toBe('d');
    }
  });
});

describe('$fromAI in expressions', () => {
  const ev = new ExpressionEvaluator();

  it('every context has the three spellings, reading the current item', () => {
    const data = createDataProxy(context({ a: 1 }));
    for (const name of ['$fromAI', '$fromAi', '$fromai']) {
      expect((data[name] as (key: string) => unknown)('a')).toBe(1);
    }
    expect(ev.evaluate("={{ $fromAI('a') }}", context({ a: 1 }))).toBe(1);
    expect(ev.evaluate("={{ $fromAi('a') }}", context({ a: 2 }))).toBe(2);
    expect(ev.evaluate("={{ $fromai('a') }}", context({ a: 3 }))).toBe(3);
    expect(ev.evaluate("={{ $fromAI('none', 'text', 'string', 'd') }}", context({}))).toBe('d');
  });

  it('a tool context wins through extra', () => {
    const ctx = context({ a: 'item' }, fromAiVariables({ a: 'tool' }));
    expect(ev.evaluate("={{ $fromAI('a') }}", ctx)).toBe('tool');
    expect(ev.evaluate('={{ $json.a }}', ctx)).toBe('item');
  });

  it('no current item: says so', () => {
    const ctx = { ...context({}), connectionInputData: [] };
    expect(() => ev.evaluate("={{ $fromAI('a') }}", ctx)).toThrow('No execution data available');
  });

  it('errors reach the user as expression errors', () => {
    expect(() => ev.evaluate('={{ $fromAI() }}', context({}))).toThrow(FromAiError);
    expect(() => ev.evaluate("={{ $fromAI('__proto__') }}", context({}))).toThrow('Invalid parameter key');
  });

  it('the return is data: it can be used and changed, not climbed out of', () => {
    const ctx = () => context({ tags: ['b', 'a'], obj: { k: 1 } });
    expect(ev.evaluate("={{ $fromAI('tags').sort().join(',') }}", ctx())).toBe('a,b');
    expect(ev.evaluate("={{ ($fromAI('obj').more = 2) + $fromAI('obj').k }}", ctx())).toBe(3);
    expect(() => ev.evaluate("={{ $fromAI('obj').constructor }}", ctx())).toThrow();
    expect(() => ev.evaluate("={{ $fromAI('obj').__proto__ }}", ctx())).toThrow();
    expect(() =>
      ev.evaluate("={{ $fromAI('tags').constructor.constructor('return 1')() }}", ctx()),
    ).toThrow();
  });

  it('a model value that looks like an expression stays text', () => {
    const value = '={{ $env.SECRET }}';
    expect(ev.evaluate("={{ $fromAI('a') }}", context({}, fromAiVariables({ a: value })))).toBe(value);
    expect(ev.evaluate("=x{{ $fromAI('a') }}", context({ a: '{{ 1 + 1 }}' }))).toBe('x{{ 1 + 1 }}');
  });
});

describe('Workflow.getSubNodesBySlot', () => {
  const node = (name: string, disabled = false): WorkflowNode =>
    ({
      id: name,
      name,
      type: 't',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
      disabled,
    }) as WorkflowNode;
  const link = (index: number) => ({
    ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index }]],
  });
  const workflow = (sources: Record<string, ReturnType<typeof link>>, disabled: string[] = []) =>
    new Workflow(
      {
        name: 'w',
        nodes: ['Agent', 'A', 'B', 'C'].map((n) => node(n, disabled.includes(n))),
        connections: sources,
      } as never,
      { get: () => undefined },
    );

  it('gives one entry per connection index', () => {
    const wf = workflow({ A: link(0), B: link(1), C: link(1) });
    expect(wf.getSubNodesBySlot('Agent', 'ai_languageModel').map((s) => s.map((n) => n.name))).toEqual([
      ['A'],
      ['B', 'C'],
    ]);
  });

  it('keeps the index of a connected slot after an empty one', () => {
    const wf = workflow({ B: link(1) });
    const slots = wf.getSubNodesBySlot('Agent', 'ai_languageModel');
    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual([]);
    expect(slots[1].map((n) => n.name)).toEqual(['B']);
  });

  it('leaves disabled nodes out and keeps their slot', () => {
    const wf = workflow({ A: link(0), B: link(1) }, ['A']);
    expect(wf.getSubNodesBySlot('Agent', 'ai_languageModel').map((s) => s.map((n) => n.name))).toEqual([
      [],
      ['B'],
    ]);
    expect(wf.getSubNodes('Agent', 'ai_languageModel').map((n) => n.name)).toEqual(['B']);
  });

  it('is empty with no connection of the type', () => {
    const wf = workflow({ A: link(0) });
    expect(wf.getSubNodesBySlot('Agent', 'ai_tool')).toEqual([]);
    expect(wf.getSubNodesBySlot('Nobody', 'ai_languageModel')).toEqual([]);
  });
});

describe('Workflow start node', () => {
  const type = (name: string, fields: Partial<NodeType['description']>, webhook = false): NodeType =>
    ({
      description: {
        name,
        displayName: name,
        description: name,
        group: ['transform'],
        version: 1,
        defaults: { name },
        inputs: ['main'],
        outputs: ['main'],
        properties: [],
        ...fields,
      },
      ...(webhook ? { webhook: async () => ({}) } : {}),
    }) as NodeType;
  const types = new Map(
    [
      type('t.plain', {}),
      type('t.agent', {}),
      type('t.schedule', { group: ['trigger'], inputs: [] }),
      // a tool variant keeps the `webhook` of the node it copies
      type('t.mailTool', { inputs: [], outputs: ['ai_tool'] }, true),
    ].map((t) => [t.description.name, t]),
  );
  const at = (name: string, nodeType: string, y = 0) => ({
    id: name,
    name,
    type: nodeType,
    typeVersion: 1,
    position: [0, y] as [number, number],
    parameters: {},
  });
  const workflow = (nodes: ReturnType<typeof at>[]) =>
    new Workflow(
      {
        id: 'w',
        name: 'w',
        nodes,
        connections: {
          Edit: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
          Mail: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
        },
      },
      { get: (name: string) => types.get(name) } as never,
    );

  it('a tool that has a webhook is no trigger: with no trigger the run starts at the first root', () => {
    const graph = workflow([at('Edit', 't.plain'), at('Agent', 't.agent'), at('Mail', 't.mailTool', -100)]);
    expect(graph.getTriggerNodes()).toEqual([]);
    expect(graph.getStartNode()?.name).toBe('Edit');
  });

  it('a tool placed above the trigger does not take its place', () => {
    const graph = workflow([
      at('Sched', 't.schedule', 100),
      at('Agent', 't.agent'),
      at('Mail', 't.mailTool', -100),
    ]);
    expect(graph.getTriggerNodes().map((n) => n.name)).toEqual(['Sched']);
    expect(graph.getStartNode()?.name).toBe('Sched');
  });
});

describe('highlighted data keys', () => {
  it.each([
    ['Chat Trigger', 'chat_trigger'],
    ['AI Agent', 'ai_agent'],
    ['AI Agent1', 'ai_agent_1'],
    ['HTTPRequest2', 'http_request_2'],
    ['myNode', 'my_node'],
    ['  --When chat  message!! ', 'when_chat_message'],
    ['Café Bot', 'cafe_bot'],
    ["Bob's node", 'bobs_node'],
    ['Foo2bar', 'foo_2_bar'],
    ['日本語Foo', '日本語_foo'],
  ])('%s -> %s', (name, snake) => {
    expect(highlightedInputKey(name)).toBe(`input_${snake}`);
    expect(highlightedResponseKey(name)).toBe(`response_${snake}`);
  });

  it('has the session key', () => {
    expect(HIGHLIGHTED_SESSION_KEY).toBe('session_id');
  });
});

describe('tool variants', () => {
  const description = (outputs: NodeTypeDescription['outputs']) => ({ outputs }) as NodeTypeDescription;

  it('isToolNode: the outputs hold ai_tool', () => {
    expect(isToolNode(description(['ai_tool']))).toBe(true);
    expect(isToolNode(description([{ type: 'ai_tool' }]))).toBe(true);
    expect(isToolNode(description(['main']))).toBe(false);
    expect(isToolNode(description([]))).toBe(false);
    expect(isToolNode(description('={{ ["ai_tool"] }}'))).toBe(false);
  });

  it('the names lanes use are exported', () => {
    for (const fn of [
      extractFromAiArguments,
      fromAiSchema,
      hasSendAndWaitOperation,
      isHitlVariant,
      isToolVariant,
      toHitlVariant,
      toToolVariant,
      toolDescriptionFor,
      toolNameOf,
      withToolVariants,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(FROM_AI_MARKER).toBe('/*auto-generated-fromAI-override*/');
  });
});

describe('type contracts', () => {
  it('resource mapper', () => {
    const property: NodeProperty = {
      displayName: 'Columns',
      name: 'columns',
      type: 'resourceMapper',
      default: { mappingMode: 'defineBelow', value: null },
      typeOptions: {
        resourceMapper: {
          resourceMapperMethod: 'getColumns',
          mode: 'upsert',
          valuesLabel: 'Values',
          fieldWords: { singular: 'column', plural: 'columns' },
          addAllFields: true,
          multiKeyMatch: true,
          supportAutoMap: true,
          noFieldsError: 'No columns',
        },
      },
    };
    const fields: ResourceMapperFields = {
      fields: [
        { id: 'a', displayName: 'A', required: true, defaultMatch: false, display: true, type: 'options' },
      ],
      emptyFieldsNotice: 'None',
    };
    const value: ResourceMapperValue = {
      mappingMode: 'autoMapInputData',
      value: { a: 1 },
      matchingColumns: ['a'],
      schema: fields.fields,
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    };
    const node: Pick<NodeType, 'methods'> = {
      methods: { resourceMapping: { getColumns: async () => fields } },
    };
    expect(property.type).toBe('resourceMapper');
    expect(value.schema[0].id).toBe('a');
    expect(node.methods?.resourceMapping?.getColumns).toBeTypeOf('function');
  });

  it('ports and usableAsTool', () => {
    const input: NodeInputConfig = { type: 'ai_tool', filter: { excludedNodes: ['a'], nodes: ['b'] } };
    const output: NodeOutputConfig = { type: 'main', filter: { nodes: ['c'] } };
    const usable: NodeTypeDescription['usableAsTool'][] = [true, { replacements: { displayName: 'Other' } }];
    expect([input.filter?.nodes, output.filter?.nodes, usable.length]).toEqual([['b'], ['c'], 2]);
  });

  it('credential helpers are the third argument of authenticate', async () => {
    const helpers: CredentialAuthHelpers = {
      http: async <T>() => ({}) as T,
      signAwsV4: (input: AwsSignInput) => ({ headers: input.headers ?? {} }),
      jwtBearerToken: async (input: JwtBearerInput): Promise<AccessToken> => ({
        token: input.email,
        expiresInSeconds: 1,
      }),
      clientCredentialsToken: async (input: ClientCredentialsInput): Promise<AccessToken> => ({
        token: input.clientId,
        expiresInSeconds: 1,
      }),
      cachedToken: async (_secret, _scope, fetch) => (await fetch()).token,
    };
    const type: Pick<CredentialType, 'authenticate'> = {
      authenticate: async (_credentials, request, h) => ({
        ...request,
        headers: h?.signAwsV4({
          method: 'GET',
          url: 'https://a.test',
          region: 'r',
          service: 's',
          accessKeyId: 'a',
          secretAccessKey: 'b',
        }).headers,
      }),
    };
    expect(typeof type.authenticate === 'function').toBe(true);
    expect(await helpers.cachedToken('s', 'c', async () => ({ token: 't', expiresInSeconds: 1 }))).toBe('t');
  });

  it('AI types', () => {
    const file: AiContentPart = {
      type: 'file',
      data: 'AA==',
      mimeType: 'application/pdf',
      fileName: 'a.pdf',
    };
    const request: AiChatRequest = { messages: [{ role: 'user', content: [file] }], toolChoice: 'any' };
    expect(request.toolChoice).toBe('any');
    expectTypeOf<AiChatModel['completion']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<AiChatModel['nodeName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AiTool['canWait']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Parameters<AiTool['invoke']>[1]>().toEqualTypeOf<
      { signal?: AbortSignal; toolCallId?: string } | undefined
    >();
  });

  it('contexts and limits', () => {
    expectTypeOf<InstanceLimits['maxPassthroughBinaryBytes']>().toEqualTypeOf<number>();
    expectTypeOf<ExecuteContext['getToolParameter']>().toEqualTypeOf<SupplyDataContext['getToolParameter']>();
    expectTypeOf<ReturnType<ExecuteContext['suspendForTool']>>().toEqualTypeOf<void>();
    expectTypeOf<Parameters<ExecuteContext['suspendForTool']>[0]>().toEqualTypeOf<ToolSuspension>();
    expectTypeOf<LoadOptionsContext['readWorkflow']>().not.toBeAny();
  });
});
