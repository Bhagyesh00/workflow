/**
 * MCP server side of the MCP Server Trigger: tool descriptors for `tools/list`, one `tools/call` against a
 * connected tool, and the header redaction applied before request headers enter run data.
 */
import {
  type AiTool,
  type DataObject,
  isToolSuspension,
  type JsonSchema,
  type McpCallResult,
  type McpRequestHeaders,
  type McpToolDescriptor,
  mcpErrorResult,
  mcpResultFromValue,
  redactSecrets,
} from '@workflow/workflow';

/** what a redacted header value reads as in run data (`authorization`, `cookie`, a Header Auth credential's header) */
export const MCP_REDACTED = '**hidden**';

/** headers that always carry a secret of the caller */
const ALWAYS_REDACTED = ['authorization', 'proxy-authorization', 'cookie'];

/** MCP needs an object schema; a tool with any other schema takes no arguments */
function objectSchema(schema: JsonSchema): JsonSchema {
  if (schema && typeof schema === 'object' && schema.type === 'object') {
    return { ...schema, properties: schema.properties ?? {} };
  }
  return { type: 'object', properties: {} };
}

/** the `tools/list` entries of the connected tools */
export function mcpToolDescriptors(tools: AiTool[]): McpToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: objectSchema(tool.parameters),
  }));
}

/**
 * run one tool for `tools/call`: `invokeRaw` when the tool has it (MCP Client sub-node), else `invoke`. A failure
 * is an `isError` result (`<name>: <message>`, secrets removed); a tool that stops the run to wait for a person
 * throws its suspension on, so the run ends `waiting`.
 */
export async function callMcpTool(tool: AiTool, args: DataObject, signal?: AbortSignal): Promise<McpCallResult> {
  try {
    if (tool.invokeRaw) return await tool.invokeRaw(args, { signal });
    return mcpResultFromValue(await tool.invoke(args, { signal }));
  } catch (error) {
    if (isToolSuspension(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return mcpErrorResult(tool.name, redactSecrets(message || 'The tool failed'));
  }
}

/**
 * the request headers as run data: one string per header, `authorization`, `cookie` and every name in `extra`
 * (lower-cased, e.g. the Header Auth credential's header) replaced by `MCP_REDACTED`
 */
export function redactMcpHeaders(headers: McpRequestHeaders, extra: string[]): Record<string, string> {
  const hidden = new Set([...ALWAYS_REDACTED, ...extra.map((name) => name.trim().toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    out[name] = hidden.has(name) ? MCP_REDACTED : Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}
