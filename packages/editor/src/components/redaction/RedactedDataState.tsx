/**
 * P6-53 (L8): what the output pane and the execution page show for a redacted run, with Reveal when
 * `info.canReveal`.
 */
import type { ReactNode } from 'react';
import type { ExecutionDetail, RedactionInfo } from '../../api/types';

export interface RedactedDataStateProps {
  info: RedactionInfo;
  executionId: string;
  /** the revealed run (`executionsApi.get(id, { redactExecutionData: false })`) */
  onRevealed?(execution: ExecutionDetail): void;
}

/** stub (L8): renders nothing until L8 draws it */
export function RedactedDataState(_props: RedactedDataStateProps): ReactNode {
  return null;
}
