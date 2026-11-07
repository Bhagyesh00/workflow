/** P5-77 on the real Agent: a tool that waits, a human review gate, and the checkpoint between the two runs. */
import { NodeTypes, WorkflowExecute } from '@workflow/core';
import { nodes as baseNodes } from '@workflow/nodes-base';
import {
  type AiChatMessage,
  type Connections,
  type DataObject,
  type ExecutionResult,
  type ExecutionState,
  type Item,
  type NodeType,
  type NodeTypeDescription,
  Workflow,
  type WorkflowNode,
  withToolVariants,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes as aiNodes } from '../src';
import { connect, type Link, node, reply, scriptModel, services, testNodes, toolCalls } from './harness';

const WAIT_UNTIL = new Date('2030-01-02T03:04:05Z');
const APPROVED: Item[][] = [[{ json: { data: { approved: true } } }]];
const DECLINED: Item[][] = [[{ json: { data: { approved: false } } }]];

function description(name: string, extra: Partial<NodeTypeDescription> = {}): NodeTypeDescription {
  return {
    name,
    displayName: name,
    description: `The ${name} tool`,
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
    ...extra,
  };
}

/** arguments each tool really ran with */
let ran: Array<{ node: string; args: DataObject }> = [];
/** review messages that went out */
let messages: string[] = [];
let memoryAppends: AiChatMessage[][] = [];
/** what a failing tool says */
const FAILURE = 'Bad token Bearer abcdefghijklmnopqrstuvwxyz123456 at the host';
const WEBHOOKS: NodeTypeDescription['webhooks'] = [
  { name: 'default', httpMethod: 'GET', path: 'answer', restartWebhook: true },
];

const sendType: NodeType = {
  description: description('test.send', {
    inputs: ['main'],
    outputs: ['main'],
    webhooks: WEBHOOKS,
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'sendAndWait',
        options: [{ name: 'Send and Wait', value: 'sendAndWait' }],
      },
      { displayName: 'Message', name: 'message', type: 'string', default: 'Review' },
    ],
  }),
  async execute(ctx) {
    messages.push(String(ctx.getNodeParameter('message', 0, '')));
    await ctx.putExecutionToWait(WAIT_UNTIL);
    return [ctx.getInputData()];
  },
};

const testTypes: NodeType[] = [
  sendType,
  {
    description: description('test.echo', {
      properties: [
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
        { displayName: 'Fail', name: 'fail', type: 'boolean', default: false },
      ],
    }),
    async execute(ctx) {
      if (ctx.getNodeParameter('fail', 0, false)) throw new Error(FAILURE);
      const args = { value: ctx.getNodeParameter('value', 0, '') as string };
      ran.push({ node: ctx.getNode().name, args });
      return [[{ json: { echoed: args.value } }]];
    },
  },
  {
    description: description('test.waiter', { webhooks: WEBHOOKS }),
    async execute(ctx) {
      await ctx.putExecutionToWait(WAIT_UNTIL);
      return [ctx.getInputData()];
    },
  },
  {
    description: description('test.memory', { outputs: ['ai_memory'] }),
    async supplyData() {
      return {
        response: {
          kind: 'memory',
          sessionId: 's1',
          load: async () => [{ role: 'user', content: 'earlier' }],
          append: async (_session: string, added: AiChatMessage[]) => {
            memoryAppends.push(added);
          },
          clear: async () => {},
        },
      };
    },
  },
  {
    description: description('test.parser', { outputs: ['ai_outputParser'] }),
    async supplyData() {
      return {
        response: {
          kind: 'outputParser',
          getFormatInstructions: () => 'Answer ok',
          parse: async (text: string) => {
            if (text !== 'ok') throw new Error('not ok');
            return { parsed: true };
          },
        },
      };
    },
  },
];

const types = new NodeTypes(withToolVariants([...aiNodes, ...baseNodes, ...testNodes, ...testTypes]));
const svc = () => services({ nodeTypes: types, resumeUrl: 'http://localhost/webhook-waiting/e1/sig' });

const TRIGGER = node('Trigger', 'test.trigger');
const MODEL = node('Model', 'test.fakeChatModel');

const agent = (options: DataObject = {}, parameters: DataObject = {}) =>
  node('Agent', 'ai.agent', { promptType: 'define', text: 'Go', options, ...parameters });

const graph = (nodes: WorkflowNode[], ...links: Link[]) => {
  const placed = [TRIGGER, MODEL, ...nodes].map((n, i) => ({ ...n, position: [i * 200, 0] as [number, number] }));
  const connections: Connections = connect(
    ['Trigger', 'Agent'],
    ['Model', 'Agent', 'ai_languageModel'],
    ...links,
  );
  return { id: 'wf', name: 'wf', nodes: placed, connections };
};

