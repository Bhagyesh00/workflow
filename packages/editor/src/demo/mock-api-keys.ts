/**
 * P6-21 (L5): the demo's API key routes. A key belongs to its creator (`userId`) and carries an optional expiry
 * (unix seconds, in the future). Create takes `expiresAt`; PATCH changes the name and scopes; rotate gives the
 * same row a new secret (refused for an expired key); `GET /api-keys/scopes` answers what the caller's role may
 * give; `?scope=all` lists every key for `apiKey:manage`; delete is the owner's own, or another member's for
 * `apiKey:manage` (404 when not allowed). An old row without an expiry keeps the answer shape of before.
 */
import { PROJECT_ROLE_SCOPES } from '@workflow/workflow';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { HttpError, now } from './mock-http';

type Row = MockBackend['apiKeys'][number];

const LABEL_TAKEN = 'There is already an API key with this label';

/** the scopes a role may give a key: its global scopes and a personal project owner's */
function givable(backend: MockBackend, role: string, tenantId: string): Set<string> {
  const held = new Set<string>(backend.globalScopesOf(role, tenantId));
  for (const scope of PROJECT_ROLE_SCOPES['project:personalOwner']) held.add(scope);
  return held;
}

function assertLabel(label: unknown): string {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > 50 || /[<>]/.test(value)) throw new HttpError(400, 'bad_request', 'Invalid label');
  return value;
}

function assertScopes(backend: MockBackend, role: string, tenantId: string, scopes: unknown): string[] {
  const list = Array.isArray(scopes) ? [...new Set(scopes.map(String))] : [];
  // an owner holds every scope the public API checks
  if (role !== 'owner') {
    const allowed = givable(backend, role, tenantId);
    if (list.some((scope) => !allowed.has(scope))) {
      throw new HttpError(400, 'bad_request', 'Invalid scopes for user role');
    }
  }
  return list;
}

function assertExpiry(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value * 1000 <= Date.now()) {
    throw new HttpError(400, 'bad_request', 'Expiration date must be in the future or null');
  }
  return Math.floor(value);
}

const expiryOf = (key: Row): number | null => (typeof key.expiresAt === 'number' ? key.expiresAt : null);

function assertLabelFree(backend: MockBackend, tenantId: string, userId: string, label: string, exceptId?: string) {
  const taken = backend.apiKeys.some(
    (k) => k.tenantId === tenantId && k.userId === userId && k.id !== exceptId && k.name === label,
  );
  if (taken) throw new HttpError(400, 'bad_request', LABEL_TAKEN);
}

export function registerApiKeyRoutes(backend: MockBackend): void {
  const dto = (key: Row, withOwner: boolean) => {
    const owner = withOwner ? backend.users.find((u) => u.id === key.userId) : undefined;
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      scopes: key.scopes,
      ...(expiryOf(key) !== null ? { expiresAt: expiryOf(key) } : {}),
      ...(withOwner
        ? { ownerId: String(key.userId ?? ''), ownerName: owner?.name || owner?.email || 'Unknown' }
        : {}),
    };
  };
  const own = (key: Row, tenantId: string, userId: string) => key.tenantId === tenantId && key.userId === userId;

  backend.on('GET', '/api-keys', ({ query }) => {
    if (query.scope === 'all') {
      const { tenant } = backend.requireScope('apiKey:manage');
      return backend.apiKeys
        .filter((k) => k.tenantId === tenant.id)
        .filter((k) => !query.ownerId || k.userId === query.ownerId)
        .filter((k) => !query.label || k.name.toLowerCase().includes(String(query.label).toLowerCase()))
        .map((k) => dto(k, true));
    }
    const { tenant, user } = backend.auth();
    return backend.apiKeys.filter((k) => own(k, tenant.id, user.id)).map((k) => dto(k, false));
  });

  backend.on('GET', '/api-keys/scopes', () => {
    const { tenant, role } = backend.auth();
    return [...givable(backend, role, tenant.id)];
  });

  backend.on('POST', '/api-keys', ({ body }) => {
    const { tenant, user, role } = backend.requireScope('apiKey:create');
    const name = assertLabel(body.name);
    const scopes = assertScopes(backend, role, tenant.id, body.scopes);
    const expiresAt = assertExpiry(body.expiresAt);
    assertLabelFree(backend, tenant.id, user.id, name);
    const prefix = newId().slice(0, 8);
    const key: Row = {
      id: newId(),
      name,
      prefix,
      createdAt: now(),
      lastUsedAt: null,
      // empty means every scope
      scopes,
      tenantId: tenant.id,
      userId: user.id,
      ...(expiresAt !== null ? { expiresAt } : {}),
    };
    backend.apiKeys.push(key);
    return {
      id: key.id,
      name: key.name,
      key: `wfk_${prefix}_${newId().replace(/-/g, '')}`,
      scopes: key.scopes,
      ...(expiresAt !== null ? { expiresAt } : {}),
    };
  });

  backend.on('PATCH', '/api-keys/:id', ({ params, body }) => {
    const { tenant, user, role } = backend.auth();
    const key = backend.apiKeys.find((k) => k.id === params[0] && own(k, tenant.id, user.id));
    if (!key) throw new HttpError(404, 'not_found', 'API key not found');
    if (body.name === undefined && body.scopes === undefined) {
      throw new HttpError(400, 'bad_request', 'Nothing to change');
    }
    const name = body.name === undefined ? key.name : assertLabel(body.name);
    const scopes = body.scopes === undefined ? key.scopes : assertScopes(backend, role, tenant.id, body.scopes);
    if (name !== key.name) assertLabelFree(backend, tenant.id, user.id, name, key.id);
    key.name = name;
    key.scopes = scopes;
    return dto(key, false);
  });

  backend.on('POST', '/api-keys/:id/rotate', ({ params }) => {
    const { tenant, user } = backend.auth();
    const key = backend.apiKeys.find((k) => k.id === params[0] && own(k, tenant.id, user.id));
    if (!key) throw new HttpError(404, 'not_found', 'API key not found');
    const expiresAt = expiryOf(key);
    if (expiresAt !== null && expiresAt * 1000 <= Date.now()) {
      throw new HttpError(400, 'bad_request', 'Cannot rotate an expired API key');
    }
    key.prefix = newId().slice(0, 8);
    return {
      id: key.id,
      name: key.name,
      key: `wfk_${key.prefix}_${newId().replace(/-/g, '')}`,
      scopes: key.scopes,
      ...(expiresAt !== null ? { expiresAt } : {}),
    };
  });

  backend.on('DELETE', '/api-keys/:id', ({ params }) => {
    const { tenant, user, role } = backend.auth();
    const key = backend.apiKeys.find((k) => k.id === params[0] && k.tenantId === tenant.id);
    const mine = key && key.userId === user.id;
    if (!key || (!mine && !backend.globalScopesOf(role, tenant.id).includes('apiKey:manage'))) {
      throw new HttpError(404, 'not_found', 'API key not found');
    }
    backend.apiKeys = backend.apiKeys.filter((k) => k.id !== key.id);
    return { ok: true };
  });
}
