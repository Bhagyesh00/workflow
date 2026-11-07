import { withToolVariants } from '@workflow/workflow';
import { NodeTypes } from '@workflow/core';
import { nodes } from '../src';
import { describe, expect, it } from 'vitest';
import {
  connect,
  node,
  reply,
  run,
  scriptModel,
  services,
  testNodes,
  toolCalls,
} from './harness';

const types = new NodeTypes(withToolVariants([...nodes, ...testNodes]));

/** a saved node holds its parameters, defaults included */
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
        node('Agent', 'ai.agent', { promptType: 'define', text: 'ask', options: { returnIntermediateSteps: true } }),
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

  it('describes a tool with no main input, an ai_tool output and the default description', () => {
    const { description } = types.get('ai.agentTool')!;
    expect(description.outputs).toEqual(['ai_tool']);
    const prop = (n: string) => description.properties.find((p) => p.name === n);
    expect(prop('toolDescription')?.default).toBe('AI Agent that can call other tools');
    expect(String(prop('text')?.default)).toContain('$fromAI');
    expect(prop('promptType')?.default).toBe('define');
  });
});
