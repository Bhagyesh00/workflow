/**
 * Demo MCP settings and OAuth consent (P5-04, P5-14, P5-15, lane L11): the routes of `mcpApi` and `consentApi`
 * (api/endpoints.ts) on the in-memory MockBackend, so the MCP settings page and the consent page work in the
 * demo build without a server.
 *
 * C0 stub: every route is registered with its final method and path and answers `not implemented (L11)`. L11
 * fills them (settings by role, the per-user key shown once and rotated, workflows with `availableInMCP`, the
 * redirect URIs, the OAuth clients with revoke, the instance stats and the consent details and decision).
 */
import type { MockBackend } from './mock-backend';

function notImplemented(): never {
  throw new Error('not implemented (L11)');
}

/** The MCP settings routes (`mcpApi`) and the consent routes (`consentApi`). */
export function registerMcpRoutes(backend: MockBackend): void {
  backend.on('GET', '/mcp/settings', notImplemented);
  backend.on('PATCH', '/mcp/settings', notImplemented);
  backend.on('GET', '/mcp/api-key', notImplemented);
  backend.on('POST', '/mcp/api-key/rotate', notImplemented);
  backend.on('GET', '/mcp/workflows', notImplemented);
  backend.on('PATCH', '/mcp/workflows/toggle-access', notImplemented);
  backend.on('GET', '/mcp/oauth/allowed-redirect-uris', notImplemented);
  backend.on('PATCH', '/mcp/oauth/allowed-redirect-uris', notImplemented);
  backend.on('GET', '/mcp/oauth-clients', notImplemented);
  backend.on('DELETE', '/mcp/oauth-clients/:id', notImplemented);
  backend.on('GET', '/mcp/instance-stats', notImplemented);
  backend.on('GET', '/consent/details', notImplemented);
  backend.on('POST', '/consent/approve', notImplemented);
}
