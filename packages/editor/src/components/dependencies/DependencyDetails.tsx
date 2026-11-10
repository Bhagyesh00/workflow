/**
 * P6-86 (L18): the popover listing what uses a resource (rows the caller cannot read are left out).
 */
import type { ReactNode } from 'react';
import type { DependencyResourceKind } from '../../api/types';

export interface DependencyDetailsProps {
  kind: DependencyResourceKind;
  id: string;
  onClose?(): void;
}

/** stub (L18): renders nothing until L18 draws it */
export function DependencyDetails(_props: DependencyDetailsProps): ReactNode {
  return null;
}
