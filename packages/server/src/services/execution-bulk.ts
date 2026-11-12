/**
 * P6-85 (L17): stop and delete many runs, in the list filter form of GET /executions (S1), each row checked.
 * - `stopMany` (POST /executions/stopMany `{ filter }`, `ids` in the filter for a selection): only rows the
 *   caller may execute (`listFilter(auth, 'workflow:execute')`: their projects and shared workflows); answers `{ stopped }`.
 * - `deleteMany` (POST /executions/delete `{ ids, filters, deleteBefore }`): `execution:delete` per row; none
 *   accessible gives "Execution not found"; answers `{ deleted }`.
 * Rows with no workflow id: owner and admin only (they reach them only through the global scope: `all`).
 * Bounded batches: a page of runs at a time, a cursor so a run that does not stop is not read again, and a cap
 * on the runs one call handles.
 */
import type { ExecutionMode, ExecutionStatus } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { Cursor } from '../http/pagination';
import type { AccessFilter } from './access';

/** the GET /executions filter fields a bulk action takes, plus a selection */
export interface ExecutionBulkFilter {
  /** a selection: only these runs (still narrowed by the rest) */
  ids?: string[];
  workflowId?: string;
  projectId?: string;
  status?: ExecutionStatus[];
  mode?: ExecutionMode;
  startedAfter?: Date;
  startedBefore?: Date;
  annotationTags?: string[];
  vote?: 'up' | 'down';
  workflowVersionId?: string;
  customDataKey?: string;
  customDataValue?: string;
  customDataExact?: boolean;
  /** the run's workflow is archived (`true`) or not (`false`) */
  archived?: boolean;
}

/** runs read, and acted on, per round */
export const BULK_BATCH = 100;
/** the most runs one call acts on (the caller repeats the call for more) */
export const BULK_LIMIT = 10_000;

/** the statuses of a run that can still be stopped */
const ACTIVE: readonly ExecutionStatus[] = ['new', 'running', 'waiting'];

type Row = { id: string; createdAt: Date; status: string };

/** reads the runs matching the filter inside the access filter, a batch at a time, until `visit` says stop */
async function eachBatch(
  deps: ServiceDeps,
  tenantId: string,
  access: AccessFilter,
  filter: ExecutionBulkFilter,
  extra: { status?: ExecutionStatus[]; startedBefore?: Date },
  visit: (rows: Row[]) => Promise<void>,
): Promise<void> {
  let cursor: Cursor | undefined;
  let seen = 0;
  while (seen < BULK_LIMIT) {
    const limit = Math.min(BULK_BATCH, BULK_LIMIT - seen);
    const rows = await deps.repos.executions.list(tenantId, {
      filter: access,
      ids: filter.ids,
      projectId: filter.projectId,
      workflowId: filter.workflowId,
      status: extra.status ?? filter.status,
      mode: filter.mode,
      startedAfter: filter.startedAfter,
      startedBefore: earliest(filter.startedBefore, extra.startedBefore),
      annotationTags: filter.annotationTags,
      vote: filter.vote,
      workflowVersionId: filter.workflowVersionId,
      customDataKey: filter.customDataKey,
      customDataValue: filter.customDataValue,
      customDataExact: filter.customDataExact,
      archived: filter.archived,
      limit,
      cursor,
    });
    // `list` reads one row more than the limit
    const batch = rows.slice(0, limit);
    if (!batch.length) return;
    await visit(batch);
    seen += batch.length;
    if (rows.length <= limit) return;
    const last = batch[batch.length - 1];
    cursor = { value: last.createdAt.toISOString(), id: last.id };
  }
}

const earliest = (a?: Date, b?: Date): Date | undefined => (a && b ? (a < b ? a : b) : (a ?? b));

export async function stopMany(
  deps: ServiceDeps,
  auth: AuthContext,
  filter: ExecutionBulkFilter,
): Promise<{ stopped: number }> {
  const ctx = deps.context();
  const tenantId = auth.tenant.id;
  // the projects where the caller may execute (every project with the global scope, and then the runs with no
  // workflow row too) plus the workflows shared to them with a role that may execute, as the stop route
  const access = await ctx.access.listFilter(auth, 'workflow:execute');
  const active = filter.status?.length ? filter.status.filter((s) => ACTIVE.includes(s)) : [...ACTIVE];
  if (!active.length) return { stopped: 0 };
  let stopped = 0;
  await eachBatch(deps, tenantId, access, filter, { status: active }, async (rows) => {
    for (const row of rows) {
      try {
        if ((await ctx.executions.stop(tenantId, row.id)) === 'canceled') stopped++;
      } catch (error) {
        // a run that ended or was deleted since it was read
        if (!(error instanceof ApiError && error.statusCode === 404)) throw error;
      }
    }
  });
  return { stopped };
}

/** the most execution ids one bulk delete audit row names */
const AUDIT_ID_LIMIT = 1000;

export async function deleteMany(
  deps: ServiceDeps,
  auth: AuthContext,
  input: { ids?: string[]; filters?: ExecutionBulkFilter; deleteBefore?: Date },
): Promise<{ deleted: number }> {
  const ctx = deps.context();
  const tenantId = auth.tenant.id;
  const access = await ctx.access.listFilter(auth, 'execution:delete');
  const filter: ExecutionBulkFilter = { ...input.filters };
  if (input.ids) filter.ids = input.ids;
  let deleted = 0;
  const deletedIds: string[] = [];
  await eachBatch(deps, tenantId, access, filter, { startedBefore: input.deleteBefore }, async (rows) => {
    for (const row of rows) {
      if (ACTIVE.includes(row.status as ExecutionStatus)) {
        try {
          await ctx.executions.stop(tenantId, row.id);
        } catch (error) {
          if (!(error instanceof ApiError && error.statusCode === 404)) throw error;
        }
      }
      if (await deps.repos.executions.delete(tenantId, row.id)) {
        deleted++;
        if (deletedIds.length < AUDIT_ID_LIMIT) deletedIds.push(row.id);
        await ctx.executions.removeBinaryData(tenantId, row.id);
      }
    }
  });
  // a selection no run of which the caller may delete: n8n answers not found
  if (input.ids?.length && deleted === 0) throw ApiError.notFound('Execution');
  // P6-58: one audit row for the whole bulk delete (ids up to a bound, `deleted` is the real count)
  if (deleted > 0) {
    await deps.repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'execution.deleted',
      resourceType: 'execution',
      metadata: {
        executionIds: deletedIds,
        deleted,
        ...(input.deleteBefore ? { deleteBefore: input.deleteBefore.toISOString() } : {}),
      },
    });
  }
  return { deleted };
}
