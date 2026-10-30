import type { DataObject } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { connect, modelRequests, node, run, scriptModel, services, toolCalls } from './harness';

const chat = (chatInput: string, sessionId = 's1') => [
  { json: { sessionId, chatInput, action: 'sendMessage' } },
];

function agentWorkflow(
  agentParams: DataObject = {},
  extraNodes: ReturnType<typeof node>[] = [],
  extraLinks: Parameters<typeof connect> = [],
) {
  return {
    nodes: [
      node('Chat', 'ai.chatTrigger'),
      node('Agent', 'ai.agent', agentParams),
      node('Model', 'test.fakeChatModel'),
      ...extraNodes,
    ],
    connections: connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ...extraLinks),
  };
}

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

describe('AI Agent', () => {
  it('answers directly without tools, taking chatInput from the Chat Trigger', async () => {
    const requests = scriptModel('Model', ['Hello there']);
    const wf = agentWorkflow({ systemMessage: 'Be brief.' });
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('Hi') });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'Hello there' }]);
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(requests[0].tools).toBeUndefined();
    // the sub-node call is recorded for the AI logs
    expect(r.runData.Model).toHaveLength(1);
  });

  it('runs several tool calls (in parallel) over multiple steps', async () => {
    const requests = scriptModel('Model', [
      toolCalls(['Calculator', { input: '2+3' }], ['Think', { thought: 'add then multiply' }]),
      toolCalls(['Calculator', { input: '5*4' }]),
      'The answer is 20',
    ]);
    const wf = agentWorkflow(
      { options: { returnIntermediateSteps: true, returnUsage: true } },
      [node('Calculator', 'ai.toolCalculator'), node('Think', 'ai.toolThink')],
      [
        ['Calculator', 'Agent', 'ai_tool'],
        ['Think', 'Agent', 'ai_tool'],
      ],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('What is (2+3)*4?') });
    expect(r.status).toBe('success');
    const [out] = r.output('Agent');
    expect(out.output).toBe('The answer is 20');
    const steps = out.intermediateSteps as Array<{ action: { tool: string }; observation: string }>;
    expect(steps.map((s) => [s.action.tool, s.observation])).toEqual([
      ['Calculator', '5'],
      ['Think', 'add then multiply'],
      ['Calculator', '20'],
    ]);
    expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 15, modelCalls: 3, toolCalls: 3 });
    expect(requests[0].tools?.map((t) => t.name).sort()).toEqual(['Calculator', 'Think']);
    // second call sees the assistant tool calls and both results
    const second = requests[1].messages;
    expect(second.slice(-3).map((m) => [m.role, m.content, m.toolCallId])).toEqual([
      ['assistant', '', undefined],
      ['tool', '5', 'call_Calculator_0'],
      ['tool', 'add then multiply', 'call_Think_1'],
    ]);
    // tool sub-nodes log every invocation
    expect(r.runData.Calculator).toHaveLength(2);
  });

  it('returns tool errors to the model and keeps going', async () => {
    const requests = scriptModel('Model', [
      toolCalls(['Calculator', { input: 'process.exit()' }]),
      toolCalls(['Missing_tool', {}]),
      toolCalls(['Calculator', {}]),
      'Sorry, I could not calculate that.',
    ]);
    const wf = agentWorkflow(
      {},
      [node('Calculator', 'ai.toolCalculator')],
      [['Calculator', 'Agent', 'ai_tool']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('break it') });
    expect(r.status).toBe('success');
    expect(r.output('Agent')[0].output).toBe('Sorry, I could not calculate that.');
    const toolMessage = (call: number) => requests[call].messages.at(-1)!;
    expect(toolMessage(1)).toMatchObject({
      role: 'tool',
      content: expect.stringMatching(/^Error: Unknown name "process.exit"/),
    });
    expect(toolMessage(2).content).toMatch(/^Error: There is no tool named "Missing_tool"/);
    expect(toolMessage(3).content).toMatch(
      /^Error: Invalid arguments for "Calculator": \$\.input is required/,
    );
  });

  it('stops on tool errors when configured to', async () => {
    scriptModel('Model', [toolCalls(['Calculator', { input: '1/' }]), 'unreachable']);
    const wf = agentWorkflow(
      { options: { toolErrorBehavior: 'stop' } },
      [node('Calculator', 'ai.toolCalculator')],
      [['Calculator', 'Agent', 'ai_tool']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('x') });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_TOOL_ERROR');
  });

  it('fails with a clear error when max iterations are exceeded', async () => {
    scriptModel('Model', () => toolCalls(['Think', { thought: 'again' }]));
    const wf = agentWorkflow(
      { options: { maxIterations: 3 } },
      [node('Think', 'ai.toolThink')],
      [['Think', 'Agent', 'ai_tool']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('loop') });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_MAX_ITERATIONS');
    expect(r.error?.message).toContain('3 iterations');
    expect(modelRequests.get('Model')).toHaveLength(3);
  });

  it('stops when the token budget is exceeded', async () => {
    scriptModel('Model', () => toolCalls(['Think', { thought: 'hmm' }]));
    const wf = agentWorkflow(
      { options: { tokenBudget: 40 } },
      [node('Think', 'ai.toolThink')],
      [['Think', 'Agent', 'ai_tool']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('spend') });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_TOKEN_BUDGET');
    expect(modelRequests.get('Model')).toHaveLength(3); // 15, 30, 45 tokens
  });

  it('remembers the conversation across executions with window memory', async () => {
    const memory = node('Memory', 'ai.memoryBufferWindow', { contextWindowLength: 2 });
    const wf = agentWorkflow({}, [memory], [['Memory', 'Agent', 'ai_memory']]);
    scriptModel('Model', ['Nice to meet you, Ada.']);
    expect((await run(wf.nodes, wf.connections, { triggerItems: chat('My name is Ada') })).status).toBe(
      'success',
    );

    const requests = scriptModel('Model', ['Your name is Ada.']);
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('What is my name?') });
    expect(r.output('Agent')).toEqual([{ output: 'Your name is Ada.' }]);
    expect(requests[0].messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are a helpful assistant.'],
      ['user', 'My name is Ada'],
      ['assistant', 'Nice to meet you, Ada.'],
      ['user', 'What is my name?'],
    ]);

    // another session and another tenant do not see this history
    const other = scriptModel('Model', ['Hi']);
    await run(wf.nodes, wf.connections, { triggerItems: chat('Hello', 's2') });
    expect(other[0].messages).toHaveLength(2);
    const tenant = scriptModel('Model', ['Hi']);
    await run(wf.nodes, wf.connections, {
      triggerItems: chat('Hello'),
      services: services({ tenantId: 't2' }),
    });
    expect(tenant[0].messages).toHaveLength(2);
  });

  it('does not write memory when the run fails, and redacts secrets', async () => {
    const memory = node('Memory', 'ai.memoryBufferWindow');
    const wf = agentWorkflow(
      { options: { maxIterations: 1 } },
      [memory, node('Think', 'ai.toolThink')],
      [
        ['Memory', 'Agent', 'ai_memory'],
        ['Think', 'Agent', 'ai_tool'],
      ],
    );
    scriptModel('Model', [toolCalls(['Think', { thought: 'x' }])]);
    expect((await run(wf.nodes, wf.connections, { triggerItems: chat('first') })).status).toBe('error');

    scriptModel('Model', ['Stored.']);
    await run(wf.nodes, wf.connections, {
      triggerItems: chat('my key is sk-abcdefghijklmnopqrstuvwxyz123456'),
    });
    const requests = scriptModel('Model', ['ok']);
    await run(wf.nodes, wf.connections, { triggerItems: chat('next') });
    expect(requests[0].messages.map((m) => m.content)).toEqual([
      'You are a helpful assistant.',
      'my key is [redacted]',
      'Stored.',
      'next',
    ]);
  });

  it('parses structured output, retrying once when the first answer does not parse', async () => {
    const requests = scriptModel('Model', [
      'not json at all',
      '```json\n{"city": "Paris", "population": 2100000}\n```',
    ]);
    const wf = agentWorkflow(
      {},
      [
        node('Parser', 'ai.outputParserStructured', {
          schemaType: 'fromJson',
          jsonSchemaExample: '{"city": "Rome", "population": 1}',
        }),
      ],
      [['Parser', 'Agent', 'ai_outputParser']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('Largest city in France?') });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: { city: 'Paris', population: 2100000 } }]);
    expect(requests).toHaveLength(2);
    expect(requests[0].responseFormat).toMatchObject({ type: 'json', schema: { type: 'object' } });
    expect(String(requests[0].messages[0].content)).toContain('JSON schema');
    expect(String(requests[1].messages.at(-1)!.content)).toContain('could not be parsed');
  });

  it('fails when structured output never parses', async () => {
    scriptModel('Model', ['nope', '{"city": 3}']);
    const wf = agentWorkflow(
      {},
      [node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}' })],
      [['Parser', 'Agent', 'ai_outputParser']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_OUTPUT_PARSE');
    expect(r.error?.message).toContain('$.city must be string');
  });

  it('streams answer text through sendChunk', async () => {
    scriptModel('Model', ['Streaming works fine']);
    const chunks: any[] = [];
    const wf = agentWorkflow();
    wf.nodes[2] = node('Model', 'test.fakeChatModel', { streaming: true });
    const r = await run(wf.nodes, wf.connections, {
      triggerItems: chat('stream please'),
      services: services({ hooks: { sendChunk: (c) => void chunks.push(c) } }),
    });
    expect(r.status).toBe('success');
    expect(chunks.map((c) => c.type)).toEqual(['begin', 'item', 'item', 'item', 'end']);
    expect(
      chunks
        .filter((c) => c.type === 'item')
        .map((c) => c.content)
        .join(''),
    ).toBe('Streaming works fine');
    expect(chunks[0].metadata).toEqual({ nodeName: 'Agent', itemIndex: 0 });
  });

  it('uses a defined prompt and fails clearly without chatInput', async () => {
    scriptModel('Model', ['ok']);
    const wf = agentWorkflow({ promptType: 'define', text: '={{ "Summarize: " + $json.body }}' });
    const r = await run(wf.nodes, wf.connections, { triggerItems: [{ json: { body: 'abc' } }] });
    expect(modelRequests.get('Model')![0].messages.at(-1)!.content).toBe('Summarize: abc');
    expect(r.status).toBe('success');

    const auto = agentWorkflow();
    const failed = await run(auto.nodes, auto.connections, { triggerItems: [{ json: { body: 'abc' } }] });
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toContain('chatInput');
  });

  it('requires a chat model', async () => {
    const r = await run(
      [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent')],
      connect(['Chat', 'Agent']),
      {
        triggerItems: chat('hi'),
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('languageModel');
  });

  it('times out slow tools and tells the model', async () => {
    const requests = scriptModel('Model', [toolCalls(['Slow', { query: 'x' }]), 'gave up']);
    const wf = agentWorkflow(
      { options: { toolTimeout: 200 } },
      [
        node('Slow', 'ai.toolCode', {
          jsCode: 'const end = Date.now() + 1500; while (Date.now() < end) {} return 1;',
        }),
      ],
      [['Slow', 'Agent', 'ai_tool']],
    );
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('go') });
    expect(r.status).toBe('success');
    expect(requests[1].messages.at(-1)!.content).toMatch(/^Error: .*timed out/);
  });

  it('continues on fail per item', async () => {
    scriptModel('Model', () => {
      throw new Error('model down');
    });
    const wf = agentWorkflow();
    wf.nodes[1] = node('Agent', 'ai.agent', {}, { onError: 'continueRegularOutput' });
    const r = await run(wf.nodes, wf.connections, { triggerItems: chat('a') });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ error: 'model down' }]);
  });
});
