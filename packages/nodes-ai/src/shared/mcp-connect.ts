/**
 * One way to open an MCP client connection for the MCP Client Tool and the MCP Client node: transport
 * (Streamable HTTP or the deprecated SSE), authentication (Bearer, Header, Multiple Headers, MCP OAuth2) and
 * the credential's allowed domains.
 *
 * When any authentication is in use, every request carries `allowedDomains`: the credential's list, or the
 * endpoint's own host. A redirect to another host is then refused instead of followed with the credential.
 */
import {
  assertCredentialUrlAllowed,
  type BaseContext,
  type DataObject,
  getCredentialAllowedDomains,
  type HttpFullResponse,
  type HttpRequestOptions,
} from '@workflow/workflow';
import { McpClient, type McpTransport } from './mcp-client';
import { createSseTransport } from './mcp-sse';
import { errorMessage, redactSecrets } from './utils';

export interface McpConnectionInput {
  endpointUrl: string;
  serverTransport: 'httpStreamable' | 'sse';
  /** `none`, `bearerAuth`, `headerAuth`, `multipleHeadersAuth` or `mcpOAuth2Api` */
  authentication: string;
  timeoutMs: number;
  itemIndex?: number;
}

type ConnectContext = Pick<BaseContext, 'helpers' | 'getCredentials'>;

export interface McpAuth {
  headers: Record<string, string>;
  /** the credential's allowed domains, else the endpoint host when a credential applies (undefined = no credential) */
  allowedDomains?: string[];
  /** a credential type the HTTP helper applies itself (MCP OAuth2) */
  credentialType?: string;
}

/** `Authentication failed` for a 401 or 403 of the server; the connection text for everything else */
export const MCP_AUTH_FAILED = 'Authentication failed. Check the credentials for the MCP server.';
export const MCP_CONNECT_FAILED = 'Could not connect to the MCP server';

export function isMcpAuthFailure(error: unknown): boolean {
  const e = error as { httpStatus?: number; httpCode?: string | number; statusCode?: number } | undefined;
  const status = e?.httpStatus ?? e?.statusCode ?? Number(e?.httpCode);
  return status === 401 || status === 403;
}

/** the text the node shows when connecting fails (no secret: `errorMessage` redacts) */
export function mcpConnectErrorMessage(error: unknown): string {
  if (isMcpAuthFailure(error)) return MCP_AUTH_FAILED;
  return `${MCP_CONNECT_FAILED}: ${redactSecrets(errorMessage(error))}`;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    throw new Error('The MCP endpoint must be an http(s) URL');
  }
}

/** the header rows of a Multiple Headers credential, lower-cased names, empty names skipped */
function multipleHeaders(creds: DataObject): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = (creds.headers as { values?: unknown } | undefined)?.values;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as Array<{ name?: unknown; value?: unknown }>) {
    const name = String(row?.name ?? '').trim();
    if (name) out[name.toLowerCase()] = String(row.value ?? '');
  }
  return out;
}

/**
 * The credential is read by hand here, so its allowed domains are read with it. The endpoint is typed by
 * the user, so the credential's `none` mode applies (it throws). With any credential in use the result
 * always has a domain list, so a redirect with a header is refused.
 */
export async function resolveMcpAuth(
  ctx: Pick<BaseContext, 'getCredentials'>,
  authentication: string,
  endpoint: string,
  itemIndex = 0,
): Promise<McpAuth> {
  const hostOnly = () => [endpointHost(endpoint)];
  if (authentication === 'bearerAuth') {
    const creds = await ctx.getCredentials('httpBearerAuth', itemIndex);
    return {
      headers: { authorization: `Bearer ${String(creds.token ?? '')}` },
      allowedDomains: getCredentialAllowedDomains(creds, { userUrl: true }) ?? hostOnly(),
    };
  }
  if (authentication === 'headerAuth') {
    const creds = await ctx.getCredentials('httpHeaderAuth', itemIndex);
    const allowedDomains = getCredentialAllowedDomains(creds, { userUrl: true }) ?? hostOnly();
    if (!creds.name) throw new Error('The header auth credential has no header name');
    return { headers: { [String(creds.name).toLowerCase()]: String(creds.value ?? '') }, allowedDomains };
  }
  if (authentication === 'multipleHeadersAuth') {
    const creds = await ctx.getCredentials('httpMultipleHeadersAuth', itemIndex);
    const headers = multipleHeaders(creds);
    if (Object.keys(headers).length === 0) throw new Error('The Multiple Headers credential has no header');
    return {
      headers,
      allowedDomains: getCredentialAllowedDomains(creds, { userUrl: true }) ?? hostOnly(),
    };
  }
  if (authentication === 'mcpOAuth2Api') {
    const creds = await ctx.getCredentials('mcpOAuth2Api', itemIndex);
    return {
      headers: {},
      credentialType: 'mcpOAuth2Api',
      allowedDomains: getCredentialAllowedDomains(creds, { userUrl: true }) ?? hostOnly(),
    };
  }
  return { headers: {} };
}

/** a connected client (initialize done); the caller closes it */
export async function createMcpConnection(
  ctx: ConnectContext,
  input: McpConnectionInput,
): Promise<McpClient> {
  const endpoint = input.endpointUrl.trim();
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('The MCP endpoint must be an http(s) URL');
  const itemIndex = input.itemIndex ?? 0;
  const auth = await resolveMcpAuth(ctx, input.authentication, endpoint, itemIndex);
  const client = openMcpClient(ctx, endpoint, input.serverTransport, auth, input.timeoutMs, itemIndex);
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

/** the client before `connect` (the transport is the seam) */
export function openMcpClient(
  ctx: Pick<BaseContext, 'helpers'>,
  endpoint: string,
  serverTransport: 'httpStreamable' | 'sse',
  auth: McpAuth,
  timeoutMs: number,
  itemIndex = 0,
): McpClient {
  // checked before any request carries the credential; the list also goes with every request, so
  // HttpClient refuses a redirect to another host
  assertCredentialUrlAllowed(endpoint, auth.allowedDomains);
  const { allowedDomains, credentialType } = auth;
  const send = async <T>(request: HttpRequestOptions) => {
    const options: HttpRequestOptions =
      allowedDomains === undefined ? request : { ...request, allowedDomains };
    if (credentialType) {
      return ctx.helpers.httpRequestWithAuthentication<T>(
        credentialType,
        { ...options, credentialScope: 'userUrl' },
        itemIndex,
      );
    }
    return ctx.helpers.httpRequest<T>(options);
  };
  if (serverTransport === 'sse') {
    const sse = createSseTransport({
      request: send,
      endpoint,
      headers: auth.headers,
      timeoutMs,
      allowedDomains,
    });
    return new McpClient(sse.transport, endpoint, auth.headers, timeoutMs, sse.close);
  }
  const transport: McpTransport = async (request) =>
    (await send<string>(request)) as HttpFullResponse<string>;
  return new McpClient(transport, endpoint, auth.headers, timeoutMs);
}
