/**
 * Public API insights (P6-05, L11), as n8n's insights public controller: GET `/insights/summary`, the workspace
 * summary (total, failed, failure rate, time saved, average run time, each with its deviation against the same
 * length before). The user needs `insights:list`, the key `insights:read`. PUBLIC_INSIGHTS_ROUTES is final and
 * shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it). The handler is a stub until L11 fills it with
 * the answer of REST `GET /insights/summary` (routes/insights.ts).
 */
import type { ApiRoute } from './public-api';

export const PUBLIC_INSIGHTS_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/insights/summary',
    summary: 'Get the insights summary of the workspace (runs, failures, time saved, run time)',
    tag: 'Insights',
    access: { scope: 'insights:list' },
    scope: 'insights:read',
    response: 'InsightsSummary',
    handler: async () => {
      // stub (L11)
      throw new Error('not implemented (L11)');
    },
  },
];
