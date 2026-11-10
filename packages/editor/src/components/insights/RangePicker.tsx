/**
 * P6-57 (L13): the date range presets ("Last 24 hours", "Last 7 days", ...).
 */
import type { ReactNode } from 'react';
import type { InsightsDateRangeKey, InsightsSettings } from '../../api/types';

export interface RangePickerProps {
  value: InsightsDateRangeKey;
  onChange(next: InsightsDateRangeKey): void;
  ranges: InsightsSettings['dateRanges'];
}

/** stub (L13): renders nothing until L13 draws it */
export function RangePicker(_props: RangePickerProps): ReactNode {
  return null;
}
