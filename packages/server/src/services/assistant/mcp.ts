/**
 * The workspace's MCP servers as Assistant tools (P5-72, lane L9): per enabled connection a one-parent
 * definition (`ai.agent`, `ai.mcpClientTool`) opened through `openSubNodes` (C0e), its `ai_tool` read,
 * descriptions and schemas sanitized, names `mcp_<connection>_<tool>`, `permission` `mcpRead` only for a
 * `readOnlyHint` tool, else `mcpWrite`, `minRole` editor. None when `mcpAccessEnabled` is off or the
 * caller is below editor. C0 stub with the final signatures: no tools, nothing resolved.
 */
import type { ServerContext } from '../../context';
import type { AssistantRunScope, AssistantToolDefinition } from './types';

/** the MCP tools of this turn and the `close()` the turn runs in its `finally` (C0: none) */
export async function openMcpTools(
  _ctx: ServerContext,
  _run: AssistantRunScope,
): Promise<{ tools: AssistantToolDefinition[]; close(): Promise<void> }> {
  return { tools: [], close: async () => {} };
}

/**
 * Reopens the connection of the MCP tool `name` for an approved call after a stop, under the same role
 * and access rules; undefined when it is not an MCP tool or no longer exists (C0: undefined).
 */
export async function resolveMcpTool(
  _ctx: ServerContext,
  _run: AssistantRunScope,
  _name: string,
): Promise<{ tool: AssistantToolDefinition; close(): Promise<void> } | undefined> {
  return undefined;
}
