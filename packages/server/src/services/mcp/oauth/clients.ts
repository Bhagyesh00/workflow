/**
 * OAuth clients of the MCP OAuth server (P5-14). Dynamic registration (RFC 7591): at most 10 redirect
 * URIs of 2048 characters, a name of 255, http only on loopback; `javascript:`, `data:`, `vbscript:`,
 * `file:` and any URI with a fragment refused; `MCP_MAX_REGISTERED_CLIENTS` per tenant. Public clients
 * plus `client_secret_post` and `client_secret_basic`; secrets stored as SHA-256 and compared with
 * `timingSafeEqual`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isPlainObject } from '@workflow/workflow';
import type { ServerContext } from '../../../context';
import type { OAuthClientAuthMethod, TenantRow } from '../../../db/schema';
import type { OAuthClientRow } from '../../../repositories/mcp-oauth';
import { sha256 } from '../../auth';

export const MCP_OAUTH_MAX_REDIRECT_URIS = 10;
export const MCP_OAUTH_MAX_REDIRECT_URI_LENGTH = 2048;
export const MCP_OAUTH_MAX_CLIENT_NAME_LENGTH = 255;

/** the schemes a redirect URI may never use */
export const MCP_OAUTH_REFUSED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'] as const;

/** the grants a client may register */
export const MCP_OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/** how a client may authenticate at the token and revoke endpoints */
export const MCP_OAUTH_AUTH_METHODS: readonly OAuthClientAuthMethod[] = [
  'none',
  'client_secret_post',
  'client_secret_basic',
];

/** the name a client that sends none is shown with */
const DEFAULT_CLIENT_NAME = 'MCP client';

/** the reply of the registration endpoint: the client's metadata (201), or `{ error, error_description }` */
export interface McpOAuthRegisterReply {
  statusCode: number;
  body: Record<string, unknown>;
}

const metadataError = (description: string, error = 'invalid_client_metadata'): McpOAuthRegisterReply => ({
  statusCode: 400,
  body: { error, error_description: description },
});

/** `localhost`, `127.x.x.x` or `[::1]`: the hosts where `http` and any port are allowed */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** why a redirect URI is refused (at register and in the allowed list), or null when it is fine */
export function redirectUriProblem(uri: string): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return 'A redirect URI must be a non-empty string';
  if (uri.length > MCP_OAUTH_MAX_REDIRECT_URI_LENGTH) {
    return `A redirect URI may have at most ${MCP_OAUTH_MAX_REDIRECT_URI_LENGTH} characters`;
  }
  const lower = uri.trim().toLowerCase();
  if (MCP_OAUTH_REFUSED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return 'This redirect URI scheme is not allowed';
  }
  if (uri.includes('#')) return 'A redirect URI must not have a fragment';
  if (/\s/.test(uri)) return 'A redirect URI must not contain spaces';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'A redirect URI must be an absolute URL';
  }
  // the parser may normalise an odd spelling into a refused scheme
  if (MCP_OAUTH_REFUSED_SCHEMES.includes(url.protocol as (typeof MCP_OAUTH_REFUSED_SCHEMES)[number])) {
    return 'This redirect URI scheme is not allowed';
  }
  if (url.username || url.password) return 'A redirect URI must not hold a user name or password';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'A redirect URI may use http only on a loopback host (localhost, 127.0.0.1, [::1])';
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) {
    return 'A redirect URI must name a host';
  }
  return null;
}

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;

