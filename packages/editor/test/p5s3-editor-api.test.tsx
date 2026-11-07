/** Phase 5 S3, C0f1: editor contracts (API, chat transport, query keys, log panel tabs, scopes). */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CHAT_TRIGGER_TYPE, type WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatFetch, setChatFetch } from '../src/api/chat-transport';
import { type ApiRequest, setTransport } from '../src/api/client';
import { evaluationsApi, executionsApi, workflowsApi } from '../src/api/endpoints';
import { queryKeys } from '../src/api/queries';
import { ApiKeyScopesField } from '../src/components/settings/ApiKeyScopesField';
import { LogPanel } from '../src/components/workflow/LogPanel';
import { demoNodeTypes } from '../src/demo/fixtures';
import { isEventTrigger } from '../src/features/editor/editor-actions';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';

function record(reply: unknown = null) {
  const requests: ApiRequest[] = [];
  setTransport(async (request) => {
    requests.push(request);
    return { status: 200, body: { data: reply } };
  });
  return requests;
}
const last = (requests: ApiRequest[]) => {
  const { method, path, query, body } = requests[requests.length - 1];
  return { method, path, query, body };
};

const nodeOf = (name: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
  ...extra,
});

const initialNodes = useWorkflowStore.getState().nodes;

afterEach(() => {
  setChatFetch(null);
  vi.restoreAllMocks();
  useUiStore.setState({ logPanelTab: 'logs', logPanelOpen: false });
  useWorkflowStore.setState({ nodes: initialNodes });
});

describe('evaluationsApi', () => {
  it('calls the seven test-run routes of a workflow', async () => {
    const r = record();
    await evaluationsApi.list('w 1', { skip: 20, limit: 10, status: 'running' });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflows/w%201/test-runs',
      query: { skip: 20, limit: 10, status: 'running' },
    });
    await evaluationsApi.get('w1', 'r1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/workflows/w1/test-runs/r1' });
    await evaluationsApi.listCases('w1', 'r1', { skip: 0, limit: 50 });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflows/w1/test-runs/r1/test-cases',
      query: { skip: 0, limit: 50 },
    });
    await evaluationsApi.start('w1', { concurrency: 3, rowIndices: [0, 2] });
    expect(last(r)).toEqual({
      method: 'POST',
      path: '/workflows/w1/test-runs/new',
      query: undefined,
      body: { concurrency: 3, rowIndices: [0, 2] },
    });
    await evaluationsApi.start('w1');
    expect(last(r).body).toEqual({});
    await evaluationsApi.cancel('w1', 'r1');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflows/w1/test-runs/r1/cancel' });
    await evaluationsApi.cancelCase('w1', 'r1', 'c/1');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflows/w1/test-runs/r1/test-cases/c%2F1/cancel',
    });
    await evaluationsApi.remove('w1', 'r1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/workflows/w1/test-runs/r1' });
    expect(r).toHaveLength(8);
  });

  it('returns the run id of a started run', async () => {
    record({ testRunId: 'r9' });
    expect(await evaluationsApi.start('w1')).toEqual({ testRunId: 'r9' });
  });
});

describe('workflowsApi.listenTestWebhook and executionsApi.list', () => {
  it('sends destinationNode only when given', async () => {
    const r = record({
      testUrl: 'http://x/webhook-test/a',
      expiresAt: '',
      formTestUrls: [],
      chatTestToken: 't',
    });
    await workflowsApi.listenTestWebhook('w1', 'Chat');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflows/w1/listen-test-webhook' });
    expect(last(r).body).toEqual({ nodeName: 'Chat' });
    const reply = await workflowsApi.listenTestWebhook('w1', 'Chat', { destinationNode: 'Agent' });
    expect(last(r).body).toEqual({ nodeName: 'Chat', destinationNode: 'Agent' });
    expect(reply.chatTestToken).toBe('t');
  });

  it('passes the custom data filter as query parameters', async () => {
    const r = record([]);
    await executionsApi.list({ customDataKey: 'user', customDataValue: 'ann', customDataExact: true });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/executions',
      query: { customDataKey: 'user', customDataValue: 'ann', customDataExact: true },
    });
  });
});

