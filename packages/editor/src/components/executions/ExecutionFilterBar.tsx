/**
 * P6-85 (L17): the date range beside the custom data inputs of the executions list.
 */
import type { ReactNode } from 'react';
import type { ExecutionListQuery } from '../../api/endpoints';

export interface ExecutionFilterBarProps {
  value: ExecutionListQuery;
  onChange(next: ExecutionListQuery): void;
}

/** stub (L17): renders nothing until L17 draws it */
export function ExecutionFilterBar(_props: ExecutionFilterBarProps): ReactNode {
  return null;
}
