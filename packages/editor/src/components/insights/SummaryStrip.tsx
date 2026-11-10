/**
 * P6-57 (L13): the five tiles (total, failed, failure rate, time saved, average run time).
 */
import type { ReactNode } from 'react';
import type { InsightsSummary, InsightsSummaryType } from '../../api/types';

export interface SummaryStripProps {
  summary: InsightsSummary | undefined;
  loading: boolean;
  /** the tile drawn as selected (the page's chart) */
  active?: InsightsSummaryType;
  /** a tile links to its chart when given */
  linkTo?(type: InsightsSummaryType): string;
}

/** stub (L13): renders nothing until L13 draws it */
export function SummaryStrip(_props: SummaryStripProps): ReactNode {
  return null;
}