/** `POST /mcp-oauth/:tenantSlug/register` */
export async function registerMcpOAuthClient(
  ctx: ServerContext,
  tenant: TenantRow,
  body: unknown,
): Promise<McpOAuthRegisterReply> {
  if (!isPlainObject(body)) return metadataError('The registration request must be a JSON object');

  const redirectUris = stringList(body.redirect_uris);
  if (!redirectUris || redirectUris.length === 0) {
    return metadataError('redirect_uris must list at least one URI', 'invalid_redirect_uri');
  }
  if (redirectUris.length > MCP_OAUTH_MAX_REDIRECT_URIS) {
    return metadataError(
      `A client may register at most ${MCP_OAUTH_MAX_REDIRECT_URIS} redirect URIs`,
      'invalid_redirect_uri',
    );
  }
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) return metadataError(problem, 'invalid_redirect_uri');
  }

  let name = DEFAULT_CLIENT_NAME;
  if (body.client_name !== undefined && body.client_name !== null) {
    if (typeof body.client_name !== 'string') return metadataError('client_name must be a string');
    if (body.client_name.length > MCP_OAUTH_MAX_CLIENT_NAME_LENGTH) {
      return metadataError(`client_name may have at most ${MCP_OAUTH_MAX_CLIENT_NAME_LENGTH} characters`);
    }
    if (body.client_name.trim()) name = body.client_name.trim();
  }

  // RFC 7591 section 2: the default is client_secret_basic
  const method = (body.token_endpoint_auth_method ?? 'client_secret_basic') as OAuthClientAuthMethod;
  if (!MCP_OAUTH_AUTH_METHODS.includes(method)) {
    return metadataError(
      'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic',
    );
  }

  const grantTypes =
    body.grant_types === undefined ? ['authorization_code', 'refresh_token'] : stringList(body.grant_types);
  if (
    !grantTypes ||
    grantTypes.length === 0 ||
    !grantTypes.every((g) => (MCP_OAUTH_GRANT_TYPES as readonly string[]).includes(g)) ||
    !grantTypes.includes('authorization_code')
  ) {
    return metadataError('grant_types may hold authorization_code and refresh_token only');
  }
  const responseTypes = body.response_types === undefined ? ['code'] : stringList(body.response_types);
  if (responseTypes?.length !== 1 || responseTypes[0] !== 'code') {
    return metadataError('response_types may hold code only');
  }

  const repo = ctx.repos.mcpOAuth;
  const max = ctx.config.mcp.maxRegisteredClients;
  if ((await repo.countClients(tenant.id)) >= max) {
    return {
      statusCode: 400,
      body: {
        error: 'invalid_request',
        error_description: `This workspace has reached its limit of ${max} registered clients`,
      },
    };
  }

  const secret = method === 'none' ? undefined : `wfocs_${randomBytes(32).toString('base64url')}`;
  const client = await repo.createClient({
    id: randomUUID(),
    tenantId: tenant.id,
    name,
    redirectUris: [...new Set(redirectUris)],
    grantTypes: [...new Set(grantTypes)],
    tokenEndpointAuthMethod: method,
    clientSecretHash: secret ? sha256(secret) : null,
    clientSecretExpiresAt: null,
  });

  return {
    statusCode: 201,
    body: {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    },
  };
}

/** `client_id` and `client_secret` of an `Authorization: Basic` header (RFC 6749 2.3.1, form-encoded) */
function basicCredentials(
  authorization: string | undefined,
): { id: string; secret: string } | null | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Basic[ \t]+([A-Za-z0-9+/=._~-]+)[ \t]*$/i.exec(authorization);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
      secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

/** the stored secret hash equals the hash of the given secret (constant time) */
function secretMatches(storedHash: string | null, secret: string): boolean {
  if (!storedHash || !secret) return false;
  const given = Buffer.from(sha256(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The client of a token or revoke request: `client_secret_basic` (the Authorization header),
 * `client_secret_post` (the body) or a public client (`client_id` only); undefined is `invalid_client`.
 * A confidential client must prove its secret; a public client must not send one.
 */
export async function authenticateMcpOAuthClient(
  ctx: ServerContext,
  tenantId: string,
  body: Record<string, string>,
  authorization: string | undefined,
): Promise<OAuthClientRow | undefined> {
  const basic = basicCredentials(authorization);
  if (basic === null) return undefined;
  const bodyId = typeof body.client_id === 'string' ? body.client_id : undefined;
  const bodySecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  // one way only: a Basic header and a body secret together are refused (RFC 6749 2.3)
  if (basic && bodySecret !== undefined) return undefined;
  if (basic && bodyId !== undefined && bodyId !== basic.id) return undefined;
  const clientId = basic?.id ?? bodyId;
  if (!clientId) return undefined;
  const client = await ctx.repos.mcpOAuth.getClient(tenantId, clientId);
  if (!client) return undefined;
  if (client.clientSecretExpiresAt && client.clientSecretExpiresAt.getTime() <= Date.now()) return undefined;

  if (client.tokenEndpointAuthMethod === 'none') {
    return basic || bodySecret !== undefined ? undefined : client;
  }
  const secret = basic?.secret ?? bodySecret;
  if (secret === undefined) return undefined;
  return secretMatches(client.clientSecretHash, secret) ? client : undefined;
}
