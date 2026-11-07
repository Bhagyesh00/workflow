/**
 * Phase 5 S3 C0f2 contracts: the demo's chat and evaluation node types, the Evaluations routes, the Chat tab of
 * the log panel, the demo listen route's chat test token, the executions filter by custom data and the
 * simulator's new node types. The lanes fill the stubs (L4, L5, L9); nothing here asserts a stub.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CHAT_TRIGGER_TYPE,
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type NodeTypeDescription,
  type WorkflowNode,
} from '@workflow/workflow';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { executionsApi, workflowsApi } from '../src/api/endpoints';
import { LogPanel } from '../src/components/workflow/LogPanel';
import { demoEvaluationRows, demoNodeTypes } from '../src/demo/fixtures';
import { installDemo } from '../src/demo/install';
import { matchesCustomData, type StoredExecution } from '../src/demo/mock-backend';
import { buildCatalog, filterCatalog } from '../src/lib/node-catalog';
import { deriveNodePorts } from '../src/lib/ports';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const NEW_TYPES = [
  EVALUATION_TRIGGER_TYPE,
  EVALUATION_NODE_TYPE,
  'core.executionData',
  CHAT_TRIGGER_TYPE,
  'ai.chat',
];

const describeOf = (name: string): NodeTypeDescription => demoNodeTypes.find((d) => d.name === name)!;

const nodeOf = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...extra,
});

/** `from`'s first output to `to` */
const main = (from: string, to: string) => ({
  [from]: { main: [[{ node: to, type: 'main' as const, index: 0 }]] },
});

/** the stored execution, once the simulator finished it */
async function finished(executionId: string): Promise<StoredExecution> {
  const execution = backend().executions.find((e) => e.id === executionId)!;
  await waitFor(() => expect(execution.status).not.toBe('running'));
  return execution;
}

const outputOf = (execution: StoredExecution, node: string, output = 0): DataObject[] =>
  (execution.state.resultData.runData[node]?.[0]?.data?.main?.[output] ?? []).map((item) => item.json);

describe('S3 demo node types', () => {
  const catalog = buildCatalog(demoNodeTypes);
  const names = (query: string, extra: Partial<Parameters<typeof filterCatalog>[1]> = {}) =>
    filterCatalog(catalog, { query, ...extra }).flatMap((s) => s.entries.map((e) => e.description.name));

  it('describes the five node types with an icon and two categories', () => {
    for (const name of NEW_TYPES) {
      const description = describeOf(name);
      expect(description, name).toBeTruthy();
      expect(description.icon, name).toBeTruthy();
      expect(description.categories, name).toHaveLength(2);
    }
    expect(describeOf(EVALUATION_TRIGGER_TYPE).group).toContain('trigger');
    expect(describeOf(CHAT_TRIGGER_TYPE).group).toContain('trigger');
  });

  it('lists them in the node picker', () => {
    expect(names('evaluation')).toEqual(
      expect.arrayContaining([EVALUATION_TRIGGER_TYPE, EVALUATION_NODE_TYPE]),
    );
    expect(names('chat')).toEqual(expect.arrayContaining([CHAT_TRIGGER_TYPE, 'ai.chat']));
    expect(names('execution data')).toContain('core.executionData');
    const triggers = filterCatalog(catalog, { query: '', noTriggerYet: true })[0].entries.map(
      (e) => e.description.name,
    );
    expect(triggers).toEqual(expect.arrayContaining([EVALUATION_TRIGGER_TYPE, CHAT_TRIGGER_TYPE]));
    const afterOutput = names('', { needsMainInput: true });
    expect(afterOutput).toEqual(
      expect.arrayContaining([EVALUATION_NODE_TYPE, 'core.executionData', 'ai.chat']),
    );
    expect(afterOutput).not.toContain(EVALUATION_TRIGGER_TYPE);
    expect(afterOutput).not.toContain(CHAT_TRIGGER_TYPE);
  });

  it('gives Check If Evaluating two outputs and an AI metric a model input', () => {
    const evaluation = describeOf(EVALUATION_NODE_TYPE);
    const ports = (parameters: Record<string, unknown>) =>
      deriveNodePorts(nodeOf('Eval', EVALUATION_NODE_TYPE, parameters), evaluation);
    expect(ports({}).outputs.map((p) => p.id)).toEqual(['out:main:0']);
    expect(ports({ operation: 'checkIfEvaluating' }).outputs.map((p) => p.id)).toEqual([
      'out:main:0',
      'out:main:1',
    ]);
    expect(ports({ operation: 'setMetrics', metric: 'correctness' }).inputs.map((p) => p.type)).toEqual([
      'main',
      'ai_languageModel',
    ]);
    expect(ports({ operation: 'setMetrics', metric: 'stringSimilarity' }).inputs.map((p) => p.type)).toEqual([
      'main',
    ]);
  });

  it('gives the Chat Trigger the hosted chat mode and the response node modes', () => {
    const chatTrigger = describeOf(CHAT_TRIGGER_TYPE);
    const mode = chatTrigger.properties.find((p) => p.name === 'mode');
    expect(mode?.default).toBe('hostedChat');
    const options = chatTrigger.properties.find((p) => p.name === 'options')?.options ?? [];
    const responseMode = options.find((o) => 'name' in o && o.name === 'responseMode') as unknown as
      | { options?: Array<{ value: unknown }> }
      | undefined;
    expect(responseMode?.options?.map((o) => o.value)).toEqual(
      expect.arrayContaining(['lastNode', 'streaming', 'responseNode', 'responseNodes']),
    );
    expect(describeOf('ai.chat').webhooks?.map((w) => w.name)).toContain('chatReply');
  });
});

