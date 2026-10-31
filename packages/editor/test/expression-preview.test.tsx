import { waitFor, within } from '@testing-library/react';
import type { Connections, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { kitchenSink } from '../src/demo/fixtures';
import { buildExpressionContext, previewExpression } from '../src/lib/expression-context';
import { signedIn } from './backend';
import { renderParameters, runDataFor } from './utils';

const node = (name: string): WorkflowNode => ({
  id: name,
  name,
  type: 'core.set',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
});
const workflow = {
  name: 'W',
  active: false,
  nodes: [node('Source'), node('Target')],
  connections: { Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } } as Connections,
};

function field(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-parameter="${name}"]`);
  if (!el) throw new Error(`parameter ${name} is not rendered`);
  return el;
}

describe('previewExpression without input data', () => {
  const empty = buildExpressionContext({ workflow, runData: {}, nodeName: 'Target' });

  it('marks failures that come from missing input as waiting for input', () => {
    for (const expression of ['={{ $json.name }}', '={{ $input.first().json.a }}', "={{ $('Source').item.json.a }}"]) {
      expect(previewExpression(expression, empty), expression).toMatchObject({ ok: false, noInput: true });
    }
  });

  it('keeps real mistakes as errors even without input', () => {
    expect(previewExpression("={{ $('Nope').item.json.x }}", empty)).toMatchObject({
      ok: false,
      noInput: false,
      error: expect.stringContaining('Nope'),
    });
    expect(previewExpression('={{ 1 + }}', empty)).toMatchObject({ ok: false, noInput: false });
  });

  it('keeps failures that no input could fix as errors', () => {
    for (const expression of ['={{ $now.foo.bar }}', "={{ 'x'.foo.bar }}", '={{ ({}).a.b }}']) {
      expect(previewExpression(expression, empty), expression).toMatchObject({
        ok: false,
        noInput: false,
        code: 'EXPRESSION',
      });
    }
  });

  it('still evaluates expressions that need no input', () => {
    expect(previewExpression('={{ 1 + 1 }}', empty)).toMatchObject({ ok: true, value: 2 });
  });
});

describe('previewExpression with input data', () => {
  const ctx = buildExpressionContext({
    workflow,
    runData: runDataFor('Source', [{ name: 'ada' }]),
    nodeName: 'Target',
  });

  it('reports the error code and hint of a real error', () => {
    expect(previewExpression('={{ 1 + }}', ctx)).toMatchObject({
      ok: false,
      noInput: false,
      code: 'EXPRESSION_SYNTAX',
      hint: 'Check brackets and quotes in the expression.',
    });
  });

  it('does not treat a missing value on real input as waiting for input', () => {
    expect(previewExpression('={{ $json.name.first.last }}', ctx)).toMatchObject({ ok: false, noInput: false });
  });
});

describe('expression preview in the parameter form', () => {
  beforeEach(() => {
    signedIn();
  });

  it('shows a neutral hint instead of a red error before any node has run', async () => {
    renderParameters(kitchenSink, { parameters: { text: '={{ $json.text }}' } });
    const preview = () => within(field('text')).getByTestId('expression-preview');
    await waitFor(() => expect(preview().textContent).toContain('Execute previous nodes to preview'));
    expect(preview().textContent).not.toContain('Error');
    expect(preview().className).not.toContain('text-err');
    expect(preview().getAttribute('data-state')).toBe('waiting');
  });

  it('still shows the underlying message in muted text while waiting for input', async () => {
    renderParameters(kitchenSink, { parameters: { text: '={{ $json.text }}' } });
    const preview = () => within(field('text')).getByTestId('expression-preview');
    await waitFor(() => expect(preview().getAttribute('data-state')).toBe('waiting'));
    expect(preview().textContent).toContain("Cannot read properties of undefined (reading 'text')");
    expect(preview().className).not.toContain('text-err');
  });

  it('shows a real error in red even when the node has no input yet', async () => {
    renderParameters(kitchenSink, { parameters: { text: '={{ $now.foo.bar }}' } });
    const preview = () => within(field('text')).getByTestId('expression-preview');
    await waitFor(() => expect(preview().getAttribute('data-state')).toBe('error'));
    expect(preview().className).toContain('text-err');
  });

  it('shows the error code and hint in red for a real error', async () => {
    renderParameters(kitchenSink, {
      parameters: { text: '={{ 1 + }}' },
      runData: runDataFor('Source', [{ name: 'ada' }]),
    });
    const preview = () => within(field('text')).getByTestId('expression-preview');
    await waitFor(() => expect(preview().textContent).toContain('Error'));
    expect(preview().textContent).toContain('EXPRESSION_SYNTAX');
    expect(preview().textContent).toContain('Check brackets and quotes in the expression.');
    expect(preview().className).toContain('text-err');
    expect(preview().getAttribute('data-state')).toBe('error');
  });
});
