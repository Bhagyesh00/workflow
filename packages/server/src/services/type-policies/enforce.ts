/**
 * P6-04 (L2): enforcement of the type availability policies at every point (C0d1 and C0d2 wired the calls).
 * Save judges only the types the save adds against `stored` (disabled nodes count; a copy adds nothing);
 * publish, start, transfer and import judge the whole workflow, its node types and its nodes' credential
 * types; `credentialSave` refuses creating a blocked type and keeps edits of an existing one;
 * `checkSingleNode` judges the node type and its credential types before any decrypt. A refusal throws
 * `PolicyViolationError` (403); a check that fails or misses its deadline (`ENFORCEMENT_DEADLINE_MS`: start
 * and decrypt 250 ms, the others 1000 ms) throws `PolicyCheckFailedError` (503), never a pass. One audit row
 * `policy.blocked` (point, type, scope) per refusal, with no workflow data. `projectId` null: the workspace
 * scope only. A type's decision is the workspace's composed with the project's (`composeDecisions`); a
 * project denial says `scope: 'project'` and never names the project.
 */
import type { ServiceDeps } from '../../context';
import { composeDecisions } from './compose';
import { PolicyCheckFailedError, PolicyViolationError, violationMessage } from './errors';
import { evaluateScope } from './evaluator';
import {
  type AvailableType,
  ENFORCEMENT_DEADLINE_MS,
  type EnforcementPoint,
  type PolicyKind,
  type PolicyWorkflow,
  type TransferResource,
  type TypeDecision,
  type TypePolicyViolation,
} from './types';

/** one type to judge, with the node that uses it (a workflow check) */
interface Wanted {
  kind: PolicyKind;
  type: string;
  nodeName?: string;
}

/** the reason of a check that missed its deadline */
const DEADLINE_MISSED = 'deadline missed';

type Decide = (kind: PolicyKind, type: string) => TypeDecision;

/** the types a credential type extends, nearest first (`CredentialTypes` `extends`, followed through) */
function ancestorsOf(deps: ServiceDeps, type: string): string[] {
  const registry = deps.context().registries.credentialTypes;
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

/** the decision function of one tenant's snapshot in one project (or the workspace when `projectId` is null) */
async function decider(deps: ServiceDeps, tenantId: string, projectId: string | null): Promise<Decide> {
  const snapshots = deps.context().policySnapshots;
  const snapshot = await snapshots.forTenant(tenantId);
  return (kind, type) => {
    const ancestors = kind === 'credential' ? ancestorsOf(deps, type) : undefined;
    const facts = snapshots.factsFor(snapshot, kind, type, ancestors);
    const workspace = evaluateScope(snapshot.workspace[kind], type, facts);
    const scope = projectId === null ? undefined : snapshot.projects[kind].get(projectId);
    return composeDecisions(workspace, scope ? evaluateScope(scope, type, facts) : undefined);
  };
}

/** only `allow` lets a type through: a `delegate` no project rule met denies */
const isAllowed = (decision: TypeDecision) => decision.action === 'allow';

function violationOf(wanted: Wanted, decision: TypeDecision): TypePolicyViolation {
  return {
    kind: wanted.kind === 'credential' ? 'credential-type-unavailable' : 'node-type-unavailable',
    type: wanted.type,
    scope: decision.scope,
    matchedRuleId: decision.matchedRuleId,
    optInAvailable: decision.optInAvailable,
    ...(wanted.nodeName !== undefined ? { nodeName: wanted.nodeName } : {}),
  };
}

/**
 * Judges `wanted` within the point's deadline. Answers the violations (empty: all allowed). Any failure, the
 * deadline included, is a `PolicyCheckFailedError`: a check that cannot decide blocks.
 */
async function judge(
  deps: ServiceDeps,
  point: EnforcementPoint,
  tenantId: string,
  projectId: string | null,
  wanted: readonly Wanted[],
): Promise<TypePolicyViolation[]> {
  if (wanted.length === 0) return [];
  const work = (async () => {
    const decide = await decider(deps, tenantId, projectId);
    const violations: TypePolicyViolation[] = [];
    for (const item of wanted) {
      const decision = decide(item.kind, item.type);
      if (!isAllowed(decision)) violations.push(violationOf(item, decision));
    }
    return violations;
  })();
  // the deadline (start and decrypt 250 ms, the others 1000 ms): whichever settles first decides, and a
  // failure or a miss is a `PolicyCheckFailedError`, never a pass
  const ms = ENFORCEMENT_DEADLINE_MS[point];
  try {
    return await new Promise<TypePolicyViolation[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PolicyCheckFailedError(point, DEADLINE_MISSED)), ms);
      timer.unref?.();
      work.then(
        (violations) => {
          clearTimeout(timer);
          resolve(violations);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(new PolicyCheckFailedError(point, error));
        },
      );
    });
  } catch (error) {
    const failure =
      error instanceof PolicyCheckFailedError ? error : new PolicyCheckFailedError(point, error);
    deps.logger.warn(
      { tenantId, point, deadlineMissed: failure.reason === DEADLINE_MISSED },
      'The type policy check failed, so the action was blocked',
    );
    throw failure;
  }
}

/** writes the refusal's audit row (point, types, scopes; no workflow data) and throws the violation */
async function refuse(
  deps: ServiceDeps,
  point: EnforcementPoint,
  tenantId: string,
  violations: TypePolicyViolation[],
): Promise<never> {
  const [first] = violations;
  const refusal = new PolicyViolationError(violations);
  try {
    await deps.repos.audit.add(tenantId, {
      action: 'policy.blocked',
      metadata: {
        point,
        type: first.type,
        scope: first.scope,
        blocked: violations.map(({ kind, type, scope }) => ({ kind, type, scope })),
      },
    });
  } catch {
    // the refusal stands even when its audit row could not be written
    deps.logger.warn({ tenantId, point }, 'The audit row of a type policy refusal could not be written');
    throw refusal;
  }
  throw refusal;
}

