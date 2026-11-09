/**
 * Demo MCP settings and OAuth consent (P5-04, P5-14, P5-15, lane L11): the routes of `mcpApi` and `consentApi`
 * (api/endpoints.ts) on the in-memory MockBackend, so the MCP settings page and the consent page work in the
 * demo build without a server.
 *
 * The state sits in a WeakMap keyed by the backend (one per test and per demo session): the settings per
 * workspace, the per-user MCP key (created on the first read and shown once, replaced by a rotate), the OAuth
 * clients, the callback URLs and the consent flows. `mcpDemoState(backend)` hands it to a test.
 */
import type { McpConsentDetails, McpOAuthClient, McpSettings } from '../api/types';
import { HttpError, type MockBackend } from './mock-backend';

/** the flow token the demo consent page is opened with (`/oauth/consent?flow=demo-flow`) */
export const DEMO_CONSENT_FLOW = 'demo-flow';

const DEMO_SCOPES = ['workflow:read', 'workflow:write', 'workflow:execute', 'execution:read'];
const INVALID_FLOW = 'This sign-in request has expired or is not valid. Start again from your MCP client.';
const REFUSED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];

export interface DemoConsentFlow {
  clientName: string;
  scopes: string[];
  /** where the browser goes after Approve; `code=...` is added */
  redirectUri: string;
}

interface StoredKey {
  id: string;
  prefix: string;
  secret: string;
  createdAt: string;
}

export interface McpDemoState {
  /** per workspace id */
  settings: Map<string, McpSettings>;
  /** per user id */
  keys: Map<string, StoredKey>;
  clients: McpOAuthClient[];
  allowedRedirectUris: string[];
  maxRegisteredClients: number;
  flows: Map<string, DemoConsentFlow>;
  /** when set, the approve reply carries this redirect instead of the flow's (tests the client-side check) */
  forcedRedirectUrl: string | null;
  managedByEnv: boolean;
  /** the server's MCP base URL (`MCP_BASE_URL`); null: the page's own origin */
  mcpBaseUrl: string | null;
}

const states = new WeakMap<MockBackend, McpDemoState>();
let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** the state of one backend (created on first use) */
export function mcpDemoState(backend: MockBackend): McpDemoState {
  let state = states.get(backend);
  if (!state) {
    state = {
      settings: new Map(),
      keys: new Map(),
      clients: [],
      allowedRedirectUris: [],
      maxRegisteredClients: 5000,
      flows: new Map([
        [
          DEMO_CONSENT_FLOW,
          {
            clientName: 'Claude Desktop',
            scopes: [...DEMO_SCOPES],
            redirectUri: 'http://127.0.0.1:33418/callback',
          },
        ],
      ]),
      forcedRedirectUrl: null,
      managedByEnv: false,
      mcpBaseUrl: null,
    };
    states.set(backend, state);
  }
  return state;
}

/** the tenant MCP server's URL, as the server's `mcpServerUrl` */
function serverUrlOf(state: McpDemoState, slug: string): string {
  return `${state.mcpBaseUrl ?? globalThis.location?.origin ?? ''}/mcp-server/${encodeURIComponent(slug)}/http`;
}

function settingsOf(state: McpDemoState, tenant: { id: string; slug: string }): McpSettings {
  let settings = state.settings.get(tenant.id);
  if (!settings) {
    settings = { mcpAccessEnabled: false, managedByEnv: state.managedByEnv, autoExposeNewWorkflows: false };
    state.settings.set(tenant.id, settings);
  }
  settings.managedByEnv = state.managedByEnv;
  settings.serverUrl = serverUrlOf(state, tenant.slug);
  return settings;
}

function keyDto(key: StoredKey, revealed: boolean) {
  return {
    id: key.id,
    name: 'MCP server key',
    prefix: key.prefix,
    key: revealed ? `wfk_${key.prefix}_${key.secret}` : `wfk_${key.prefix}_...`,
    revealed,
    createdAt: key.createdAt,
  };
}

function newKey(): StoredKey {
  return {
    id: nextId('mcpkey'),
    prefix: randomSecret().slice(0, 8),
    secret: randomSecret(),
    createdAt: new Date().toISOString(),
  };
}

/** a short version of the server's redirect URI rule (clients.ts `redirectUriProblem`) */
function redirectProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) return 'A redirect URI must be a non-empty string';
  const lower = uri.trim().toLowerCase();
  if (REFUSED_SCHEMES.some((scheme) => lower.startsWith(scheme)))
    return 'This redirect URI scheme is not allowed';
  if (uri.includes('#')) return 'A redirect URI must not have a fragment';
  try {
    new URL(uri);
  } catch {
    return 'A redirect URI must be an absolute URL';
  }
  return null;
}

