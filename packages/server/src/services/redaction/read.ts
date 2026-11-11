/**
 * P6-53 (L8): the execution data redaction on the read side. `redactExecution` judges one run for one
 * viewer: the policy channels (the run's snapshot merged with `reportedChannels(runData)`) and the credential
 * rule (credential-rule.ts); a redacted read clears the items, moves the error to `redactedError`, blanks the
 * row's `errorMessage` and says why in `redactionInfo`. `{ reveal: true }` (`?redactExecutionData=false`)
 * reveals with `execution:reveal` (audit `execution.data.revealed`), else 403 `EXECUTION_REVEAL_FORBIDDEN`
 * (audit `execution.data.reveal_failed`); the credential rule is never bypassed. `redactSummaries` judges a
 * page of rows with one `repos.executions.redactionFacts` query. A tool never passes `reveal`.
 */
import {
  type ExecutionErrorShape,
  type ExecutionState,
  mergeChannels,
  type RedactionChannels,
  type RunData,
  reportedChannels,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExecutionDataRow, ExecutionRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import type { ExecutionRedactionFacts } from '../../repositories/executions';
import { inaccessibleCredentialIds, runReferencedCredentialIds } from './credential-rule';
import { clearTask, REASON_SUB_WORKFLOW, REASON_WORKFLOW, redactedErrorShape } from './policy';

/** who reads the run */
export type ExecutionViewer = { tenantId: string; userId: string };

/** why a run's data is hidden and whether the viewer may reveal it (the editor's `RedactionInfo`) */
export interface RedactionInfo {
  isRedacted: boolean;
  /** e.g. `workflow_redaction_policy`, `sub_workflow_redaction_policy`, `credential_access` */
  reason: string;
  canReveal: boolean;
}

export interface RedactedRead {
  /** the row, `errorMessage` blanked when redacted */
  row: ExecutionRow;
  /** the stored data, items cleared when redacted */
  data: ExecutionDataRow | undefined;
  /** absent when nothing is redacted */
  redactionInfo?: RedactionInfo;
  /** the run's error, moved out of the data when redacted */
  redactedError?: ExecutionErrorShape | null;
}

export const REASON_CREDENTIAL = 'credential_access';
export const REVEAL_FORBIDDEN_CODE = 'EXECUTION_REVEAL_FORBIDDEN';
const REVEAL_FORBIDDEN_MESSAGE = "Couldn't reveal the data of this execution";

/** what the judgement reads of one run */
interface RunFacts {
  snapshot: ExecutionRedactionFacts['redaction'];
  reported: RedactionChannels;
  userId: string | null;
  credentialIds: string[];
  usedPrivateCredentials: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** the facts of a run whose data is in hand */
function factsOfData(row: ExecutionRow, data: ExecutionDataRow): RunFacts {
  const runOptions = isRecord(data.runOptions) ? data.runOptions : {};
  const state = isRecord(data.state) ? (data.state as unknown as ExecutionState) : undefined;
  const runData: RunData | undefined = state?.resultData?.runData;
  const workflowNodes = isRecord(data.workflowData) ? data.workflowData.nodes : undefined;
  const snapshot = isRecord(runOptions.redaction)
    ? (runOptions.redaction as unknown as ExecutionRedactionFacts['redaction'])
    : null;
  return {
    snapshot,
    reported: reportedChannels(runData),
    userId: typeof runOptions.userId === 'string' && runOptions.userId !== '' ? runOptions.userId : null,
    credentialIds: runReferencedCredentialIds(Array.isArray(workflowNodes) ? workflowNodes : [], runData),
    usedPrivateCredentials: row.usedPrivateCredentials,
  };
}

const factsOfRow = (facts: ExecutionRedactionFacts): RunFacts => ({
  snapshot: facts.redaction,
  reported: { production: false, manual: false },
  userId: facts.userId,
  credentialIds: facts.credentialIds,
  usedPrivateCredentials: facts.usedPrivateCredentials,
});

/**
 * The policy side: the reason when the run's own channel (manual or production) is on, else null. A row with
 * no known mode (an Assistant summary) is judged by either channel.
 */
function policyReason(mode: unknown, facts: RunFacts): string | null {
  const snapshot = facts.snapshot;
  const channels: Array<keyof RedactionChannels> =
    mode === 'manual' ? ['manual'] : typeof mode === 'string' ? ['production'] : ['manual', 'production'];
  for (const channel of channels) {
    if (snapshot?.[channel] === true) return snapshot.reason ?? REASON_WORKFLOW;
  }
  const merged = mergeChannels(
    { production: snapshot?.production === true, manual: snapshot?.manual === true },
    facts.reported,
  );
  return channels.some((channel) => merged[channel]) ? REASON_SUB_WORKFLOW : null;
}

/** a private run is revealed to its own user only */
function privateMiss(viewer: ExecutionViewer, facts: RunFacts): boolean {
  return facts.usedPrivateCredentials && facts.userId !== viewer.userId;
}

/** a run's `state` without items, error text or stored stacks */
function redactState(state: ExecutionDataRow['state']): ExecutionDataRow['state'] {
  if (!isRecord(state)) return state;
  const source = state as unknown as ExecutionState;
  const resultData = isRecord(source.resultData) ? source.resultData : undefined;
  const runData: RunData = {};
  for (const [name, tasks] of Object.entries(resultData?.runData ?? {})) {
    runData[name] = Array.isArray(tasks) ? tasks.map(clearTask) : [];
  }
  const pinData = resultData?.pinData
    ? Object.fromEntries(Object.keys(resultData.pinData).map((name) => [name, []]))
    : undefined;
  const cleared: ExecutionState = {
    startData: source.startData,
    resultData: {
      runData,
      ...(pinData ? { pinData } : {}),
      ...(resultData?.lastNodeExecuted ? { lastNodeExecuted: resultData.lastNodeExecuted } : {}),
      customData: {},
    },
    executionData: {
      nodeExecutionStack: [],
      waitingExecution: {},
      waitingExecutionSource: {},
      contextData: {},
    },
  };
  return cleared as unknown as ExecutionDataRow['state'];
}

/** a row or summary with the texts that can carry run values blanked */
function blanked<R extends object>(row: R): R {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  if (typeof out.errorMessage === 'string' && out.errorMessage !== '') out.errorMessage = '';
  if (isRecord(out.customData)) out.customData = {};
  return out as R;
}

async function hasRevealScope(deps: ServiceDeps, viewer: ExecutionViewer, runId: string): Promise<boolean> {
  const scopes = await deps
    .context()
    .access.scopesFor(viewer.tenantId, viewer.userId, { executionId: runId });
  return scopes.has('execution:reveal');
}

async function logReveal(
  deps: ServiceDeps,
  viewer: ExecutionViewer,
  row: ExecutionRow,
  revealed: boolean,
  reason: string,
): Promise<void> {
  await deps.repos.audit.add(viewer.tenantId, {
    userId: viewer.userId,
    action: revealed ? 'execution.data.revealed' : 'execution.data.reveal_failed',
    resourceType: 'execution',
    resourceId: row.id,
    metadata: { workflowId: row.workflowId, mode: row.mode, reason },
  });
}

export async function redactExecution(
  deps: ServiceDeps,
  viewer: ExecutionViewer,
  row: ExecutionRow,
  data: ExecutionDataRow | undefined,
  options: { reveal?: boolean } = {},
): Promise<RedactedRead> {
  let facts: RunFacts | undefined;
  if (data) facts = factsOfData(row, data);
  else {
    const found = (await deps.repos.executions.redactionFacts(viewer.tenantId, [row.id])).get(row.id);
    if (found) facts = factsOfRow(found);
  }
  if (!facts) return { row, data };

  const policy = policyReason(row.mode, facts);
  const credentialMiss =
    privateMiss(viewer, facts) ||
    (await inaccessibleCredentialIds(deps, viewer, facts.credentialIds)).length > 0;
  if (!policy && !credentialMiss) return { row, data };

  const reason = policy ?? REASON_CREDENTIAL;
  const canReveal = !credentialMiss && (await hasRevealScope(deps, viewer, row.id));
  if (options.reveal) {
    const why = canReveal ? reason : credentialMiss ? REASON_CREDENTIAL : 'missing_scope';
    await logReveal(deps, viewer, row, canReveal, why);
    if (canReveal) return { row, data };
    throw new ApiError(403, REVEAL_FORBIDDEN_CODE, REVEAL_FORBIDDEN_MESSAGE);
  }

  const result: RedactedRead = {
    row: blanked(row),
    data: data ? { ...data, state: redactState(data.state), runOptions: {} } : undefined,
    redactionInfo: { isRedacted: true, reason, canReveal },
  };
  if (data) {
    const error = isRecord(data.state)
      ? (data.state as unknown as ExecutionState).resultData?.error
      : undefined;
    result.redactedError = error && isRecord(error) ? redactedErrorShape(error) : null;
  }
  return result;
}

/** a page of summaries (list rows, the Assistant's own summaries, an error text with its run id) */
export async function redactSummaries<R extends { id: string }>(
  deps: ServiceDeps,
  viewer: ExecutionViewer,
  rows: R[],
): Promise<R[]> {
  if (!rows.length) return rows;
  const facts = await deps.repos.executions.redactionFacts(
    viewer.tenantId,
    rows.map((row) => row.id),
  );
  if (!facts.size) return rows;
  const wanted = new Set<string>();
  for (const fact of facts.values()) for (const id of fact.credentialIds) wanted.add(id);
  const blocked = new Set(await inaccessibleCredentialIds(deps, viewer, [...wanted]));
  return rows.map((row) => {
    const fact = facts.get(row.id);
    if (!fact) return row;
    const run = factsOfRow(fact);
    const redacted =
      policyReason((row as { mode?: unknown }).mode, run) !== null ||
      privateMiss(viewer, run) ||
      run.credentialIds.some((id) => blocked.has(id));
    return redacted ? blanked(row) : row;
  });
}