describe('chat transport', () => {
  it('calls the fetch set last, also through a reference taken before the swap', async () => {
    const held = chatFetch;
    const fake = vi.fn(async () => new Response('{"ok":true}'));
    setChatFetch(fake);
    const init = { method: 'POST', body: '{}' };
    const response = await held('/webhook-test/a/chat', init);
    expect(await response.json()).toEqual({ ok: true });
    expect(fake).toHaveBeenCalledWith('/webhook-test/a/chat', init);
  });

  it('goes back to the browser fetch with null', async () => {
    const fake = vi.fn(async () => new Response('fake'));
    setChatFetch(fake);
    setChatFetch(null);
    const browser = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('browser'));
    expect(await (await chatFetch('/x')).text()).toBe('browser');
    expect(browser).toHaveBeenCalledWith('/x', undefined);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe('query keys', () => {
  it('nests runs and cases under the workflow, so one invalidation covers them', () => {
    expect(queryKeys.testRuns('w1')).toEqual(['workflow', 'w1', 'test-runs']);
    expect(queryKeys.testRun('w1', 'r1')).toEqual(['workflow', 'w1', 'test-runs', 'r1']);
    expect(queryKeys.testRunCases('w1', 'r1')).toEqual(['workflow', 'w1', 'test-runs', 'r1', 'cases']);
    expect(queryKeys.testRun('w1', 'r1').slice(0, 3)).toEqual([...queryKeys.testRuns('w1')]);
  });
});

describe('editor actions', () => {
  it('runs the evaluation trigger at once instead of listening', () => {
    const redis = demoNodeTypes.find((d) => d.name === 'app.redisTrigger')!;
    expect(isEventTrigger(redis)).toBe(true);
    expect(isEventTrigger({ ...redis, name: 'core.evaluationTrigger' })).toBe(false);
  });
});

describe('log panel tabs', () => {
  const props = { logs: [], runData: {}, onClear: vi.fn(), onClose: vi.fn(), onFocusNode: vi.fn() };

  beforeEach(() => {
    useWorkflowStore.setState({ nodes: [] });
  });

  it('defaults to logs; setLogPanelTab switches the tab and leaves the panel state alone', () => {
    expect(useUiStore.getState().logPanelTab).toBe('logs');
    useUiStore.getState().setLogPanelTab('console');
    expect(useUiStore.getState().logPanelTab).toBe('console');
    expect(useUiStore.getState().logPanelOpen).toBe(false);
  });

  it('shows Logs, Console and Run timeline, and Chat only with an enabled chat trigger', () => {
    const { unmount } = render(<LogPanel {...props} />);
    const names = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(names()).toEqual(['Logs', 'Console', 'Run timeline']);
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-selected')).toBe('true');

    act(() => useWorkflowStore.setState({ nodes: [nodeOf('Chat', CHAT_TRIGGER_TYPE, { disabled: true })] }));
    expect(names()).toEqual(['Logs', 'Console', 'Run timeline']);

    act(() => useWorkflowStore.setState({ nodes: [nodeOf('Chat', CHAT_TRIGGER_TYPE)] }));
    expect(names()).toEqual(['Logs', 'Console', 'Run timeline', 'Chat']);
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(useUiStore.getState().logPanelTab).toBe('chat');
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');

    // the trigger goes: the panel falls back to the logs tab
    act(() => useWorkflowStore.setState({ nodes: [] }));
    expect(names()).toEqual(['Logs', 'Console', 'Run timeline']);
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-selected')).toBe('true');
    unmount();
  });

  it('the store opens the console tab', () => {
    render(<LogPanel {...props} />);
    act(() => useUiStore.getState().setLogPanelTab('console'));
    expect(screen.getByRole('tab', { name: 'Console' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Nothing logged yet')).toBeTruthy();
  });
});

describe('API key scopes', () => {
  it('has a test runs row with list, create, read and cancel', () => {
    const onChange = vi.fn();
    render(<ApiKeyScopesField value={['testRun:read']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'All test runs scopes' }));
    expect(onChange).toHaveBeenLastCalledWith([
      'testRun:list',
      'testRun:create',
      'testRun:read',
      'testRun:cancel',
    ]);
  });
});
