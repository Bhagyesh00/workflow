/**
 * Public API node and credential type policies (P6-49, L4), as n8n's node-type-policies and
 * credential-type-policies public controllers: per kind the workspace scope (`/instance`), a project's scope
 * (`/projects/:projectId`), the policy documents (`/policies`, `/policies/:policyId`) and the attachments of a
 * scope (`/scopes/:scopeId/attachments`), eleven rows under `/node-type-policies` (`nodeTypePolicy:manage`) and
 * the same eleven under `/credential-type-policies` (`credentialTypePolicy:manage`); the user scope and the key
 * scope are the same name. PUBLIC_TYPE_POLICY_ROUTES is final and shaped as PUBLIC_DATA_TABLE_ROUTES
 * (public-api.ts spreads it and runs the `access` check, then the key scope). Summaries say "Preview:" as n8n's
 * do. Each handler calls `typePolicyOps` (routes/type-policies.ts), so a public row and its REST route answer
 * the same shapes: `{ data }`, and `{ data, nextCursor: null }` for the lists. A write sends the
 * `expectedVersion` it read (body; DELETE: query), and a stale one gets 409.
 */
import { z } from 'zod';
import type { PolicyKind } from '../services/type-policies/types';
import type { ApiRoute, PublicApiInput, RouteAccess, RouteTarget } from './public-api';
import {
  attachmentsBody,
  deleteQuery,
  type PolicyActor,
  policyCreateBody,
  policyUpdateBody,
  scopeBody,
  typePolicyOps,
} from './type-policies';

const projectParams = z.object({ projectId: z.uuid() });
const policyParams = z.object({ policyId: z.uuid() });
const scopeParams = z.object({ scopeId: z.uuid() });
const onProject: RouteTarget = ({ params }) => ({ projectId: params.projectId });

/** the scope that manages one policy kind: the user's scope and the key's scope have the same name */
type PolicyScope = 'nodeTypePolicy:manage' | 'credentialTypePolicy:manage';

type PolicyRow = Omit<ApiRoute, 'tag' | 'access' | 'scope'> & { access?: RouteAccess };

const actorOf = (input: PublicApiInput): PolicyActor => ({
  tenantId: input.auth.tenant.id,
  userId: input.auth.user.id,
  ip: input.request.ip,
});

function policyRows(
  base: string,
  noun: string,
  tag: string,
  scope: PolicyScope,
  kind: PolicyKind,
): ApiRoute[] {
  const row = ({ access, ...r }: PolicyRow): ApiRoute => ({
    ...r,
    tag,
    access: access ?? { scope },
    scope,
  });
  const ops = (ctx: Parameters<ApiRoute['handler']>[0]) => typePolicyOps(ctx, kind);
  return [
    row({
      method: 'GET',
      path: `${base}/instance`,
      summary: `Preview: get the workspace ${noun} policy scope (default action and attachments)`,
      response: 'TypePolicyScope',
      handler: async (ctx, input) => ({ data: await ops(ctx).getScope(input.auth.tenant.id, null) }),
    }),
    row({
      method: 'PUT',
      path: `${base}/instance`,
      summary: `Preview: change the workspace ${noun} policy scope`,
      body: scopeBody,
      response: 'TypePolicyScope',
      handler: async (ctx, input) => ({ data: await ops(ctx).putScope(actorOf(input), null, input.body) }),
    }),
    row({
      method: 'GET',
      path: `${base}/projects/:projectId`,
      summary: `Preview: get a project's ${noun} policy scope`,
      access: { scope, target: onProject },
      params: projectParams,
      response: 'TypePolicyScope',
      handler: async (ctx, input) => ({
        data: await ops(ctx).getScope(input.auth.tenant.id, input.params.projectId),
      }),
    }),
    row({
      method: 'PUT',
      path: `${base}/projects/:projectId`,
      summary: `Preview: change a project's ${noun} policy scope (a project can only restrict)`,
      access: { scope, target: onProject },
      params: projectParams,
      body: scopeBody,
      response: 'TypePolicyScope',
      handler: async (ctx, input) => ({
        data: await ops(ctx).putScope(actorOf(input), input.params.projectId, input.body),
      }),
    }),
    row({
      method: 'GET',
      path: `${base}/policies`,
      summary: `Preview: list the ${noun} policies`,
      response: 'TypePolicyDocument',
      list: true,
      handler: async (ctx, input) => ({
        data: await ops(ctx).listPolicies(input.auth.tenant.id),
        nextCursor: null,
      }),
    }),
    row({
      method: 'POST',
      path: `${base}/policies`,
      summary: `Preview: create a ${noun} policy`,
      body: policyCreateBody,
      response: 'TypePolicyDocument',
      handler: async (ctx, input) => ({ data: await ops(ctx).createPolicy(actorOf(input), input.body) }),
    }),
    row({
      method: 'GET',
      path: `${base}/policies/:policyId`,
      summary: `Preview: get a ${noun} policy`,
      params: policyParams,
      response: 'TypePolicyDocument',
      handler: async (ctx, input) => ({
        data: await ops(ctx).getPolicy(input.auth.tenant.id, input.params.policyId),
      }),
    }),
    row({
      method: 'PATCH',
      path: `${base}/policies/:policyId`,
      summary: `Preview: change a ${noun} policy`,
      params: policyParams,
      body: policyUpdateBody,
      response: 'TypePolicyDocument',
      handler: async (ctx, input) => ({
        data: await ops(ctx).updatePolicy(actorOf(input), input.params.policyId, input.body),
      }),
    }),
    row({
      method: 'DELETE',
      path: `${base}/policies/:policyId`,
      summary: `Preview: delete a ${noun} policy that no scope uses (query expectedVersion: the version read)`,
      params: policyParams,
      query: deleteQuery,
      response: 'Ok',
      handler: async (ctx, input) => ({
        data: await ops(ctx).deletePolicy(actorOf(input), input.params.policyId, input.query),
      }),
    }),
    row({
      method: 'GET',
      path: `${base}/scopes/:scopeId/attachments`,
      summary: `Preview: list the ${noun} policies attached to a scope`,
      params: scopeParams,
      response: 'TypePolicyAttachment',
      list: true,
      handler: async (ctx, input) => ({
        data: await ops(ctx).getAttachments(input.auth.tenant.id, input.params.scopeId),
        nextCursor: null,
      }),
    }),
    row({
      method: 'PUT',
      path: `${base}/scopes/:scopeId/attachments`,
      summary: `Preview: replace the ${noun} policies attached to a scope (order is priority)`,
      params: scopeParams,
      body: attachmentsBody,
      response: 'TypePolicyAttachment',
      list: true,
      handler: async (ctx, input) => ({
        data: await ops(ctx).putAttachments(actorOf(input), input.params.scopeId, input.body),
        nextCursor: null,
      }),
    }),
  ];
}

export const PUBLIC_TYPE_POLICY_ROUTES: ApiRoute[] = [
  ...policyRows('/node-type-policies', 'node type', 'Node type policies', 'nodeTypePolicy:manage', 'node'),
  ...policyRows(
    '/credential-type-policies',
    'credential type',
    'Credential type policies',
    'credentialTypePolicy:manage',
    'credential',
  ),
];
