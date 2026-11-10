/**
 * /rest/tags, /rest/variables, /rest/audit-log. Members and invitations are in routes/members.ts, API keys in
 * routes/api-keys.ts (moved in S2's C0).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { TagRow, VariableRow } from '../db/schema';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { page, paginationQuery } from '../http/pagination';
import { idParams, tagSchema, variableCreateSchema, variableUpdateSchema } from '../http/schemas';
import { isUniqueViolation } from '../repositories';

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

/** POST /variables: with `projectId` a project variable (`projectVariable:create` on it) */
const variableBodySchema = variableCreateSchema.extend({ projectId: z.uuid().nullish() });
/** PATCH /variables/:id: `projectId` moves the variable (a uuid: into that project, null: to global) */
const variablePatchSchema = variableUpdateSchema.extend({ projectId: z.uuid().nullable().optional() });

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
  const { repos, variables } = ctx;

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
