/**
 * Public API rows the CLI needs (P6-77, L10), n8n's public API: GET and PUT `/workflows/:id/tags` (`[{ id }]`),
 * POST `/executions/:id/stop` (the REST stop path's access: `workflow:execute` on the run), GET `/credentials` (the
 * list filter form, as REST) and GET `/credentials/:id` (`credential:read` on the credential), both answering
 * `CredentialRef` with no `data`. PUBLIC_CLI_ROUTES is shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 * stub (L10): the rows have their final path, access and scope; the handlers throw.
 */
import { z } from 'zod';
import type { ApiRoute, RouteTarget } from './public-api';

const idParams = z.object({ id: z.uuid() });
const tagIdsBody = z.array(z.object({ id: z.string().min(1).max(64) })).max(500);
const credentialListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const onWorkflow: RouteTarget = ({ params }) => ({ workflowId: params.id });
const onExecution: RouteTarget = ({ params }) => ({ executionId: params.id });
const onCredential: RouteTarget = ({ params }) => ({ credentialId: params.id });

// stub (L10)
const notImplemented = async (): Promise<never> => {
  throw new Error('not implemented (L10)');
};

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
    handler: notImplemented,
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
    handler: notImplemented,
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
    handler: notImplemented,
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
    handler: notImplemented,
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
    handler: notImplemented,
  },
];