describe('Evaluations routes', () => {
  beforeEach(() => void signedIn());

  it.each(['', '/run-1'])('mounts a page with the Evaluations heading at evaluations%s', async (suffix) => {
    const wf = backend().seedWorkflow({ name: 'Evals', nodes: [nodeOf('Manual', 'core.manualTrigger')] });
    renderApp(`/workflow/${wf.id}/evaluations${suffix}`);
    const headings = await screen.findAllByRole('heading', { name: 'Evaluations' }, { timeout: 20_000 });
    expect(headings.length).toBeGreaterThan(0);
  });
});

describe('log panel tabs', () => {
  const noop = () => undefined;

  function renderPanel(nodes: WorkflowNode[]) {
    act(() => useWorkflowStore.getState().load({ name: 'Panel', nodes, connections: {} }));
    const panel = <LogPanel logs={[]} runData={{}} onClear={noop} onClose={noop} onFocusNode={noop} />;
    // in a router, as in the editor page
    return withProviders(<RouterProvider router={createMemoryRouter([{ path: '/', element: panel }])} />);
  }

  const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

  beforeEach(() => {
    signedIn();
    useUiStore.setState({ logPanelTab: 'console' });
  });

  it('defaults to the Logs tab', () => {
    expect(useUiStore.getInitialState().logPanelTab).toBe('logs');
  });

  it('shows the Chat tab only when the workflow has a Chat Trigger', () => {
    const { unmount } = renderPanel([nodeOf('Manual', 'core.manualTrigger')]);
    expect(tabNames()).toEqual(expect.arrayContaining(['Logs', 'Console', 'Run timeline']));
    expect(tabNames()).not.toContain('Chat');
    unmount();

    renderPanel([nodeOf('Chat', CHAT_TRIGGER_TYPE, {}, { webhookId: 'chat-hook' })]);
    expect(tabNames()).toEqual(expect.arrayContaining(['Logs', 'Console', 'Run timeline', 'Chat']));
  });

  it('follows setLogPanelTab, and a click on a tab sets it', async () => {
    renderPanel([nodeOf('Manual', 'core.manualTrigger')]);
    expect(screen.getByRole('tab', { name: 'Console' }).getAttribute('aria-selected')).toBe('true');
    act(() => useUiStore.getState().setLogPanelTab('timeline'));
    expect(screen.getByRole('tab', { name: 'Run timeline' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Console' }).getAttribute('aria-selected')).toBe('false');
    await userEvent.click(screen.getByRole('tab', { name: 'Console' }));
    expect(useUiStore.getState().logPanelTab).toBe('console');
  });
});

describe('demo backend', () => {
  beforeEach(() => void signedIn());

  function seedChat() {
    return backend().seedWorkflow({
      name: 'Support chat',
      nodes: [
        nodeOf('Chat', CHAT_TRIGGER_TYPE, {}, { webhookId: 'chat-hook' }),
        nodeOf('Reply', 'ai.chat', { message: 'Thanks' }),
        nodeOf('After', 'core.noOp'),
        nodeOf('Hook', 'core.webhook', { path: 'orders/new' }),
      ],
      connections: { ...main('Chat', 'Reply'), ...main('Reply', 'After') },
    });
  }

  it('gives a Chat Trigger a chat test token on its chat URL, and a webhook none', async () => {
    const wf = seedChat();
    const chat = await workflowsApi.listenTestWebhook(wf.id, 'Chat', { destinationNode: 'Reply' });
    expect(chat.chatTestToken).toEqual(expect.any(String));
    expect(chat.chatTestToken).not.toBe('');
    expect(chat.testUrl).toMatch(/\/webhook-test\/[^/]+\/chat-hook\/chat$/);
    expect(backend().testListenByChatToken(chat.chatTestToken!)).toMatchObject({
      workflowId: wf.id,
      listen: { nodeName: 'Chat', destinationNode: 'Reply' },
    });
    expect(backend().testListenByChatToken('demo-chat-test-unknown')).toBeNull();

    const hook = await workflowsApi.listenTestWebhook(wf.id, 'Hook');
    expect(hook.chatTestToken).toBeUndefined();
    expect(hook.testUrl).toMatch(/\/webhook-test\/[^/]+\/orders\/new$/);
  });

  it('lists the chat URL of a Chat Trigger among the webhook URLs', async () => {
    const wf = seedChat();
    const { body } = await backend().handle({ method: 'GET', path: `/workflows/${wf.id}/webhook-urls` });
    const urls = (body as { data: Array<{ nodeName: string; productionUrl: string }> }).data;
    expect(urls.find((u) => u.nodeName === 'Chat')?.productionUrl).toMatch(
      /\/webhook\/[^/]+\/chat-hook\/chat$/,
    );
  });

  it('runs a chat message from the trigger to the destination node', async () => {
    const wf = seedChat();
    await workflowsApi.listenTestWebhook(wf.id, 'Chat', { destinationNode: 'Reply' });
    const item = { json: { sessionId: 's-1', action: 'sendMessage', chatInput: 'Hi' } };
    const executionId = backend().receiveTestWebhook(wf.id, [item]);
    expect(executionId).toEqual(expect.any(String));
    const execution = await finished(executionId!);
    expect(outputOf(execution, 'Chat')).toEqual([item.json]);
    expect(outputOf(execution, 'Reply')).toEqual([item.json]);
    expect(execution.state.resultData.runData.After).toBeUndefined();
  });

  it('filters executions by custom data key, value and exact match', async () => {
    const wf = backend().seedWorkflow({ name: 'Orders', nodes: [nodeOf('Manual', 'core.manualTrigger')] });
    const stored = backend().workflow(wf.id);
    const saved: Array<Record<string, string> | null> = [
      { orderId: '1042', channel: 'web' },
      { orderId: '10420' },
      null,
    ];
    const [a, b, c] = saved.map((customData) => {
      const id = backend().startExecution(stored, stored, { mode: 'manual' });
      backend().executions.find((e) => e.id === id)!.customData = customData;
      return id;
    });
    const ids = async (query: Record<string, string>) => {
      const { body } = await backend().handle({ method: 'GET', path: '/executions', query });
      return (body as { data: Array<{ id: string }> }).data.map((e) => e.id).sort();
    };
    expect(await ids({})).toEqual([a, b, c].sort());
    expect(await ids({ customDataKey: 'orderId' })).toEqual([a, b].sort());
    expect(await ids({ customDataKey: 'orderId', customDataValue: '1042' })).toEqual([a, b].sort());
    expect(await ids({ customDataKey: 'orderId', customDataValue: '1042', customDataExact: 'true' })).toEqual(
      [a],
    );
    expect(await ids({ customDataKey: 'channel', customDataValue: 'WEB' })).toEqual([]);
    expect(await ids({ customDataKey: 'missing' })).toEqual([]);

    const page = await executionsApi.list({ customDataKey: 'channel' });
    expect(page.data.map((e) => e.id)).toEqual([a]);
  });

  it('matches custom data as the server filter does', () => {
    expect(matchesCustomData(null, {})).toBe(true);
    expect(matchesCustomData(null, { customDataKey: 'k' })).toBe(false);
    expect(matchesCustomData({ k: 'a%b' }, { customDataKey: 'k', customDataValue: '%' })).toBe(true);
    expect(matchesCustomData({ k: 'ab' }, { customDataKey: 'k', customDataValue: '%' })).toBe(false);
    expect(matchesCustomData({ k: 'ab' }, { customDataKey: 'toString' })).toBe(false);
  });

  it('simulates the Evaluation Trigger and the Evaluation node', async () => {
    const wf = backend().seedWorkflow({
      name: 'Eval',
      nodes: [
        nodeOf('Dataset', EVALUATION_TRIGGER_TYPE),
        nodeOf('Metrics', EVALUATION_NODE_TYPE, { operation: 'setMetrics' }),
        nodeOf('Check', EVALUATION_NODE_TYPE, { operation: 'checkIfEvaluating' }),
        nodeOf('Save', 'core.executionData'),
      ],
      connections: {
        Dataset: {
          main: [
            [
              { node: 'Metrics', type: 'main', index: 0 },
              { node: 'Check', type: 'main', index: 0 },
            ],
          ],
        },
        ...main('Check', 'Save'),
      },
    });
    const stored = backend().workflow(wf.id);

    const manual = await finished(backend().startExecution(stored, stored, { mode: 'manual' }));
    expect(outputOf(manual, 'Dataset')).toEqual([
      expect.objectContaining({
        ...demoEvaluationRows[0],
        row_number: 1,
        _rowsLeft: demoEvaluationRows.length - 1,
      }),
    ]);
    expect(outputOf(manual, 'Metrics')).toEqual([{ score: 1 }]);
    // a manual run is not an evaluation: the items leave on the Normal output
    expect(outputOf(manual, 'Check', 0)).toEqual([]);
    expect(outputOf(manual, 'Check', 1)).toHaveLength(1);

    const row = { question: 'Q', expected: 'A', row_number: 2, row_id: 2, _rowsLeft: 0 };
    const evaluation = await finished(
      backend().startExecution(stored, stored, { mode: 'evaluation', triggerItems: [{ json: row }] }),
    );
    expect(evaluation.mode).toBe('evaluation');
    expect(outputOf(evaluation, 'Dataset')).toEqual([row]);
    expect(outputOf(evaluation, 'Check', 0)).toEqual([row]);
    expect(outputOf(evaluation, 'Save')).toEqual([row]);
  });
});

describe('demo install', () => {
  it('installs the demo with its chat transport', () => {
    // the last test of the file: it swaps the transport, push and chat fetch for the demo's
    expect(() => installDemo()).not.toThrow();
  });
});
