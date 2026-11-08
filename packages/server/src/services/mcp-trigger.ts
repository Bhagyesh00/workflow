/**
 * The MCP Server Trigger's transport and run (P5-03, filled by L7). services/webhooks.ts hands a found
 * `mcp` hook here (Host already checked) before reading the body. This service reads and parses the
 * JSON-RPC message (`parseMcpMessage`; too large 413, malformed or a batch a JSON-RPC error), calls the
 * node's `webhook` (auth and the answers that need no run: `initialize`, `tools/list`), then owns
 * sessions (`Mcp-Session-Id`, legacy SSE with `?sessionId=` and bus channel `mcp-session:<id>`), `ping`,
 * notifications (202), DELETE, and `tools/call`: `claim()`, then one execution with
 * `{ ...baseItem, mcpToolCall, mcpMessageId }` whose `lastNodeOutput` answers the POST. Every reply
 * carries `mcpCorsHeaders`.
 *
 * The constructor and `close` never throw (`createContext` and `close()` run them in every server test).
 */
import type { WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';
import type { McpSessionStore } from './mcp-sessions';
import type { NodeWebhook } from './webhook-paths';
import type { IncomingWebhook, WebhookReply } from './webhooks';

export interface McpTriggerServiceDeps extends ServiceDeps {
  /** the context's MCP session store (`createMcpSessionStore`) */
  sessions: McpSessionStore;
}

/** one request to an MCP Server Trigger's URL, production or test */
export interface McpTriggerRequest {
  tenant: TenantRow;
  definition: WorkflowDefinition;
  workflowId: string;
  node: WorkflowNode;
  /** `setup` GET, `default` POST or `sessionEnd` DELETE */
  hook: NodeWebhook;
  mode: 'webhook' | 'manual';
  /** the request; its body is not read yet */
  incoming: IncomingWebhook;
  params: Record<string, string>;
  userId?: string;
  /** a test URL: takes the registration on the first tool call; a reply means another request took it */
  claim?: () => Promise<WebhookReply | undefined>;
  onStarted?(executionId: string): void;
}

export class McpTriggerService {
  constructor(readonly deps: McpTriggerServiceDeps) {}

  async handle(_input: McpTriggerRequest): Promise<WebhookReply> {
    throw new Error('not implemented (L7)');
  }

  /** ends held SSE streams and bus subscriptions */
  async close(): Promise<void> {}
}
