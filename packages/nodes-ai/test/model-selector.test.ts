import { NodeTypes } from '@workflow/core';
import type { Connections, DataObject, NodeType } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { modelRequests, node, reply, run, scriptModel, services, testNodes } from './harness';

const eq = (left: string, right: string) => ({
  conditions: [
    { id: 'c1', leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } },
  ],
  combinator: 'and',
  options: { caseSensitive: true, typeValidation: 'strict' },
});
const rule = (model: number, conditions: DataObject) => ({ model, conditions });
const rulesOf = (...rules: DataObject[]) => ({ rule: rules });
const kindIs = (value: string) => eq('={{ $json.kind }}', value);

/** Models connect to the selector input slots in order; the selector connects to the consumer. */
function wire(consumer: string, modelNames: string[], selector = 'Selector'): Connections {
  const c: Connections = { Trigger: { main: [[{ node: consumer, type: 'main', index: 0 }]] } };
  modelNames.forEach((name, slot) => {
    c[name] = { ai_languageModel: [[{ node: selector, type: 'ai_languageModel', index: slot }]] };
  });
  c[selector] = { ai_languageModel: [[{ node: consumer, type: 'ai_languageModel', index: 0 }]] };
  return c;
}

const agent = () => node('Agent', 'ai.agent', { promptType: 'define', text: 'q' });
const selectorNode = (params: DataObject) => node('Selector', 'ai.modelSelector', params);
const items = (...kinds: string[]) => kinds.map((kind) => ({ json: { kind } }));

beforeEach(() => modelRequests.clear());

describe('Model Selector', () => {
  it('uses model 2 for item 1 and model 3 for item 2', async () => {
    const m1 = scriptModel('M1', ['from one']);
    const m2 = scriptModel('M2', ['from two']);
    const m3 = scriptModel('M3', ['from three']);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        agent(),
        selectorNode({
          numberInputs: 3,
          rules: rulesOf(rule(2, kindIs('b')), rule(3, kindIs('c')), rule(1, kindIs('a'))),
        }),
        node('M1', 'test.fakeChatModel'),
        node('M2', 'test.fakeChatModel'),
        node('M3', 'test.fakeChatModel'),
      ],
      wire('Agent', ['M1', 'M2', 'M3']),
      { triggerItems: items('b', 'c') },
    );
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'from two' }, { output: 'from three' }]);
    expect(m1).toHaveLength(0);
    expect(m2).toHaveLength(1);
    expect(m3).toHaveLength(1);
  });

  it('takes the first rule that matches, top to bottom', async () => {
    const m1 = scriptModel('M1', ['one']);
    const m2 = scriptModel('M2', ['two']);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        agent(),
        selectorNode({ rules: rulesOf(rule(2, kindIs('x')), rule(1, kindIs('x'))) }),
        node('M1', 'test.fakeChatModel'),
        node('M2', 'test.fakeChatModel'),
      ],
      wire('Agent', ['M1', 'M2']),
      { triggerItems: items('x') },
    );
    expect(r.output('Agent')).toEqual([{ output: 'two' }]);
    expect(m1).toHaveLength(0);
    expect(m2).toHaveLength(1);
  });

  it('compares case sensitively and reads the OR combinator', async () => {
    scriptModel('M1', ['one']);
    scriptModel('M2', ['two']);
    const either = {
      ...kindIs('A'),
      combinator: 'or',
      conditions: [
        ...kindIs('A').conditions,
        { id: 'c2', leftValue: '={{ $json.kind }}', rightValue: 'b', operator: { type: 'string', operation: 'equals' } },
      ],
    };
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        agent(),
        selectorNode({ rules: rulesOf(rule(2, either), rule(1, kindIs('a'))) }),
        node('M1', 'test.fakeChatModel'),
        node('M2', 'test.fakeChatModel'),
      ],
      wire('Agent', ['M1', 'M2']),
      { triggerItems: items('a', 'b') },
    );
    expect(r.output('Agent')).toEqual([{ output: 'one' }, { output: 'two' }]);
  });

  describe('errors', () => {
    const failing = async (params: DataObject, connected = ['M1', 'M2'], kinds = ['a']) => {
      scriptModel('M1', ['one']);
      scriptModel('M2', ['two']);
      return run(
        [
          node('Trigger', 'test.trigger'),
          agent(),
          selectorNode(params),
          ...connected.map((n) => node(n, 'test.fakeChatModel')),
        ],
        wire('Agent', connected),
        { triggerItems: items(...kinds) },
      );
    };

    it('says "No models connected" when no input has a model', async () => {
      const r = await failing({ rules: rulesOf(rule(1, kindIs('a'))) }, []);
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('No models connected');
      expect(r.error?.description).toBe('No models found in input connections');
    });

    it('says "No rules defined" when there are no rules', async () => {
      const r = await failing({});
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('No rules defined');
      expect(r.error?.description).toBe('At least one rule must be defined to select a model');
    });

    it('says "Invalid model index N" when the rule points past the connected models', async () => {
      const r = await failing({ numberInputs: 2, rules: rulesOf(rule(5, kindIs('a'))) });
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('Invalid model index 5');
      expect(r.error?.description).toBe('Model index must be between 1 and 2');
    });

    it('says "Invalid model index N" when the picked input has no model', async () => {
      const r = await failing({ rules: rulesOf(rule(2, kindIs('a'))) }, ['M1']);
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('Invalid model index 2');
    });

    it('says "No matching rule found" when no rule matches the item', async () => {
      const r = await failing({ rules: rulesOf(rule(1, kindIs('z'))) });
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('No matching rule found');
      expect(r.error?.description).toBe('None of the defined rules matched the workflow data');
    });

    it('points at the rule when a condition cannot be evaluated', async () => {
      const bad = {
        conditions: [
          {
            id: 'c1',
            leftValue: '={{ $json.kind }}',
            rightValue: 'x',
            operator: { type: 'number', operation: 'equals' },
          },
        ],
        combinator: 'and',
        options: { caseSensitive: true, typeValidation: 'strict' },
      };
      const r = await failing({ rules: rulesOf(rule(1, bad)) });
      expect(r.status).toBe('error');
      expect(String(r.error?.message)).toContain('[rule 1]');
    });
  });

  it('has no node filter on its inputs, so a completion model passes through and the Agent refuses it', async () => {
    const completion: NodeType = {
      description: {
        name: 'test.completionModel',
        displayName: 'Completion Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Completion' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [],
      },
      async supplyData() {
        return {
          response: {
            kind: 'chatModel',
            provider: 'fake',
            model: 'completion-1',
            completion: true,
            capabilities: { structuredOutput: false, structuredOutputWithTools: false },
            chat: async () => reply('never'),
          },
        };
      },
    };
    const selector = nodes.find((n) => n.description.name === 'ai.modelSelector')!;
    expect(String(selector.description.inputs)).not.toContain('filter');

    scriptModel('M1', ['one']);
    const types = new NodeTypes([...nodes, ...testNodes, completion]);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        agent(),
        selectorNode({ rules: rulesOf(rule(2, kindIs('a'))) }),
        node('M1', 'test.fakeChatModel'),
        node('Completion', 'test.completionModel'),
      ],
      wire('Agent', ['M1', 'Completion']),
      { triggerItems: items('a'), nodeTypes: types, services: services({ nodeTypes: types }) },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('is a text completion model; connect a chat model');
  });

  it('is registered in the shared registry', () => {
    expect(nodes.some((n) => n.description.name === 'ai.modelSelector')).toBe(true);
  });
});
