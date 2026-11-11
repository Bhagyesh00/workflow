/**
 * P6-50 (L5): the demo's node and credential type policies as the editor reads them: the types a project may use
 * (`/projects/:projectId/available-types`, `/available-credential-types`), the sub-workflow policy check, and
 * `restrictedDemoTypes`, the types GET /workflows `executionBlockedBy=restrictedNode` looks for.
 *
 * The editor has no policy page (the documents are written through the public API), so a fresh demo blocks
 * nothing. `denyDemoTypes` and `allowDemoTypes` keep the demo's blocked types: a workspace list and a list per
 * project, for a node kind and a credential kind each. Tests and the demo call them.
 */
import type { AvailableType, SubWorkflowPolicyCheck, TypePolicyViolation } from '../api/types';
import { demoCredentialTypes, demoNodeTypes } from './fixtures';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

/** which policy a type belongs to (the server's `restrictedTypes(deps, tenantId, projectId, kind)`) */
export type DemoPolicyKind = 'node' | 'credential';

interface DemoPolicy {
  /** blocked in the whole workspace */
  workspace: Record<DemoPolicyKind, Set<string>>;
  /** blocked in one project */
  projects: Map<string, Record<DemoPolicyKind, Set<string>>>;
}

const policies = new WeakMap<MockBackend, Map<string, DemoPolicy>>();

const emptyKinds = (): Record<DemoPolicyKind, Set<string>> => ({
  node: new Set(),
  credential: new Set(),
});

function policyOf(backend: MockBackend, tenantId: string): DemoPolicy {
  let byTenant = policies.get(backend);
  if (!byTenant) {
    byTenant = new Map();
    policies.set(backend, byTenant);
  }
  let policy = byTenant.get(tenantId);
  if (!policy) {
    policy = { workspace: emptyKinds(), projects: new Map() };
    byTenant.set(tenantId, policy);
  }
  return policy;
}

function listOf(
  backend: MockBackend,
  tenantId: string,
  kind: DemoPolicyKind,
  projectId: string | null | undefined,
): Set<string> {
  const policy = policyOf(backend, tenantId);
  if (!projectId) return policy.workspace[kind];
  let kinds = policy.projects.get(projectId);
  if (!kinds) {
    kinds = emptyKinds();
    policy.projects.set(projectId, kinds);
  }
  return kinds[kind];
}

/** Block `types` (a node or credential kind) in the workspace, or only in `options.projectId`. */
export function denyDemoTypes(
  backend: MockBackend,
  tenantId: string,
  types: readonly string[],
  options: { kind?: DemoPolicyKind; projectId?: string | null } = {},
): void {
  const list = listOf(backend, tenantId, options.kind ?? 'node', options.projectId);
  for (const type of types) list.add(type);
}

/** Lift the block of `types` in the workspace, or in `options.projectId`. */
export function allowDemoTypes(
  backend: MockBackend,
  tenantId: string,
  types: readonly string[],
  options: { kind?: DemoPolicyKind; projectId?: string | null } = {},
): void {
  const list = listOf(backend, tenantId, options.kind ?? 'node', options.projectId);
  for (const type of types) list.delete(type);
}

/**
 * The types the workspace's (and the project's) policy blocks, for GET /workflows `executionBlockedBy`.
 */
export function restrictedDemoTypes(
  backend: MockBackend,
  tenantId: string,
  projectId: string | null | undefined,
  kind: DemoPolicyKind = 'node',
): string[] {
  const policy = policyOf(backend, tenantId);
  const blocked = new Set(policy.workspace[kind]);
  if (projectId) for (const type of policy.projects.get(projectId)?.[kind] ?? []) blocked.add(type);
  return [...blocked];
}

/** the scope that blocks `type` for `projectId` (the workspace's wins), if any */
function blockedBy(
  backend: MockBackend,
  tenantId: string,
  projectId: string | null | undefined,
  kind: DemoPolicyKind,
  type: string,
): 'workspace' | 'project' | undefined {
  const policy = policyOf(backend, tenantId);
  if (policy.workspace[kind].has(type)) return 'workspace';
  if (projectId && policy.projects.get(projectId)?.[kind].has(type)) return 'project';
  return undefined;
}

function rowsFor(
  backend: MockBackend,
  tenantId: string,
  projectId: string,
  kind: DemoPolicyKind,
): AvailableType[] {
  const names =
    kind === 'node'
      ? demoNodeTypes.filter((d) => !d.hidden).map((d) => d.name)
      : demoCredentialTypes.map((d) => d.name);
  return names.map((type) => {
    const scope = blockedBy(backend, tenantId, projectId, kind, type);
    return scope
      ? { type, available: false, reason: 'blocked by a policy', scope, optInAvailable: false }
      : { type, available: true };
  });
}

export function registerTypePolicyRoutes(backend: MockBackend): void {
  const project = (id: string) => {
    const { tenant } = backend.auth();
    const found = backend.projects.find((p) => p.id === id && p.tenantId === tenant.id);
    if (!found) throw new HttpError(404, 'not_found', 'Project not found');
    backend.requireScope('project:read', { scopes: backend.projectScopes(found) });
    return { tenantId: tenant.id, projectId: found.id };
  };
  backend.on('GET', '/projects/:projectId/available-types', ({ params }) => {
    const target = project(params[0]);
    return rowsFor(backend, target.tenantId, target.projectId, 'node');
  });
  backend.on('GET', '/projects/:projectId/available-credential-types', ({ params }) => {
    const target = project(params[0]);
    return rowsFor(backend, target.tenantId, target.projectId, 'credential');
  });
  // would the sub-workflow start from the calling workflow's project: its node types must be allowed there
  backend.on(
    'GET',
    '/workflows/:id/sub-workflows/:subId/policy-check',
    ({ params }): SubWorkflowPolicyCheck => {
      const caller = backend.workflow(params[0]);
      backend.requireScope('workflow:update', { scopes: backend.rowScopes(caller) });
      const sub = backend.workflow(params[1]);
      const violations: TypePolicyViolation[] = [];
      for (const node of sub.nodes) {
        const scope = blockedBy(backend, sub.tenantId, caller.projectId, 'node', node.type);
        if (!scope) continue;
        violations.push({
          kind: 'node-type-unavailable',
          type: node.type,
          scope,
          matchedRuleId: null,
          optInAvailable: false,
          nodeName: node.name,
        });
      }
      return { allowed: violations.length === 0, violations };
    },
  );
}
