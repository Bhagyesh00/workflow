/**
 * /rest node and credential type policies (P6-49, L4), as n8n's type policy controllers: the workspace scope
 * (`/instance`), the policy documents (`/policies`, `/policies/:policyId`) and the attachments of a scope
 * (`/scopes/:scopeId/attachments`), nine routes under `/node-type-policies` (`nodeTypePolicy:manage`) and the
 * same nine under `/credential-type-policies` (`credentialTypePolicy:manage`). Beside them the types a project
 * may use (`/projects/:projectId/available-types` and `/available-credential-types`, `project:read` in the
 * project; only unavailable entries carry a reason) and the sub-workflow start preview
 * (`/workflows/:id/sub-workflows/:subId/policy-check`, `workflow:update`; a sub-workflow the caller cannot read
 * is 404). Paths and scope gates are final. `typePolicyOps` holds what the REST routes and the public rows
 * (public-type-policies.ts) share: bodies, the store calls and the audit rows `type_policy.*`.
 * A policy holds type names only: no route reads or writes a secret.
 */
import { randomUUID } from 'node:crypto';
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { composeDecisions } from '../services/type-policies/compose';
import { filterAvailable } from '../services/type-policies/enforce';
import { evaluateScope } from '../services/type-policies/evaluator';
import type {
  PolicyAttachment,
  PolicyDocument,
  PolicyKind,
  PolicyRule,
  PolicyScope,
  TypeDecision,
  TypePolicyViolation,
} from '../services/type-policies/types';

/** the two policy kinds: their REST base path and the scope that manages them */
const POLICY_BASES: readonly { base: string; scope: Scope; kind: PolicyKind }[] = [
  { base: '/node-type-policies', scope: 'nodeTypePolicy:manage', kind: 'node' },
  { base: '/credential-type-policies', scope: 'credentialTypePolicy:manage', kind: 'credential' },
];

const MAX_VERSION = 2_147_483_647;
const versionField = z.number().int().min(0).max(MAX_VERSION);

const attachmentSchema = z.object({
  policyId: z.uuid(),
  priority: z.number().int().min(0).max(1_000_000),
  isFloor: z.boolean(),
});

const selectorSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    package: z.string().trim().min(1).max(255).optional(),
    extends: z.string().trim().min(1).max(255).optional(),
  })
  .refine((s) => [s.name, s.package, s.extends].filter((v) => v !== undefined).length === 1, {
    message: 'A rule selector names exactly one of name, package or extends',
  });

const ruleSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  action: z.enum(['allow', 'deny', 'delegate']),
  selector: selectorSchema,
  description: z.string().max(512).nullish(),
});

const rulesSchema = z.array(ruleSchema).max(1000);

/** body of PUT `.../instance` and `.../projects/:projectId` */
export const scopeBody = z.object({
  defaultAction: z.enum(['allow', 'deny', 'delegate']),
  attachments: z.array(attachmentSchema).max(200).optional(),
  expectedVersion: versionField,
});

export const policyCreateBody = z.object({
  name: z.string().max(1000),
  description: z.string().max(100_000).nullish(),
  rules: rulesSchema,
});

export const policyUpdateBody = z.object({
  name: z.string().max(1000).optional(),
  description: z.string().max(100_000).nullish(),
  rules: rulesSchema.optional(),
  expectedVersion: versionField,
});

export const attachmentsBody = z.object({
  attachments: z.array(attachmentSchema).max(200),
  expectedVersion: versionField,
});

/** DELETE has no body: the version the caller read travels in the query */
export const deleteQuery = z.object({ expectedVersion: z.coerce.number().int().min(0).max(MAX_VERSION) });

/** the rules with an id each; a node policy cannot use the credential-only `extends` selector */
function readRules(kind: PolicyKind, rules: z.infer<typeof rulesSchema>): PolicyRule[] {
  const ids = new Set<string>();
  return rules.map((rule) => {
    if (kind === 'node' && rule.selector.extends !== undefined) {
      throw ApiError.badRequest('A node policy cannot use an extends selector');
    }
    const id = rule.id ?? randomUUID();
    if (ids.has(id)) throw ApiError.badRequest('Two rules of a policy share an id');
    ids.add(id);
    return {
      id,
      action: rule.action,
      selector: rule.selector,
      ...(rule.description !== undefined ? { description: rule.description } : {}),
    };
  });
}

