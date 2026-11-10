/**
 * /rest node and credential type policies (P6-49, L4), as n8n's type policy controllers: the workspace scope
 * (`/instance`), the policy documents (`/policies`, `/policies/:policyId`) and the attachments of a scope
 * (`/scopes/:scopeId/attachments`), nine routes under `/node-type-policies` (`nodeTypePolicy:manage`) and the
 * same nine under `/credential-type-policies` (`credentialTypePolicy:manage`). Beside them the types a project
 * may use (`/projects/:projectId/available-types` and `/available-credential-types`, `project:read` in the
 * project; only unavailable entries carry a reason) and the sub-workflow start preview
 * (`/workflows/:id/sub-workflows/:subId/policy-check`, `workflow:update`; a sub-workflow the caller cannot read
 * is 404). Paths and scope gates are final; each handler is a stub until L4 fills it.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

/** the two policy kinds: their REST base path and the scope that manages them */
const POLICY_BASES: readonly { base: string; scope: Scope }[] = [
  { base: '/node-type-policies', scope: 'nodeTypePolicy:manage' },
  { base: '/credential-type-policies', scope: 'credentialTypePolicy:manage' },
];

const notImplemented = (): never => {
  // stub (L4)
  throw new Error('not implemented (L4)');
};

export function registerTypePolicyRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  for (const { base, scope } of POLICY_BASES) {
    // the workspace scope: default action and its attachments
    app.get(`${base}/instance`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.put(`${base}/instance`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    // the policy documents
    app.get(`${base}/policies`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.post(`${base}/policies`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.get(`${base}/policies/:policyId`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.patch(`${base}/policies/:policyId`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.delete(`${base}/policies/:policyId`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    // the policies attached to one scope (workspace or project), with priority and floor
    app.get(`${base}/scopes/:scopeId/attachments`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
    app.put(`${base}/scopes/:scopeId/attachments`, async (request) => {
      await requireScope(request, scope);
      return notImplemented();
    });
  }

  // the node and credential types a project may use (n8n: available-types.controller.ts, `project:read`)
  app.get('/projects/:projectId/available-types', async (request) => {
    const { projectId } = request.params as { projectId: string };
    await requireScope(request, 'project:read', { projectId });
    return notImplemented();
  });
  app.get('/projects/:projectId/available-credential-types', async (request) => {
    const { projectId } = request.params as { projectId: string };
    await requireScope(request, 'project:read', { projectId });
    return notImplemented();
  });

  // may this workflow start that sub-workflow (n8n: sub-workflow-policy-check.controller.ts, `workflow:update`)
  app.get('/workflows/:id/sub-workflows/:subId/policy-check', async (request) => {
    const { id } = request.params as { id: string; subId: string };
    await requireScope(request, 'workflow:update', { workflowId: id });
    return notImplemented();
  });
}
