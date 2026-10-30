import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  completeExpression,
  enclosingExpressionStart,
  parseAccessPath,
} from '../src/components/code/completions';
import {
  buildExpressionContext,
  previewExpression,
  resolveInput,
  withPinnedData,
} from '../src/lib/expression-context';
import { runDataFor } from './utils';

const node = (name: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id: name,
  name,
  type: 'core.set',
  typeVersion: 1,
  position: [0, 0],
  parameters,
});

const workflow = {
  name: 'Flow',
  active: false,
  nodes: [node('Trigger'), node('Shape'), node('Target', { greeting: 'hi' })],
  connections: {
    Trigger: { main: [[{ node: 'Shape', type: 'main' as const, index: 0 }]] },
    Shape: { main: [[{ node: 'Target', type: 'main' as const, index: 0 }]] },
  },
};

describe('expression preview context', () => {
  const runData = {
    ...runDataFor('Trigger', [{ id: 1 }, { id: 2 }]),
    ...runDataFor('Shape', [
      { name: 'ada', id: 1 },
      { name: 'grace', id: 2 },
    ]),
  };

  it('uses the first parent with data as $json and $input', () => {
    const ctx = buildExpressionContext({ workflow, runData, nodeName: 'Target' });
    expect(previewExpression('={{ $json.name }}', ctx)).toMatchObject({ ok: true, value: 'ada' });
    expect(previewExpression('={{ $input.all().length }}', ctx)).toMatchObject({ ok: true, value: 2 });
    expect(previewExpression('={{ $parameter.greeting }}', ctx)).toMatchObject({ ok: true, value: 'hi' });
  });

  it("follows paired items back to ancestors with $('Node')", () => {
    // as recorded by the engine: Shape's items point at Trigger's items
    const paired = {
      ...runData,
      Shape: [
        {
          ...runData.Shape[0],
          source: [{ previousNode: 'Trigger' }],
          data: {
            main: [
              [
                { json: { name: 'ada' }, pairedItem: { item: 0 } },
                { json: { name: 'grace' }, pairedItem: { item: 1 } },
              ],
            ],
          },
        },
      ],
    };
    const ctx = buildExpressionContext({ workflow, runData: paired, nodeName: 'Target', itemIndex: 1 });
    expect(previewExpression("={{ $('Trigger').item.json.id }}", ctx)).toMatchObject({ ok: true, value: 2 });
  });

  it('renders templates as text and reports errors', () => {
    const ctx = buildExpressionContext({ workflow, runData, nodeName: 'Target' });
    expect(previewExpression('=Hello {{ $json.name }}!', ctx)).toMatchObject({
      ok: true,
      text: 'Hello ada!',
    });
    const failed = previewExpression('={{ $json.name.nope() }}', ctx);
    expect(failed.ok).toBe(false);
  });

  it('keeps the sandbox rules: no constructor escapes, no $env', () => {
    const ctx = buildExpressionContext({ workflow, runData, nodeName: 'Target' });
    expect(previewExpression('={{ "".constructor.constructor("return 1")() }}', ctx).ok).toBe(false);
    expect(previewExpression('={{ $env.HOME }}', ctx).ok).toBe(false);
  });

  it('falls back to pinned data when a parent has not run', () => {
    const pinned = withPinnedData({}, { Shape: [{ json: { name: 'pinned' } }] });
    expect(resolveInput(workflow, pinned, 'Target').items[0].json).toEqual({ name: 'pinned' });
    const ctx = buildExpressionContext({
      workflow,
      runData: {},
      pinData: { Shape: [{ json: { name: 'pinned' } }] },
      nodeName: 'Target',
    });
    expect(previewExpression('={{ $json.name }}', ctx)).toMatchObject({ ok: true, value: 'pinned' });
  });

  it('formats objects and empty values readably', () => {
    const ctx = buildExpressionContext({ workflow, runData, nodeName: 'Target' });
    expect(previewExpression('={{ $json }}', ctx)).toMatchObject({
      ok: true,
      text: '{\n  "name": "ada",\n  "id": 1\n}',
    });
    expect(previewExpression('={{ "" }}', ctx)).toMatchObject({ ok: true, text: '[empty]' });
    expect(previewExpression('={{ $json.missing }}', ctx)).toMatchObject({ ok: true, text: '[undefined]' });
  });
});

describe('completion', () => {
  const data = {
    inputFields: (path: Array<string | number>) =>
      path.length === 0 ? ['name', 'customer', 'first name'] : path[0] === 'customer' ? ['email'] : [],
    nodeNames: ['Trigger', 'Shape'],
    nodeFields: (n: string) => (n === 'Trigger' ? ['id'] : []),
    variables: ['region'],
  };

  it('suggests root variables', () => {
    const result = completeExpression('$js', data)!;
    expect(result.options.map((o) => o.label)).toEqual(['$json']);
    expect(result.from).toBe(0);
  });

  it('suggests $json fields at any depth', () => {
    expect(completeExpression('$json.', data)!.options.map((o) => o.label)).toEqual([
      'name',
      'customer',
      'first name',
    ]);
    expect(completeExpression('$json.cu', data)!.options.map((o) => o.label)).toEqual(['customer']);
    expect(completeExpression('$json.customer.', data)!.options.map((o) => o.label)).toEqual(['email']);
    const spaced = completeExpression('$json.', data)!.options.find((o) => o.label === 'first name');
    expect(spaced?.apply).toBe('["first name"]');
  });

  it("suggests node names inside $('", () => {
    const result = completeExpression("$('Sh", data)!;
    expect(result.options.map((o) => o.apply)).toEqual(["Shape')"]);
  });

  it("suggests members and fields of $('Node')", () => {
    expect(completeExpression("$('Trigger').", data)!.options.map((o) => o.label)).toContain('item');
    expect(completeExpression("$('Trigger').item.json.", data)!.options.map((o) => o.label)).toEqual(['id']);
    expect(completeExpression('$vars.', data)!.options.map((o) => o.label)).toEqual(['region']);
  });

  it('parses access paths and finds the enclosing {{ }}', () => {
    expect(parseAccessPath('.a["b c"][0]')).toEqual(['a', 'b c', 0]);
    expect(parseAccessPath('.a(')).toBeNull();
    expect(enclosingExpressionStart('x {{ $json. }} y', 12)).toBe(4);
    expect(enclosingExpressionStart('x {{ a }} y', 11)).toBe(-1);
  });
});
