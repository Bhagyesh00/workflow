/** Build trigger / poll / load-options / webhook-lifecycle contexts for tests. */
import {
  type ContextDeps,
  createBaseContext,
  createPollContext,
  createWebhookContext,
  type ExecutionServices,
} from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type LoadOptionsContext,
  type PollContext,
  type WebhookContext,
  type WebhookLifecycleContext,
  type WebhookRequest,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { node as makeNode, nodeTypes, testServices } from './harness';

export function contextFor(
  type: string,
  parameters: DataObject,
  options: {
    creds?: Record<string, DataObject>;
    services?: Partial<ExecutionServices>;
    staticData?: DataObject;
    node?: Partial<WorkflowNode>;
    workflow?: Partial<WorkflowDefinition>;
  } = {},
) {
  const wfNode = makeNode('Node', type, parameters, [0, 0], {
    credentials: Object.fromEntries(Object.keys(options.creds ?? {}).map((k) => [k, { id: k, name: k }])),
    ...options.node,
  });
  const workflow = new Workflow(
    {
      id: 'wf1',
      name: 'test',
      nodes: [wfNode],
      connections: {},
      staticData: options.staticData ?? {},
      ...options.workflow,
    },
    nodeTypes,
  );
  const deps: ContextDeps = {
    workflow,
    node: wfNode,
    services: testServices(options.creds, options.services),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  };
  return {
    workflow,
    node: wfNode,
    nodeType: nodeTypes.get(type)!,
    loadOptions(): LoadOptionsContext {
      const base = createBaseContext(deps);
      const { getNodeParameter: _omit, ...rest } = base;
      return { ...rest, getCurrentNodeParameter: (name: string) => parameters[name] };
    },
    poll(mode: 'manual' | 'trigger' = 'trigger'): PollContext {
      return createPollContext(
        { ...deps, services: { ...deps.services, mode } },
        mode === 'manual' ? 'manual' : 'activate',
      );
    },
    webhook(request: Partial<WebhookRequest>): WebhookContext {
      return createWebhookContext(
        deps,
        { method: 'POST', headers: {}, query: {}, params: {}, body: {}, ...request },
        'default',
      );
    },
    lifecycle(webhookUrl: string): WebhookLifecycleContext {
      return {
        ...createBaseContext(deps),
        getNodeWebhookUrl: () => webhookUrl,
        getWebhookName: () => 'default',
      };
    },
  };
}
