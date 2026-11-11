/**
 * Public API insights (P6-05, L11), as n8n's insights public controller: GET `/insights/summary`, the workspace
 * summary (total, failed, failure rate, time saved, average run time, each with its deviation against the same
 * length before). The user needs `insights:list`, the key `insights:read`. PUBLIC_INSIGHTS_ROUTES is shaped as
 * PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it); the handler answers what REST `GET /insights/summary`
 * (routes/insights.ts) answers, for the query `startDate`, `endDate` (ISO with offset) and `projectId`.
 */
import type { z } from 'zod';
import { insightsSummary } from '../services/insights/query';
import { insightsRangeOf, insightsRangeQuery } from './insights';
import type { ApiRoute } from './public-api';

const summaryQuery = insightsRangeQuery.pick({ startDate: true, endDate: true, projectId: true });

export const PUBLIC_INSIGHTS_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/insights/summary',
    summary: 'Get the insights summary of the workspace (runs, failures, time saved, run time)',
    tag: 'Insights',
    access: { scope: 'insights:list' },
    scope: 'insights:read',
    query: summaryQuery as z.ZodObject,
    response: 'InsightsSummary',
    handler: async (ctx, { auth, query }) => ({
      data: await insightsSummary(
        ctx.serviceDeps,
        auth.tenant.id,
        insightsRangeOf(query as z.output<typeof summaryQuery>),
      ),
    }),
  },
];
