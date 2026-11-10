/**
 * /rest/api-keys (moved from routes/resources.ts in S2's C0; P6-21, L5): the caller's own keys; they act with
 * the creator's current role. Create takes an expiry, a key can be edited (name, scopes) and rotated, the
 * scope list answers what the caller's role may give, `?scope=all` lists every key for `apiKey:manage`, and
 * an admin may delete another member's key (the owner is mailed).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { API_KEY_SCOPES } from '../http/api-key-scopes';
import { requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';
import type { ApiKeyListRow, ApiKeyWithOwnerRow } from '../repositories';
import { API_KEY_LABEL_MAX } from '../services/api-keys';

/** n8n's label: 1 to 50 characters, no markup */
const label = z
  .string()
  .trim()
  .min(1)
  .max(API_KEY_LABEL_MAX)
  .refine((value) => !/[<>]/.test(value), 'The label can not contain < or >');
const scopeList = z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length);

const unixSeconds = (date: Date | null): number | null => (date ? Math.floor(date.getTime() / 1000) : null);

/** a key as the editor's `ApiKey`: `expiresAt` in unix seconds, never the hash */
function keyDto(row: ApiKeyListRow | ApiKeyWithOwnerRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: unixSeconds(row.expiresAt),
    ...('ownerName' in row ? { ownerId: row.userId, ownerName: row.ownerName || row.ownerEmail } : {}),
  };
}

/** the expiry of a new key: unix seconds in the future, or none */
function expiryOf(seconds: number | null | undefined): Date | null {
  if (seconds === null || seconds === undefined) return null;
  const at = new Date(seconds * 1000);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
    throw ApiError.badRequest('Expiration date must be in the future or null');
  }
  return at;
}

export function registerApiKeyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, auth: authService, apiKeys } = ctx;

  app.get('/api-keys', async (request) => {
    const query = parse(
      z.object({
        scope: z.enum(['all']).optional(),
        ownerId: z.string().max(64).optional(),
        label: z.string().max(100).optional(),
      }),
      request.query ?? {},
    );
    if (query.scope === 'all') {
      const auth = await requireScope(request, 'apiKey:manage');
      const rows = await apiKeys.listAll(auth, {
        userId: query.ownerId,
        name: query.label,
      });
      return { data: rows.map(keyDto), nextCursor: null };
    }
    const auth = requireAuth(request);
    const rows = await repos.apiKeys.list(auth.tenant.id, auth.user.id);
    return { data: rows.map(keyDto), nextCursor: null };
  });

  // P6-21: the scopes the caller's role may give a key (`apiKeyScopesForRole`); session only, as n8n
  app.get('/api-keys/scopes', async (request) => {
    const auth = requireAuth(request);
    return { data: await apiKeys.scopesFor(auth) };
  });

  app.post('/api-keys', async (request) => {
    const auth = await requireScope(request, 'apiKey:create');
    const { name, scopes, expiresAt } = parse(
      z.object({
        name: label,
        scopes: scopeList.optional(),
        expiresAt: z.number().int().nullable().optional(),
      }),
      request.body,
    );
    const given = [...new Set(scopes ?? [])];
    const expires = expiryOf(expiresAt);
    await apiKeys.assertScopesAllowed(auth, given);
    await apiKeys.assertLabelFree(auth.tenant.id, auth.user.id, name);
    const key = await authService.createApiKey(auth.tenant.id, auth.user.id, name, given, undefined, expires);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'apikey.created',
      resourceType: 'api_key',
      resourceId: key.id,
      ip: request.ip,
    });
    return {
      data: {
        id: key.id,
        name: key.name,
        key: key.key,
        prefix: key.prefix,
        scopes: key.scopes,
        createdAt: key.createdAt,
        expiresAt: unixSeconds(expires),
      },
    };
  });

  // P6-21: the owner's own key: name and scopes; session only (the key's owner), as n8n
  app.patch('/api-keys/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(idParams, request.params);
    const body = parse(
      z
        .object({ name: label.optional(), scopes: scopeList.optional() })
        .refine((value) => value.name !== undefined || value.scopes !== undefined, 'Nothing to change'),
      request.body,
    );
    return { data: keyDto(await apiKeys.update(auth, id, body)) };
  });

  // P6-21: a new secret on the same row, shown once; the owner's own key, session only
  app.post('/api-keys/:id/rotate', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(idParams, request.params);
    const rotated = await apiKeys.rotate(auth, id);
    return {
      data: {
        id: rotated.id,
        name: rotated.name,
        key: rotated.key,
        prefix: rotated.prefix,
        scopes: rotated.scopes,
        createdAt: rotated.createdAt,
        expiresAt: rotated.expiresAt ? Math.floor(Date.parse(rotated.expiresAt) / 1000) : null,
      },
    };
  });

  // the owner's own key; another member's key only for `apiKey:manage` (404, not 403, when not allowed)
  app.delete('/api-keys/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(idParams, request.params);
    if (await repos.apiKeys.delete(auth.tenant.id, auth.user.id, id)) {
      await repos.audit.add(auth.tenant.id, {
        userId: auth.user.id,
        action: 'apikey.deleted',
        resourceType: 'api_key',
        resourceId: id,
        ip: request.ip,
      });
    } else {
      await apiKeys.revokeByAdmin(auth, id);
    }
    return { data: { ok: true } };
  });
}
