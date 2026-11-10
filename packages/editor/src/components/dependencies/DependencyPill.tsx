/**
 * P6-86 (L18): "Used by N" on a workflow, credential or data table row, from `useDependencyCounts`
 * (one batched POST per page). Opens `DependencyDetails`.
 */
import type { ReactNode } from 'react';
import type { DependencyResourceKind } from '../../api/types';

export interface DependencyPillProps {
  kind: DependencyResourceKind;
  id: string;
}

/** stub (L18): renders nothing until L18 draws it */
export function DependencyPill(_props: DependencyPillProps): ReactNode {
  return null;
}
