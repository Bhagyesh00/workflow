/**
 * P6-85 (L17): stop or delete the selected runs, or every run matching the filter.
 */
import type { ReactNode } from 'react';
import type { ExecutionBulkFilter } from '../../api/endpoints';

export interface BulkActionsBarProps {
  /** the picked run ids; empty with `allMatching` means the whole filter */
  selectedIds: string[];
  /** the list's filter */
  filter: ExecutionBulkFilter;
  allMatching: boolean;
  /** clears the selection after an action */
  onClear(): void;
}

/** stub (L17): renders nothing until L17 draws it */
export function BulkActionsBar(_props: BulkActionsBarProps): ReactNode {
  return null;
}
