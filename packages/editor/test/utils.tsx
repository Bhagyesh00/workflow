import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { NodeTypeDescription, RunData, WorkflowNode } from '@workflow/workflow';
import { type ReactNode, useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AppProviders, routes } from '../src/App';
import { ParameterContext, type ParameterContextValue } from '../src/components/parameters/context';
import { ParameterList } from '../src/components/parameters/ParameterForm';
import { buildExpressionContext, previewExpression } from '../src/lib/expression-context';
import { setIn } from '../src/lib/workflow-ops';

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
}

/** Render the whole app at `path`, as the browser would. */
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = testQueryClient();
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router, queryClient };
}

export function withProviders(ui: ReactNode, queryClient = testQueryClient()) {
  return render(<AppProviders queryClient={queryClient}>{ui}</AppProviders>);
}

const PARENT: WorkflowNode = {
  id: 'p1',
  name: 'Source',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const CONNECTIONS = { Source: { main: [[{ node: 'Subject', type: 'main' as const, index: 0 }]] } };

interface HarnessProps {
  description: NodeTypeDescription;
  initial: WorkflowNode;
  runData: RunData;
  readOnly: boolean;
  latest: { current: WorkflowNode };
}

function ParameterHarness({ description, initial, runData, readOnly, latest }: HarnessProps) {
  const [node, setNode] = useState(initial);
  latest.current = node;
  const ctx: ParameterContextValue = {
    node,
    description,
    rootValues: node.parameters,
    readOnly,
    allowExpressions: true,
    onChange: (path, value) =>
      setNode((n) => {
        const next = { ...n, parameters: setIn(n.parameters, path, value) as Record<string, unknown> };
        latest.current = next;
        return next;
      }),
    preview: (expression) =>
      previewExpression(
        expression,
        buildExpressionContext({
          workflow: { name: 'Test', active: false, nodes: [PARENT, node], connections: CONNECTIONS },
          runData,
          nodeName: node.name,
        }),
      ),
    onButton: () => undefined,
  };
  return (
    <ParameterContext.Provider value={ctx}>
      <ParameterList properties={description.properties} values={node.parameters} path={[]} />
    </ParameterContext.Provider>
  );
}

/**
 * Render a parameter form for `description` with a stateful node. `node.current` always holds
 * the latest node so tests can assert on what the form wrote.
 */
export function renderParameters(
  description: NodeTypeDescription,
  options: {
    parameters?: Record<string, unknown>;
    typeVersion?: number;
    runData?: RunData;
    readOnly?: boolean;
  } = {},
) {
  const initial: WorkflowNode = {
    id: 'n1',
    name: 'Subject',
    type: description.name,
    typeVersion: options.typeVersion ?? 1,
    position: [0, 0],
    parameters: options.parameters ?? {},
  };
  const node = { current: initial };
  const utils = withProviders(
    <ParameterHarness
      description={description}
      initial={initial}
      runData={options.runData ?? {}}
      readOnly={options.readOnly ?? false}
      latest={node}
    />,
  );
  return { ...utils, node };
}

export function runDataFor(nodeName: string, items: Array<Record<string, unknown>>): RunData {
  return {
    [nodeName]: [
      {
        startTime: 0,
        executionTime: 1,
        executionStatus: 'success',
        data: { main: [items.map((json) => ({ json }))] },
        source: [],
      },
    ],
  };
}
