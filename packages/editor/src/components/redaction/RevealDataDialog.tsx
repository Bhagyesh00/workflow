/**
 * P6-53 (L8): confirm before revealing a redacted run; the reveal is logged.
 */
import type { ReactNode } from 'react';
import type { ExecutionDetail } from '../../api/types';

export interface RevealDataDialogProps {
  open: boolean;
  onClose(): void;
  executionId: string;
  onRevealed(execution: ExecutionDetail): void;
}

/** stub (L8): renders nothing until L8 draws it */
export function RevealDataDialog(_props: RevealDataDialogProps): ReactNode {
  return null;
}
