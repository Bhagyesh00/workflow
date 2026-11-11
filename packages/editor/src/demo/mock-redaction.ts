/**
 * P6-53 (L8): the demo's execution data redaction: `redactDemoExecution` judges GET /executions/:id (the policy of
 * the workflow, the workspace floor of `/settings/security`, `?redactExecutionData=false` to reveal), and the
 * who-can-reveal list. A run is judged when it is read (the demo keeps no snapshot at start), so the floor
 * applies to every run it holds.
 */
import {
  type ExecutionErrorShape,
  floorToChannels,
  mergeChannels,
  policyToChannels,
  type RedactionPolicy,
  type Scope,
} from '@workflow/workflow';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

const REDACTED_ERROR = 'The error text of this execution is redacted';

type Row = {
  mode?: string;
  errorMessage?: string | null;
  customData?: unknown;
  workflowData?: { settings?: { redactionPolicy?: RedactionPolicy } };
  state?: {
    resultData?: {
      runData?: Record<string, Array<{ data?: Record<string, unknown[]>; error?: ExecutionErrorShape }>>;
      error?: ExecutionErrorShape;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  scopes?: Scope[];
};

const stripError = (error: ExecutionErrorShape): ExecutionErrorShape => ({
  name: error.name,
  message: REDACTED_ERROR,
  ...(error.node ? { node: error.node } : {}),
  ...(error.code ? { code: error.code } : {}),
});

/**
 * GET /executions/:id's answer, redacted for the caller (items cleared, the error moved to `redactedError`,
 * `redactionInfo` set) or as is. `query.redactExecutionData === 'false'` asks to reveal.
 */
export function redactDemoExecution<T extends object>(
  row: T,
  query: Record<string, string>,
  backend: MockBackend,
): T {
  const run = row as T & Row;
  const tenantId = backend.session?.tenantId;
  const floor = tenantId ? backend.redactionFloorOf(tenantId) : 'off';
  const channels = mergeChannels(
    policyToChannels(run.workflowData?.settings?.redactionPolicy),
    floorToChannels(floor),
  );
  if (!(run.mode === 'manual' ? channels.manual : channels.production)) return row;

  const canReveal = (run.scopes ?? []).includes('execution:reveal');
  if (query.redactExecutionData === 'false') {
    if (!canReveal) {
      throw new HttpError(403, 'EXECUTION_REVEAL_FORBIDDEN', "Couldn't reveal the data of this execution");
    }
    return row;
  }

  const resultData = run.state?.resultData;
  const runData: NonNullable<Row['state']>['resultData'] = { ...resultData, runData: {} };
  for (const [name, tasks] of Object.entries(resultData?.runData ?? {})) {
    runData.runData ??= {};
    runData.runData[name] = tasks.map((task) => ({
      ...task,
      ...(task.data
        ? {
            data: Object.fromEntries(
              Object.entries(task.data).map(([type, outputs]) => [
                type,
                outputs.map((items) => (Array.isArray(items) ? [] : items)),
              ]),
            ),
          }
        : {}),
      ...(task.error ? { error: stripError(task.error) } : {}),
    }));
  }
  const error = resultData?.error;
  delete runData.error;
  return {
    ...run,
    errorMessage: run.errorMessage ? '' : run.errorMessage,
    // custom data stays readable on a redacted run, as on the server (and n8n)
    state: { ...run.state, resultData: runData },
    redactionInfo: { isRedacted: true, reason: 'workflow_redaction_policy', canReveal },
    redactedError: error ? stripError(error) : null,
  };
}

export function registerRedactionRoutes(backend: MockBackend): void {
  // demo data only, never a permission check: the project admins of a project (S1's server route, P6-32)
  backend.on('GET', '/roles/:slug/assignments/:projectId/members', ({ params }) => {
    const tenantId = backend.session?.tenantId;
    if (!tenantId) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const [slug, projectId] = params;
    const members = backend.projectRelations
      .filter((r) => r.tenantId === tenantId && r.projectId === projectId && r.role === slug)
      .flatMap((r) => {
        const user = backend.users.find((u) => u.id === r.userId);
        return user ? [{ userId: user.id, name: user.name, email: user.email, role: r.role }] : [];
      });
    return { members, total: members.length };
  });
}
