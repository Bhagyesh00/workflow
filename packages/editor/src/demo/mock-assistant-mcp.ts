/**
 * Demo Assistant MCP connections (P5-72, lane L9): GET, POST, PATCH and DELETE `/assistant/mcp-connections`
 * (`assistantApi.mcpConnections`, `createMcpConnection`, `patchMcpConnection`, `deleteMcpConnection`) on the
 * in-memory MockBackend. A connection holds a credential id, never a secret. The demo refuses what the real
 * server refuses: an address that is not https (or http on a loopback host), a credential of another
 * workspace or the wrong type, a name used twice, a tool setting that loosens.
 */
import type {
  AssistantMcpAuthentication,
  AssistantMcpConnectionDTO,
  AssistantPermissionMode,
} from '../api/types';
import { HttpError, type MockBackend } from './mock-backend';

const CREDENTIAL_TYPES: Record<AssistantMcpAuthentication, string | null> = {
  none: null,
  bearerAuth: 'httpBearerAuth',
  headerAuth: 'httpHeaderAuth',
  multipleHeadersAuth: 'httpMultipleHeadersAuth',
  mcpOAuth2Api: 'mcpOAuth2Api',
};

const states = new WeakMap<MockBackend, Map<string, AssistantMcpConnectionDTO[]>>();

function listOf(backend: MockBackend, tenantId: string): AssistantMcpConnectionDTO[] {
  let byTenant = states.get(backend);
  if (!byTenant) {
    byTenant = new Map();
    states.set(backend, byTenant);
  }
  let list = byTenant.get(tenantId);
  if (!list) {
    list = [];
    byTenant.set(tenantId, list);
  }
  return list;
}

function addressProblem(raw: unknown): string | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return 'The address is not a valid URL';
  }
  if (url.username || url.password) return 'The address must not hold a user name or password';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    const host = url.hostname;
    if (host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)) return null;
    return 'The address must use https (http is only allowed for localhost)';
  }
  return 'The address must start with https://';
}

/** P5-72: registers the demo MCP connection routes (L9). */
export function registerAssistantMcpRoutes(backend: MockBackend): void {
  const nextId = () => `mcp-conn-${Math.random().toString(36).slice(2, 10)}`;

  const checkCredential = (
    tenantId: string,
    authentication: AssistantMcpAuthentication,
    credentialId: string | null,
  ) => {
    const wanted = CREDENTIAL_TYPES[authentication];
    if (!wanted) {
      if (credentialId)
        throw new HttpError(400, 'bad_request', 'Choose a sign-in method to use a credential');
      return;
    }
    if (!credentialId) throw new HttpError(400, 'bad_request', 'Choose a credential for this sign-in method');
    const credential = backend.credentials.find((c) => c.id === credentialId && c.tenantId === tenantId);
    if (!credential)
      throw new HttpError(400, 'bad_request', 'The credential was not found in this workspace');
    if (credential.type !== wanted) {
      throw new HttpError(400, 'bad_request', `This sign-in method needs a ${wanted} credential`);
    }
  };

  const toolPermissionsOf = (value: unknown): Record<string, AssistantPermissionMode> => {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'bad_request', 'toolPermissions must be an object');
    }
    const out: Record<string, AssistantPermissionMode> = {};
    for (const [tool, mode] of Object.entries(value as Record<string, unknown>)) {
      if (mode !== 'blocked' && mode !== 'require_approval') {
        throw new HttpError(400, 'bad_request', 'A tool permission can only tighten the workspace setting');
      }
      out[tool] = mode;
    }
    return out;
  };

  backend.on('GET', '/assistant/mcp-connections', () => {
    const { tenant } = backend.auth();
    return structuredClone(listOf(backend, tenant.id));
  });

  backend.on('POST', '/assistant/mcp-connections', ({ body }) => {
    const { tenant } = backend.requireScope('instanceAi:manage');
    const list = listOf(backend, tenant.id);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 64) throw new HttpError(400, 'bad_request', 'Give the connection a name');
    const problem = addressProblem(body.url);
    if (problem) throw new HttpError(400, 'bad_request', problem);
    if (list.some((c) => c.name === name)) {
      throw new HttpError(409, 'conflict', `A connection named "${name}" already exists`);
    }
    const authentication = (body.authentication as AssistantMcpAuthentication | undefined) ?? 'none';
    if (!(authentication in CREDENTIAL_TYPES))
      throw new HttpError(400, 'bad_request', 'Unknown sign-in method');
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId : null;
    checkCredential(tenant.id, authentication, credentialId);
    const now = new Date().toISOString();
    const row: AssistantMcpConnectionDTO = {
      id: nextId(),
      name,
      url: String(body.url).trim(),
      transport: body.transport === 'sse' ? 'sse' : 'httpStreamable',
      authentication,
      credentialId,
      enabled: body.enabled !== false,
      toolPermissions: toolPermissionsOf(body.toolPermissions),
      createdAt: now,
      updatedAt: now,
    };
    list.push(row);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return structuredClone(row);
  });

  backend.on('PATCH', '/assistant/mcp-connections/:id', ({ params, body }) => {
    const { tenant } = backend.requireScope('instanceAi:manage');
    const list = listOf(backend, tenant.id);
    const row = list.find((c) => c.id === params[0]);
    if (!row) throw new HttpError(404, 'not_found', 'Connection not found');
    const next = structuredClone(row);
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 64) throw new HttpError(400, 'bad_request', 'Give the connection a name');
      if (list.some((c) => c.id !== row.id && c.name === name)) {
        throw new HttpError(409, 'conflict', `A connection named "${name}" already exists`);
      }
      next.name = name;
    }
    if (typeof body.url === 'string') next.url = body.url.trim();
    const problem = addressProblem(next.url);
    if (problem) throw new HttpError(400, 'bad_request', problem);
    if (body.transport === 'sse' || body.transport === 'httpStreamable') next.transport = body.transport;
    if (body.authentication !== undefined) {
      if (!(String(body.authentication) in CREDENTIAL_TYPES)) {
        throw new HttpError(400, 'bad_request', 'Unknown sign-in method');
      }
      next.authentication = body.authentication as AssistantMcpAuthentication;
      if (next.authentication === 'none' && body.credentialId === undefined) next.credentialId = null;
    }
    if (body.credentialId !== undefined) {
      next.credentialId = typeof body.credentialId === 'string' ? body.credentialId : null;
    }
    checkCredential(tenant.id, next.authentication, next.credentialId);
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (body.toolPermissions !== undefined) next.toolPermissions = toolPermissionsOf(body.toolPermissions);
    next.updatedAt = new Date().toISOString();
    Object.assign(row, next);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return structuredClone(row);
  });

  backend.on('DELETE', '/assistant/mcp-connections/:id', ({ params }) => {
    const { tenant } = backend.requireScope('instanceAi:manage');
    const list = listOf(backend, tenant.id);
    const index = list.findIndex((c) => c.id === params[0]);
    if (index < 0) throw new HttpError(404, 'not_found', 'Connection not found');
    list.splice(index, 1);
    return { ok: true };
  });
}
