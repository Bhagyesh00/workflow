/**
 * P6-57 (L13): the date range presets ("Last 24 hours", "Last 7 days", ...). Only the ranges the server lists
 * (`InsightsSettings.dateRanges`) are offered; a range that is not licensed shows disabled.
 */
import type { InsightsDateRangeKey, InsightsSettings } from '../../api/types';
import { Select } from '../ui/Field';

export interface RangePickerProps {
  value: InsightsDateRangeKey;
  onChange(next: InsightsDateRangeKey): void;
  ranges: InsightsSettings['dateRanges'];
}

export const RANGE_LABELS: Record<InsightsDateRangeKey, string> = {
  day: 'Last 24 hours',
  week: 'Last 7 days',
  '2weeks': 'Last 14 days',
  month: 'Last 30 days',
  quarter: 'Last 90 days',
  '6months': 'Last 6 months',
  year: 'Last 12 months',
};

/** how many days each preset reaches back */
export const RANGE_DAYS: Record<InsightsDateRangeKey, number> = {
  day: 1,
  week: 7,
  '2weeks': 14,
  month: 30,
  quarter: 90,
  '6months': 180,
  year: 365,
};

export function RangePicker({ value, onChange, ranges }: RangePickerProps) {
  return (
    <Select
      aria-label="Date range"
      value={value}
      onChange={(event) => onChange(event.target.value as InsightsDateRangeKey)}
    >
      {ranges.map((range) => (
        <option key={range.key} value={range.key} disabled={!range.licensed}>
          {RANGE_LABELS[range.key]}
        </option>
      ))}
    </Select>
  );
}
