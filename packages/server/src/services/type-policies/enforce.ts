/**
 * P6-04 (L2): enforcement of the type availability policies at every point (C0d1 and C0d2 wired the calls).
 * Save judges only the types the save adds against `stored` (disabled nodes count; a copy adds nothing);
 * publish, start, transfer and import judge the whole workflow; run start also judges each node's
 * credential types; `credentialSave` refuses creating a blocked type and keeps edits of an existing one;
 * `checkSingleNode` judges the node type and its credential types before any decrypt. A refusal throws
 * `PolicyViolationError` (403); a check that fails or misses its deadline (`ENFORCEMENT_DEADLINE_MS`) throws
 * `PolicyCheckFailedError` (503). One audit row `policy.blocked` (point, type, scope) per refusal.
 * `projectId` null: the workspace scope only.
 * Stub from C0: every function PASSES (allows everything) until L2, because saves, publishes, runs and
 * reads call them today.
 */
import type { ServiceDeps } from '../../context';
import type { AvailableType, EnforcementPoint, PolicyKind, PolicyWorkflow, TransferResource } from './types';

export async function evaluateWorkflow(
  _deps: ServiceDeps,
  _point: EnforcementPoint,
  _input: {
    tenantId: string;
    projectId: string | null;
    workflow: PolicyWorkflow;
    /** the stored workflow at a save: only the types the save adds are judged */
    stored?: PolicyWorkflow | null;
  },
): Promise<void> {
  // stub (L2): PASSES
}

export async function assertCredentialType(
  _deps: ServiceDeps,
  _point: EnforcementPoint,
  _input: {
    tenantId: string;
    projectId: string | null;
    /** the credential type name */
    type: string;
    /** a create (refused when blocked); an edit of an existing credential is kept */
    isNew?: boolean;
  },
): Promise<void> {
  // stub (L2): PASSES
}

/** the given types with their availability in the project (or the workspace when `projectId` is null) */
export async function filterAvailable(
  _deps: ServiceDeps,
  _tenantId: string,
  _projectId: string | null,
  _kind: PolicyKind,
  types: readonly string[],
): Promise<AvailableType[]> {
  // stub (L2): PASSES, every type available
  return types.map((type) => ({ type, available: true }));
}

/** the types blocked in the project (the workflow list's `executionBlockedBy=restrictedNode`) */
export async function restrictedTypes(
  _deps: ServiceDeps,
  _tenantId: string,
  _projectId: string | null,
  _kind: PolicyKind,
): Promise<string[]> {
  // stub (L2): PASSES, nothing blocked
  return [];
}

/** a move into `targetProjectId` (P6-51: move routes, project delete with transfer, `requireTarget`) */
export async function assertTransferAllowed(
  _deps: ServiceDeps,
  _tenantId: string,
  _targetProjectId: string,
  _resource: TransferResource,
): Promise<void> {
  // stub (L2): PASSES
}

/** one node run outside `run` (options loading, `execute_node`, MCP `explore_node_resources`, a dataset row) */
export async function checkSingleNode(
  _deps: ServiceDeps,
  _input: {
    tenantId: string;
    projectId: string | null;
    nodeType: string;
    /** the credential types the node will decrypt */
    credentialTypes: readonly string[];
  },
): Promise<void> {
  // stub (L2): PASSES
}
