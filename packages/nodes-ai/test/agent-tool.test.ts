import { NodeTypes } from '@workflow/core';
import { withToolVariants } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { connect, node, reply, run, scriptModel, services, testNodes, toolCalls } from './harness';

const types = new NodeTypes(withToolVariants([...nodes, ...testNodes]));

/** a node with its prompt written in; the editor stores only what a person changed, see the test with `{}` */
const tool = (extra = {}) =>
  node('Researcher', 'ai.agentTool', {
    toolDescription: 'Researches a topic',
    text: "={{ $fromAI('input', 'The prompt to send to the agent') }}",
    ...extra,
  });

describe('AI Agent Tool', () => {
  it('an agent calls a sub-agent and gets its answer, each on its own model', async () => {
    const outer = scriptModel('Outer', [
      toolCalls(['Researcher', { input: 'capital of France' }, 'c1']),
      'The sub-agent says: Paris',
    ]);
    const inner = scriptModel('Inner', ['Paris']);
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', {
          promptType: 'define',
          text: 'ask',
          options: { returnIntermediateSteps: true },
        }),
        node('Outer', 'test.fakeChatModel'),
        tool(),
        node('Inner', 'test.fakeChatModel'),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Researcher', 'Agent', 'ai_tool'],
        ['Inner', 'Researcher', 'ai_languageModel'],
      ),
      { services: services({ nodeTypes: types }), nodeTypes: types },
    );
    expect(result.status).toBe('success');
    expect(result.output('Agent')[0].output).toBe('The sub-agent says: Paris');
    // the sub-agent got the model's argument as its prompt and its own model answered
    expect(JSON.stringify(inner[0].messages)).toContain('capital of France');
    expect(inner).toHaveLength(1);
    // the outer model saw the sub-agent's answer as the tool result, and the tool's description
    const toolMessage = outer[1].messages.find((m) => m.role === 'tool');
    expect(String(toolMessage?.content)).toContain('Paris');
    expect(outer[0].tools?.find((t) => t.name === 'Researcher')?.description).toBe('Researches a topic');
  });

  it('a sub-agent can use its own tool', async () => {
    scriptModel('Outer', [toolCalls(['Researcher', { input: 'q' }]), reply('done')]);
    const inner = scriptModel('Inner', [toolCalls(['Echo', { query: 'x' }]), 'inner answer']);
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
        node('Outer', 'test.fakeChatModel'),
        tool(),
        node('Inner', 'test.fakeChatModel'),
        node('Echo', 'ai.toolCalculator'),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Researcher', 'Agent', 'ai_tool'],
        ['Inner', 'Researcher', 'ai_languageModel'],
        ['Echo', 'Researcher', 'ai_tool'],
      ),
      { services: services({ nodeTypes: types }), nodeTypes: types },
    );
    expect(result.status).toBe('success');
    expect(inner).toHaveLength(2);
  });

  it('a node left at its defaults, as the editor stores it, declares the prompt and gets the value', async () => {
    const outer = scriptModel('Outer', [
      toolCalls(['Researcher', { input: 'capital of France' }, 'c1']),
      'The sub-agent says: Paris',
    ]);
    const inner = scriptModel('Inner', ['Paris']);
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
        node('Outer', 'test.fakeChatModel'),
        node('Researcher', 'ai.agentTool', {}),
        node('Inner', 'test.fakeChatModel'),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Researcher', 'Agent', 'ai_tool'],
        ['Inner', 'Researcher', 'ai_languageModel'],
      ),
      { services: services({ nodeTypes: types }), nodeTypes: types },
    );
    expect(result.status).toBe('success');
    expect(outer[0].tools?.find((t) => t.name === 'Researcher')?.parameters).toMatchObject({
      properties: { input: { type: 'string' } },
      required: ['input'],
    });
    expect(JSON.stringify(inner[0].messages)).toContain('capital of France');
  });

  it('a sub-agent writes nothing to the response: only the outer answer reaches the stream', async () => {
    scriptModel('Outer', [toolCalls(['Researcher', { input: 'q' }, 'c1']), 'outer answer']);
    scriptModel('Inner', ['SUB AGENT PRIVATE TEXT']);
    const chunks: unknown[] = [];
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
        node('Outer', 'test.fakeChatModel'),
        tool(),
        node('Inner', 'test.fakeChatModel'),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Researcher', 'Agent', 'ai_tool'],
        ['Inner', 'Researcher', 'ai_languageModel'],
      ),
      {
        services: services({ nodeTypes: types, hooks: { sendChunk: (chunk) => void chunks.push(chunk) } }),
        nodeTypes: types,
      },
    );
    expect(result.status).toBe('success');
    expect(chunks).toEqual(['outer answer']);
  });

  it('a sub-agent linked to itself: the second call is refused, and the model reads why', async () => {
    scriptModel('Outer', [toolCalls(['Sub', { input: 'q' }, 'c1']), 'done']);
    const inner = scriptModel('Inner', [toolCalls(['Sub', { input: 'again' }, 'c2']), 'gave up']);
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
        node('Outer', 'test.fakeChatModel'),
        node('Sub', 'ai.agentTool', {}),
        node('Inner', 'test.fakeChatModel'),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Sub', 'Agent', 'ai_tool'],
        ['Inner', 'Sub', 'ai_languageModel'],
        ['Sub', 'Sub', 'ai_tool'],
      ),
      { services: services({ nodeTypes: types }), nodeTypes: types },
    );
    expect(result.status).toBe('success');
    // one sub-agent run only: the refused call asked no model
    expect(inner).toHaveLength(2);
    const refused = inner[1].messages.find((m) => m.role === 'tool');
    expect(String(refused?.content)).toContain(
      `Couldn't run tool "Sub": it is already running in this chain of tool calls`,
    );
  });

  it('a chain of tools ends with a clear error past the depth limit', async () => {
    const names = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
    const models = names.map((name) => `${name} model`);
    scriptModel('Outer', [toolCalls(['S1', { input: 'q' }]), 'done']);
    const requests = names.map((name, i) =>
      scriptModel(models[i], [toolCalls([names[i + 1] ?? 'none', { input: 'q' }]), `${name} answer`]),
    );
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
        node('Outer', 'test.fakeChatModel'),
        ...names.map((name) => node(name, 'ai.agentTool', {})),
        ...models.map((name) => node(name, 'test.fakeChatModel')),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['S1', 'Agent', 'ai_tool'],
        ...names.slice(1).map((name, i): [string, string, 'ai_tool'] => [name, names[i], 'ai_tool']),
        ...names.map((name, i): [string, string, 'ai_languageModel'] => [
          models[i],
          name,
          'ai_languageModel',
        ]),
      ),
      { services: services({ nodeTypes: types }), nodeTypes: types },
    );
    expect(result.status).toBe('success');
    // S1 to S5 run; the sixth level is refused before it asks its model
    expect(requests[5]).toHaveLength(0);
    const refused = requests[4][1].messages.find((m) => m.role === 'tool');
    expect(String(refused?.content)).toContain(
      `Couldn't run tool "S6": tools can run inside each other at most 5 levels deep`,
    );
  });

  it('ignores a connected output parser until the switch is on', async () => {
    const answer = async (parameters: object) => {
      const outer = scriptModel('Outer', [toolCalls(['Researcher', { input: 'city' }, 'c1']), 'done']);
      scriptModel('Inner', ['{"city": "Paris"}']);
      await run(
        [
          node('Trigger', 'test.trigger'),
          node('Agent', 'ai.agent', { promptType: 'define', text: 'ask' }),
          node('Outer', 'test.fakeChatModel'),
          tool(parameters),
          node('Inner', 'test.fakeChatModel'),
          node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}' }),
        ],
        connect(
          ['Trigger', 'Agent'],
          ['Outer', 'Agent', 'ai_languageModel'],
          ['Researcher', 'Agent', 'ai_tool'],
          ['Inner', 'Researcher', 'ai_languageModel'],
          ['Parser', 'Researcher', 'ai_outputParser'],
        ),
        { services: services({ nodeTypes: types }), nodeTypes: types },
      );
      return String(outer[1].messages.find((m) => m.role === 'tool')?.content);
    };
    // as a string, the model's own text
    expect(await answer({})).toContain('{\\"city\\": \\"Paris\\"}');
    // parsed into an object
    expect(await answer({ hasOutputParser: true })).toContain('"output":{"city":"Paris"}');
  });

  it('describes a tool with no main input, an ai_tool output and the default description', () => {
    const { description } = types.get('ai.agentTool')!;
    expect(description.outputs).toEqual(['ai_tool']);
    const prop = (n: string) => description.properties.find((p) => p.name === n);
    expect(prop('toolDescription')?.default).toBe('AI Agent that can call other tools');
    expect(String(prop('text')?.default)).toContain('$fromAI');
    expect(prop('promptType')?.default).toBe('define');
    expect(prop('hasOutputParser')).toMatchObject({ default: false });
    expect(prop('hasOutputParser')?.displayOptions).toBeUndefined();
  });
});
