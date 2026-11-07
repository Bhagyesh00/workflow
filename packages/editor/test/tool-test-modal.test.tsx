/**
 * P5-76 Test a tool in the editor: Execute step on a tool node asks for the values the model would pass, and the
 * run carries them as `agentRequest`. With no `$fromAI` in the node it runs at once; other sub-nodes have no step.
 */
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connections, DataObject, FromAiArgument, Item, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsApi } from '../src/api/endpoints';
import { NodeDetailsView } from '../src/components/ndv/NodeDetailsView';
import { ToolTestModal } from '../src/components/ndv/ToolTestModal';
import { demoNodeTypes } from '../src/demo/fixtures';
import { runWorkflow } from '../src/features/editor/editor-actions';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

// the first render of the panel loads its lazy parts
configure({ asyncUtilTimeout: 20_000 });

const deps = {
  navigate: vi.fn(),
  descriptions: { get: (name: string) => demoNodeTypes.find((d) => d.name === name) },
};

const nodeOf = (name: string, type: string, parameters: DataObject = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters: parameters as WorkflowNode['parameters'],
});
const link = (node: string, type: 'main' | 'ai_tool' | 'ai_languageModel'): Connections[string] => ({
  [type]: [[{ node, type, index: 0 }]],
});

const URL_PARAMETER = "=https://api.test/{{ $fromAI('city', 'The city', 'string') }}";
const nodes = (url: string = URL_PARAMETER): WorkflowNode[] => [
  nodeOf('Start', 'core.manualTrigger'),
  nodeOf('Agent', 'ai.agent', { text: 'go' }),
  nodeOf('Model', 'ai.lmChatDemo'),
  nodeOf('Request', 'core.httpRequestTool', {
    url,
    timeout: "={{ $fromAI('timeout', 'Seconds', 'number', 30) }}",
  }),
];
const connections: Connections = {
  Start: link('Agent', 'main'),
  Model: link('Agent', 'ai_languageModel'),
  Request: link('Agent', 'ai_tool'),
};

const runCalls = () => backend().requests.filter((r) => r.method === 'POST' && r.path.endsWith('/run'));
let unsubscribe: (() => void) | undefined;

async function openNdv(
  nodeName: string,
  graph: { nodes: WorkflowNode[]; connections: Connections; pinData?: Record<string, Item[]> },
  readOnly = false,
) {
  const wf = backend().seedWorkflow({ name: 'Tools', ...graph });
  useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
  unsubscribe = backend().subscribe((event) => useRunStore.getState().receive(event, wf.id));
  const onExecuteNode = vi.fn((name: string) => void runWorkflow(deps, { destinationNode: name }));
  withProviders(
    <NodeDetailsView
      nodeName={nodeName}
      readOnly={readOnly}
      onClose={() => undefined}
      onExecuteNode={readOnly ? undefined : onExecuteNode}
    />,
  );
  await screen.findByRole('textbox', { name: 'Node name' });
  return { wf, onExecuteNode };
}

/** the button in the header of the panel */
const executeStep = async () => (await screen.findAllByRole('button', { name: 'Execute step' }))[0];

beforeEach(() => {
  signedIn();
  useRunStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ ndvNode: null });
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  useRunStore.getState().reset();
});

