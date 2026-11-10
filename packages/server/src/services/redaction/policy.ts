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
 * Stub from C0: all PASS (no check, settings and data unchanged, no snapshot) until L8.
 */
import type {
  ExecutionErrorShape,
  ExecutionState,
  RedactionChannels,
  TaskData,
  WorkflowDefinition,
  WorkflowSettings,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TenantRow } from '../../db/schema';

/** who changes the settings: the workspace, and the user (absent on a server path) */
export interface RedactionActor {
  tenantId: string;
  userId?: string;
}

/** the run's channels at start, kept in `StoredRunOptions.redaction` */
export type RedactionSnapshot = RedactionChannels & { reason?: string };

/** the tenant fields the floor is read from */
export type RedactionTenant = Pick<TenantRow, 'id' | 'settings'>;

export async function assertRedactionChange(
  _deps: ServiceDeps,
  _actor: RedactionActor,
  /** null on a create (no id yet) */
  _workflowId: string | null | undefined,
  _before: WorkflowSettings | null | undefined,
  _after: WorkflowSettings | null | undefined,
): Promise<void> {
  // stub (L8): PASSES
}

export async function seedRedactionSettings(
  _deps: ServiceDeps,
  _tenant: RedactionTenant,
  settings: WorkflowSettings | undefined,
): Promise<WorkflowSettings | undefined> {
  // stub (L8): PASSES, the settings unchanged
  return settings;
}

export async function snapshotRedaction(
  _deps: ServiceDeps,
  _tenant: RedactionTenant,
  _definition: Pick<WorkflowDefinition, 'settings'>,
  _parent?: RedactionChannels,
): Promise<RedactionSnapshot | undefined> {
  // stub (L8): PASSES, no snapshot (nothing redacted)
  return undefined;
}

export function pushableTaskData(
  _snapshot: RedactionSnapshot | undefined,
  taskData: TaskData,
  _state: ExecutionState | undefined,
): TaskData {
  // stub (L8): PASSES, the task data unchanged
  return taskData;
}

export function pushableError(
  _snapshot: RedactionSnapshot | undefined,
  error: ExecutionErrorShape | undefined,
  _state: ExecutionState | undefined,
): ExecutionErrorShape | undefined {
  // stub (L8): PASSES, the error unchanged
  return error;
}
