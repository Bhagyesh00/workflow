/**
 * P6-53 (L8): the execution data redaction on the read side. `redactExecution` judges one run for one
 * viewer: the policy channels (the run's snapshot merged with `reportedChannels(runData)`) and the credential
 * rule (credential-rule.ts); a redacted read clears the items, moves the error to `redactedError`, blanks the
 * row's `errorMessage` and says why in `redactionInfo`. `{ reveal: true }` (`?redactExecutionData=false`)
 * reveals with `execution:reveal` (audit `execution.data.revealed`), else 403 `EXECUTION_REVEAL_FORBIDDEN`;
 * the credential rule is never bypassed. `redactSummaries` judges a page of rows with one
 * `repos.executions.redactionFacts` query. A tool never passes `reveal`.
 * Stub from C0: both PASS (data and rows unchanged, no `redactionInfo`) until L8.
 */
import type { ExecutionErrorShape } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExecutionDataRow, ExecutionRow } from '../../db/schema';

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

export async function redactExecution(
  _deps: ServiceDeps,
  _viewer: ExecutionViewer,
  row: ExecutionRow,
  data: ExecutionDataRow | undefined,
  _options: { reveal?: boolean } = {},
): Promise<RedactedRead> {
  // stub (L8): PASSES, the data unchanged, `redactionInfo` absent
  return { row, data };
}

/** a page of summaries (list rows, the Assistant's own summaries, an error text with its run id) */
export async function redactSummaries<R extends { id: string }>(
  _deps: ServiceDeps,
  _viewer: ExecutionViewer,
  rows: R[],
): Promise<R[]> {
  // stub (L8): PASSES, the rows unchanged
  return rows;
}
