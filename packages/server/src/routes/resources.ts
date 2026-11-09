/** /rest/tags, /rest/variables, /rest/members, /rest/invitations, /rest/api-keys, /rest/audit-log */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { TagRow, VariableRow } from '../db/schema';
import { API_KEY_SCOPES } from '../http/api-key-scopes';
import { requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { page, paginationQuery } from '../http/pagination';
import { idParams, tagSchema, variableCreateSchema, variableUpdateSchema } from '../http/schemas';
import { isUniqueViolation } from '../repositories';
import { type MemberRemovalChoice, removeMember } from '../services/member-removal';

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

/** a variable on the editor's pages and `/rest/variables`: `projectId` is null for a global one */
export const projectVariableDTO = (v: VariableRow) => ({ ...variableDTO(v), projectId: v.projectId });

/** a workspace role in a member route: a system role or a custom global slug (checked against the roles) */
const memberRoleSchema = z.string().trim().min(1).max(64);

/** POST /variables: with `projectId` a project variable (`projectVariable:create` on it) */
const variableBodySchema = variableCreateSchema.extend({ projectId: z.uuid().nullish() });
/** PATCH /variables/:id: `projectId` moves the variable (a uuid: into that project, null: to global) */
const variablePatchSchema = variableUpdateSchema.extend({ projectId: z.uuid().nullable().optional() });

/**
 * DELETE /members/:userId: what happens to the member's personal work. The editor sends the choice in the
 * body; n8n's `?transferId=` also works. No choice (or both) is a 400.
 */
const removalBodySchema = z
  .object({ transferToProjectId: z.uuid().optional(), deleteData: z.literal(true).optional() })
  .nullish();
const removalQuerySchema = z.object({ transferId: z.uuid().optional() });

function removalChoice(body: unknown, query: unknown): MemberRemovalChoice {
  const fromBody = parse(removalBodySchema, body) ?? {};
  const { transferId } = parse(removalQuerySchema, query ?? {});
  const transferTo = fromBody.transferToProjectId ?? transferId;
  if (transferTo !== undefined && fromBody.deleteData) {
    throw ApiError.badRequest("Choose one: move the member's work to a project or delete it");
  }
  if (transferTo !== undefined) return { transferToProjectId: transferTo };
  if (fromBody.deleteData) return { deleteData: true };
  throw ApiError.badRequest(
    "Say what happens to the member's work: send transferToProjectId to move it to a project, or deleteData: true to delete it",
  );
}

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
    return variableDTO(await ctx.repos.variables.create(tenantId, { key, value }));
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
  const { repos, auth: authService, config, variables } = ctx;

  // tags --------------------------------------------------------------------------------------
  app.get('/tags', async (request) => {
    const auth = await requireScope(request, 'tag:list');
    return { data: (await repos.tags.list(auth.tenant.id)).map(tagDTO), nextCursor: null };
  });
  app.get('/tags/:id', async (request) => {
    const auth = await requireScope(request, 'tag:read');
    const { id } = parse(idParams, request.params);
    const row = await repos.tags.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Tag');
    return { data: tagDTO(row) };
  });
  app.post('/tags', async (request) => {
    const auth = await requireScope(request, 'tag:create');
    const { name } = parse(tagSchema, request.body);
    return { data: await createTag(ctx, auth.tenant.id, name) };
  });
  app.patch('/tags/:id', async (request) => {
    const auth = await requireScope(request, 'tag:update');
    const { id } = parse(idParams, request.params);
    const { name } = parse(tagSchema, request.body);
    return { data: await renameTag(ctx, auth.tenant.id, id, name) };
  });
  app.delete('/tags/:id', async (request) => {
    const auth = await requireScope(request, 'tag:delete');
    const { id } = parse(idParams, request.params);
    if (!(await repos.tags.delete(auth.tenant.id, id))) throw ApiError.notFound('Tag');
    return { data: { ok: true } };
  });

  // variables ---------------------------------------------------------------------------------
  // `?projectId=` lists one project's variables (`projectVariable:list` on it); without it the caller
  // gets the globals (`variable:list`) and the variables of the projects they may list
  app.get('/variables', async (request) => {
    const raw = (request.query as { projectId?: unknown } | undefined)?.projectId;
    const auth =
      typeof raw === 'string'
        ? await requireScope(request, 'projectVariable:list', { projectId: raw })
        : await requireScope(request, 'variable:list');
    const { projectId } = parse(z.object({ projectId: z.uuid().optional() }), request.query ?? {});
    const rows = await variables.list(auth, projectId === undefined ? {} : { projectId });
    return { data: rows.map(projectVariableDTO), nextCursor: null };
  });
  app.get('/variables/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, ['variable:read', 'projectVariable:read'], { variableId: id });
    return { data: projectVariableDTO(await variables.get(auth, id)) };
  });
  app.post('/variables', async (request) => {
    // the place decides the gate: a project variable is allowed by the project's own scope
    const raw = (request.body as { projectId?: unknown } | null | undefined)?.projectId;
    const auth =
      typeof raw === 'string'
        ? await requireScope(request, 'projectVariable:create', { projectId: raw })
        : await requireScope(request, 'variable:create');
    const body = parse(variableBodySchema, request.body);
    return { data: projectVariableDTO(await variables.create(auth, body)) };
  });
  app.patch('/variables/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, ['variable:update', 'projectVariable:update'], {
      variableId: id,
    });
    return {
      data: projectVariableDTO(await variables.update(auth, id, parse(variablePatchSchema, request.body))),
    };
  });
  app.delete('/variables/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, ['variable:delete', 'projectVariable:delete'], {
      variableId: id,
    });
    await variables.delete(auth, id);
    return { data: { ok: true } };
  });

  // members & invitations ---------------------------------------------------------------------
  app.get('/members', async (request) => {
    const auth = await requireScope(request, 'user:list');
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
    const auth = await requireScope(request, 'user:create');
    const body = parse(z.object({ email: z.email().max(254), role: memberRoleSchema }), request.body);
    await authService.assertMemberRole(auth.tenant.id, body.role);
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
    const auth = await requireScope(request, 'user:changeRole');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    const { role } = parse(z.object({ role: memberRoleSchema }), request.body);
    await authService.assertMemberRole(auth.tenant.id, role);
    const target = await repos.memberships.get(auth.tenant.id, userId);
    if (!target) throw ApiError.notFound('Member');
    if ((target.role === 'owner' || role === 'owner') && auth.role !== 'owner') {
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
    const auth = await requireScope(request, 'user:delete');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    if (!(await repos.memberships.get(auth.tenant.id, userId))) throw ApiError.notFound('Member');
    await removeMember(ctx, auth, userId, removalChoice(request.body, request.query));
    return { data: { ok: true } };
  });

  app.get('/invitations', async (request) => {
    const auth = await requireScope(request, 'user:create');
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
    const auth = await requireScope(request, 'user:create');
    const { id } = parse(idParams, request.params);
    if (!(await repos.invitations.delete(auth.tenant.id, id))) throw ApiError.notFound('Invitation');
    return { data: { ok: true } };
  });

  // API keys (own keys; they act with the creator's current role) ----------------------------
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

  // audit log ---------------------------------------------------------------------------------
  app.get('/audit-log', async (request) => {
    const auth = await requireScope(request, 'auditLogs:manage');
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
