import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeParameters, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeTypesApi, workflowsApi } from '../src/api/endpoints';
import { AppProviders } from '../src/App';
import { ParameterContext, type ParameterContextValue } from '../src/components/parameters/context';
import { ParameterList } from '../src/components/parameters/ParameterForm';
import { demoNodeTypes } from '../src/demo/fixtures';
import { listenForTestEvent, runWorkflow, stopListening } from '../src/features/editor/editor-actions';
import { buildCatalog, filterCatalog, nodeActions } from '../src/lib/node-catalog';
import { setIn } from '../src/lib/workflow-ops';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';

const crm = demoNodeTypes.find((d) => d.name === 'app.crm')!;

describe('R52: list search results depend on the other parameters of the node', () => {
  beforeEach(() => {
    signedIn();
  });

  it('asks again when a parameter the list depends on changed within the stale time', async () => {
    const description: NodeTypeDescription = {
      ...crm,
      properties: [
        { displayName: 'Account', name: 'accountId', type: 'string', default: '' },
        ...crm.properties,
      ],
    };
    const search = vi.spyOn(nodeTypesApi, 'listSearch');
    const initial: WorkflowNode = {
      id: 'n1',
      name: 'Subject',
      type: description.name,
      typeVersion: 1,
      position: [0, 0],
      parameters: { resource: 'contact', operation: 'get', accountId: 'A' },
    };
    let setParameters: (parameters: NodeParameters) => void = () => undefined;
    // biome-ignore lint/correctness/noComponentHookFactories: rendered once; it hands this test its setter
    function Harness() {
      const [node, setNode] = useState(initial);
      setParameters = (parameters) => setNode((n) => ({ ...n, parameters }));
      const ctx: ParameterContextValue = {
        node,
        description,
        rootValues: node.parameters,
        readOnly: false,
        allowExpressions: true,
        onChange: (path, value) =>
          setNode((n) => ({ ...n, parameters: setIn(n.parameters, path, value) as NodeParameters })),
      };
      return (
        <ParameterContext.Provider value={ctx}>
          <ParameterList properties={description.properties} values={node.parameters} path={[]} />
        </ParameterContext.Provider>
      );
    }
    // the application's cache settings: results stay fresh for 15 s
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 15_000 }, mutations: { retry: false } },
    });
    render(
      <AppProviders queryClient={queryClient}>
        <Harness />
      </AppProviders>,
    );
    const user = userEvent.setup();
    const picker = () => screen.getByText(/Choose from the list/).closest('button')!;

    await user.click(picker());
    await screen.findAllByRole('option');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].node.parameters.accountId).toBe('A');
    await user.click(picker());

    act(() => setParameters({ ...initial.parameters, accountId: 'B' }));
    await user.click(picker());
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(search.mock.calls[1][0].node.parameters.accountId).toBe('B');
  });
});

describe('R53: stopping the listener also stops it on the server', () => {
  const webhook: WorkflowNode = {
    id: 'h',
    name: 'Webhook',
    type: 'core.webhook',
    typeVersion: 1,
    position: [0, 0],
    parameters: { path: 'hook' },
    webhookId: '7d3d3f4e-1111-4222-8333-944455556666',
  };
  const deps = { navigate: vi.fn(), descriptions: { get: () => undefined } };
  const stopCalls = () =>
    backend().requests.filter((r) => r.method === 'DELETE' && r.path.endsWith('/listen-test-webhook'));

  async function startListening() {
    const wf = backend().seedWorkflow({ name: 'Hooked', nodes: [webhook], connections: {} });
    useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
    await listenForTestEvent(deps, 'Webhook');
    expect(useRunStore.getState().status).toBe('listening');
    return wf;
  }

  beforeEach(() => {
    signedIn();
    useRunStore.getState().reset();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useRunStore.getState().reset();
  });

  it('removes the test registration when the user clicks Stop listening', async () => {
    const wf = await startListening();
    await stopListening();
    expect(useRunStore.getState().status).toBe('idle');
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0].path).toBe(`/workflows/${wf.id}/listen-test-webhook`);
    expect(stopCalls()[0].body).toEqual({ nodeName: 'Webhook' });
    // the mock server no longer has a listener: a call to the test URL starts nothing
    expect(backend().receiveTestWebhook(wf.id)).toBeNull();
  });

  it('clears the listening state even when the server call fails', async () => {
    await startListening();
    const real = backend().handle.bind(backend());
    vi.spyOn(backend(), 'handle').mockImplementation(async (request) =>
      request.method === 'DELETE'
        ? { status: 500, body: { error: { code: 'boom', message: 'Server down' } } }
        : real(request),
    );
    await stopListening();
    expect(useRunStore.getState().status).toBe('idle');
    expect(useRunStore.getState().testWebhook).toBeNull();
  });

  it('removes the registration when listening times out in the editor', async () => {
    const timers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms > 60_000) {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as unknown as typeof setTimeout);
    const wf = await startListening();
    expect(timers).toHaveLength(1);
    timers[0]();
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
    expect(useRunStore.getState().status).toBe('idle');
    expect(backend().receiveTestWebhook(wf.id)).toBeNull();
  });
});

