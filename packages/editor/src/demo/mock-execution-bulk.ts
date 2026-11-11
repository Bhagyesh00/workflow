/**
 * P6-85: the demo's bulk stop and delete of executions, in the list filter form of GET /executions (a selection
 * as `ids`, or the filter). As the server: stop acts only on runs the caller holds `workflow:execute` on, delete
 * only on runs it holds `execution:delete` on (each through its workflow's project; a run with no workflow holds
 * only the workspace role's scopes); a selection with no run the caller may delete answers 404.
 */
import type { Scope } from '@workflow/workflow';
import { filterExecutionList } from './mock-annotations';
import type { MockBackend, StoredExecution } from './mock-backend';
import { HttpError } from './mock-http';

const ACTIVE = ['new', 'running', 'waiting'];

/** a filter of the body as the list's query strings */
function asQuery(filter: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || key === 'ids') continue;
    query[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return query;
}

function matchesCustomData(e: StoredExecution, query: Record<string, string>): boolean {
  const key = query.customDataKey;
  if (!key) return true;
  const data = e.customData;
  if (!data || !Object.hasOwn(data, key)) return false;
  const wanted = query.customDataValue;
  if (!wanted) return true;
  return query.customDataExact === 'true' ? String(data[key]) === wanted : String(data[key]).includes(wanted);
}

export function registerExecutionBulkRoutes(backend: MockBackend): void {
  const holds = (scope: Scope, e: StoredExecution): boolean => {
    backend.auth();
    const workflow = backend.workflows.find((w) => w.id === e.workflowId);
    return backend.rowScopes(workflow ?? {}).includes(scope);
  };

  /** the runs of the workspace the body's filter or selection names, and the caller may act on with `scope` */
  const matching = (
    filter: Record<string, unknown>,
    scope: Scope,
    deleteBefore?: string,
  ): StoredExecution[] => {
    const { tenant } = backend.auth();
    const query = asQuery(filter);
    const ids = Array.isArray(filter.ids) ? new Set(filter.ids.map(String)) : null;
    const before = deleteBefore ? Date.parse(deleteBefore) : null;
    return filterExecutionList(
      backend,
      backend.executions.filter((e) => e.tenantId === tenant.id),
      query,
    )
      .filter((e) => !ids || ids.has(e.id))
      .filter((e) => !query.workflowId || e.workflowId === query.workflowId)
      .filter(
        (e) =>
          !query.projectId ||
          backend.workflows.find((w) => w.id === e.workflowId)?.projectId === query.projectId,
      )
      .filter((e) => !query.status || query.status.split(',').includes(e.status))
      .filter((e) => !query.workflowVersionId || e.workflowVersionId === query.workflowVersionId)
      .filter((e) => matchesCustomData(e, query))
      .filter((e) => before === null || (e.startedAt !== null && Date.parse(e.startedAt) <= before))
      .filter((e) => holds(scope, e));
  };

  backend.on('POST', '/executions/stopMany', ({ body }) => {
    backend.auth();
    const filter = (body.filter ?? {}) as Record<string, unknown>;
    let stopped = 0;
    for (const e of matching(filter, 'workflow:execute')) {
      if (!ACTIVE.includes(e.status)) continue;
      if (e.cancel) e.cancel.canceled = true;
      e.status = 'canceled';
      stopped++;
    }
    return { stopped };
  });

  backend.on('POST', '/executions/delete', ({ body }) => {
    backend.auth();
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : undefined;
    const filters = body.filters as Record<string, unknown> | undefined;
    const deleteBefore = typeof body.deleteBefore === 'string' ? body.deleteBefore : undefined;
    if (!ids?.length && !filters && !deleteBefore) {
      throw new HttpError(400, 'bad_request', 'Give ids, filters or deleteBefore');
    }
    const rows = matching({ ...filters, ...(ids ? { ids } : {}) }, 'execution:delete', deleteBefore);
    if (ids?.length && rows.length === 0) throw new HttpError(404, 'not_found', 'Execution not found');
    const gone = new Set(rows);
    for (const e of rows) if (e.cancel) e.cancel.canceled = true;
    backend.executions = backend.executions.filter((e) => !gone.has(e));
    return { deleted: rows.length };
  });
}
