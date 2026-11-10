/**
 * P6-57 (L13): the note shown when the picked range starts before the first day with data.
 */
import type { ReactNode } from 'react';
import type { InsightsDateRangeKey } from '../../api/types';

export interface RangeAlertProps {
  range: InsightsDateRangeKey;
  /** `InsightsSettings.earliestDataDate` */
  earliestDataDate: string | null;
}

/** stub (L13): renders nothing until L13 draws it */
export function RangeAlert(_props: RangeAlertProps): ReactNode {
  return null;
}