export interface PolicyActor {
  tenantId: string;
  userId: string;
  ip?: string;
}

const scopeOut = (scope: PolicyScope) => ({
  id: scope.id,
  kind: scope.kind,
  projectId: scope.projectId,
  defaultAction: scope.defaultAction,
  version: scope.version,
  attachments: scope.attachments,
});

/**
 * What the REST routes and the public rows share, per policy kind. Every write leaves an audit row
 * `type_policy.*`; the store invalidates the snapshot after the commit.
 */
export function typePolicyOps(ctx: ServerContext, kind: PolicyKind) {
  const { typePolicies, repos } = ctx;

  const audit = (
    actor: PolicyActor,
    action: string,
    resourceType: string,
    resourceId: string | null | undefined,
    metadata: Record<string, unknown>,
  ) =>
    repos.audit.add(actor.tenantId, {
      userId: actor.userId,
      action,
      resourceType,
      ...(resourceId ? { resourceId } : {}),
      metadata: { kind, ...metadata },
      ip: actor.ip,
    });

  const requireProject = async (tenantId: string, projectId: string) => {
    if (!(await repos.projects.get(tenantId, projectId))) throw ApiError.notFound('Project');
  };

  /** the scope of this kind and tenant; another kind's or tenant's scope is 404 */
  const requireScopeRow = async (tenantId: string, scopeId: string) => {
    const row = await repos.typePolicies.getScopeById(tenantId, scopeId);
    if (!row || row.kind !== kind) throw ApiError.notFound('Policy scope');
    return row;
  };

  const writeDocument = (policy: PolicyDocument, warnings: unknown[]) => ({ ...policy, warnings });

  return {
    async getScope(tenantId: string, projectId: string | null) {
      if (projectId !== null) await requireProject(tenantId, projectId);
      return scopeOut(await typePolicies.getScope(tenantId, kind, projectId));
    },
    async putScope(actor: PolicyActor, projectId: string | null, input: unknown) {
      const body = parse(scopeBody, input);
      const scope = await typePolicies.putScope(
        actor.tenantId,
        kind,
        projectId,
        { defaultAction: body.defaultAction, attachments: body.attachments },
        body.expectedVersion,
      );
      await audit(actor, 'type_policy.scope.updated', 'type_policy_scope', scope.id, {
        projectId,
        defaultAction: scope.defaultAction,
        version: scope.version,
      });
      if (body.attachments !== undefined) {
        await audit(actor, 'type_policy.attachments.updated', 'type_policy_scope', scope.id, {
          projectId,
          policyIds: scope.attachments.map((a) => a.policyId),
        });
      }
      return scopeOut(scope);
    },
    listPolicies(tenantId: string) {
      return typePolicies.listPolicies(tenantId, kind);
    },
    getPolicy(tenantId: string, policyId: string) {
      return typePolicies.getPolicy(tenantId, kind, policyId);
    },
    async createPolicy(actor: PolicyActor, input: unknown) {
      const body = parse(policyCreateBody, input);
      const { policy, warnings } = await typePolicies.createPolicy(
        actor.tenantId,
        kind,
        { name: body.name, description: body.description, rules: readRules(kind, body.rules) },
        actor.userId,
      );
      await audit(actor, 'type_policy.document.created', 'type_policy', policy.id, { name: policy.name });
      return writeDocument(policy, warnings);
    },
    async updatePolicy(actor: PolicyActor, policyId: string, input: unknown) {
      const { expectedVersion, ...patch } = parse(policyUpdateBody, input);
      const { policy, warnings } = await typePolicies.updatePolicy(
        actor.tenantId,
        kind,
        policyId,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.rules !== undefined ? { rules: readRules(kind, patch.rules) } : {}),
        },
        expectedVersion,
        actor.userId,
      );
      await audit(actor, 'type_policy.document.updated', 'type_policy', policy.id, {
        name: policy.name,
        version: policy.version,
      });
      return writeDocument(policy, warnings);
    },
    async deletePolicy(actor: PolicyActor, policyId: string, query: unknown) {
      const { expectedVersion } = parse(deleteQuery, query);
      await typePolicies.deletePolicy(actor.tenantId, kind, policyId, expectedVersion, actor.userId);
      await audit(actor, 'type_policy.document.deleted', 'type_policy', policyId, {});
      return { ok: true as const };
    },
    async getAttachments(tenantId: string, scopeId: string): Promise<PolicyAttachment[]> {
      await requireScopeRow(tenantId, scopeId);
      return typePolicies.getAttachments(tenantId, scopeId);
    },
    async putAttachments(actor: PolicyActor, scopeId: string, input: unknown) {
      const body = parse(attachmentsBody, input);
      await requireScopeRow(actor.tenantId, scopeId);
      const scope = await typePolicies.putAttachments(
        actor.tenantId,
        scopeId,
        body.attachments,
        body.expectedVersion,
      );
      await audit(actor, 'type_policy.attachments.updated', 'type_policy_scope', scopeId, {
        projectId: scope.projectId,
        policyIds: scope.attachments.map((a) => a.policyId),
        version: scope.version,
      });
      return scope.attachments;
    },
  };
}

