/** P5-77: a tool stops the run, the state goes through JSON, and the agent carries on from its checkpoint. */
import {
  type AiTool,
  type Connections,
  type DataObject,
  type ExecuteContext,
  type ExecutionResult,
  type ExecutionState,
  isToolSuspension,
  type Item,
  type NodeOutput,
  type NodeType,
  type NodeTypeDescription,
  type ToolSuspension,
  toHitlVariant,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeTypes, reviewNodeKey, WorkflowExecute } from '../src';
import { node, services as baseServices } from './helpers';

const WAIT_UNTIL = new Date('2030-01-02T03:04:05Z');

function description(
  name: string,
  inputs: NodeTypeDescription['inputs'],
  outputs: NodeTypeDescription['outputs'],
  extra: Partial<NodeTypeDescription> = {},
): NodeTypeDescription {
  return {
    name,
    displayName: name,
    description: name,
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs,
    outputs,
    properties: [],
    ...extra,
  };
}

/** what each test's agent does with its tools */
let agentBody: (ctx: ExecuteContext, tools: AiTool[]) => Promise<NodeOutput>;
/** the calls that really ran a gated or instant tool */
let ran: DataObject[] = [];
/** what the send node read when it ran */
let sent: DataObject[] = [];

const passThrough = async (ctx: ExecuteContext): Promise<NodeOutput> => [ctx.getInputData()];

const sendType: NodeType = {
  description: description('test.send', ['main'], ['main'], {
    webhooks: [{ name: 'default', httpMethod: 'GET', path: 'answer', restartWebhook: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'other',
        options: [
          { name: 'Other', value: 'other' },
          { name: 'Send and Wait', value: 'sendAndWait' },
        ],
      },
      { displayName: 'Message', name: 'message', type: 'string', default: 'Please review' },
    ],
  }),
  async execute(ctx) {
    if (ctx.getNodeParameter('operation', 0, '') !== 'sendAndWait') return [ctx.getInputData()];
    sent.push({
      message: String(ctx.getNodeParameter('message', 0, '')),
      key: String(ctx.getNode().webhookId ?? ctx.getNode().id),
      url: String(ctx.evaluateExpression('={{ $execution.resumeUrl }}', 0)),
    });
    await ctx.putExecutionToWait(WAIT_UNTIL);
    return [ctx.getInputData()];
  },
};

const types = new NodeTypes([
  { description: description('test.start', [], ['main']), execute: passThrough },
  { description: description('test.after', ['main'], ['main']), execute: passThrough },
  {
    description: description(
      'test.agent',
      ['main', { type: 'ai_tool', displayName: 'Tool' }],
      ['main'],
    ),
    async execute(ctx) {
      return agentBody(ctx, (await ctx.getInputConnectionData('ai_tool', 0)) as AiTool[]);
    },
  },
  {
    description: description('test.instant', [], ['ai_tool']),
    async execute(ctx) {
      const json = ctx.getInputData()[0].json;
      ran.push(json);
      return [[{ json: { done: true } }]];
    },
  },
  {
    description: description('test.wait', [], ['ai_tool'], {
      webhooks: [{ name: 'default', httpMethod: 'GET', path: 'answer', restartWebhook: true }],
    }),
    async execute(ctx) {
      await ctx.putExecutionToWait(WAIT_UNTIL);
      return [ctx.getInputData()];
    },
  },
  {
    description: description(
      'test.subAgent',
      [{ type: 'ai_tool', displayName: 'Tool' }],
      ['ai_tool'],
    ),
    async execute(ctx) {
      await ctx.getInputConnectionData('ai_tool', 0);
      return [[{ json: {} }]];
    },
  },
  sendType,
  toHitlVariant(sendType),
]);

const services = (overrides = {}) =>
  baseServices({
    nodeTypes: types,
    resumeUrl: 'http://localhost:5678/webhook-waiting/e1/signature',
    ...overrides,
  });

const tool = (from: string, to: string): Connections => ({
  [from]: { ai_tool: [[{ node: to, type: 'ai_tool', index: 0 }]] },
});

const definition = (nodes: WorkflowNode[], connections: Connections) => ({
  id: 'wf',
  name: 'wf',
  nodes,
  connections: { Start: { main: [[{ node: 'Agent', type: 'main' as const, index: 0 }]] }, ...connections },
});

