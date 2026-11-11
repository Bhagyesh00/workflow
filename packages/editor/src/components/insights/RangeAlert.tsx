/**
 * P6-57 (L13): the note shown when the picked range starts before the first day with data.
 */
import type { InsightsDateRangeKey } from '../../api/types';
import { Callout } from '../ui/misc';
import { RANGE_DAYS } from './RangePicker';

export interface RangeAlertProps {
  range: InsightsDateRangeKey;
  /** `InsightsSettings.earliestDataDate` */
  earliestDataDate: string | null;
}

export function RangeAlert({ range, earliestDataDate }: RangeAlertProps) {
  if (!earliestDataDate) return null;
  const earliest = Date.parse(earliestDataDate);
  if (Number.isNaN(earliest)) return null;
  const start = Date.now() - RANGE_DAYS[range] * 24 * 3_600_000;
  if (start >= earliest) return null;
  const since = new Date(earliest).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return (
    <Callout tone="warn" title="Part of this range has no data">
      Insights start on {since}, so the figures for earlier days count as zero.
    </Callout>
  );
}
