/**
 * P6-50 (L5): the lock badge on a canvas node whose type a policy blocks.
 */
import type { ReactNode } from 'react';

export interface CanvasLockBadgeProps {
  /** the node's type */
  nodeType: string;
}

/** stub (L5): renders nothing until L5 draws it */
export function CanvasLockBadge(_props: CanvasLockBadgeProps): ReactNode {
  return null;
}