const agentGraph = () =>
  definition(
    [
      node('Start', 'test.start', [0, 0]),
      node('Agent', 'test.agent', [200, 0]),
      node('After', 'test.after', [400, 0]),
      node('Instant', 'test.instant', [200, 200]),
      node('Wait', 'test.wait', [400, 200]),
    ],
    {
      Agent: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
      ...tool('Instant', 'Agent'),
      ...tool('Wait', 'Agent'),
    },
  );

/** the small agent of these tests: runs its calls in turn and keeps the rest in the checkpoint */
function callInTurn(plan: Array<'Instant' | 'Wait'>) {
  return async (ctx: ExecuteContext, tools: AiTool[]): Promise<NodeOutput> => {
    const resume = ctx.getResumeData();
    const seen = [
      ...((resume?.checkpoint.seen as DataObject[] | undefined) ?? []),
      ...(resume ? [{ toolCallId: resume.toolCallId, answer: resume.answer as unknown as DataObject[] }] : []),
    ] as DataObject[];
    let remaining = (resume?.checkpoint.remaining as string[] | undefined) ?? plan;
    while (remaining.length) {
      const [name, ...rest] = remaining;
      remaining = rest;
      const target = tools.find((candidate) => candidate.name === name)!;
      try {
        seen.push({ result: String(await target.invoke({}, { toolCallId: `call-${name}` })) });
      } catch (error) {
        if (!isToolSuspension(error)) throw error;
        ctx.suspendForTool(error, { seen, remaining });
        return null;
      }
    }
    return [[{ json: { seen } }]];
  };
}

const run = (graph: ReturnType<typeof definition>, overrides = {}) =>
  new WorkflowExecute(new Workflow(graph, types), services(overrides)).run({ startNode: 'Start' });

/** a new engine in a new "process": the state has been through JSON */
function reload(graph: ReturnType<typeof definition>, result: ExecutionResult, overrides = {}) {
  const state = JSON.parse(JSON.stringify(result.state)) as ExecutionState;
  return new WorkflowExecute(new Workflow(graph, types), services(overrides), state);
}

const answer: Item[][] = [[{ json: { data: { approved: true } } }]];

beforeEach(() => {
  ran = [];
  sent = [];
});

describe('suspend', () => {
  it('while waiting there is no Agent task and lastNodeExecuted is the tool node', async () => {
    agentBody = callInTurn(['Instant', 'Wait', 'Instant']);
    const graph = agentGraph();
    const result = await run(graph);

    expect(result.status).toBe('waiting');
    const { resultData, executionData, waitTill } = result.state;
    expect(resultData.runData.Agent).toBeUndefined();
    expect(resultData.runData.After).toBeUndefined();
    expect(resultData.lastNodeExecuted).toBe('Wait');
    expect(waitTill).toBe(WAIT_UNTIL.toISOString());
    expect(resultData.runData.Wait).toHaveLength(1);
    expect(resultData.runData.Wait[0]).toMatchObject({
      executionStatus: 'waiting',
      source: [{ previousNode: 'Agent' }],
    });
    expect(executionData.suspended).toMatchObject({
      agentNode: 'Agent',
      toolNode: 'Wait',
      toolRunIndex: 0,
      toolCallId: 'call-Wait',
      exec: { node: 'Agent' },
    });
    // the call before the wait is logged, the one after it has not run
    expect(ran).toHaveLength(1);
    expect(resultData.runData.Instant).toHaveLength(1);
  });

  it('tells the hooks about the tool, and not about an Agent task', async () => {
    agentBody = callInTurn(['Wait']);
    const after: Array<[string, string]> = [];
    await run(agentGraph(), {
      hooks: {
        nodeExecuteAfter: async (name: string, _index: number, task: { executionStatus: string }) => {
          after.push([name, task.executionStatus]);
        },
      },
    });
    expect(after).toEqual([
      ['Start', 'success'],
      ['Wait', 'waiting'],
    ]);
  });

  it('a retried agent still suspends once', async () => {
    agentBody = callInTurn(['Wait']);
    const graph = agentGraph();
    graph.nodes[1] = { ...graph.nodes[1], retryOnFail: true, maxTries: 3 };
    const result = await run(graph);
    expect(result.status).toBe('waiting');
    expect(result.state.resultData.runData.Wait).toHaveLength(1);
  });
});

