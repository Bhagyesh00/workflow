/**
 * /rest project type policies (P6-51, L6): the project's own scope of node and credential type policies,
 * GET and PUT `/projects/:projectId/node-type-policies/project` (`nodeTypePolicy:manage` in the project) and
 * `/projects/:projectId/credential-type-policies/project` (`credentialTypePolicy:manage` in the project). A
 * project can only restrict what the workspace allows (`composeDecisions`), so its default action is `allow`
 * or `deny` (the store refuses `delegate`). A project of another workspace is 404. The reads and writes are
 * the store calls and audit rows L4's `typePolicyOps` holds.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import type { PolicyKind } from '../services/type-policies/types';
import { typePolicyOps } from './type-policies';

const PROJECT_POLICY_ROUTES: readonly { path: string; scope: Scope; kind: PolicyKind }[] = [
  { path: '/projects/:projectId/node-type-policies/project', scope: 'nodeTypePolicy:manage', kind: 'node' },
  {
    path: '/projects/:projectId/credential-type-policies/project',
    scope: 'credentialTypePolicy:manage',
    kind: 'credential',
  },
];

export function registerProjectTypePolicyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  for (const { path, scope, kind } of PROJECT_POLICY_ROUTES) {
    const ops = typePolicyOps(ctx, kind);
    app.get(path, async (request) => {
      const { projectId } = request.params as { projectId: string };
      const auth = await requireScope(request, scope, { projectId });
      return { data: await ops.getScope(auth.tenant.id, projectId) };
    });
    app.put(path, async (request) => {
      const { projectId } = request.params as { projectId: string };
      const auth = await requireScope(request, scope, { projectId });
      const actor = { tenantId: auth.tenant.id, userId: auth.user.id, ip: request.ip };
      return { data: await ops.putScope(actor, projectId, request.body) };
    });
  }
}
