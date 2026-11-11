/**
 * P6-55 (L10): the type policies in the AI tools (builder, MCP, Assistant). `restrictedNodeTypesView` is a
 * registry view that hides the restricted node types, passed to `searchNodes` and `nodeDetails` (their
 * signatures stay), so a model is never offered a blocked node; `policyIssues` gives a definition's
 * violations as validation issues (C0d2 wires it into `WorkflowService.validate`; the builder's and MCP's
 * `validateDefinition` and `validate_node_config` add it), so a model retries. Writes still meet the 403 of
 * the save check, which stays the last gate. `projectId` null: the workspace scope.
 * A check that cannot decide (a failure or a missed deadline) throws `PolicyCheckFailedError`: it never passes.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { ServiceDeps } from '../../context';
import { filterAvailable } from './enforce';
import { PolicyCheckFailedError } from './errors';
import {
  ENFORCEMENT_DEADLINE_MS,
  type PolicyKind,
  type PolicyWorkflow,
  type TypePolicyViolation,
} from './types';

/** the types of `kind` that are blocked in the scope, within the save deadline; fail closed */
async function blockedAmong(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | null,
  kind: PolicyKind,
  types: readonly string[],
) {
  if (types.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      filterAvailable(deps, tenantId, projectId, kind, types),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('deadline missed')), ENFORCEMENT_DEADLINE_MS.workflowSave);
        timer.unref?.();
      }),
    ]);
    return rows.filter((row) => !row.available);
  } catch (error) {
    deps.logger.warn({ tenantId, point: 'workflowSave' }, 'The type policy check of an AI tool failed');
    throw new PolicyCheckFailedError('workflowSave', error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** the project a workflow is in, or null (the workspace scope) when none is given or it is not found */
export async function workflowProjectId(
  deps: ServiceDeps,
  tenantId: string,
  workflowId: string | undefined,
): Promise<string | null> {
  if (!workflowId) return null;
  const row = await deps.repos.workflows.get(tenantId, workflowId);
  return row?.projectId ?? null;
}

/**
 * The violations of a definition, for a validator. With `stored` (as at a save) only the node types the
 * definition adds are judged; without it the whole definition is, its nodes' credential types too (as at a
 * publish). A disabled node counts.
 */
export async function policyIssues(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | null,
  definition: PolicyWorkflow,
  /** the stored workflow: as at a save, only added types are judged */
  stored?: PolicyWorkflow | null,
): Promise<TypePolicyViolation[]> {
  const had = new Set((stored?.nodes ?? []).map((node) => node.type));
  const firstNode = new Map<string, string>();
  const firstCredential = new Map<string, string>();
  for (const node of definition.nodes) {
    if (!had.has(node.type) && !firstNode.has(node.type)) firstNode.set(node.type, node.name);
    if (stored) continue;
    for (const type of Object.keys(node.credentials ?? {}))
      if (!firstCredential.has(type)) firstCredential.set(type, node.name);
  }
  const [nodes, credentials] = await Promise.all([
    blockedAmong(deps, tenantId, projectId, 'node', [...firstNode.keys()]),
    blockedAmong(deps, tenantId, projectId, 'credential', [...firstCredential.keys()]),
  ]);
  const violation = (
    kind: PolicyKind,
    row: (typeof nodes)[number],
    nodeName: string | undefined,
  ): TypePolicyViolation => ({
    kind: kind === 'credential' ? 'credential-type-unavailable' : 'node-type-unavailable',
    type: row.type,
    scope: row.scope ?? 'workspace',
    matchedRuleId: null,
    optInAvailable: row.optInAvailable ?? false,
    ...(nodeName !== undefined ? { nodeName } : {}),
  });
  return [
    ...nodes.map((row) => violation('node', row, firstNode.get(row.type))),
    ...credentials.map((row) => violation('credential', row, firstCredential.get(row.type))),
  ];
}

/**
 * The registry without the node types the policies block in the scope: `list` leaves them out and `get`
 * does not find them, so `searchNodes` and `nodeDetails` never offer one.
 */
export async function restrictedNodeTypesView(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | null,
  nodeTypes: NodeTypeRegistry,
): Promise<NodeTypeRegistry> {
  const blocked = new Set(
    (
      await blockedAmong(
        deps,
        tenantId,
        projectId,
        'node',
        nodeTypes.list().map((type) => type.description.name),
      )
    ).map((row) => row.type),
  );
  if (blocked.size === 0) return nodeTypes;
  return {
    get: (type) => (blocked.has(type) ? undefined : nodeTypes.get(type)),
    list: () => nodeTypes.list().filter((type) => !blocked.has(type.description.name)),
  };
}