describe('R54: vector store nodes are offered after a main output', () => {
  // ports and modes of the vector store nodes of the AI package, same expressions
  const mode = "($parameter.mode ?? 'retrieve')";
  const embedding = "{ type: 'ai_embedding', displayName: 'Embedding', required: true, maxConnections: 1 }";
  const document = "{ type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1 }";
  const vectorStore: NodeTypeDescription = {
    displayName: 'Simple Vector Store',
    name: 'ai.vectorStoreInMemory',
    group: ['transform'],
    version: 1,
    description: 'Keeps documents and their vectors in the worker process',
    categories: ['AI'],
    defaults: { name: 'Simple Vector Store' },
    inputs: `={{ ${mode} === 'insert' ? ['main', ${document}, ${embedding}] : ${mode} === 'load' ? ['main', ${embedding}] : [${embedding}] }}`,
    outputs: `={{ ${mode} === 'retrieve' ? [{ type: 'ai_vectorStore', displayName: 'Vector Store' }] : ['main'] }}`,
    properties: [
      {
        displayName: 'Operation Mode',
        name: 'mode',
        type: 'options',
        default: 'retrieve',
        noDataExpression: true,
        options: [
          { name: 'Get Many', value: 'load', action: 'Get ranked documents' },
          { name: 'Insert Documents', value: 'insert', action: 'Add documents' },
          { name: 'Retrieve Documents', value: 'retrieve', action: 'Retrieve documents for a chain or tool' },
        ],
      },
    ],
  };
  const sideNode: NodeTypeDescription = {
    displayName: 'Vector Router',
    name: 'ai.vectorRouter',
    group: ['transform'],
    version: 1,
    description: 'Never takes a main input',
    categories: ['AI'],
    defaults: { name: 'Vector Router' },
    inputs: `={{ $parameter.kind === 'a' ? [${embedding}] : [${document}] }}`,
    outputs: ['main'],
    properties: [
      {
        displayName: 'Kind',
        name: 'kind',
        type: 'options',
        default: 'a',
        options: [
          { name: 'A', value: 'a', action: 'Use A' },
          { name: 'B', value: 'b', action: 'Use B' },
        ],
      },
    ],
  };
  const catalog = buildCatalog([vectorStore, sideNode]);
  const names = (query: string, filter: object) =>
    filterCatalog(catalog, { query, ...filter }).flatMap((s) => s.entries.map((e) => e.description.name));

  it('lists the vector store after a main output with Insert and Load actions that preset the mode', () => {
    const entries = filterCatalog(catalog, { query: 'vector', needsMainInput: true }).flatMap(
      (s) => s.entries,
    );
    expect(entries.map((e) => e.description.name)).toEqual(['ai.vectorStoreInMemory']);
    expect(entries[0].actions.map((a) => [a.label, a.parameters])).toEqual([
      ['Get ranked documents', { mode: 'load' }],
      ['Add documents', { mode: 'insert' }],
    ]);
  });

  it('offers the retrieve action where a vector store sub-node is wanted', () => {
    const entries = filterCatalog(catalog, { query: 'vector', outputType: 'ai_vectorStore' }).flatMap(
      (s) => s.entries,
    );
    expect(entries.map((e) => e.description.name)).toEqual(['ai.vectorStoreInMemory']);
    expect(entries[0].actions.map((a) => a.parameters)).toEqual([{ mode: 'retrieve' }]);
  });

  it('derives one action per mode in the unfiltered node search', () => {
    expect(nodeActions(vectorStore).map((a) => a.parameters)).toEqual([
      { mode: 'load' },
      { mode: 'insert' },
      { mode: 'retrieve' },
    ]);
    expect(names('vector', {})).toContain('ai.vectorStoreInMemory');
  });

  it('keeps nodes whose dynamic inputs never include main out of the list', () => {
    expect(names('vector', {})).toContain('ai.vectorRouter');
    expect(names('vector', { needsMainInput: true })).toEqual(['ai.vectorStoreInMemory']);
  });
});

describe('R35: a partial run sends the last run data of the workflow', () => {
  const nodes: WorkflowNode[] = [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Loop', type: 'core.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
  ];
  const deps = { navigate: vi.fn(), descriptions: { get: () => undefined } };
  const previousRunData = {
    Start: [
      {
        startTime: 1,
        executionTime: 2,
        executionStatus: 'success' as const,
        data: { main: [[{ json: { n: 1 } }]] },
        source: [],
      },
    ],
  };
  const runBody = () =>
    backend().requests.find((r) => r.method === 'POST' && r.path.endsWith('/run'))?.body as
      | Record<string, unknown>
      | undefined;

  async function openWithPreviousRun() {
    const wf = backend().seedWorkflow({ name: 'Looped', nodes, connections: {} });
    useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
    useRunStore.setState({ workflowId: wf.id, executionId: 'prev', status: 'success', runData: previousRunData });
    return wf;
  }

  beforeEach(() => {
    signedIn();
    useRunStore.getState().reset();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    useRunStore.getState().reset();
  });

  it('sends the previous run data when a step is executed from a start node', async () => {
    await openWithPreviousRun();
    await runWorkflow(deps, { startNode: 'Loop' });
    expect(runBody()?.startNode).toBe('Loop');
    expect(runBody()?.runData).toEqual(previousRunData);
  });

  it('sends no run data on a run without a start node', async () => {
    await openWithPreviousRun();
    await runWorkflow(deps);
    expect(runBody()).toBeDefined();
    expect(runBody()).not.toHaveProperty('runData');
  });
});