describe('ToolTestModal', () => {
  const args: FromAiArgument[] = [
    { key: 'city', description: 'The city', type: 'string' },
    { key: 'days', type: 'number' },
    { key: 'full', type: 'boolean' },
    { key: 'filter', type: 'json' },
    { key: 'limit', type: 'number', defaultValue: 10 },
    { key: 'unit', type: 'string', defaultValue: 'C' },
    { key: 'shape', type: 'json', defaultValue: { a: 1 } },
    { key: 'note', type: 'string', defaultValue: '' },
  ];

  function renderModal(list = args) {
    const onExecute = vi.fn();
    const onCancel = vi.fn();
    render(
      <ToolTestModal
        open
        nodeName="Request"
        parentName="Agent"
        args={list}
        onExecute={onExecute}
        onCancel={onCancel}
      />,
    );
    return { onExecute, onCancel, user: userEvent.setup() };
  }
  const submit = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Execute step' }));

  it('names the node and the node the data would come from', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Test Request' })).toBeTruthy();
    expect(screen.getByText('Provide the data that would normally come from the "Agent" node')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Execute step' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByText('The city')).toBeTruthy();
  });

  it('has no parent to name for a tool that nothing calls', () => {
    const onExecute = vi.fn();
    render(
      <ToolTestModal
        open
        nodeName="Lone"
        parentName=""
        args={[{ key: 'x', type: 'string' }]}
        onExecute={onExecute}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText('Provide the data the tool needs')).toBeTruthy();
  });

  it('hands over typed values, with the defaults filled in', async () => {
    const { onExecute, user } = renderModal();
    await user.type(screen.getByLabelText(/^city/), 'Pune');
    await user.type(screen.getByLabelText(/^days/), '3');
    await user.click(screen.getByRole('switch', { name: 'full' }));
    await user.click(screen.getByLabelText(/^filter/));
    await user.paste('{"a":[1]}');
    await submit(user);
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0][0]).toEqual({
      city: 'Pune',
      days: 3,
      full: true,
      filter: { a: [1] },
      limit: 10,
      unit: 'C',
      shape: { a: 1 },
    });
  });

  it('a value that looks like an expression stays text', async () => {
    const { onExecute, user } = renderModal([{ key: 'city', type: 'string' }]);
    await user.click(screen.getByLabelText(/^city/));
    await user.paste('={{ 1 + 1 }}');
    await submit(user);
    expect(onExecute.mock.calls[0][0]).toEqual({ city: '={{ 1 + 1 }}' });
  });

  it('leaves out an empty value that has a default, so the default applies', async () => {
    const { onExecute, user } = renderModal([{ key: 'limit', type: 'number', defaultValue: 10 }]);
    await user.clear(screen.getByLabelText(/^limit/));
    await submit(user);
    expect(onExecute.mock.calls[0][0]).toEqual({});
  });

  it('asks for what is missing or wrong and does not run', async () => {
    const { onExecute, user } = renderModal([
      { key: 'city', type: 'string' },
      { key: 'days', type: 'number' },
      { key: 'filter', type: 'json' },
      { key: 'other', type: 'json' },
    ]);
    await user.click(screen.getByLabelText(/^filter/));
    await user.paste('not json');
    await user.click(screen.getByLabelText(/^other/));
    await user.paste('[]');
    await submit(user);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((e) => e.textContent)).toEqual([
      'Enter a value',
      'Enter a value',
      'Value must be a non-empty object or a non-empty array',
      'Value must be a non-empty object or a non-empty array',
    ]);
    await user.type(screen.getByLabelText(/^days/), '3');
    await user.type(screen.getByLabelText(/^city/), 'Pune');
    await user.clear(screen.getByLabelText(/^filter/));
    await user.click(screen.getByLabelText(/^filter/));
    await user.paste('{"a":1}');
    await user.clear(screen.getByLabelText(/^other/));
    await user.click(screen.getByLabelText(/^other/));
    await user.paste('[1]');
    await submit(user);
    expect(onExecute.mock.calls[0][0]).toEqual({ city: 'Pune', days: 3, filter: { a: 1 }, other: [1] });
  });

  it('a key named __proto__ stays an own value', async () => {
    const { onExecute, user } = renderModal([{ key: '__proto__', type: 'string' }]);
    await user.type(screen.getByLabelText(/^__proto__/), 'x');
    await submit(user);
    const query = onExecute.mock.calls[0][0];
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(JSON.stringify(query)).toBe('{"__proto__":"x"}');
  });

  it('Cancel closes it without a run', async () => {
    const { onExecute, onCancel, user } = renderModal();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();
  });
});

