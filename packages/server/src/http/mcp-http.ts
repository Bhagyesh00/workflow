/**
 * HTTP rules shared by every MCP prefix (P5-03 trigger `/mcp` and `/mcp-test`, P5-04 `/mcp-server`,
 * P5-14 `/mcp-oauth` and `/.well-known`):
 * - Host check (DNS rebinding): the request's Host must be the host of `config.mcp.baseUrl`.
 * - CORS: any origin, never credentials (MCP calls carry a Bearer token, never a cookie).
 * - Rate limit: a 5-minute window per IP, as the route's `config.rateLimit`.
 */
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config';

/** the request headers an MCP client sends, always allowed in a preflight */
export const MCP_ALLOW_HEADERS = [
  'content-type',
  'authorization',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
  'last-event-id',
] as const;

/** the reply headers an MCP client in a browser must read */
export const MCP_EXPOSE_HEADERS = ['mcp-session-id', 'www-authenticate'] as const;

export const MCP_ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

export const MCP_CORS_MAX_AGE_S = 600;

/** the window of every MCP and MCP OAuth rate limit */
export const MCP_RATE_LIMIT_WINDOW_MS = 300_000;

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/**
 * True when the request's Host equals the host of `config.mcp.baseUrl` (exact, lower-cased).
 * A Host naming the scheme's default port (`example.com:443` for https) equals the bare host,
 * as the URL parser writes it. No Host, or another one, is false: the caller answers 403.
 */
export function mcpHostAllowed(request: FastifyRequest, config: Config): boolean {
  const base = new URL(config.mcp.baseUrl);
  const expected = base.host.toLowerCase();
  const raw = typeof request.host === 'string' ? request.host.trim().toLowerCase() : '';
  if (!raw) return false;
  if (raw === expected) return true;
  const defaultPort = DEFAULT_PORTS[base.protocol];
  return defaultPort !== undefined && raw === `${expected}:${defaultPort}`;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * CORS headers of every MCP reply and preflight: any origin (`*`), the MCP methods, the MCP
 * request headers plus the names the preflight asks for (`Access-Control-Request-Headers`;
 * invalid names and `*` dropped), the exposed `mcp-session-id` and `www-authenticate`, max age 600.
 * Never `Access-Control-Allow-Credentials`.
 */
export function mcpCorsHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const requested = (headerValue(requestHeaders, 'access-control-request-headers') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && name !== '*' && HEADER_NAME.test(name));
  const allow = [...new Set<string>([...MCP_ALLOW_HEADERS, ...requested])];
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': MCP_ALLOW_METHODS,
    'access-control-allow-headers': allow.join(', '),
    'access-control-expose-headers': MCP_EXPOSE_HEADERS.join(', '),
    'access-control-max-age': String(MCP_CORS_MAX_AGE_S),
  };
}

/**
 * The route `config.rateLimit` of an MCP route: `max` requests per 5 minutes per IP. Each route
 * keeps its own count (the plugin gives every route its own store).
 */
export function mcpRateLimit(max: number): RateLimitOptions {
  return {
    max,
    timeWindow: MCP_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => `mcp:${request.ip}`,
  };
}