const start = (definition: ReturnType<typeof graph>, triggerItems: Item[] = [{ json: { chatInput: 'x' } }]) =>
  new WorkflowExecute(new Workflow(definition, types), svc()).run({ triggerItems, startNode: 'Trigger' });

/** the next process: the state has been through JSON, the engine and the agent are new */
const resume = (definition: ReturnType<typeof graph>, waiting: ExecutionResult, output?: Item[][]) => {
  const state = JSON.parse(JSON.stringify(waiting.state)) as ExecutionState;
  return new WorkflowExecute(new Workflow(definition, types), svc(), state).resume({ output });
};

const agentOutput = (result: ExecutionResult) =>
  (result.state.resultData.runData.Agent[0].data?.main?.[0] ?? []).map((item) => item.json);

const toolMessages = (messagesSent: AiChatMessage[]) =>
  messagesSent.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]);

beforeEach(() => {
  ran = [];
  messages = [];
  memoryAppends = [];
});

describe('a plain waiting tool', () => {
  const plain = () => graph([agent({ returnIntermediateSteps: true, returnUsage: true }), node('Waiter', 'test.waiter')], [
    'Waiter',
    'Agent',
    'ai_tool',
  ]);

  it('stops the run, and the answer goes back to the model', async () => {
    const requests = scriptModel('Model', [toolCalls(['Waiter', {}, 'w1']), 'done']);
    const definition = plain();
    const waiting = await start(definition);

    expect(waiting.status).toBe('waiting');
    const { resultData, executionData } = waiting.state;
    expect(resultData.runData.Agent).toBeUndefined();
    expect(resultData.lastNodeExecuted).toBe('Waiter');
    expect(executionData.suspended).toMatchObject({ agentNode: 'Agent', toolNode: 'Waiter', toolCallId: 'w1' });
    expect(requests).toHaveLength(1);

    const result = await resume(definition, waiting, [[{ json: { answer: 42 } }]]);
    expect(result.status).toBe('success');
    expect(requests).toHaveLength(2);
    expect(toolMessages(requests[1].messages)).toEqual([['w1', '[{"answer":42}]']]);
    const [json] = agentOutput(result);
    expect(json.output).toBe('done');
    expect(json.usage).toMatchObject({ modelCalls: 2, toolCalls: 1, inputTokens: 20, outputTokens: 10 });
    expect(json.intermediateSteps).toMatchObject([
      { action: { tool: 'Waiter', toolCallId: 'w1' }, observation: '[{"answer":42}]' },
    ]);
  });

  it('a wait that ends by itself tells the model so', async () => {
    const requests = scriptModel('Model', [toolCalls(['Waiter', {}, 'w1']), 'done']);
    const definition = plain();
    const result = await resume(definition, await start(definition));
    expect(result.status).toBe('success');
    expect(toolMessages(requests[1].messages)).toEqual([['w1', 'The tool finished waiting without a response.']]);
  });

  it('the other calls of the turn finish first and the results keep the call order', async () => {
    const requests = scriptModel('Model', [
      toolCalls(['Echo', {}, 'e1'], ['Waiter', {}, 'w1'], ['Waiter', {}, 'w2'], ['Echo', {}, 'e2']),
      'done',
    ]);
    const definition = graph(
      [
        agent(),
        node('Waiter', 'test.waiter'),
        node('Echo', 'test.echo', { value: 'hi' }),
      ],
      ['Waiter', 'Agent', 'ai_tool'],
      ['Echo', 'Agent', 'ai_tool'],
    );
    const first = await start(definition);
    expect(first.status).toBe('waiting');
    expect(ran).toHaveLength(2);
    expect(first.state.executionData.suspended).toMatchObject({ toolCallId: 'w1' });

    // the second waiting call takes its turn after the first one
    const second = await resume(definition, first, [[{ json: { a: 1 } }]]);
    expect(second.status).toBe('waiting');
    expect(second.state.executionData.suspended).toMatchObject({ toolCallId: 'w2' });
    expect(ran).toHaveLength(2);

    const result = await resume(definition, second, [[{ json: { a: 2 } }]]);
    expect(result.status).toBe('success');
    expect(ran).toHaveLength(2);
    expect(toolMessages(requests[1].messages)).toEqual([
      ['e1', '[{"echoed":"hi"}]'],
      ['w1', '[{"a":1}]'],
      ['w2', '[{"a":2}]'],
      ['e2', '[{"echoed":"hi"}]'],
    ]);
  });

  it('iterations carry over the wait', async () => {
    scriptModel('Model', [toolCalls(['Waiter', {}, 'w1'])]);
    const definition = graph([agent({ maxIterations: 1 }), node('Waiter', 'test.waiter')], [
      'Waiter',
      'Agent',
      'ai_tool',
    ]);
    const result = await resume(definition, await start(definition), APPROVED);
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toContain('Max iterations (1) reached');
  });

  it('the parser retry is not repeated after a wait', async () => {
    const requests = scriptModel('Model', [
      'bad',
      toolCalls(['Waiter', {}, 'w1']),
      'still bad',
    ]);
    const definition = graph(
      [agent(), node('Waiter', 'test.waiter'), node('Parser', 'test.parser')],
      ['Waiter', 'Agent', 'ai_tool'],
      ['Parser', 'Agent', 'ai_outputParser'],
    );
    const result = await resume(definition, await start(definition), APPROVED);
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toContain('The model output could not be parsed');
    expect(requests).toHaveLength(3);
  });
});

