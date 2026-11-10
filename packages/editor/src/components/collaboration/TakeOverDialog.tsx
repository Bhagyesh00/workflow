/**
 * P6-81 (L14): confirm before taking the write lock from its holder (`force`).
 */
import type { ReactNode } from 'react';

export interface TakeOverDialogProps {
  open: boolean;
  onClose(): void;
  workflowId: string;
  /** the holder's name */
  holderName?: string;
}

/** stub (L14): renders nothing until L14 draws it */
export function TakeOverDialog(_props: TakeOverDialogProps): ReactNode {
  return null;
}
