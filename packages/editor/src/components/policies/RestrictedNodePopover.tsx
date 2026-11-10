/**
 * P6-50 (L5): the lock on a restricted row of the node creator: why the type is blocked and a
 * "Contact admin" action. The row stays greyed and sorted last; picking it adds nothing.
 */
import type { ReactNode } from 'react';
import type { AvailableType } from '../../api/types';

export interface RestrictedNodePopoverProps {
  /** the unavailable row of `useAvailableTypes` */
  entry: AvailableType;
  /** the type's display name */
  displayName: string;
  /** opens `ContactAdminDialog` for this type */
  onContactAdmin(): void;
}

/** stub (L5): renders nothing until L5 draws it */
export function RestrictedNodePopover(_props: RestrictedNodePopoverProps): ReactNode {
  return null;
}
