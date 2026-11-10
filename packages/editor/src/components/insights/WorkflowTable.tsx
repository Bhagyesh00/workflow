/**
 * P6-57 (L13): runs per workflow, with sort, paging and a link when `hasReadAccess`.
 */
import type { ReactNode } from 'react';
import type { InsightsByWorkflowPage, InsightsByWorkflowQuery } from '../../api/types';

export interface WorkflowTableProps {
  page: InsightsByWorkflowPage | undefined;
  loading: boolean;
  sortBy: NonNullable<InsightsByWorkflowQuery['sortBy']>;
  onSortChange(sortBy: NonNullable<InsightsByWorkflowQuery['sortBy']>): void;
  skip: number;
  take: number;
  onPageChange(skip: number, take: number): void;
}

/** stub (L13): renders nothing until L13 draws it */
export function WorkflowTable(_props: WorkflowTableProps): ReactNode {
  return null;
}
