/**
 * MCP server side of the MCP Server Trigger: tool descriptors for `tools/list`, one `tools/call` against a
 * connected tool, and the header redaction applied before request headers enter run data. Lane L7 fills it;
 * `MCP_REDACTED` is final.
 */
import type {
  AiTool,
  DataObject,
  McpCallResult,
  McpRequestHeaders,
  McpToolDescriptor,
} from '@workflow/workflow';

/** what a redacted header value reads as in run data (`authorization`, `cookie`, a Header Auth credential's header) */
export const MCP_REDACTED = '**hidden**';

/** the `tools/list` entries of the connected tools */
export function mcpToolDescriptors(_tools: AiTool[]): McpToolDescriptor[] {
  throw new Error('not implemented (L7)');
}

/** run one tool for `tools/call`: `invokeRaw` when the tool has it (MCP Client sub-node), else `invoke` */
export async function callMcpTool(
  _tool: AiTool,
  _args: DataObject,
  _signal?: AbortSignal,
): Promise<McpCallResult> {
  throw new Error('not implemented (L7)');
}

/**
 * the request headers as run data: one string per header, `authorization`, `cookie` and every name in `extra`
 * (lower-cased, e.g. the Header Auth credential's header) replaced by `MCP_REDACTED`
 */
export function redactMcpHeaders(_headers: McpRequestHeaders, _extra: string[]): Record<string, string> {
  throw new Error('not implemented (L7)');
}