/** every loaded type of one kind, in name order (a hidden node type is not offered) */
function loadedTypes(ctx: ServerContext, kind: PolicyKind): string[] {
  const { registries } = ctx;
  const names =
    kind === 'node'
      ? registries.nodeTypes
          .list()
          .filter((type) => !type.description.hidden)
          .map((type) => type.description.name)
      : registries.credentialTypes.list().map((type) => type.name);
  return [...new Set(names)].sort();
}

/** the types a credential type extends, nearest first */
function ancestorsOf(ctx: ServerContext, type: string): string[] {
  const registry = ctx.registries.credentialTypes;
  const found: string[] = [];
  const queue = [...(registry.get(type)?.extends ?? [])];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    if (parent === type || found.includes(parent)) continue;
    found.push(parent);
    queue.push(...(registry.get(parent)?.extends ?? []));
  }
  return found;
}

/**
 * Would `sub` start: its node and credential types judged as a start under `projectId`, with no audit row (a
 * preview refuses nothing). The same decision as enforcement: the workspace scope composed with the project's.
 * The caller passes the sub-workflow's own project, because the run gate judges a sub-run under the project of
 * the workflow it runs, not the project of the workflow that calls it.
 */
async function previewStart(
  ctx: ServerContext,
  tenantId: string,
  projectId: string,
  sub: { nodes: unknown },
): Promise<TypePolicyViolation[]> {
  const { policySnapshots } = ctx;
  const snapshot = await policySnapshots.forTenant(tenantId);
  const decide = (kind: PolicyKind, type: string): TypeDecision => {
    const facts = policySnapshots.factsFor(
      snapshot,
      kind,
      type,
      kind === 'credential' ? ancestorsOf(ctx, type) : undefined,
    );
    const workspace = evaluateScope(snapshot.workspace[kind], type, facts);
    const scope = snapshot.projects[kind].get(projectId);
    return composeDecisions(workspace, scope ? evaluateScope(scope, type, facts) : undefined);
  };
  const violations: TypePolicyViolation[] = [];
  const seen = new Set<string>();
  const check = (kind: PolicyKind, type: string, nodeName: string) => {
    const key = `${kind}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const decision = decide(kind, type);
    if (decision.action === 'allow') return;
    violations.push({
      kind: kind === 'credential' ? 'credential-type-unavailable' : 'node-type-unavailable',
      type,
      scope: decision.scope,
      matchedRuleId: decision.matchedRuleId,
      optInAvailable: decision.optInAvailable,
      nodeName,
    });
  };
  const nodes = (Array.isArray(sub.nodes) ? sub.nodes : []) as Array<{
    name?: string;
    type?: string;
    credentials?: Record<string, unknown>;
  }>;
  for (const node of nodes) if (typeof node.type === 'string') check('node', node.type, node.name ?? '');
  for (const node of nodes) {
    for (const type of Object.keys(node.credentials ?? {})) check('credential', type, node.name ?? '');
  }
  return violations;
}

export function registerTypePolicyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  for (const { base, scope, kind } of POLICY_BASES) {
    const ops = typePolicyOps(ctx, kind);
    const actorOf = (auth: { tenant: { id: string }; user: { id: string } }, ip: string): PolicyActor => ({
      tenantId: auth.tenant.id,
      userId: auth.user.id,
      ip,
    });
    // the workspace scope: default action and its attachments
    app.get(`${base}/instance`, async (request) => {
      const auth = await requireScope(request, scope);
      return { data: await ops.getScope(auth.tenant.id, null) };
    });
    app.put(`${base}/instance`, async (request) => {
      const auth = await requireScope(request, scope);
      return { data: await ops.putScope(actorOf(auth, request.ip), null, request.body) };
    });
    // the policy documents
    app.get(`${base}/policies`, async (request) => {
      const auth = await requireScope(request, scope);
      return { data: await ops.listPolicies(auth.tenant.id) };
    });
    app.post(`${base}/policies`, async (request) => {
      const auth = await requireScope(request, scope);
      return { data: await ops.createPolicy(actorOf(auth, request.ip), request.body) };
    });
    app.get(`${base}/policies/:policyId`, async (request) => {
      const auth = await requireScope(request, scope);
      const { policyId } = request.params as { policyId: string };
      return { data: await ops.getPolicy(auth.tenant.id, policyId) };
    });
    app.patch(`${base}/policies/:policyId`, async (request) => {
      const auth = await requireScope(request, scope);
      const { policyId } = request.params as { policyId: string };
      return { data: await ops.updatePolicy(actorOf(auth, request.ip), policyId, request.body) };
    });
    app.delete(`${base}/policies/:policyId`, async (request) => {
      const auth = await requireScope(request, scope);
      const { policyId } = request.params as { policyId: string };
      return { data: await ops.deletePolicy(actorOf(auth, request.ip), policyId, request.query) };
    });
    // the policies attached to one scope (workspace or project), with priority and floor
    app.get(`${base}/scopes/:scopeId/attachments`, async (request) => {
      const auth = await requireScope(request, scope);
      const { scopeId } = request.params as { scopeId: string };
      return { data: await ops.getAttachments(auth.tenant.id, scopeId) };
    });
    app.put(`${base}/scopes/:scopeId/attachments`, async (request) => {
      const auth = await requireScope(request, scope);
      const { scopeId } = request.params as { scopeId: string };
      return { data: await ops.putAttachments(actorOf(auth, request.ip), scopeId, request.body) };
    });
  }

  // the node and credential types a project may use (n8n: available-types.controller.ts, `project:read`)
  const available = (kind: PolicyKind) => async (request: FastifyRequest) => {
    const { projectId } = request.params as { projectId: string };
    const auth = await requireScope(request, 'project:read', { projectId });
    if (!(await ctx.repos.projects.get(auth.tenant.id, projectId))) throw ApiError.notFound('Project');
    return {
      data: await filterAvailable(ctx.serviceDeps, auth.tenant.id, projectId, kind, loadedTypes(ctx, kind)),
    };
  };
  app.get('/projects/:projectId/available-types', available('node'));
  app.get('/projects/:projectId/available-credential-types', available('credential'));

  // may this workflow start that sub-workflow (n8n: sub-workflow-policy-check.controller.ts, `workflow:update`);
  // a sub-workflow the caller cannot read is 404, so the answer hides whether it exists
  app.get('/workflows/:id/sub-workflows/:subId/policy-check', async (request) => {
    const { id, subId } = request.params as { id: string; subId: string };
    const auth = await requireScope(request, 'workflow:update', { workflowId: id });
    const tenantId = auth.tenant.id;
    const caller = await ctx.repos.workflows.get(tenantId, id);
    const sub = await ctx.repos.workflows.get(tenantId, subId);
    if (!caller || !sub) throw ApiError.notFound('Workflow');
    const held = await request.server.access.scopesForAuth(auth, { workflowId: sub.id });
    if (!held.has('workflow:read')) throw ApiError.notFound('Workflow');
    const violations = await previewStart(ctx, tenantId, sub.projectId, sub);
    return { data: { allowed: violations.length === 0, violations } };
  });
}
