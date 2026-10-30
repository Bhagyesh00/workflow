/** /rest/tags, /rest/variables, /rest/members, /rest/invitations, /rest/api-keys, /rest/audit-log */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { TagRow, VariableRow } from '../db/schema';
import { requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { page, paginationQuery } from '../http/pagination';
import { idParams, roleSchema, tagSchema, variableCreateSchema, variableUpdateSchema } from '../http/schemas';
import { isUniqueViolation } from '../repositories';
import { hasRole } from '../services/auth';

export const tagDTO = (
  t: Pick<TagRow, 'id' | 'name' | 'createdAt' | 'updatedAt'> & { usageCount?: number },
) => ({
  id: t.id,
  name: t.name,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
  ...(t.usageCount !== undefined ? { usageCount: t.usageCount } : {}),
});

export const variableDTO = (v: VariableRow) => ({
  id: v.id,
  key: v.key,
  value: v.value,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export async function createTag(ctx: ServerContext, tenantId: string, name: string) {
  if (await ctx.repos.tags.getByName(tenantId, name))
    throw ApiError.conflict(`A tag named "${name}" already exists`);
  try {
    return tagDTO(await ctx.repos.tags.create(tenantId, name));
  } catch (error) {
    if (isUniqueViolation(error)) throw ApiError.conflict(`A tag named "${name}" already exists`);
    throw error;
  }
}

export async function renameTag(ctx: ServerContext, tenantId: string, id: string, name: string) {
  try {
    const row = await ctx.repos.tags.rename(tenantId, id, name);
    if (!row) throw ApiError.notFound('Tag');
    return tagDTO(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw ApiError.conflict(`A tag named "${name}" already exists`);
    throw error;
  }
}

export async function createVariable(ctx: ServerContext, tenantId: string, key: string, value: string) {
  try {
    return variableDTO(await ctx.repos.variables.create(tenantId, key, value));
  } catch (error) {
    if (isUniqueViolation(error)) throw ApiError.conflict(`A variable "${key}" already exists`);
    throw error;
  }
}

export async function updateVariable(
  ctx: ServerContext,
  tenantId: string,
  id: string,
  patch: { key?: string; value?: string },
) {
  try {
    const row = await ctx.repos.variables.update(tenantId, id, patch);
    if (!row) throw ApiError.notFound('Variable');
    return variableDTO(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw ApiError.conflict(`A variable "${patch.key}" already exists`);
    throw error;
  }
}

export function registerResourceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, auth: authService, config } = ctx;

  // tags --------------------------------------------------------------------------------------
  app.get('/tags', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: (await repos.tags.list(auth.tenant.id)).map(tagDTO), nextCursor: null };
  });
  app.get('/tags/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    const row = await repos.tags.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Tag');
    return { data: tagDTO(row) };
  });
  app.post('/tags', async (request) => {
    const auth = requireRole(request, 'editor');
    const { name } = parse(tagSchema, request.body);
    return { data: await createTag(ctx, auth.tenant.id, name) };
  });
  app.patch('/tags/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const { name } = parse(tagSchema, request.body);
    return { data: await renameTag(ctx, auth.tenant.id, id, name) };
  });
  app.delete('/tags/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    if (!(await repos.tags.delete(auth.tenant.id, id))) throw ApiError.notFound('Tag');
    return { data: { ok: true } };
  });

  // variables ---------------------------------------------------------------------------------
  app.get('/variables', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: (await repos.variables.list(auth.tenant.id)).map(variableDTO), nextCursor: null };
  });
  app.get('/variables/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    const row = await repos.variables.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Variable');
    return { data: variableDTO(row) };
  });
  app.post('/variables', async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(variableCreateSchema, request.body);
    return { data: await createVariable(ctx, auth.tenant.id, body.key, body.value) };
  });
  app.patch('/variables/:id', async (request) => {
    const auth = requireRole(request, 'admin');
    const { id } = parse(idParams, request.params);
    return { data: await updateVariable(ctx, auth.tenant.id, id, parse(variableUpdateSchema, request.body)) };
  });
  app.delete('/variables/:id', async (request) => {
    const auth = requireRole(request, 'admin');
    const { id } = parse(idParams, request.params);
    if (!(await repos.variables.delete(auth.tenant.id, id))) throw ApiError.notFound('Variable');
    return { data: { ok: true } };
  });

  // members & invitations ---------------------------------------------------------------------
  app.get('/members', async (request) => {
    const auth = requireRole(request, 'viewer');
    const members = await repos.memberships.listForTenant(auth.tenant.id);
    return {
      data: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  app.post('/members/invite', async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(z.object({ email: z.email().max(254), role: roleSchema }), request.body);
    const { invitation, token } = await authService.invite(
      auth.tenant.id,
      { id: auth.user.id, role: auth.role },
      body.email,
      body.role,
    );
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      ip: request.ip,
    });
    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
        // shown once: deliver it to the invitee (no mail transport is configured)
        token,
        // the editor's accept page (`/invitation/:token`)
        inviteUrl: `${config.baseUrl}/invitation/${token}`,
      },
    };
  });

  app.patch('/members/:userId', async (request) => {
    const auth = requireRole(request, 'admin');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    const { role } = parse(z.object({ role: roleSchema }), request.body);
    const target = await repos.memberships.get(auth.tenant.id, userId);
    if (!target) throw ApiError.notFound('Member');
    if ((target.role === 'owner' || role === 'owner') && !hasRole(auth.role, 'owner')) {
      throw ApiError.forbidden('Only owners can grant or revoke the owner role');
    }
    if (
      target.role === 'owner' &&
      role !== 'owner' &&
      (await repos.memberships.countOwners(auth.tenant.id)) <= 1
    ) {
      throw ApiError.conflict('A workspace needs at least one owner');
    }
    await repos.memberships.updateRole(auth.tenant.id, userId, role);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'member.role_changed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { from: target.role, to: role },
      ip: request.ip,
    });
    return { data: { userId, role } };
  });

  app.delete('/members/:userId', async (request) => {
    const auth = requireRole(request, 'admin');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    const target = await repos.memberships.get(auth.tenant.id, userId);
    if (!target) throw ApiError.notFound('Member');
    if (target.role === 'owner') {
      if (!hasRole(auth.role, 'owner')) throw ApiError.forbidden('Only owners can remove owners');
      if ((await repos.memberships.countOwners(auth.tenant.id)) <= 1) {
        throw ApiError.conflict('A workspace needs at least one owner');
      }
    }
    await repos.memberships.remove(auth.tenant.id, userId);
    await repos.sessions.deleteForUserInTenant(auth.tenant.id, userId);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'member.removed',
      resourceType: 'user',
      resourceId: userId,
      ip: request.ip,
    });
    return { data: { ok: true } };
  });

  app.get('/invitations', async (request) => {
    const auth = requireRole(request, 'admin');
    const rows = await repos.invitations.listPending(auth.tenant.id);
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  app.delete('/invitations/:id', async (request) => {
    const auth = requireRole(request, 'admin');
    const { id } = parse(idParams, request.params);
    if (!(await repos.invitations.delete(auth.tenant.id, id))) throw ApiError.notFound('Invitation');
    return { data: { ok: true } };
  });

  // API keys (own keys; they act with the creator's current role) ----------------------------
  app.get('/api-keys', async (request) => {
    const auth = requireRole(request, 'viewer');
    const rows = await repos.apiKeys.list(auth.tenant.id, auth.user.id);
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  app.post('/api-keys', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(64) }), request.body);
    const key = await authService.createApiKey(auth.tenant.id, auth.user.id, name);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'apikey.created',
      resourceType: 'api_key',
      resourceId: key.id,
      ip: request.ip,
    });
    return {
      data: { id: key.id, name: key.name, key: key.key, prefix: key.prefix, createdAt: key.createdAt },
    };
  });

  app.delete('/api-keys/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
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

  // audit log ---------------------------------------------------------------------------------
  app.get('/audit-log', async (request) => {
    const auth = requireRole(request, 'admin');
    const query = parse(z.object(paginationQuery), request.query);
    const rawCursor = query.cursor ? Buffer.from(query.cursor, 'base64url').toString() : undefined;
    if (rawCursor !== undefined && !/^\d{1,18}$/.test(rawCursor)) throw ApiError.badRequest('Invalid cursor');
    const cursor = rawCursor ? { value: '', id: rawCursor } : undefined;
    const rows = await repos.audit.list(auth.tenant.id, query.limit, cursor);
    const { data, nextCursor } = page(rows, query.limit, (r) =>
      Buffer.from(String(r.id)).toString('base64url'),
    );
    return {
      data: data.map((r) => ({
        id: r.id,
        userId: r.userId,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });
}