describe('the checkpoint', () => {
  it('holds no image or file data, and the resumed run reads them from the binary again', async () => {
    const requests = scriptModel('Model', [toolCalls(['Waiter', {}, 'w1']), 'done']);
    const definition = graph([agent({ passthroughBinaryPdfs: true }), node('Waiter', 'test.waiter')], [
      'Waiter',
      'Agent',
      'ai_tool',
    ]);
    const png = Buffer.from('PNG-SECRET-BYTES').toString('base64');
    const pdf = Buffer.from('PDF-SECRET-BYTES').toString('base64');
    const waiting = await start(definition, [
      {
        json: { chatInput: 'x' },
        binary: {
          a: { data: png, mimeType: 'image/png', fileName: 'a.png' },
          b: { data: pdf, mimeType: 'application/pdf', fileName: 'b.pdf' },
        },
      },
    ]);
    expect(waiting.status).toBe('waiting');
    const stored = JSON.stringify(waiting.state.executionData.suspended?.checkpoint);
    expect(stored).not.toContain(png);
    expect(stored).not.toContain(pdf);
    expect(stored).toContain('"steps"');

    const result = await resume(definition, waiting, APPROVED);
    expect(result.status).toBe('success');
    const prompt = requests[1].messages.find((m) => m.role === 'user')!;
    expect(prompt.content).toEqual([
      { type: 'text', text: 'Go' },
      { type: 'image', data: png, mimeType: 'image/png' },
      expect.objectContaining({ type: 'file', data: pdf, mimeType: 'application/pdf' }),
    ]);
    expect(requests[1].messages).toHaveLength(requests[0].messages.length + 2);
  });

  it('memory is read once and written only at the end', async () => {
    const requests = scriptModel('Model', [toolCalls(['Waiter', {}, 'w1']), 'done']);
    const definition = graph(
      [agent(), node('Waiter', 'test.waiter'), node('Memory', 'test.memory')],
      ['Waiter', 'Agent', 'ai_tool'],
      ['Memory', 'Agent', 'ai_memory'],
    );
    const waiting = await start(definition);
    expect(memoryAppends).toEqual([]);
    const result = await resume(definition, waiting, APPROVED);
    expect(result.status).toBe('success');
    expect(memoryAppends).toEqual([
      [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: 'done' },
      ],
    ]);
    expect(requests[1].messages.filter((m) => m.content === 'earlier')).toHaveLength(1);
  });

  it('a tool result that holds a secret stays out of the model through the error path', async () => {
    const requests = scriptModel('Model', [toolCalls(['Echo', {}, 'e1']), 'done']);
    const definition = graph([agent(), node('Echo', 'test.echo', { fail: true })], ['Echo', 'Agent', 'ai_tool']);
    const result = await start(definition);
    expect(result.status).toBe('success');
    const [[, text]] = toolMessages(requests[1].messages);
    expect(text).toContain('Error: Bad token');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});

describe('items', () => {
  const items: Item[] = ['a', 'b', 'c'].map((chatInput) => ({ json: { chatInput } }));
  const perItem = (options: DataObject) =>
    graph([agent(options, { promptType: 'auto' }), node('Waiter', 'test.waiter')], ['Waiter', 'Agent', 'ai_tool']);

  it('a tool that can wait makes the items run one by one, with a hint', async () => {
    const running: string[] = [];
    let active = 0;
    let most = 0;
    scriptModel('Model', async (request) => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      running.push(String(request.messages.at(-1)?.content));
      return reply('ok');
    });
    const result = await start(perItem({ batching: { batchSize: 3 } }), items);
    expect(result.status).toBe('success');
    expect(most).toBe(1);
    const task = result.state.resultData.runData.Agent[0];
    expect(task.hints).toEqual([
      { message: 'A tool of this agent can wait, so its items run one at a time.', level: 'info' },
    ]);
    expect(running).toEqual(['a', 'b', 'c']);
  });

  it('keeps the batch size when no tool can wait', async () => {
    let active = 0;
    let most = 0;
    scriptModel('Model', async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return reply('ok');
    });
    const definition = graph(
      [agent({ batching: { batchSize: 3 } }, { promptType: 'auto' }), node('Echo', 'test.echo')],
      ['Echo', 'Agent', 'ai_tool'],
    );
    const result = await start(definition, items);
    expect(most).toBe(3);
    expect(result.state.resultData.runData.Agent[0].hints).toBeUndefined();
  });

  it('finished items stay in the checkpoint and the wait stops the next ones', async () => {
    const requests = scriptModel('Model', async (request) => {
      const last = request.messages.at(-1)!;
      if (last.content === 'b') return toolCalls(['Waiter', {}, 'w1']);
      return reply(last.role === 'tool' ? 'b answered' : `${String(last.content)} answered`);
    });
    const definition = perItem({});
    const waiting = await start(definition, items);
    expect(waiting.status).toBe('waiting');
    expect(requests).toHaveLength(2);
    const checkpoint = waiting.state.executionData.suspended?.checkpoint as DataObject;
    expect(checkpoint.itemIndex).toBe(1);
    expect(checkpoint.finishedItems).toEqual([
      { json: { output: 'a answered' }, pairedItem: { item: 0 } },
    ]);

    const result = await resume(definition, waiting, APPROVED);
    expect(result.status).toBe('success');
    expect(agentOutput(result)).toEqual([
      { output: 'a answered' },
      { output: 'b answered' },
      { output: 'c answered' },
    ]);
    expect(result.state.resultData.runData.Agent[0].data?.main?.[0]?.map((i) => i.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
      { item: 2 },
    ]);
  });

  it('a wait does not sit through the delay between batches', async () => {
    scriptModel('Model', [toolCalls(['Waiter', {}, 'w1'])]);
    const definition = perItem({ batching: { batchSize: 1, delayBetweenBatches: 3_600_000 } });
    const waiting = await start(definition, items);
    expect(waiting.status).toBe('waiting');
    expect(waiting.state.executionData.suspended?.checkpoint.itemIndex).toBe(0);
  });
});

