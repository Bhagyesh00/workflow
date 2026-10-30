/** Test harness: run a node (or small workflow) through the real engine with in-memory services. */
import {
  CredentialTypes,
  type ExecutionServices,
  HttpClient,
  InlineBinaryDataStore,
  IsolatedVmCodeRunner,
  NodeTypes,
  silentLogger,
  WorkflowExecute,
} from '@workflow/core';
import { type DataObject, type Item, Workflow, type WorkflowNode } from '@workflow/workflow';
import { credentials, nodes } from '../src';

export const nodeTypes = new NodeTypes(nodes);
export const credentialTypes = new CredentialTypes(credentials);

export function testServices(
  creds: Record<string, DataObject> = {},
  overrides: Partial<ExecutionServices> = {},
): ExecutionServices {
  return {
    tenantId: 't1',
    executionId: 'e1',
    mode: 'manual',
    timezone: 'UTC',
    variables: {},
    instanceBaseUrl: 'http://localhost:5678',
    nodeTypes,
    credentialTypes,
    credentials: { get: async (_ref, type) => creds[type] ?? {}, update: async () => {} },
    binaryData: new InlineBinaryDataStore(),
    codeRunner: new IsolatedVmCodeRunner({ timeoutMs: 3000 }),
    http: new HttpClient(),
    logger: silentLogger,
    ...overrides,
  };
}

/** Execute one node with the given input items; returns its outputs (json only). */
export async function runNode(
  type: string,
  parameters: DataObject,
  input: Item[] = [{ json: {} }],
  options: {
    creds?: Record<string, DataObject>;
    node?: Partial<WorkflowNode>;
    services?: Partial<ExecutionServices>;
  } = {},
) {
  const workflow = new Workflow(
    {
      name: 'test',
      nodes: [
        {
          id: 'start',
          name: 'Start',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'n',
          name: 'Node',
          type,
          typeVersion: 1,
          position: [200, 0],
          parameters,
          credentials: Object.fromEntries(
            Object.keys(options.creds ?? {}).map((k) => [k, { id: k, name: k }]),
          ),
          ...options.node,
        },
      ],
      connections: { Start: { main: [[{ node: 'Node', type: 'main', index: 0 }]] } },
    },
    nodeTypes,
  );
  const result = await new WorkflowExecute(workflow, testServices(options.creds, options.services)).run({
    triggerItems: input,
  });
  const task = result.state.resultData.runData.Node?.[0];
  return {
    status: result.status,
    error: result.state.resultData.error,
    outputs: (task?.data?.main ?? []).map((items) => (items ?? []).map((i) => i.json)),
    items: (task?.data?.main ?? []) as Item[][],
  };
}