/** The MCP settings routes (`mcpApi`) and the consent routes (`consentApi`). */
export function registerMcpRoutes(backend: MockBackend): void {
  const state = () => mcpDemoState(backend);

  backend.on('GET', '/mcp/settings', () => {
    const { tenant } = backend.auth();
    return { ...settingsOf(state(), tenant) };
  });

  backend.on('PATCH', '/mcp/settings', ({ body }) => {
    const { tenant } = backend.requireScope('mcp:manage');
    const settings = settingsOf(state(), tenant);
    if (settings.managedByEnv) {
      throw new HttpError(409, 'conflict', 'MCP access is set by the server environment');
    }
    if (typeof body.mcpAccessEnabled === 'boolean') settings.mcpAccessEnabled = body.mcpAccessEnabled;
    if (typeof body.autoExposeNewWorkflows === 'boolean')
      settings.autoExposeNewWorkflows = body.autoExposeNewWorkflows;
    return { ...settings };
  });

  backend.on('GET', '/mcp/api-key', () => {
    const { user } = backend.auth();
    const keys = state().keys;
    const existing = keys.get(user.id);
    if (existing) return keyDto(existing, false);
    const created = newKey();
    keys.set(user.id, created);
    return keyDto(created, true);
  });

  backend.on('POST', '/mcp/api-key/rotate', () => {
    const { user } = backend.auth();
    const created = newKey();
    state().keys.set(user.id, created);
    return keyDto(created, true);
  });

  backend.on('GET', '/mcp/workflows', ({ query }) => {
    const { tenant } = backend.requireScopeAnywhere('workflow:update');
    const search = (query.search ?? '').toLowerCase();
    return backend.workflows
      .filter((w) => w.tenantId === tenant.id && !w.isArchived)
      .filter((w) => !search || w.name.toLowerCase().includes(search))
      .filter((w) => !query.folderId || w.folderId === query.folderId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((w) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        availableInMCP: w.settings?.availableInMCP === true,
        folderId: w.folderId,
        updatedAt: w.updatedAt,
      }));
  });

  backend.on('PATCH', '/mcp/workflows/toggle-access', ({ body }) => {
    const { tenant } = backend.requireScope('mcp:manage');
    const value = body.availableInMCP === true;
    const ids = Array.isArray(body.workflowIds) ? (body.workflowIds as string[]) : undefined;
    if (ids && ids.length > 100)
      throw new HttpError(400, 'bad_request', 'Pick at most 100 workflows at a time');
    if (!ids && !body.folderId && body.allWorkflows !== true) {
      throw new HttpError(400, 'bad_request', 'Name the workflows, a folder or all workflows');
    }
    let updatedCount = 0;
    for (const w of backend.workflows) {
      if (w.tenantId !== tenant.id || w.isArchived) continue;
      const picked = ids ? ids.includes(w.id) : body.folderId ? w.folderId === body.folderId : true;
      if (!picked || (w.settings?.availableInMCP === true) === value) continue;
      w.settings = { ...w.settings, availableInMCP: value };
      updatedCount += 1;
    }
    return { updatedCount };
  });

  backend.on('GET', '/mcp/oauth/allowed-redirect-uris', () => {
    backend.requireScope('mcp:manage');
    return { allowedRedirectUris: [...state().allowedRedirectUris] };
  });

  backend.on('PATCH', '/mcp/oauth/allowed-redirect-uris', ({ body }) => {
    backend.requireScope('mcp:manage');
    const uris = Array.isArray(body.allowedRedirectUris) ? (body.allowedRedirectUris as unknown[]) : null;
    if (!uris) throw new HttpError(400, 'bad_request', 'allowedRedirectUris must be a list');
    for (const uri of uris) {
      const problem = redirectProblem(uri);
      if (problem) throw new HttpError(400, 'bad_request', problem);
    }
    state().allowedRedirectUris = [...new Set(uris as string[])];
    return { allowedRedirectUris: [...state().allowedRedirectUris] };
  });

  backend.on('GET', '/mcp/oauth-clients', () => {
    backend.requireScope('mcp:manage');
    return state().clients.map((c) => ({ ...c, redirectUris: [...c.redirectUris] }));
  });

  backend.on('DELETE', '/mcp/oauth-clients/:id', ({ params }) => {
    backend.requireScope('mcp:manage');
    const s = state();
    if (!s.clients.some((c) => c.id === params[0])) throw new HttpError(404, 'not_found', 'Client not found');
    s.clients = s.clients.filter((c) => c.id !== params[0]);
    return { ok: true };
  });

  backend.on('GET', '/mcp/instance-stats', () => {
    backend.requireScope('mcp:manage');
    const s = state();
    return { registeredClients: s.clients.length, maxRegisteredClients: s.maxRegisteredClients };
  });

  backend.on('GET', '/consent/details', ({ query }) => {
    const { tenant } = backend.auth();
    const flow = state().flows.get(query.flow ?? '');
    if (!flow) throw new HttpError(400, 'bad_request', INVALID_FLOW);
    const details: McpConsentDetails = {
      clientName: flow.clientName,
      tenantName: tenant.name,
      resource: serverUrlOf(state(), tenant.slug),
      scopes: [...flow.scopes],
      redirectHost: new URL(flow.redirectUri).host,
    };
    return details;
  });

  backend.on('POST', '/consent/approve', ({ body }) => {
    backend.auth();
    const s = state();
    const flowToken = typeof body.flow === 'string' ? body.flow : '';
    const flow = s.flows.get(flowToken);
    if (!flow) throw new HttpError(400, 'bad_request', INVALID_FLOW);
    const target = new URL(flow.redirectUri);
    if (body.approved !== true) {
      target.searchParams.set('error', 'access_denied');
      s.flows.delete(flowToken);
      return { redirectUrl: s.forcedRedirectUrl ?? target.toString() };
    }
    const picked = Array.isArray(body.scopes)
      ? flow.scopes.filter((scope) => (body.scopes as unknown[]).includes(scope))
      : flow.scopes;
    if (picked.length === 0) throw new HttpError(400, 'bad_request', 'Pick at least one permission to grant');
    target.searchParams.set('code', `demo-code-${nextId('c')}`);
    target.searchParams.set('scope', picked.join(' '));
    s.flows.delete(flowToken);
    return { redirectUrl: s.forcedRedirectUrl ?? target.toString() };
  });
}