describe('Execute step on a tool node', () => {
  it('opens the modal, and the run carries the values as agentRequest', async () => {
    const user = userEvent.setup();
    await openNdv('Request', { nodes: nodes(), connections });
    expect(screen.queryByRole('dialog', { name: 'Test Request' })).toBeNull();
    await user.click(await executeStep());
    const dialog = await screen.findByRole('dialog', { name: 'Test Request' });
    expect(dialog.textContent).toContain('Provide the data that would normally come from the "Agent" node');
    expect(runCalls()).toHaveLength(0);

    await user.type(screen.getByLabelText(/^city/), 'Pune');
    const buttons = screen.getAllByRole('button', { name: 'Execute step' });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0].body).toMatchObject({
      destinationNode: 'Request',
      agentRequest: { query: { city: 'Pune', timeout: 30 }, toolName: 'Request' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Test Request' })).toBeNull());
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'));
    expect(Object.keys(useRunStore.getState().runData).sort()).toEqual(['Request', 'Start']);
  });

  it('Cancel starts no run', async () => {
    const user = userEvent.setup();
    await openNdv('Request', { nodes: nodes(), connections });
    await user.click(await executeStep());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Test Request' })).toBeNull());
    expect(runCalls()).toHaveLength(0);
  });

  it('with no $fromAI it runs at once, with an empty query', async () => {
    const user = userEvent.setup();
    const fixed = [
      ...nodes().slice(0, 3),
      nodeOf('Request', 'core.httpRequestTool', { url: 'https://api.test' }),
    ];
    await openNdv('Request', { nodes: fixed, connections });
    await user.click(await executeStep());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Test Request' })).toBeNull();
    expect(runCalls()[0].body).toMatchObject({
      destinationNode: 'Request',
      agentRequest: { query: {}, toolName: 'Request' },
    });
  });

  it('a node name with spaces goes out as the name the model knows', async () => {
    const user = userEvent.setup();
    const fixed = [
      ...nodes().slice(0, 3),
      nodeOf('Call the API', 'core.httpRequestTool', { url: 'https://api.test' }),
    ];
    await openNdv('Call the API', {
      nodes: fixed,
      connections: { ...connections, Request: {}, 'Call the API': link('Agent', 'ai_tool') },
    });
    await user.click(await executeStep());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0].body).toMatchObject({
      destinationNode: 'Call the API',
      agentRequest: { toolName: 'Call_the_API' },
    });
  });

  it('a second test sends the last run data, planned up to the root, so the parents keep their output', async () => {
    const user = userEvent.setup();
    const fixed = [
      ...nodes().slice(0, 3),
      nodeOf('Request', 'core.httpRequestTool', { url: 'https://api.test' }),
    ];
    await openNdv('Request', { nodes: fixed, connections });
    await user.click(await executeStep());
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'));
    await user.click(await executeStep());
    await waitFor(() => expect(runCalls()).toHaveLength(2));
    const body = runCalls()[1].body as { runData?: Record<string, unknown>; dirtyNodeNames?: string[] };
    expect(Object.keys(body.runData ?? {})).toContain('Start');
    expect(body.dirtyNodeNames).toEqual([]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('a broken $fromAI call says so and starts no run', async () => {
    const user = userEvent.setup();
    await openNdv('Request', { nodes: nodes("={{ $fromAI('bad key!') }}"), connections });
    await user.click(await executeStep());
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Could not test this tool'),
    );
    expect(runCalls()).toHaveLength(0);
  });

  it('a plain node runs as before, with no agentRequest', async () => {
    const user = userEvent.setup();
    const { onExecuteNode } = await openNdv('Agent', { nodes: nodes(), connections });
    await user.click(await executeStep());
    expect(onExecuteNode).toHaveBeenCalledWith('Agent');
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0].body).not.toHaveProperty('agentRequest');
    expect(screen.queryByRole('dialog', { name: 'Test Agent' })).toBeNull();
  });

  it('a later plain run carries no values from the test before it', async () => {
    const user = userEvent.setup();
    const fixed = [
      ...nodes().slice(0, 3),
      nodeOf('Request', 'core.httpRequestTool', { url: 'https://api.test' }),
    ];
    await openNdv('Request', { nodes: fixed, connections });
    await user.click(await executeStep());
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'));
    await act(() => runWorkflow(deps, { destinationNode: 'Agent' }));
    expect(runCalls()).toHaveLength(2);
    expect(runCalls()[1].body).toMatchObject({ destinationNode: 'Agent' });
    expect(runCalls()[1].body).not.toHaveProperty('agentRequest');
  });

  it('a model has no Execute step', async () => {
    await openNdv('Model', { nodes: nodes(), connections });
    await screen.findByText('Sub-nodes have no direct input');
    expect(screen.queryByRole('button', { name: 'Execute step' })).toBeNull();
  });

  it('a Human review node has no Execute step', async () => {
    const graph = {
      nodes: [...nodes(), nodeOf('Review', 'app.slackHitlTool')],
      connections: {
        ...connections,
        Request: link('Review', 'ai_tool'),
        Review: link('Agent', 'ai_tool'),
      },
    };
    await openNdv('Review', graph);
    await screen.findByText('Sub-nodes have no direct input');
    expect(screen.queryByRole('button', { name: 'Execute step' })).toBeNull();
  });

  it('names the node that calls the tool directly', async () => {
    const user = userEvent.setup();
    await openNdv('Request', {
      nodes: [...nodes(), nodeOf('Review', 'app.slackHitlTool')],
      connections: {
        ...connections,
        Request: link('Review', 'ai_tool'),
        Review: link('Agent', 'ai_tool'),
      },
    });
    await user.click(await executeStep());
    const dialog = await screen.findByRole('dialog', { name: 'Test Request' });
    expect(dialog.textContent).toContain('normally come from the "Review" node');
  });

  it('read only has no step', async () => {
    await openNdv('Request', { nodes: nodes(), connections }, true);
    expect(screen.queryByRole('button', { name: 'Execute step' })).toBeNull();
  });
});
