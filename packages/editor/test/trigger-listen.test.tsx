/**
 * P4-21 test listen in the editor: Execute step on a trigger without a URL waits for its first event, the
 * bar shows no URL, Stop closes it on the server, and the test event shows in the editor.
 */
import { act, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsApi } from '../src/api/endpoints';
import { NodeDetailsView } from '../src/components/ndv/NodeDetailsView';
import { demoNodeTypes } from '../src/demo/fixtures';
import { receiveTestTrigger } from '../src/demo/mock-triggers';
import {
  isEventTrigger,
  listenForTestEvent,
  runWorkflow,
  stopExecution,
  webhookTriggerToListen,
} from '../src/features/editor/editor-actions';
import { ExecuteBar } from '../src/features/editor/ExecuteBar';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

// the first render of the panel loads its lazy parts
configure({ asyncUtilTimeout: 20_000 });

const description = (name: string) => demoNodeTypes.find((d) => d.name === name);
const deps = { navigate: vi.fn(), descriptions: { get: description } };

const nodeOf = (name: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters: { channels: 'orders' },
  ...extra,
});

const listenCalls = (method: string) =>
  backend().requests.filter((r) => r.method === method && r.path.endsWith('/listen-test-trigger'));
const runCalls = () => backend().requests.filter((r) => r.method === 'POST' && r.path.endsWith('/run'));

let unsubscribe: (() => void) | undefined;

async function open(nodes: WorkflowNode[], pinData?: Record<string, Item[]>) {
  const wf = backend().seedWorkflow({ name: 'Events', nodes, connections: {}, pinData });
  useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
  // what the push bridge does in the app
  unsubscribe = backend().subscribe((event) => useRunStore.getState().receive(event, wf.id));
  return wf;
}

beforeEach(() => {
  signedIn();
  useRunStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  useRunStore.getState().reset();
});

describe('isEventTrigger', () => {
  it('is a trigger with no URL, no poll and no sample of its own', () => {
    expect(isEventTrigger(description('app.redisTrigger'))).toBe(true);
    expect(isEventTrigger(description('core.webhook'))).toBe(false);
    expect(isEventTrigger(description('core.formTrigger'))).toBe(false);
    expect(isEventTrigger(description('core.scheduleTrigger'))).toBe(false);
    expect(isEventTrigger(description('core.manualTrigger'))).toBe(false);
    expect(isEventTrigger(description('core.set'))).toBe(false);
    expect(isEventTrigger(undefined)).toBe(false);
    const redis = description('app.redisTrigger')!;
    expect(isEventTrigger({ ...redis, polling: true })).toBe(false);
    expect(isEventTrigger({ ...redis, name: 'core.errorTrigger' })).toBe(false);
    expect(isEventTrigger({ ...redis, name: 'core.executeWorkflowTrigger' })).toBe(false);
  });
});

describe('starting to listen', () => {
  it('Execute step listens instead of running', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(listenCalls('POST')).toHaveLength(1);
    expect(listenCalls('POST')[0].path).toBe(`/workflows/${wf.id}/listen-test-trigger`);
    expect(listenCalls('POST')[0].body).toEqual({ nodeName: 'Redis' });
    expect(runCalls()).toEqual([]);
    const state = useRunStore.getState();
    expect(state.status).toBe('listening');
    expect(state.testWebhook?.nodeName).toBe('Redis');
    expect(state.testWebhook?.testUrl).toBeUndefined();
    expect(new Date(state.testWebhook?.expiresAt ?? '').getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it('Execute workflow listens when the only trigger waits for events', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    expect(webhookTriggerToListen(deps)).toBe('Redis');
    await runWorkflow(deps);
    expect(listenCalls('POST')).toHaveLength(1);
    expect(runCalls()).toEqual([]);
  });

  it('Execute workflow runs when a trigger can run at once', async () => {
    await open([
      nodeOf('Redis', 'app.redisTrigger'),
      nodeOf('Start', 'core.manualTrigger', { position: [0, 200] }),
    ]);
    expect(webhookTriggerToListen(deps)).toBeNull();
  });

  it('pinned data runs without listening', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')], { Redis: [{ json: { pinned: true } }] });
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(listenCalls('POST')).toEqual([]);
    expect(runCalls()).toHaveLength(1);
  });

  it('a webhook keeps its own listen call', async () => {
    await open([nodeOf('Hook', 'core.webhook', { parameters: { path: 'x' } })]);
    await listenForTestEvent(deps, 'Hook');
    expect(listenCalls('POST')).toEqual([]);
    expect(useRunStore.getState().testWebhook?.testUrl).toContain('/webhook-test/');
  });

  it('a refused start leaves listening and says why', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    const real = backend().handle.bind(backend());
    vi.spyOn(backend(), 'handle').mockImplementation(async (request) =>
      request.path.endsWith('/listen-test-trigger')
        ? {
            status: 400,
            body: { error: { code: 'trigger_error', message: 'Redis: Connection refused' } },
          }
        : real(request),
    );
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(useRunStore.getState().status).toBe('idle');
    expect(JSON.stringify(useToastStore.getState().toasts)).toContain('Connection refused');
  });
});

