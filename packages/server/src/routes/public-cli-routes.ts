/**
 * Public API rows the CLI needs (P6-77, L10), n8n's public API: GET and PUT `/workflows/:id/tags` (`[{ id }]`),
 * POST `/executions/:id/stop` (the REST stop path's access: `workflow:execute` on the run), GET `/credentials` (the
 * list filter form, as REST) and GET `/credentials/:id` (`credential:read` on the credential), both answering
 * `CredentialRef` with no `data`. PUBLIC_CLI_ROUTES is shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ApiError } from '../http/errors';
import { credentialSummary } from './credentials';
import type { ApiRoute, PublicApiInput, RouteTarget } from './public-api';
import { decodeCursor, encodeCursor } from './public-data-tables';

const idParams = z.object({ id: z.uuid() });
const tagIdsBody = z.array(z.object({ id: z.string().min(1).max(64) })).max(500);
const credentialListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const onWorkflow: RouteTarget = ({ params }) => ({ workflowId: params.id });
const onExecution: RouteTarget = ({ params }) => ({ executionId: params.id });
const onCredential: RouteTarget = ({ params }) => ({ credentialId: params.id });

const actorOf = (input: PublicApiInput) => ({ userId: input.auth.user.id, ip: input.request.ip });

/** the tags of a workflow as the public answer (id, name, dates), by name */
async function tagsOf(ctx: ServerContext, tenantId: string, ids: readonly string[]) {
  const wanted = new Set(ids);
  const rows = await ctx.repos.tags.list(tenantId);
  return rows
    .filter((row) => wanted.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
}

/** a credential as n8n's public API shows it here: id, name, type, dates and nothing of the data */
const credentialRef = (row: Parameters<typeof credentialSummary>[0]) => credentialSummary(row);

export const PUBLIC_CLI_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/workflows/:id/tags',
    summary: 'List the tags of a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'workflowTags:list',
    params: idParams,
    response: 'WorkflowTag',
    list: true,
    handler: async (ctx, { auth, params }) => {
      const workflow = await ctx.workflows.get(auth.tenant.id, params.id);
      const refs = (await ctx.repos.workflows.tagsFor(auth.tenant.id, [workflow.id])).get(workflow.id) ?? [];
      return {
        data: await tagsOf(
          ctx,
          auth.tenant.id,
          refs.map((ref) => ref.id),
        ),
        nextCursor: null,
      };
    },
  },
  {
    method: 'PUT',
    path: '/workflows/:id/tags',
    summary: 'Set the tags of a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:update', target: onWorkflow },
    scope: 'workflowTags:update',
    params: idParams,
    body: tagIdsBody,
    response: 'WorkflowTag',
    list: true,
    handler: async (ctx, input) => {
      const { auth, params, body } = input;
      // through the workflow service: the tag check and the update lock run (never `repos.workflows.setTags`)
      await ctx.workflows.update(
        auth.tenant.id,
        params.id,
        { tagIds: (body as Array<{ id: string }>).map((tag) => tag.id) },
        actorOf(input),
      );
      const refs = (await ctx.repos.workflows.tagsFor(auth.tenant.id, [params.id])).get(params.id) ?? [];
      return {
        data: await tagsOf(
          ctx,
          auth.tenant.id,
          refs.map((ref) => ref.id),
        ),
        nextCursor: null,
      };
    },
  },
  {
    method: 'POST',
    path: '/executions/:id/stop',
    summary: 'Stop a running execution',
    tag: 'Executions',
    access: { scope: 'workflow:execute', target: onExecution },
    scope: 'execution:stop',
    params: idParams,
    response: 'Execution',
    handler: async (ctx, { auth, params }) => {
      const status = await ctx.executions.stop(auth.tenant.id, params.id);
      return { data: { id: params.id, status } };
    },
  },
  {
    method: 'GET',
    path: '/credentials',
    summary: 'List credentials (names and types, no data)',
    tag: 'Credentials',
    access: { scope: 'credential:list', list: true },
    scope: 'credential:list',
    query: credentialListQuery,
    response: 'CredentialRef',
    list: true,
    handler: async (ctx, { auth, query }) => {
      const skip = decodeCursor(query.cursor);
      const rows = await ctx.repos.credentials.list(auth.tenant.id, {
        filter: await ctx.access.listFilter(auth, 'credential:list'),
      });
      const page = rows.slice(skip, skip + query.limit);
      const end = skip + page.length;
      return { data: page.map(credentialRef), nextCursor: end < rows.length ? encodeCursor(end) : null };
    },
  },
  {
    method: 'GET',
    path: '/credentials/:id',
    summary: 'Get a credential (name and type, no data)',
    tag: 'Credentials',
    access: { scope: 'credential:read', target: onCredential },
    scope: 'credential:read',
    params: idParams,
    response: 'CredentialRef',
    handler: async (ctx, { auth, params }) => {
      const row = await ctx.repos.credentials.get(auth.tenant.id, params.id);
      if (!row) throw ApiError.notFound('Credential');
      return { data: credentialRef(row) };
    },
  },
];
