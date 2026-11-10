/**
 * P6-21 (C0): the demo's API key routes, moved unchanged out of mock-backend.ts `registerRoutes`: list, create and
 * delete at today's behaviour (FULL). L5 owns this file after C0 and adds update, rotate, the scopes per role and
 * the owner's list of every key.
 */
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { now } from './mock-http';

export function registerApiKeyRoutes(backend: MockBackend): void {
  backend.on('GET', '/api-keys', () => {
    const { tenant } = backend.auth();
    return backend.apiKeys
      .filter((k) => k.tenantId === tenant.id)
      .map(({ id, name, prefix, createdAt, lastUsedAt, scopes }) => ({
        id,
        name,
        prefix,
        createdAt,
        lastUsedAt,
        scopes,
      }));
  });
  backend.on('POST', '/api-keys', ({ body }) => {
    const { tenant } = backend.auth();
    const prefix = newId().slice(0, 8);
    const key = {
      id: newId(),
      name: String(body.name ?? 'Key'),
      prefix,
      createdAt: now(),
      lastUsedAt: null,
      // empty means every scope
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
      tenantId: tenant.id,
    };
    backend.apiKeys.push(key);
    return {
      id: key.id,
      name: key.name,
      key: `wfk_${prefix}_${newId().replace(/-/g, '')}`,
      scopes: key.scopes,
    };
  });
  backend.on('DELETE', '/api-keys/:id', ({ params }) => {
    backend.apiKeys = backend.apiKeys.filter((k) => k.id !== params[0]);
    return { ok: true };
  });
}
