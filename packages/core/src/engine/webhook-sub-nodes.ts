/**
 * Sub-nodes for a webhook context (from S3): a node that answers a request before any run starts, such as the Chat
 * Trigger loading a session's history from its memory, reads its sub-nodes through these callbacks.
 *
 * The sub-nodes run on a throwaway engine with a fresh state: a logged sub-node run lands in that state only, never
 * in an execution. The caller hands `callbacks` to `createWebhookContext` and calls `close()` in a `finally` after
 * the node's `webhook` method, which waits for the logged runs' hooks and then runs the sub-nodes' close functions.
 */
import type { Item } from '@workflow/workflow';
import type { ContextDeps, WebhookContextCallbacks } from './node-context';
import { createInitialState, WorkflowExecute } from './workflow-execute';

export interface WebhookSubNodes {
  callbacks: WebhookContextCallbacks;
  /** waits for the logged sub-node hooks, then closes what the sub-nodes opened; a second call does nothing */
  close(): Promise<void>;
}

/** `item` is the webhook node's one input item (the request body), what a memory's `$json.sessionId` reads */
export function createWebhookSubNodes(deps: ContextDeps, item: Item): WebhookSubNodes {
  const engine = new WorkflowExecute(deps.workflow, deps.services, createInitialState());
  const closeFunctions: Array<() => Promise<void>> = [];
  let closed = false;
  return {
    callbacks: {
      getInputConnectionData: (type, itemIndex) =>
        engine.supplySubNodesForWebhook(deps.node, type, itemIndex, item, deps.signal, closeFunctions),
    },
    async close() {
      if (closed) return;
      closed = true;
      await engine.finishSubNodesForWebhook(closeFunctions.splice(0));
    },
  };
}
