/**
 * Public API dependencies (P6-86, L18), in n8n's `DependencyListPublicDto` shape with paging: GET
 * `/workflows/:id/dependencies` (`workflow:read` on the workflow) and GET `/credentials/:id/dependencies`
 * (`credential:read` on the credential); the key needs the same scope. The workflows the caller cannot read are
 * dropped through `AccessService.listFilter`, as in REST. PUBLIC_DEPENDENCY_ROUTES is shaped as
 * PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it; the data table row stays in public-data-tables.ts and
 * answers the same shape). Each page is `{ data, nextCursor }`, `limit` 1 to 250 (default 100).
 */
import { z } from 'zod';
import type { ApiRoute, RouteTarget } from './public-api';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const onWorkflow: RouteTarget = ({ params }) => ({ workflowId: params.id });
const onCredential: RouteTarget = ({ params }) => ({ credentialId: params.id });

export const PUBLIC_DEPENDENCY_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/workflows/:id/dependencies',
    summary: 'List what a workflow uses and what uses it',
    tag: 'Workflows',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'workflow:read',
    params: idParams,
    query: pageQuery,
    response: 'DependencyList',
    list: true,
    handler: (ctx, { auth, params, query }) =>
      ctx.dependencies.forWorkflow(auth, params.id, { limit: query.limit, cursor: query.cursor }),
  },
  {
    method: 'GET',
    path: '/credentials/:id/dependencies',
    summary: 'List the workflows that use a credential',
    tag: 'Credentials',
    access: { scope: 'credential:read', target: onCredential },
    scope: 'credential:read',
    params: idParams,
    query: pageQuery,
    response: 'DependencyList',
    list: true,
    handler: (ctx, { auth, params, query }) =>
      ctx.dependencies.forCredential(auth, params.id, { limit: query.limit, cursor: query.cursor }),
  },
];
