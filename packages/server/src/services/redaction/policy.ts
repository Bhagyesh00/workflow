/**
 * P6-53 (L8): the execution data redaction policy on the write and run side.
 * - `assertRedactionChange`: a workflow's `redactionPolicy` may not be weaker than the workspace floor (422
 *   "Workflow redaction policy cannot be weaker than the workspace floor."; a legacy workflow below the floor
 *   still saves unchanged); raising needs `workflow:enableRedaction`, lowering `workflow:disableRedaction`
 *   (read through `scopesFor`); `redactCallerExecutions` is judged the same way. An actor with no `userId`
 *   is a server path: no scope read, the floor still holds.
 * - `seedRedactionSettings`: a new workflow's settings seeded from the floor.
 * - `snapshotRedaction`: the run's channels at start (`StoredRunOptions.redaction`); a sub-run takes the
 *   strictest of its own and its parent's.
 * - `pushableTaskData`, `pushableError`: what the manual push may carry once a channel is on (the run's
 *   snapshot merged with `reportedChannels(state.resultData.runData)`).
 * The clearing helpers at the end are shared with read.ts.
 */
import {
  type ExecutionErrorShape,
  type ExecutionState,
  floorToChannels,
  isWeakerThanFloor,
  mergeChannels,
  policyToChannels,
  type ConnectionType,
  type RedactionChannels,
  type RedactionFloor,
  type RedactionPolicy,
  reportedChannels,
  type TaskData,
  type WorkflowDefinition,
  type WorkflowSettings,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TenantRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { MISSING_SCOPE_MESSAGE } from '../access';

/** who changes the settings: the workspace, and the user (absent on a server path) */
export interface RedactionActor {
  tenantId: string;
  userId?: string;
  /**
   * the project a create goes to, when the caller knows it: the scope is then read there. A create with no
   * project is judged by the scopes the user holds in any of their projects.
   */
  projectId?: string;
}

/** the run's channels at start, kept in `StoredRunOptions.redaction` */
export type RedactionSnapshot = RedactionChannels & { reason?: string };

/** the tenant fields the floor is read from */
export type RedactionTenant = Pick<TenantRow, 'id' | 'settings'>;

/** n8n's text for a policy below the floor */
export const FLOOR_MESSAGE = 'Workflow redaction policy cannot be weaker than the workspace floor.';

/** why a run is redacted: its own policy or floor, or a sub-workflow's */
export const REASON_WORKFLOW = 'workflow_redaction_policy';
export const REASON_SUB_WORKFLOW = 'sub_workflow_redaction_policy';

const POLICIES: readonly RedactionPolicy[] = ['none', 'manual-only', 'non-manual', 'all'];
const FLOORS: readonly RedactionFloor[] = ['off', 'production', 'all'];

/** the floor stored in the tenant settings (an unknown value reads as off) */
export function floorOf(tenant: Pick<TenantRow, 'settings'> | undefined | null): RedactionFloor {
  const floor = (tenant?.settings as { redactionFloor?: unknown } | undefined)?.redactionFloor;
  return FLOORS.includes(floor as RedactionFloor) ? (floor as RedactionFloor) : 'off';
}

/** a stored policy value; anything else is no policy */
function policyOf(settings: WorkflowSettings | null | undefined): RedactionPolicy | undefined {
  const policy = settings?.redactionPolicy;
  return POLICIES.includes(policy as RedactionPolicy) ? policy : undefined;
}

/** `redactCallerExecutions` is on unless it is `false` */
const callerRedactOf = (settings: WorkflowSettings | null | undefined) =>
  settings?.redactCallerExecutions !== false;

const sameChannels = (a: RedactionChannels, b: RedactionChannels) =>
  a.production === b.production && a.manual === b.manual;

/** the scopes the user holds for a change: on the workflow, or (a create, no row yet) anywhere they have one */
async function holdsScopes(
  deps: ServiceDeps,
  actor: RedactionActor & { userId: string },
  workflowId: string | null | undefined,
  wanted: Array<'workflow:enableRedaction' | 'workflow:disableRedaction'>,
): Promise<boolean> {
  const { access } = deps.context();
  const { tenantId, userId } = actor;
  if (workflowId) {
    const held = await access.scopesFor(tenantId, userId, { workflowId });
    return wanted.every((scope) => held.has(scope));
  }
  if (actor.projectId) {
    const held = await access.scopesFor(tenantId, userId, { projectId: actor.projectId });
    return wanted.every((scope) => held.has(scope));
  }
  const membership = await deps.repos.memberships.get(tenantId, userId);
  if (!membership) return false;
  const global = await access.globalScopes(tenantId, membership.role);
  const missing = wanted.filter((scope) => !global.has(scope));
  if (!missing.length) return true;
  for (const relation of await deps.repos.projects.relations.listForUser(tenantId, userId)) {
    const scopes = await access.projectRoleScopes(tenantId, relation.role);
    if (missing.every((scope) => scopes.has(scope))) return true;
  }
  return false;
}

export async function assertRedactionChange(
  deps: ServiceDeps,
  actor: RedactionActor,
  /** null on a create (no id yet) */
  workflowId: string | null | undefined,
  before: WorkflowSettings | null | undefined,
  after: WorkflowSettings | null | undefined,
): Promise<void> {
  const beforeChannels = policyToChannels(policyOf(before));
  const afterPolicy = policyOf(after);
  const afterChannels = policyToChannels(afterPolicy);
  const beforeCaller = callerRedactOf(before);
  const afterCaller = callerRedactOf(after);

  // the floor: the policy being saved may not redact less than it, unless it is the workflow's own unchanged
  // legacy value (a create has no legacy value: an explicit policy is judged, no policy is seeded later)
  const floor = floorOf(await deps.repos.tenants.get(actor.tenantId));
  const creating = !workflowId;
  const changed = creating ? afterPolicy !== undefined : !sameChannels(beforeChannels, afterChannels);
  if (changed && isWeakerThanFloor(afterPolicy, floor)) {
    throw new ApiError(422, 'REDACTION_BELOW_FLOOR', FLOOR_MESSAGE);
  }

  if (!actor.userId) return; // a server path: no scope read
  const raising =
    (afterChannels.production && !beforeChannels.production) ||
    (afterChannels.manual && !beforeChannels.manual) ||
    (afterCaller && !beforeCaller);
  const lowering =
    (!afterChannels.production && beforeChannels.production) ||
    (!afterChannels.manual && beforeChannels.manual) ||
    (!afterCaller && beforeCaller);
  if (!raising && !lowering) return;
  const wanted: Array<'workflow:enableRedaction' | 'workflow:disableRedaction'> = [];
  if (raising) wanted.push('workflow:enableRedaction');
  if (lowering) wanted.push('workflow:disableRedaction');
  if (!(await holdsScopes(deps, { ...actor, userId: actor.userId }, workflowId, wanted))) {
    throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
  }
}

export async function seedRedactionSettings(
  _deps: ServiceDeps,
  tenant: RedactionTenant,
  settings: WorkflowSettings | undefined,
): Promise<WorkflowSettings | undefined> {
  const floor = floorOf(tenant);
  if (floor === 'off' || policyOf(settings) !== undefined) return settings;
  return { ...settings, redactionPolicy: floor === 'all' ? 'all' : 'non-manual' };
}

export async function snapshotRedaction(
  _deps: ServiceDeps,
  tenant: RedactionTenant,
  definition: Pick<WorkflowDefinition, 'settings'>,
  parent?: RedactionChannels,
): Promise<RedactionSnapshot | undefined> {
  const own = mergeChannels(
    policyToChannels(policyOf(definition.settings)),
    floorToChannels(floorOf(tenant)),
  );
  const inherited = parent ?? { production: false, manual: false };
  const merged = mergeChannels(own, inherited);
  if (!merged.production && !merged.manual) return undefined;
  // a channel only the parent redacts is the parent's: the reason says so
  const fromOwn = (own.production && merged.production) || (own.manual && merged.manual);
  return { ...merged, reason: fromOwn ? REASON_WORKFLOW : REASON_SUB_WORKFLOW };
}

/** the channels a push may rely on: the snapshot raised by what the run's sub-workflows reported */
function effectiveChannels(
  snapshot: RedactionSnapshot | undefined,
  state: ExecutionState | undefined,
): RedactionChannels {
  const base = { production: snapshot?.production === true, manual: snapshot?.manual === true };
  return mergeChannels(base, reportedChannels(state?.resultData?.runData));
}

export function pushableTaskData(
  snapshot: RedactionSnapshot | undefined,
  taskData: TaskData,
  state: ExecutionState | undefined,
): TaskData {
  // the push of node data goes to the editor of a manual run: its channel is `manual`
  return effectiveChannels(snapshot, state).manual ? clearTask(taskData) : taskData;
}

export function pushableError(
  snapshot: RedactionSnapshot | undefined,
  error: ExecutionErrorShape | undefined,
  state: ExecutionState | undefined,
): ExecutionErrorShape | undefined {
  if (!error) return error;
  // the finished event goes out for every mode and carries no mode: a channel on in either hides the text
  const channels = effectiveChannels(snapshot, state);
  return channels.manual || channels.production ? redactedErrorShape(error) : error;
}

// ---------------------------------------------------------------------------------------------------
// clearing (shared with read.ts)

export const REDACTED_ERROR_MESSAGE = 'The error text of this execution is redacted';

/** what is left of an error: its kind and node, never its text, description, stack or hint */
export function redactedErrorShape(error: ExecutionErrorShape): ExecutionErrorShape {
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: REDACTED_ERROR_MESSAGE,
    ...(typeof error.node === 'string' ? { node: error.node } : {}),
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
  };
}

/** the items of every output emptied, the branch count kept */
function clearConnections(connections: NonNullable<TaskData['data']>): NonNullable<TaskData['data']> {
  const out: NonNullable<TaskData['data']> = {};
  for (const [type, outputs] of Object.entries(connections)) {
    out[type as ConnectionType] = Array.isArray(outputs)
      ? outputs.map((items) => (Array.isArray(items) ? [] : items))
      : outputs;
  }
  return out;
}

/** one task without its items, input overrides, hints and error text */
export function clearTask(task: TaskData): TaskData {
  const out: TaskData = { ...task };
  if (task.data && typeof task.data === 'object') out.data = clearConnections(task.data);
  if (task.inputOverride && typeof task.inputOverride === 'object') {
    out.inputOverride = clearConnections(task.inputOverride);
  }
  if (task.error && typeof task.error === 'object') out.error = redactedErrorShape(task.error);
  delete out.hints;
  return out;
}
