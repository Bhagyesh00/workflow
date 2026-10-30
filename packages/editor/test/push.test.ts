import type { TaskData } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { parsePushMessage } from '../src/api/push';
import type { PushEvent } from '../src/api/types';
import { handlePushEvent } from '../src/components/shell/PushBridge';
import {
  initialRunSnapshot,
  nodeRunStatus,
  type RunSnapshot,
  reduceRunEvent,
  useRunStore,
} from '../src/stores/run-store';
import { useWorkflowStore } from '../src/stores/workflow-store';

const task = (status: TaskData['executionStatus'] = 'success', items = 1): TaskData => ({
  startTime: 1,
  executionTime: 5,
  executionStatus: status,
  data: { main: [Array.from({ length: items }, (_, i) => ({ json: { i } }))] },
  source: [],
  ...(status === 'error' ? { error: { name: 'Error', message: 'boom' } } : {}),
});

const starting = (): RunSnapshot => ({ ...initialRunSnapshot(), status: 'starting', workflowId: 'wf1' });

describe('push message parsing', () => {
  it('accepts known event types with JSON data', () => {
    expect(parsePushMessage('nodeExecuteBefore', '{"executionId":"e1","nodeName":"A"}')).toEqual({
      type: 'nodeExecuteBefore',
      data: { executionId: 'e1', nodeName: 'A' },
    });
  });

  it('drops unknown types and malformed payloads', () => {
    expect(parsePushMessage('somethingElse', '{}')).toBeNull();
    expect(parsePushMessage('executionStarted', '{oops')).toBeNull();
    expect(parsePushMessage('executionStarted', '42')).toBeNull();
  });
});

describe('run state reducer', () => {
  it('adopts the execution announced for the open workflow and tracks node status', () => {
    let s = reduceRunEvent(
      starting(),
      { type: 'executionStarted', data: { executionId: 'e1', workflowId: 'wf1', mode: 'manual' } },
      'wf1',
    );
    expect(s.executionId).toBe('e1');
    expect(s.status).toBe('running');
    s = reduceRunEvent(s, { type: 'nodeExecuteBefore', data: { executionId: 'e1', nodeName: 'A' } }, 'wf1');
    expect(nodeRunStatus(s, 'A')).toBe('running');
    s = reduceRunEvent(
      s,
      {
        type: 'nodeExecuteAfter',
        data: { executionId: 'e1', nodeName: 'A', runIndex: 0, taskData: task('success', 3) },
      },
      'wf1',
    );
    expect(nodeRunStatus(s, 'A')).toBe('success');
    expect(s.runData.A[0].data?.main?.[0]).toHaveLength(3);
    s = reduceRunEvent(
      s,
      {
        type: 'nodeExecuteAfter',
        data: { executionId: 'e1', nodeName: 'B', runIndex: 0, taskData: task('error') },
      },
      'wf1',
    );
    expect(nodeRunStatus(s, 'B')).toBe('error');
    s = reduceRunEvent(
      s,
      { type: 'consoleMessage', data: { executionId: 'e1', nodeName: 'B', args: ['hello', { a: 1 }] } },
      'wf1',
    );
    expect(s.logs.map((l) => l.args)).toEqual([['hello', { a: 1 }]]);
    s = reduceRunEvent(
      s,
      {
        type: 'executionFinished',
        data: {
          executionId: 'e1',
          workflowId: 'wf1',
          status: 'error',
          error: { name: 'E', message: 'boom' },
        },
      },
      'wf1',
    );
    expect(s.status).toBe('error');
    expect(s.error?.message).toBe('boom');
  });

  it('ignores events of other executions and other workflows', () => {
    const running: RunSnapshot = { ...initialRunSnapshot(), status: 'running', executionId: 'mine' };
    const s = reduceRunEvent(
      running,
      { type: 'nodeExecuteBefore', data: { executionId: 'other', nodeName: 'A' } },
      'wf1',
    );
    expect(s).toBe(running);
    const other = reduceRunEvent(
      starting(),
      { type: 'executionStarted', data: { executionId: 'e9', workflowId: 'another', mode: 'manual' } },
      'wf1',
    );
    expect(other.executionId).toBeNull();
  });

  it('buffers events that arrive before the run request returns, then replays them', () => {
    let s = starting();
    const before: PushEvent = { type: 'nodeExecuteBefore', data: { executionId: 'e1', nodeName: 'A' } };
    const after: PushEvent = {
      type: 'nodeExecuteAfter',
      data: { executionId: 'e1', nodeName: 'A', runIndex: 0, taskData: task() },
    };
    s = reduceRunEvent(s, before, null);
    s = reduceRunEvent(s, after, null);
    expect(s.runData).toEqual({});
    expect(s.pending.e1).toHaveLength(2);
    useRunStore.setState(s);
    useRunStore.getState().adopt('e1');
    const adopted = useRunStore.getState();
    expect(adopted.executionId).toBe('e1');
    expect(nodeRunStatus(adopted, 'A')).toBe('success');
    expect(adopted.pending).toEqual({});
  });

  it('follows a test webhook call while listening', () => {
    const listening: RunSnapshot = {
      ...initialRunSnapshot(),
      status: 'listening',
      testWebhook: { nodeName: 'Webhook', testUrl: 'http://x/webhook-test/a/b', expiresAt: '' },
    };
    const s = reduceRunEvent(
      listening,
      { type: 'testWebhookReceived', data: { workflowId: 'wf1', executionId: 'e5' } },
      'wf1',
    );
    expect(s.executionId).toBe('e5');
    expect(s.status).toBe('running');
    expect(s.testWebhook).toBeNull();
  });
});

describe('push bridge', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
    useWorkflowStore.getState().load({ id: 'wf1', name: 'Flow', nodes: [], connections: {} });
  });

  it('routes events to the run store for the open workflow', () => {
    useRunStore.getState().beginRun('wf1');
    handlePushEvent({
      type: 'executionStarted',
      data: { executionId: 'e1', workflowId: 'wf1', mode: 'manual' },
    });
    handlePushEvent({ type: 'nodeExecuteBefore', data: { executionId: 'e1', nodeName: 'A' } });
    expect(useRunStore.getState().runningNodes).toEqual(['A']);
    handlePushEvent({
      type: 'executionFinished',
      data: { executionId: 'e1', workflowId: 'wf1', status: 'success' },
    });
    expect(useRunStore.getState().status).toBe('success');
    expect(useRunStore.getState().runningNodes).toEqual([]);
  });

  it('keeps the previous run for comparison', () => {
    useRunStore.setState({ runData: { A: [task()] } });
    useRunStore.getState().beginRun('wf1');
    expect(useRunStore.getState().previousRunData?.A).toHaveLength(1);
    expect(useRunStore.getState().runData).toEqual({});
  });
});