describe('resume', () => {
  it('the state goes through JSON and the agent runs its remaining calls', async () => {
    agentBody = callInTurn(['Wait', 'Instant', 'Instant']);
    const graph = agentGraph();
    const waiting = await run(graph);
    expect(ran).toHaveLength(0);

    const result = await reload(graph, waiting).resume({ output: answer });

    expect(result.status).toBe('success');
    const { resultData, executionData, waitTill } = result.state;
    expect(ran).toHaveLength(2);
    expect(executionData.suspended).toBeUndefined();
    expect(waitTill).toBeUndefined();
    expect(resultData.lastNodeExecuted).toBe('After');
    expect(resultData.runData.Agent).toHaveLength(1);
    expect(resultData.runData.After).toHaveLength(1);
    const task = resultData.runData.Wait[0];
    expect(task.executionStatus).toBe('success');
    expect(task.data?.ai_tool?.[0]?.[0]?.json).toEqual({ data: { approved: true } });
    const seen = resultData.runData.Agent[0].data?.main?.[0]?.[0]?.json.seen as DataObject[];
    expect(seen[0]).toMatchObject({ toolCallId: 'call-Wait' });
    expect(JSON.stringify(seen[0])).toContain('approved');
    expect(seen).toHaveLength(3);
  });

  it('a wait that ends by itself hands the agent null', async () => {
    agentBody = callInTurn(['Wait']);
    const graph = agentGraph();
    const result = await reload(graph, await run(graph)).resume();
    expect(result.status).toBe('success');
    const seen = result.state.resultData.runData.Agent[0].data?.main?.[0]?.[0]?.json.seen as DataObject[];
    expect(seen[0]).toEqual({ toolCallId: 'call-Wait', answer: null });
    expect(result.state.resultData.runData.Wait[0].data?.ai_tool).toEqual([[]]);
  });

  it('a second wait writes a second run on the tool', async () => {
    agentBody = callInTurn(['Wait', 'Wait']);
    const graph = agentGraph();
    const second = await reload(graph, await run(graph)).resume({ output: answer });
    expect(second.status).toBe('waiting');
    expect(second.state.executionData.suspended).toMatchObject({ toolRunIndex: 1 });
    expect(second.state.resultData.runData.Agent).toBeUndefined();
    expect(second.state.resultData.runData.Wait.map((t) => t.executionStatus)).toEqual([
      'success',
      'waiting',
    ]);
    const done = await reload(graph, second).resume({ output: answer });
    expect(done.status).toBe('success');
    expect(done.state.resultData.runData.Agent).toHaveLength(1);
    expect(done.state.resultData.runData.Wait.map((t) => t.executionStatus)).toEqual(['success', 'success']);
  });

  it('only the run that waited reads the resume data', async () => {
    let reads = 0;
    agentBody = async (ctx, tools) => {
      reads++;
      if (reads === 1) expect(ctx.getResumeData()).toBeUndefined();
      if (reads === 2) expect(ctx.getResumeData()).toMatchObject({ checkpoint: { mark: 1 } });
      if (reads === 3) expect(ctx.getResumeData()).toBeUndefined();
      if (reads === 1) {
        const wait = tools.find((candidate) => candidate.name === 'Wait')!;
        const error = (await wait.invoke({}).catch((e: unknown) => e)) as ToolSuspension;
        ctx.suspendForTool(error, { mark: 1 });
        return null;
      }
      return [ctx.getInputData()];
    };
    const graph = agentGraph();
    // the second run of the agent is queued while the first one waits
    graph.connections.Start = {
      main: [
        [
          { node: 'Agent', type: 'main', index: 0 },
          { node: 'Agent', type: 'main', index: 0 },
        ],
      ],
    };
    const waiting = await run(graph);
    expect(waiting.state.executionData.nodeExecutionStack.map((e) => e.node)).toEqual(['Agent']);
    const result = await reload(graph, waiting).resume({ output: answer });
    expect(result.status).toBe('success');
    expect(reads).toBe(3);
    expect(result.state.resultData.runData.Agent).toHaveLength(2);
  });

  it('an agent that fails after the wait fails the run on the agent', async () => {
    agentBody = async (ctx, tools) => {
      if (ctx.getResumeData()) throw new Error('model down');
      const wait = tools.find((candidate) => candidate.name === 'Wait')!;
      ctx.suspendForTool((await wait.invoke({}).catch((e: unknown) => e)) as ToolSuspension, {});
      return null;
    };
    const graph = agentGraph();
    const result = await reload(graph, await run(graph)).resume({ output: answer });
    expect(result.status).toBe('error');
    expect(result.state.resultData.lastNodeExecuted).toBe('Agent');
    expect(result.state.resultData.runData.Agent[0].executionStatus).toBe('error');
  });

  it('resume with no suspension still refuses a run that is not waiting', async () => {
    agentBody = async (ctx) => [ctx.getInputData()];
    const graph = agentGraph();
    const done = await run(graph);
    await expect(reload(graph, done).resume()).rejects.toThrow('Execution is not waiting');
  });
});