/** each type once, in node order, with the first node that uses it; `credentials` adds the nodes' credential types */
function typesOf(workflow: PolicyWorkflow, credentials: boolean): Wanted[] {
  const nodes = new Map<string, Wanted>();
  const credentialTypes = new Map<string, Wanted>();
  for (const item of workflow.nodes) {
    if (!nodes.has(item.type)) nodes.set(item.type, { kind: 'node', type: item.type, nodeName: item.name });
    if (!credentials) continue;
    for (const type of Object.keys(item.credentials ?? {})) {
      if (!credentialTypes.has(type))
        credentialTypes.set(type, { kind: 'credential', type, nodeName: item.name });
    }
  }
  return [...nodes.values(), ...credentialTypes.values()];
}

/** the node types a save adds to `stored` (type level: a copy or a rename of a type it has adds nothing) */
function addedTypes(workflow: PolicyWorkflow, stored: PolicyWorkflow | null | undefined): Wanted[] {
  const had = new Set((stored?.nodes ?? []).map((item) => item.type));
  return typesOf(workflow, false).filter((wanted) => !had.has(wanted.type));
}

export async function evaluateWorkflow(
  deps: ServiceDeps,
  point: EnforcementPoint,
  input: {
    tenantId: string;
    projectId: string | null;
    workflow: PolicyWorkflow;
    /** the stored workflow at a save: only the types the save adds are judged */
    stored?: PolicyWorkflow | null;
  },
): Promise<void> {
  const wanted =
    point === 'workflowSave' ? addedTypes(input.workflow, input.stored) : typesOf(input.workflow, true);
  const violations = await judge(deps, point, input.tenantId, input.projectId, wanted);
  if (violations.length > 0) await refuse(deps, point, input.tenantId, violations);
}

export async function assertCredentialType(
  deps: ServiceDeps,
  point: EnforcementPoint,
  input: {
    tenantId: string;
    projectId: string | null;
    /** the credential type name */
    type: string;
    /** a create (refused when blocked); an edit of an existing credential is kept */
    isNew?: boolean;
  },
): Promise<void> {
  // an edit of an existing credential is kept at a save; a move or a decrypt judges it
  if (point === 'credentialSave' && input.isNew === false) return;
  const violations = await judge(deps, point, input.tenantId, input.projectId, [
    { kind: 'credential', type: input.type },
  ]);
  if (violations.length > 0) await refuse(deps, point, input.tenantId, violations);
}

/** the given types with their availability in the project (or the workspace when `projectId` is null) */
export async function filterAvailable(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | null,
  kind: PolicyKind,
  types: readonly string[],
): Promise<AvailableType[]> {
  const decide = await decider(deps, tenantId, projectId);
  return types.map((type) => {
    const decision = decide(kind, type);
    if (isAllowed(decision)) return { type, available: true };
    return {
      type,
      available: false,
      reason: violationMessage([violationOf({ kind, type }, decision)]),
      scope: decision.scope,
      optInAvailable: decision.optInAvailable,
    };
  });
}

/** the types blocked in the project (the workflow list's `executionBlockedBy=restrictedNode`) */
export async function restrictedTypes(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | null,
  kind: PolicyKind,
): Promise<string[]> {
  const { registries, policySnapshots } = deps.context();
  const snapshot = await policySnapshots.forTenant(tenantId);
  // the loaded types, plus every type a `name` rule of this kind names (a saved workflow may hold a type
  // that is not loaded)
  const candidates = new Set<string>(
    kind === 'node'
      ? registries.nodeTypes.list().map((type) => type.description.name)
      : registries.credentialTypes.list().map((type) => type.name),
  );
  for (const document of snapshot.policies.values()) {
    if (document.kind !== kind) continue;
    for (const rule of document.rules)
      if (rule.selector.name !== undefined) candidates.add(rule.selector.name);
  }
  const rows = await filterAvailable(deps, tenantId, projectId, kind, [...candidates]);
  return rows
    .filter((row) => !row.available)
    .map((row) => row.type)
    .sort();
}

/** a move into `targetProjectId` (P6-51: move routes, project delete with transfer, `requireTarget`) */
export async function assertTransferAllowed(
  deps: ServiceDeps,
  tenantId: string,
  targetProjectId: string,
  resource: TransferResource,
): Promise<void> {
  if (resource.kind === 'workflow') {
    await evaluateWorkflow(deps, 'workflowTransfer', {
      tenantId,
      projectId: targetProjectId,
      workflow: resource.workflow,
    });
    return;
  }
  await assertCredentialType(deps, 'credentialTransfer', {
    tenantId,
    projectId: targetProjectId,
    type: resource.credentialType,
  });
}

/** one node run outside `run` (options loading, `execute_node`, MCP `explore_node_resources`, a dataset row) */
export async function checkSingleNode(
  deps: ServiceDeps,
  input: {
    tenantId: string;
    projectId: string | null;
    nodeType: string;
    /** the credential types the node will decrypt */
    credentialTypes: readonly string[];
  },
): Promise<void> {
  const wanted: Wanted[] = [{ kind: 'node', type: input.nodeType }];
  for (const type of new Set(input.credentialTypes)) wanted.push({ kind: 'credential', type });
  const point: EnforcementPoint = 'credentialDecrypt';
  const violations = await judge(deps, point, input.tenantId, input.projectId, wanted);
  if (violations.length > 0) await refuse(deps, point, input.tenantId, violations);
}