describe('the human review gate', () => {
  const gated = (agentOptions: DataObject = {}) =>
    graph(
      [
        agent(agentOptions),
        node('Review', 'test.sendHitlTool', { message: '={{ $tool.name }} {{ $tool.parameters }}' }),
        node('Echo', 'test.echo', { value: `={{ $fromAI('value', 'A value', 'string') }}` }),
      ],
      ['Review', 'Agent', 'ai_tool'],
      ['Echo', 'Review', 'ai_tool'],
    );
  const call = (value: string, id = 'c1') =>
    ['Echo', { toolParameters: { value }, hitlParameters: {} }, id] as [string, DataObject, string];

  it('Approve runs the tool with the original arguments', async () => {
    const requests = scriptModel('Model', [toolCalls(call('hello')), 'done']);
    const definition = gated();
    const waiting = await start(definition);
    expect(waiting.status).toBe('waiting');
    expect(waiting.state.resultData.lastNodeExecuted).toBe('Review');
    expect(messages).toEqual(['Echo {"value":"hello"}']);
    expect(ran).toEqual([]);
    // the model sees the gated tool under its own name with the two groups of arguments
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['Echo']);
    expect(Object.keys((requests[0].tools?.[0].parameters as DataObject).properties as DataObject)).toEqual([
      'toolParameters',
      'hitlParameters',
    ]);

    const result = await resume(definition, waiting, APPROVED);
    expect(result.status).toBe('success');
    expect(ran).toEqual([{ node: 'Echo', args: { value: 'hello' } }]);
    expect(toolMessages(requests[1].messages)).toEqual([['c1', '[{"echoed":"hello"}]']]);
    expect(result.state.resultData.runData.Review[0].data?.ai_tool?.[0]?.[0]?.json).toEqual({
      data: { approved: true },
    });
  });

  it('Decline and a timeout feed the rejection text and the tool does not run', async () => {
    const rejection = (id: string) =>
      `User rejected the tool call to Echo (id: ${id}). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`;
    for (const answer of [DECLINED, undefined]) {
      const requests = scriptModel('Model', [toolCalls(call('hello')), 'ok']);
      const definition = gated();
      const result = await resume(definition, await start(definition), answer);
      expect(result.status).toBe('success');
      expect(toolMessages(requests[1].messages)).toEqual([['c1', rejection('c1')]]);
    }
    expect(ran).toEqual([]);
  });

  it('further gated calls wait their turn, one message at a time', async () => {
    const requests = scriptModel('Model', [toolCalls(call('one', 'c1'), call('two', 'c2')), 'done']);
    const definition = gated();
    const first = await start(definition);
    expect(messages).toEqual(['Echo {"value":"one"}']);

    const second = await resume(definition, first, APPROVED);
    expect(second.status).toBe('waiting');
    expect(second.state.executionData.suspended).toMatchObject({ toolCallId: 'c2', toolRunIndex: 1 });
    expect(messages).toEqual(['Echo {"value":"one"}', 'Echo {"value":"two"}']);
    expect(ran).toEqual([{ node: 'Echo', args: { value: 'one' } }]);

    const result = await resume(definition, second, DECLINED);
    expect(result.status).toBe('success');
    expect(ran).toHaveLength(1);
    expect(toolMessages(requests[1].messages).map(([id]) => id)).toEqual(['c1', 'c2']);
    expect(toolMessages(requests[1].messages)[1][1]).toContain('User rejected the tool call to Echo (id: c2)');
  });

  it('a call without toolParameters goes back to the model and sends nothing', async () => {
    const requests = scriptModel('Model', [toolCalls(['Echo', { value: 'x' }, 'c1']), 'done']);
    const result = await start(gated());
    expect(result.status).toBe('success');
    expect(messages).toEqual([]);
    expect(String(toolMessages(requests[1].messages)[0][1])).toContain('Invalid arguments for "Echo"');
  });

  it('a gated tool that waits by itself waits after the approval', async () => {
    const requests = scriptModel('Model', [
      toolCalls(['Waiter', { toolParameters: {}, hitlParameters: {} }, 'c1']),
      'done',
    ]);
    const definition = graph(
      [agent(), node('Review', 'test.sendHitlTool'), node('Waiter', 'test.waiter')],
      ['Review', 'Agent', 'ai_tool'],
      ['Waiter', 'Review', 'ai_tool'],
    );
    const approved = await resume(definition, await start(definition), APPROVED);
    expect(approved.status).toBe('waiting');
    expect(approved.state.executionData.suspended).toMatchObject({ toolNode: 'Waiter', toolCallId: 'c1' });
    const result = await resume(definition, approved, [[{ json: { from: 'waiter' } }]]);
    expect(result.status).toBe('success');
    expect(toolMessages(requests[1].messages)).toEqual([['c1', '[{"from":"waiter"}]']]);
  });
});

