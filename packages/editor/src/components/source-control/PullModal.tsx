/**
 * P6-76 (L6): the pull modal: incoming changes and conflicts; a conflict asks first ("Pull and override" sends
 * `force`).
 */
import type { ReactNode } from 'react';
import type { PullResult } from '../../api/types';

export interface PullModalProps {
  open: boolean;
  onClose(): void;
  onPulled(result: PullResult): void;
}

/** stub (L6): renders nothing until L6 draws it */
export function PullModal(_props: PullModalProps): ReactNode {
  return null;
}
