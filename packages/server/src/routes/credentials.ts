/** /rest/credentials/* and /rest/oauth2/* */
import { randomBytes } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { CredentialRow } from '../db/schema';
import { requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import {
  credentialCreateSchema,
  credentialTestSchema,
  credentialUpdateSchema,
  idParams,
} from '../http/schemas';
import { testCredential } from '../services/credential-test';
import { oauthCallbackPage } from '../services/oauth2';

export function credentialSummary(
  row: Pick<CredentialRow, 'id' | 'name' | 'type' | 'createdAt' | 'updatedAt'>,
) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCredential(
  ctx: ServerContext,
  tenantId: string,
  body: z.output<typeof credentialCreateSchema>,
  userId: string,
  ip: string,
) {
  const row = await ctx.credentials.create(tenantId, { ...body, data: body.data as DataObject }, userId);
  await ctx.repos.audit.add(tenantId, {
    userId,
    action: 'credential.created',
    resourceType: 'credential',
    resourceId: row.id,
    metadata: { type: row.type },
    ip,
  });
  return { id: row.id, name: row.name, type: row.type };
}

export async function deleteCredential(
  ctx: ServerContext,
  tenantId: string,
  id: string,
  userId: string,
  ip: string,
) {
  if (!(await ctx.repos.credentials.delete(tenantId, id))) throw ApiError.notFound('Credential');
  await ctx.repos.audit.add(tenantId, {
    userId,
    action: 'credential.deleted',
    resourceType: 'credential',
    resourceId: id,
    ip,
  });
}

export function registerCredentialRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, credentials, config } = ctx;

  // viewers may list names/types (the editor shows which credential a node uses), never data
  app.get('/credentials', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { type } = parse(z.object({ type: z.string().max(128).optional() }), request.query);
    const rows = await repos.credentials.list(auth.tenant.id, type);
    return { data: rows.map(credentialSummary), nextCursor: null };
  });

  app.post('/credentials', async (request) => {
    const auth = requireRole(request, 'editor');
    const body = parse(credentialCreateSchema, request.body);
    return { data: await createCredential(ctx, auth.tenant.id, body, auth.user.id, request.ip) };
  });

  app.get('/credentials/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const row = await repos.credentials.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Credential');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'credential.read',
      resourceType: 'credential',
      resourceId: id,
      ip: request.ip,
    });
    return { data: { ...credentialSummary(row), data: credentials.redacted(row) } };
  });

  app.patch('/credentials/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(credentialUpdateSchema, request.body);
    const row = await credentials.update(auth.tenant.id, id, {
      name: body.name,
      data: body.data as DataObject,
    });
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'credential.updated',
      resourceType: 'credential',
      resourceId: id,
      ip: request.ip,
    });
    return { data: { id: row.id, name: row.name, type: row.type } };
  });

  app.delete('/credentials/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    await deleteCredential(ctx, auth.tenant.id, id, auth.user.id, request.ip);
    return { data: { ok: true } };
  });

  app.post('/credentials/test', async (request) => {
    const auth = requireRole(request, 'editor');
    const body = parse(credentialTestSchema, request.body);
    let data = body.data as DataObject;
    if (body.id) {
      const row = await repos.credentials.get(auth.tenant.id, body.id);
      if (!row) throw ApiError.notFound('Credential');
      if (row.type !== body.type) throw ApiError.badRequest('The credential type does not match');
      data = credentials.merge(credentials.decrypt(row), data);
    }
    credentials.resolvedType(body.type);
    return { data: await testCredential(credentials, ctx.http, body.type, data) };
  });

  app.get('/oauth2/authorize', async (request) => {
    const auth = requireRole(request, 'editor');
    const { credentialId } = parse(z.object({ credentialId: z.uuid() }), request.query);
    return { data: { url: await ctx.oauth2.authorizeUrl(auth.tenant.id, auth.user.id, credentialId) } };
  });

  // the provider redirects the popup here; the signed state (not the session) identifies the tenant
  app.get('/oauth2/callback', { logLevel: 'warn' }, async (request, reply) => {
    const query = parse(
      z.object({
        code: z.string().max(4096).optional(),
        state: z.string().max(8192).optional(),
        error: z.string().max(256).optional(),
        error_description: z.string().max(1024).optional(),
      }),
      request.query,
    );
    const nonce = randomBytes(16).toString('base64');
    const origin = new URL(config.baseUrl).origin;
    let body: string;
    let status = 200;
    try {
      if (query.error) throw ApiError.badRequest(query.error_description ?? query.error);
      if (!query.code || !query.state) throw ApiError.badRequest('The authorization response is incomplete');
      const result = await ctx.oauth2.callback(query.code, query.state);
      body = oauthCallbackPage(origin, nonce, { status: 'success', credentialId: result.credentialId });
    } catch (error) {
      status = 400;
      body = oauthCallbackPage(origin, nonce, {
        status: 'error',
        message: (error as Error).message.slice(0, 300),
      });
    }
    return (
      reply
        .status(status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`)
        .header('cache-control', 'no-store')
        // the page came back from the provider's origin: keep its opener so it can post the result
        .header('cross-origin-opener-policy', 'unsafe-none')
        .send(body)
    );
  });
}
