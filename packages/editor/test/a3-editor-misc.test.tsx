import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PushEvent } from '../src/api/types';
import { demoNodeTypes } from '../src/demo/fixtures';
import {
  initialRunSnapshot,
  nodeRunStatus,
  type RunSnapshot,
  reduceRunEvent,
  type TestWebhookState,
} from '../src/stores/run-store';
import { signedIn } from './backend';
import { renderParameters } from './utils';

const crm = demoNodeTypes.find((d) => d.name === 'app.crm')!;

function field(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-parameter="${name}"]`);
  if (!el) throw new Error(`parameter ${name} is not rendered`);
  return el;
}

describe('R22: resource locator in list mode switches to an expression', () => {
  beforeEach(() => {
    signedIn();
  });

  it('shows the expression editor after toggling Expression on a list-mode locator', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(crm, { parameters: { resource: 'contact', operation: 'get' } });
    await user.click(within(field('contactId')).getByRole('button', { name: 'Expression' }));
    expect(node.current.parameters.contactId).toMatchObject({ __rl: true, value: '=' });
    expect(field('contactId').querySelector('[data-testid="code-editor-expression"]')).toBeTruthy();
    expect(within(field('contactId')).queryByRole('button', { name: '=' })).toBeNull();
  });

  it('keeps the list button for a plain list-mode value', () => {
    renderParameters(crm, {
      parameters: {
        resource: 'contact',
        operation: 'get',
        contactId: { __rl: true, mode: 'list', value: 'c_1' },
      },
    });
    expect(field('contactId').querySelector('[data-testid="code-editor-expression"]')).toBeNull();
  });
});

const webhook: TestWebhookState = {
  nodeName: 'Webhook',
  testUrl: 'http://x/webhook-test/a/b',
  expiresAt: '',
};
const started = (executionId: string, mode: 'manual' | 'webhook'): PushEvent => ({
  type: 'executionStarted',
  data: { executionId, workflowId: 'wf1', mode: mode as never },
});
const nodeStarted = (executionId: string, nodeName: string): PushEvent => ({
  type: 'nodeExecuteBefore',
  data: { executionId, nodeName },
});

describe('R26: production executions are not adopted while starting or listening', () => {
  const listening = (): RunSnapshot => ({
    ...initialRunSnapshot(),
    status: 'listening',
    testWebhook: webhook,
  });
  const starting = (): RunSnapshot => ({ ...initialRunSnapshot(), status: 'starting' });

  it('keeps listening when a production execution starts, then follows the test call', () => {
    let s = reduceRunEvent(listening(), started('prod1', 'webhook'), 'wf1');
    expect(s.status).toBe('listening');
    expect(s.executionId).toBeNull();
    expect(s.testWebhook).toEqual(webhook);
    s = reduceRunEvent(s, started('test1', 'manual'), 'wf1');
    expect(s.status).toBe('listening');
    expect(s.executionId).toBeNull();
    s = reduceRunEvent(s, nodeStarted('test1', 'NoOp'), 'wf1');
    s = reduceRunEvent(
      s,
      { type: 'testWebhookReceived', data: { workflowId: 'wf1', executionId: 'test1' } },
      'wf1',
    );
    expect(s.executionId).toBe('test1');
    expect(s.status).toBe('running');
    expect(s.runningNodes).toEqual(['NoOp']);
    expect(nodeRunStatus(s, 'NoOp')).toBe('running');
  });

  it('does not buffer the later events of a production execution while listening', () => {
    let s = reduceRunEvent(listening(), started('prod1', 'webhook'), 'wf1');
    s = reduceRunEvent(s, nodeStarted('prod1', 'NoOp'), 'wf1');
    s = reduceRunEvent(
      s,
      { type: 'consoleMessage', data: { executionId: 'prod1', nodeName: 'NoOp', args: ['x'] } },
      'wf1',
    );
    s = reduceRunEvent(
      s,
      {
        type: 'executionFinished',
        data: { executionId: 'prod1', status: 'success' },
      } as unknown as PushEvent,
      'wf1',
    );
    expect(s.pending).toEqual({});
    s = reduceRunEvent(s, started('test1', 'manual'), 'wf1');
    s = reduceRunEvent(
      s,
      { type: 'testWebhookReceived', data: { workflowId: 'wf1', executionId: 'test1' } },
      'wf1',
    );
    expect(s.executionId).toBe('test1');
    expect(s.status).toBe('running');
    expect(s.pending).toEqual({});
  });

  it('does not adopt a production execution while a manual run is starting', () => {
    let s = reduceRunEvent(starting(), started('prod1', 'webhook'), 'wf1');
    expect(s.executionId).toBeNull();
    expect(s.status).toBe('starting');
    s = reduceRunEvent(s, started('man1', 'manual'), 'wf1');
    expect(s.executionId).toBe('man1');
    expect(s.status).toBe('running');
  });
});
