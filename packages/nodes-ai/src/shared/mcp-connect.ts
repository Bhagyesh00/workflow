/**
 * One way to open an MCP client connection for the MCP Client Tool and the MCP Client node: transport
 * (Streamable HTTP or the deprecated SSE), authentication (Bearer, Header, Multiple Headers, MCP OAuth2) and
 * the credential's allowed domains. Lane L12 fills it (moving `authHeaders` and `createClient` here).
 */
import type { BaseContext } from '@workflow/workflow';
import type { McpClient } from './mcp-client';

export interface McpConnectionInput {
  endpointUrl: string;
  serverTransport: 'httpStreamable' | 'sse';
  /** `none`, `bearerAuth`, `headerAuth`, `multipleHeadersAuth` or `mcpOAuth2Api` */
  authentication: string;
  timeoutMs: number;
  itemIndex?: number;
}

/** a connected client (initialize done); the caller closes it */
export async function createMcpConnection(
  _ctx: Pick<BaseContext, 'helpers' | 'getCredentials'>,
  _input: McpConnectionInput,
): Promise<McpClient> {
  throw new Error('not implemented (L12)');
}
