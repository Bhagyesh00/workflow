/**
 * /rest project type policies (P6-51, L6): the project's own scope of node and credential type policies,
 * GET and PUT `/projects/:projectId/node-type-policies/project` (`nodeTypePolicy:manage` in the project) and
 * `/projects/:projectId/credential-type-policies/project` (`credentialTypePolicy:manage` in the project). A
 * project can only restrict what the workspace allows (`composeDecisions`). Paths and scope gates are final;
 * each handler is a stub until L6 fills it.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

const PROJECT_POLICY_ROUTES: readonly { path: string; scope: Scope }[] = [
  { path: '/projects/:projectId/node-type-policies/project', scope: 'nodeTypePolicy:manage' },
  { path: '/projects/:projectId/credential-type-policies/project', scope: 'credentialTypePolicy:manage' },
];

const notImplemented = (): never => {
  // stub (L6)
  throw new Error('not implemented (L6)');
};

export function registerProjectTypePolicyRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  for (const { path, scope } of PROJECT_POLICY_ROUTES) {
    app.get(path, async (request) => {
      const { projectId } = request.params as { projectId: string };
      await requireScope(request, scope, { projectId });
      return notImplemented();
    });
    app.put(path, async (request) => {
      const { projectId } = request.params as { projectId: string };
      await requireScope(request, scope, { projectId });
      return notImplemented();
    });
  }
}