describe('createHitlGate', () => {
  const gateGraph = (send: DataObject = {}) =>
    definition(
      [
        node('Start', 'test.start', [0, 0]),
        node('Agent', 'test.agent', [200, 0]),
        node('Review', 'test.sendHitlTool', [200, 200], {
          parameters: {
            message: `={{ $tool.name }}|{{ $tool.parameters }}|{{ $fromAI('reason', 'Why', 'string') }}|{{ $json.who }}`,
            ...send,
          },
        }),
        node('Gated', 'test.instant', [200, 400]),
      ],
      { ...tool('Review', 'Agent'), ...tool('Gated', 'Review') },
    );

  const expectGate = (body: (gate: AiTool & Record<string, any>, ctx: ExecuteContext) => Promise<void>) => {
    agentBody = async (ctx, tools) => {
      await body(tools[0] as AiTool & Record<string, any>, ctx);
      return [ctx.getInputData()];
    };
  };

  const REVIEW_ARGS = { toolParameters: { amount: 3 }, hitlParameters: { reason: 'it is due' } };

  it('offers each gated tool under its own name with toolParameters and hitlParameters', async () => {
    let names: string[] = [];
    expectGate(async (gate) => {
      names = [gate.name];
      expect(gate.kind).toBe('tool');
      expect(gate.canWait).toBe(true);
      expect(gate.description).toBe('test.instant');
      expect(gate.parameters).toEqual({
        type: 'object',
        properties: {
          toolParameters: { type: 'object', properties: {} },
          hitlParameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Why' } },
            required: ['reason'],
          },
        },
        required: ['toolParameters', 'hitlParameters'],
      });
    });
    const result = await run(gateGraph());
    expect(result.status).toBe('success');
    expect(names).toEqual(['Gated']);
  });

  it('a call sends the message with $tool and $fromAI, waits, and does not run the tool', async () => {
    let thrown: unknown;
    agentBody = async (ctx, tools) => {
      thrown = await tools[0].invoke(REVIEW_ARGS, { toolCallId: 'c1' }).catch((e: unknown) => e);
      return [ctx.getInputData()];
    };
    const graph = gateGraph();
    await new WorkflowExecute(new Workflow(graph, types), services()).run({
      startNode: 'Start',
      triggerItems: [{ json: { who: 'Ann' } }],
    });
    expect(isToolSuspension(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      toolNode: 'Review',
      toolName: 'Gated',
      toolCallId: 'c1',
      waitTill: WAIT_UNTIL,
      gatedTool: { name: 'Gated', arguments: { amount: 3 } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('Gated|{"amount":3}|it is due|Ann');
    expect(ran).toEqual([]);
  });

  it('a model value is data: the literal text of an expression goes out', async () => {
    let thrown: unknown;
    agentBody = async (ctx, tools) => {
      thrown = await tools[0]
        .invoke({ toolParameters: { q: '={{ $env.SECRET }}' }, hitlParameters: { reason: '={{ 1 + 1 }}' } })
        .catch((e: unknown) => e);
      return [ctx.getInputData()];
    };
    await run(gateGraph());
    expect(isToolSuspension(thrown)).toBe(true);
    expect(sent[0].message).toContain('={{ $env.SECRET }}');
    expect(sent[0].message).toContain('|={{ 1 + 1 }}|');
  });

  it('the review key holds the run, so a link belongs to one wait', async () => {
    agentBody = async (ctx, tools) => {
      const first = (await tools[0].invoke(REVIEW_ARGS).catch((e: unknown) => e)) as ToolSuspension;
      ctx.suspendForTool(first, {});
      return null;
    };
    const graph = gateGraph();
    const first = await run(graph);
    expect(first.state.executionData.suspended).toMatchObject({ toolNode: 'Review', toolRunIndex: 0 });
    const review = graph.nodes.find((n) => n.name === 'Review')!;
    expect(sent[0].key).toBe(reviewNodeKey(review, 0));

    agentBody = async (ctx, tools) => {
      ctx.suspendForTool((await tools[0].invoke(REVIEW_ARGS).catch((e: unknown) => e)) as ToolSuspension, {});
      return null;
    };
    const second = await reload(graph, first).resume({ output: answer });
    expect(second.state.executionData.suspended).toMatchObject({ toolRunIndex: 1 });
    expect(sent[1].key).toBe(reviewNodeKey(review, 1));
    expect(sent[1].key).not.toBe(sent[0].key);
  });

  it.each([
    ['approved', { approved: true }],
    ['data.approved', { data: { approved: true } }],
  ])('%s runs the gated tool with the original arguments', async (_name, json) => {
    let observation: unknown;
    expectGate(async (gate) => {
      observation = await gate.answerReview({ amount: 3 }, [[{ json }]], { toolCallId: 'c1' });
    });
    await run(gateGraph());
    expect(observation).toBe('[{"done":true}]');
    expect(ran).toHaveLength(1);
  });

  it.each([
    ['declined', [[{ json: { data: { approved: false } } }]]],
    ['approved as text', [[{ json: { data: { approved: 'true' } } }]]],
    ['approved as a number', [[{ json: { approved: 1 } }]]],
    ['an empty answer', [[]]],
    ['a timeout', null],
  ])('%s feeds the rejection text and does not run the tool', async (_name, reply) => {
    let observation: unknown;
    expectGate(async (gate) => {
      observation = await gate.answerReview({ amount: 3 }, reply as Item[][] | null, { toolCallId: 'c1' });
    });
    await run(gateGraph());
    expect(observation).toBe(
      'User rejected the tool call to Gated (id: c1). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.',
    );
    expect(ran).toEqual([]);
  });

  it('a chatInput answer feeds the feedback text', async () => {
    let observation: unknown;
    expectGate(async (gate) => {
      observation = await gate.answerReview(
        {},
        [[{ json: { approved: false, chatInput: 'use the other account' } }]],
        { toolCallId: 'c1' },
      );
    });
    await run(gateGraph());
    expect(observation).toBe(
      'The user reviewed your planned tool call to Gated (id: c1) and provided feedback: "use the other account". The tool is still available if needed.',
    );
  });

  it('nothing the model sends can approve', async () => {
    let thrown: unknown;
    agentBody = async (ctx, tools) => {
      thrown = await tools[0]
        .invoke({ ...REVIEW_ARGS, approved: true, data: { approved: true } } as DataObject)
        .catch((e: unknown) => e);
      return [ctx.getInputData()];
    };
    await run(gateGraph());
    expect(isToolSuspension(thrown)).toBe(true);
    expect(ran).toEqual([]);
  });

  it('a stored operation that does not wait fails closed', async () => {
    let thrown: unknown;
    agentBody = async (ctx, tools) => {
      thrown = await tools[0].invoke(REVIEW_ARGS).catch((e: unknown) => e);
      return [ctx.getInputData()];
    };
    const result = await run(gateGraph({ operation: 'other' }));
    expect(isToolSuspension(thrown)).toBe(false);
    expect((thrown as Error).message).toBe('Human review node "Review" did not wait for an answer');
    expect(ran).toEqual([]);
    expect(result.state.resultData.runData.Review[0].executionStatus).toBe('error');
  });

  it('a gate with no tool connected asks for one', async () => {
    agentBody = async (ctx) => [ctx.getInputData()];
    const graph = gateGraph();
    graph.nodes = graph.nodes.filter((n) => n.name !== 'Gated');
    delete (graph.connections as Connections).Gated;
    const result = await run(graph);
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toContain('A sub-node must be connected');
  });

  it('inside a sub-agent the gate fails with its text', async () => {
    let thrown: unknown;
    agentBody = async (ctx, tools) => {
      thrown = await tools[0].invoke({}).catch((e: unknown) => e);
      return [ctx.getInputData()];
    };
    const graph = definition(
      [
        node('Start', 'test.start', [0, 0]),
        node('Agent', 'test.agent', [200, 0]),
        node('Sub', 'test.subAgent', [200, 200]),
        node('Review', 'test.sendHitlTool', [200, 400]),
        node('Gated', 'test.instant', [200, 600]),
      ],
      { ...tool('Sub', 'Agent'), ...tool('Review', 'Sub'), ...tool('Gated', 'Review') },
    );
    await run(graph);
    expect((thrown as Error).message).toBe(
      'Human-in-the-Loop nodes cannot be used inside a sub-agent. Move "Review" to the top-level workflow.',
    );
    expect(sent).toEqual([]);
  });
});