describe('the first event', () => {
  it('a test event shows in the editor', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    const executionId = await receiveTestTrigger(backend(), wf.id);
    expect(executionId).toEqual(expect.any(String));
    expect(useRunStore.getState().executionId).toBe(executionId);
    expect(useRunStore.getState().testWebhook).toBeNull();
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'));
    expect(useRunStore.getState().runData.Redis).toHaveLength(1);
  });

  it('an event before the listen call answers is not lost', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    const real = backend().handle.bind(backend());
    vi.spyOn(backend(), 'handle').mockImplementation(async (request) => {
      const answer = await real(request);
      if (request.method === 'POST' && request.path.endsWith('/listen-test-trigger')) {
        await receiveTestTrigger(backend(), wf.id);
      }
      return answer;
    });
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(useRunStore.getState().executionId).toEqual(expect.any(String));
    expect(useRunStore.getState().status).not.toBe('listening');
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'));
  });

  it('a failure while listening shows as a failed run', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    const executionId = '6f4b4b84-4a7e-4e6a-9e10-111111111111';
    backend().emit({ type: 'testWebhookReceived', data: { workflowId: wf.id, executionId } });
    backend().emit({
      type: 'executionFinished',
      data: {
        executionId,
        workflowId: wf.id,
        status: 'error',
        error: { name: 'Error', message: 'Redis: Connection lost' },
      },
    });
    const state = useRunStore.getState();
    expect(state.status).toBe('error');
    expect(state.error?.message).toBe('Redis: Connection lost');
  });

  it('a production run of the same workflow is not adopted', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    backend().emit({
      type: 'executionStarted',
      data: { executionId: 'prod', workflowId: wf.id, mode: 'trigger' },
    });
    expect(useRunStore.getState().status).toBe('listening');
    expect(useRunStore.getState().executionId).toBeNull();
  });
});

describe('stopping', () => {
  it('Stop closes it on the server, and no later event runs', async () => {
    const wf = await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    await stopExecution();
    expect(useRunStore.getState().status).toBe('idle');
    expect(listenCalls('DELETE')).toHaveLength(1);
    expect(listenCalls('DELETE')[0].path).toBe(`/workflows/${wf.id}/listen-test-trigger`);
    expect(await receiveTestTrigger(backend(), wf.id)).toBeNull();
    expect(backend().requests.some((r) => r.path.endsWith('/listen-test-webhook'))).toBe(false);
  });

  it('a stop while the listen call runs still closes it on the server', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    const real = backend().handle.bind(backend());
    vi.spyOn(backend(), 'handle').mockImplementation(async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/listen-test-trigger')) {
        useRunStore.getState().stopListening();
      }
      return real(request);
    });
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(useRunStore.getState().status).toBe('idle');
    expect(listenCalls('DELETE')).toHaveLength(1);
    expect(useRunStore.getState().testWebhook).toBeNull();
  });

  it('a failed stop still leaves the listening state and says so', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    await runWorkflow(deps, { destinationNode: 'Redis' });
    const real = backend().handle.bind(backend());
    vi.spyOn(backend(), 'handle').mockImplementation(async (request) =>
      request.method === 'DELETE'
        ? { status: 500, body: { error: { code: 'boom', message: 'boom' } } }
        : real(request),
    );
    await stopExecution();
    expect(useRunStore.getState().status).toBe('idle');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('stops by itself when no event arrived in time', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await runWorkflow(deps, { destinationNode: 'Redis' });
    expect(useRunStore.getState().status).toBe('listening');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(useRunStore.getState().status).toBe('idle');
    expect(listenCalls('DELETE')).toHaveLength(1);
    expect(JSON.stringify(useToastStore.getState().toasts)).toContain('No test event arrived in time.');
  });
});

describe('ExecuteBar', () => {
  const bar = () =>
    withProviders(<ExecuteBar onExecute={() => undefined} onStop={stopExecution} readOnly={false} listenNode="Redis" />);

  it('offers to listen, then waits for a trigger event without a URL', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    bar();
    expect(screen.getByRole('button', { name: 'Listen for test event' })).toBeTruthy();
    await act(() => runWorkflow(deps, { destinationNode: 'Redis' }));
    expect(screen.getByText('Waiting for a trigger event')).toBeTruthy();
    expect(screen.queryByText('Waiting for a call to')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy test URL' })).toBeNull();
    expect(document.querySelector('code')).toBeNull();
  });

  it('Stop listening closes it', async () => {
    const user = userEvent.setup();
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    bar();
    await act(() => runWorkflow(deps, { destinationNode: 'Redis' }));
    await user.click(screen.getByRole('button', { name: 'Stop listening' }));
    expect(useRunStore.getState().status).toBe('idle');
    await waitFor(() => expect(listenCalls('DELETE')).toHaveLength(1));
    expect(screen.queryByText('Waiting for a trigger event')).toBeNull();
  });

  it('a webhook still shows its URL', async () => {
    await open([nodeOf('Hook', 'core.webhook', { parameters: { path: 'x' } })]);
    bar();
    await act(() => listenForTestEvent(deps, 'Hook'));
    expect(screen.getByText('Waiting for a call to')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy test URL' })).toBeTruthy();
  });
});

describe('NodeDetailsView', () => {
  it('a trigger that waits for events offers to listen and has no URL rows', async () => {
    const user = userEvent.setup();
    const onListen = vi.fn();
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    withProviders(
      <NodeDetailsView nodeName="Redis" readOnly={false} onClose={() => undefined} onListen={onListen} />,
    );
    await screen.findByText('Listen, then send it an event. The data appears on the right.');
    expect(screen.queryByText('Test URL')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Listen for test event' }));
    expect(onListen).toHaveBeenCalledWith('Redis');
  });

  it('says what it waits for while listening', async () => {
    await open([nodeOf('Redis', 'app.redisTrigger')]);
    await act(() => runWorkflow(deps, { destinationNode: 'Redis' }));
    withProviders(
      <NodeDetailsView nodeName="Redis" readOnly={false} onClose={() => undefined} onListen={() => undefined} />,
    );
    await screen.findByText('Listening for a test event');
    expect(screen.getByText('Waiting for a message on the channels')).toBeTruthy();
  });
});