describe('under an AI Agent Tool', () => {
  const subAgent = () => node('Sub', 'ai.agentTool', { text: `={{ $fromAI('input', 'Prompt') }}` });

  it('a plain waiting tool cannot stop the run', async () => {
    const outer = scriptModel('Model', [toolCalls(['Sub', { input: 'go' }, 's1']), 'done']);
    scriptModel('Sub Model', [toolCalls(['Waiter', {}, 'w1'])]);
    const definition = graph(
      [agent(), subAgent(), node('Sub Model', 'test.fakeChatModel'), node('Waiter', 'test.waiter')],
      ['Sub', 'Agent', 'ai_tool'],
      ['Sub Model', 'Sub', 'ai_languageModel'],
      ['Waiter', 'Sub', 'ai_tool'],
    );
    const result = await start(definition);
    expect(result.status).toBe('success');
    expect(String(toolMessages(outer[1].messages)[0][1])).toContain('This run cannot wait for a tool');
  });

  it('a human review gate is refused with its text', async () => {
    const outer = scriptModel('Model', [toolCalls(['Sub', { input: 'go' }, 's1']), 'done']);
    scriptModel('Sub Model', ['never']);
    const definition = graph(
      [
        agent(),
        subAgent(),
        node('Sub Model', 'test.fakeChatModel'),
        node('Review', 'test.sendHitlTool'),
        node('Echo', 'test.echo'),
      ],
      ['Sub', 'Agent', 'ai_tool'],
      ['Sub Model', 'Sub', 'ai_languageModel'],
      ['Review', 'Sub', 'ai_tool'],
      ['Echo', 'Review', 'ai_tool'],
    );
    const result = await start(definition);
    expect(result.status).toBe('success');
    expect(String(toolMessages(outer[1].messages)[0][1])).toContain(
      'Human-in-the-Loop nodes cannot be used inside a sub-agent. Move "Review" to the top-level workflow.',
    );
    expect(messages).toEqual([]);
    expect(ran).toEqual([]);
  });
});
