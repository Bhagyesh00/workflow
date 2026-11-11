/**
 * P6-76 (L6): what a pull did: created, updated and deleted files, publishing errors and content policy skips.
 */
import type { ReactNode } from 'react';
import type { PullResult } from '../../api/types';

export interface PullResultModalProps {
  /** open while set */
  result: PullResult | null;
  onClose(): void;
}

/** stub (L6): renders nothing until L6 draws it */
export function PullResultModal(_props: PullResultModalProps): ReactNode {
  return null;
}
