/**
 * P6-57 (L13): one own SVG chart per tile type, with keyboard focus on the buckets.
 */
import type { ReactNode } from 'react';
import type { InsightsByTimeRow, InsightsGranularity, InsightsSummaryType } from '../../api/types';

export interface InsightsChartProps {
  type: InsightsSummaryType;
  data: InsightsByTimeRow[];
  granularity: InsightsGranularity;
}

/** stub (L13): renders nothing until L13 draws it */
export function InsightsChart(_props: InsightsChartProps): ReactNode {
  return null;
}
