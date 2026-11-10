/**
 * /rest/api-keys (moved from routes/resources.ts in S2's C0, unchanged; P6-21, L5 owns it afterwards). The
 * caller's own keys; they act with the creator's current role. Edit, rotate and the scope list are stubs
 * until L5.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { API_KEY_SCOPES } from '../http/api-key-scopes';
import { requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';

export function registerApiKeyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, auth: authService } = ctx;

  app.get('/api-keys', async (request) => {
    const auth = requireAuth(request);
    const rows = await repos.apiKeys.list(auth.tenant.id, auth.user.id);
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  // P6-21: the scopes the caller's role may give a key (`apiKeyScopesForRole`); session only, as n8n
  app.get('/api-keys/scopes', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L5)');
  });

  app.post('/api-keys', async (request) => {
    const auth = await requireScope(request, 'apiKey:create');
    const { name, scopes } = parse(
      z.object({
        name: z.string().trim().min(1).max(64),
        scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).optional(),
      }),
      request.body,
    );
    const key = await authService.createApiKey(auth.tenant.id, auth.user.id, name, [
      ...new Set(scopes ?? []),
    ]);
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
      },
    };
  });

  // P6-21: the owner's own key: name and scopes; session only (the key's owner), as n8n
  app.patch('/api-keys/:id', async (request) => {
    requireAuth(request);
    parse(idParams, request.params);
    throw new Error('not implemented (L5)');
  });

  // P6-21: a new secret on the same row, shown once; the owner's own key, session only
  app.post('/api-keys/:id/rotate', async (request) => {
    requireAuth(request);
    parse(idParams, request.params);
    throw new Error('not implemented (L5)');
  });

  app.delete('/api-keys/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(idParams, request.params);
    if (!(await repos.apiKeys.delete(auth.tenant.id, auth.user.id, id))) throw ApiError.notFound('API key');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'apikey.deleted',
      resourceType: 'api_key',
      resourceId: id,
      ip: request.ip,
    });
    return { data: { ok: true } };
  });
}
