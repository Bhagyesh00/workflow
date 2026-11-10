/**
 * Public API node and credential type policies (P6-49, L4), as n8n's node-type-policies and
 * credential-type-policies public controllers: per kind the workspace scope (`/instance`), a project's scope
 * (`/projects/:projectId`), the policy documents (`/policies`, `/policies/:policyId`) and the attachments of a
 * scope (`/scopes/:scopeId/attachments`), eleven rows under `/node-type-policies` (`nodeTypePolicy:manage`) and
 * the same eleven under `/credential-type-policies` (`credentialTypePolicy:manage`); the user scope and the key
 * scope are the same name. PUBLIC_TYPE_POLICY_ROUTES is final and shaped as PUBLIC_DATA_TABLE_ROUTES
 * (public-api.ts spreads it and runs the `access` check, then the key scope). Summaries say "Preview:" as n8n's
 * do. Every handler is a stub until L4 fills it with the shapes of the REST routes (routes/type-policies.ts).
 */
import { z } from 'zod';
import type { ApiRoute, RouteAccess, RouteTarget } from './public-api';

const notImplemented = async (): Promise<never> => {
  // stub (L4)
  throw new Error('not implemented (L4)');
};

const projectParams = z.object({ projectId: z.uuid() });
const policyParams = z.object({ policyId: z.uuid() });
const scopeParams = z.object({ scopeId: z.uuid() });
const onProject: RouteTarget = ({ params }) => ({ projectId: params.projectId });

/** the scope that manages one policy kind: the user's scope and the key's scope have the same name */
type PolicyScope = 'nodeTypePolicy:manage' | 'credentialTypePolicy:manage';

type PolicyRow = Omit<ApiRoute, 'tag' | 'access' | 'scope' | 'handler'> & { access?: RouteAccess };

function policyRows(base: string, noun: string, tag: string, scope: PolicyScope): ApiRoute[] {
  const row = ({ access, ...r }: PolicyRow): ApiRoute => ({
    ...r,
    tag,
    access: access ?? { scope },
    scope,
    handler: notImplemented,
  });
  return [
    row({
      method: 'GET',
      path: `${base}/instance`,
      summary: `Preview: get the workspace ${noun} policy scope (default action and attachments)`,
      response: 'TypePolicyScope',
    }),
    row({
      method: 'PUT',
      path: `${base}/instance`,
      summary: `Preview: change the workspace ${noun} policy scope`,
      response: 'TypePolicyScope',
    }),
    row({
      method: 'GET',
      path: `${base}/projects/:projectId`,
      summary: `Preview: get a project's ${noun} policy scope`,
      access: { scope, target: onProject },
      params: projectParams,
      response: 'TypePolicyScope',
    }),
    row({
      method: 'PUT',
      path: `${base}/projects/:projectId`,
      summary: `Preview: change a project's ${noun} policy scope (a project can only restrict)`,
      access: { scope, target: onProject },
      params: projectParams,
      response: 'TypePolicyScope',
    }),
    row({
      method: 'GET',
      path: `${base}/policies`,
      summary: `Preview: list the ${noun} policies`,
      response: 'TypePolicyDocument',
      list: true,
    }),
    row({
      method: 'POST',
      path: `${base}/policies`,
      summary: `Preview: create a ${noun} policy`,
      response: 'TypePolicyDocument',
    }),
    row({
      method: 'GET',
      path: `${base}/policies/:policyId`,
      summary: `Preview: get a ${noun} policy`,
      params: policyParams,
      response: 'TypePolicyDocument',
    }),
    row({
      method: 'PATCH',
      path: `${base}/policies/:policyId`,
      summary: `Preview: change a ${noun} policy`,
      params: policyParams,
      response: 'TypePolicyDocument',
    }),
    row({
      method: 'DELETE',
      path: `${base}/policies/:policyId`,
      summary: `Preview: delete a ${noun} policy that no scope uses`,
      params: policyParams,
      response: 'Ok',
    }),
    row({
      method: 'GET',
      path: `${base}/scopes/:scopeId/attachments`,
      summary: `Preview: list the ${noun} policies attached to a scope`,
      params: scopeParams,
      response: 'TypePolicyAttachment',
      list: true,
    }),
    row({
      method: 'PUT',
      path: `${base}/scopes/:scopeId/attachments`,
      summary: `Preview: replace the ${noun} policies attached to a scope (order is priority)`,
      params: scopeParams,
      response: 'TypePolicyAttachment',
      list: true,
    }),
  ];
}

export const PUBLIC_TYPE_POLICY_ROUTES: ApiRoute[] = [
  ...policyRows('/node-type-policies', 'node type', 'Node type policies', 'nodeTypePolicy:manage'),
  ...policyRows(
    '/credential-type-policies',
    'credential type',
    'Credential type policies',
    'credentialTypePolicy:manage',
  ),
];
