/**
 * P6-50 (L5): the lock badge on a canvas node whose type a policy blocks.
 */
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { restrictedReason, useRestrictedEntry } from '../../lib/policy-violations';

export interface CanvasLockBadgeProps {
  /** the node's type */
  nodeType: string;
}

export function CanvasLockBadge({ nodeType }: CanvasLockBadgeProps): ReactNode {
  const entry = useRestrictedEntry(nodeType);
  if (!entry) return null;
  return (
    <span
      className="wf-node-badge bg-err"
      style={{ left: -9, right: 'auto' }}
      title={restrictedReason(entry)}
      role="img"
      aria-label="Restricted node"
      data-testid="canvas-lock-badge"
    >
      <Lock size={10} strokeWidth={2.6} />
    </span>
  );
}
