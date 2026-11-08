/**
 * Model Context Protocol wire contracts shared by the MCP Server Trigger, the workspace MCP server
 * and the MCP Client nodes: JSON-RPC 2.0 shapes, protocol revisions, error codes and the helpers
 * that read and answer one message. Isomorphic: no Node API, no SDK types.
 */
import type { JsonSchema } from './ai-types';
import type { DataObject } from './interfaces';

/** the revision this server speaks first (2026: no `initialize`, `server/discover`, per-request `_meta`) */
export const MCP_LATEST_REVISION = '2026-07-28';

/** older revisions still answered (stateless `initialize` fallback), newest first */
export const MCP_LEGACY_REVISIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** JSON-RPC and MCP error codes; `HEADER_MISMATCH` is the 2026 routing header check */
export const MCP_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: DataObject;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: DataObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** one answer: `result` on success, `error` on failure (never both) */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: DataObject;
}

/** a `tools/call` result as the server sends it (content array kept, not flattened to text) */
export interface McpCallResult {
  content: Array<DataObject & { type: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** one parsed POST body */
export type McpMessage =
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }
  | { kind: 'response' }
  | { kind: 'invalid'; id: string | number | null; code: number; text: string };

/** who the server is, for `initialize` and `server/discover` */
export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

/** request headers as Fastify and Node give them (names lower-cased) */
export type McpRequestHeaders = Record<string, string | string[] | undefined>;

/** Reads one POST body. An array (batch) is `invalid` -32600; a body with `result` or `error` is a `response`. */
export function parseMcpMessage(_body: unknown): McpMessage {
  throw new Error('not implemented (L7)');
}

/** The revision to answer with: the requested one when supported, else `MCP_LATEST_REVISION`. */
export function negotiateMcpVersion(_requested: unknown): string {
  throw new Error('not implemented (L7)');
}

export function mcpResult(_id: JsonRpcId | null, _result: unknown): JsonRpcResponse {
  throw new Error('not implemented (L7)');
}

export function mcpError(
  _id: JsonRpcId | null,
  _code: number,
  _message: string,
  _data?: unknown,
): JsonRpcResponse {
  throw new Error('not implemented (L7)');
}

/** the `initialize` result (2025 revisions): protocol version, capabilities `tools`, server info, instructions */
export function mcpInitializeResult(_input: McpServerInfo & { protocolVersion: string }): DataObject {
  throw new Error('not implemented (L7)');
}

/** the `server/discover` result (2026 revision): supported versions, capabilities, server info, instructions */
export function mcpDiscoverResult(_input: McpServerInfo): DataObject {
  throw new Error('not implemented (L7)');
}

/**
 * 2026 routing headers: `mcp-method` must equal the body's method and `mcp-name` the tool name of a
 * `tools/call`; null when they match, else `{ code: MCP_ERRORS.HEADER_MISMATCH, text }`.
 */
export function checkMcpRoutingHeaders(
  _headers: McpRequestHeaders,
  _message: JsonRpcRequest,
): { code: number; text: string } | null {
  throw new Error('not implemented (L7)');
}

/** A tool's value as an MCP result: a string as is, anything else as JSON text. */
export function mcpResultFromValue(_value: unknown): McpCallResult {
  throw new Error('not implemented (L7)');
}

/** A failed tool call: one text part `<toolName>: <message>` and `isError: true`. */
export function mcpErrorResult(_toolName: string, _message: string): McpCallResult {
  throw new Error('not implemented (L7)');
}
