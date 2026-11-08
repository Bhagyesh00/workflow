/**
 * The tenant MCP server (P5-04, filled by L8): stateless JSON-RPC over `POST /mcp-server/:tenantSlug/http`,
 * 2026-07-28 (`server/discover`, routing headers checked with `checkMcpRoutingHeaders`, -32020) with the
 * `initialize` fallback for 2025 clients. A tool is listed only when the caller holds one of its scopes
 * and meets `minRole`, and the call checks both again. Production errors are generic -32603.
 */
import type { McpRequestHeaders } from '@workflow/workflow';
import type { Config } from '../../config';
import type { ServerContext } from '../../context';
import { MCP_BUILDER_TOOLS } from './tools/builder';
import { credentialsTools } from './tools/credentials';
import { dataTablesTools } from './tools/data-tables';
import { executionsTools } from './tools/executions';
import { foldersTools } from './tools/folders';
import { runTools } from './tools/run';
import { tagsTools } from './tools/tags';
import { workflowsTools } from './tools/workflows';
import type { McpCaller, McpToolDefinition } from './types';

/** every tool of the tenant server, the build tools (P5-13) last; read at call time, so a lane's list is current */
export function mcpToolTable(): McpToolDefinition<any>[] {
  return [
    ...workflowsTools,
    ...executionsTools,
    ...runTools,
    ...credentialsTools,
    ...tagsTools,
    ...dataTablesTools,
    ...foldersTools,
    ...MCP_BUILDER_TOOLS,
  ];
}

/** the tools this caller may see: a scope it holds, its role at least `minRole`; no build tools when `MCP_BUILDER_ENABLED` is false */
export function listMcpTools(_caller: McpCaller, _config: Config): McpToolDefinition<any>[] {
  throw new Error('not implemented (L8)');
}

/** one POST to the tenant server, after the Host check, the access check and Bearer auth */
export interface McpServerRequest {
  caller: McpCaller;
  /** the raw body text (the route's string parser), so malformed JSON gives -32700 */
  body: string;
  headers: McpRequestHeaders;
  /** the tenant server's URL (`mcpServerUrl`) */
  resource: string;
}

export interface McpServerReply {
  statusCode: number;
  headers: Record<string, string>;
  /** a JSON-RPC response; absent for a notification (202) */
  body?: unknown;
}

export async function handleMcpRequest(
  _ctx: ServerContext,
  _request: McpServerRequest,
): Promise<McpServerReply> {
  throw new Error('not implemented (L8)');
}
