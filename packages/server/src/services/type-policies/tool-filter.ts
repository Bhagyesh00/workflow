/**
 * P6-55 (L10): the type policies in the AI tools (builder, MCP, Assistant). `restrictedNodeTypesView` is a
 * registry view that hides the restricted node types, passed to `searchNodes` and `nodeDetails` (their
 * signatures stay); `policyIssues` gives a definition's violations as validation issues (C0d2 wires it into
 * `WorkflowService.validate`), so a model retries; writes still meet the 403 of the save check.
 * `projectId` null: the workspace scope.
 * Stub from C0: both PASS (no issue, the registry unchanged) until L10.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { ServiceDeps } from '../../context';
import type { PolicyWorkflow, TypePolicyViolation } from './types';

export async function policyIssues(
  _deps: ServiceDeps,
  _tenantId: string,
  _projectId: string | null,
  _definition: PolicyWorkflow,
  /** the stored workflow: as at a save, only added types are judged */
  _stored?: PolicyWorkflow | null,
): Promise<TypePolicyViolation[]> {
  // stub (L10): PASSES, no issue
  return [];
}

export async function restrictedNodeTypesView(
  _deps: ServiceDeps,
  _tenantId: string,
  _projectId: string | null,
  nodeTypes: NodeTypeRegistry,
): Promise<NodeTypeRegistry> {
  // stub (L10): PASSES, the registry unchanged
  return nodeTypes;
}
