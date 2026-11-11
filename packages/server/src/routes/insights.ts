/**
 * /rest/insights (P6-05, L11), as n8n's insights controller: GET `/insights/summary`, `/insights/by-workflow`,
 * `/insights/by-time` and `/insights/by-time/time-saved`, all `insights:list` (a `projectId` in the query narrows
 * to one project; an unknown one is 404). GET `/insights/settings` carries what n8n sends in its frontend
 * settings (summary and dashboard on, the date ranges with their granularity, the earliest data date), also
 * `insights:list`. The reads are services/insights/query.ts; the public route
 * (routes/public-insights.ts) answers with the same summary.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';
import {
  type InsightsRange,
  insightsByTime,
  insightsByWorkflow,
  insightsSettings,
  insightsSummary,
} from '../services/insights/query';

const dateParam = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a date')
  .transform((value) => new Date(value));

/** the query every insights read takes: n8n's names */
export const insightsRangeQuery = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  projectId: z.string().min(1).max(64).optional(),
  timeZone: z.string().min(1).max(64).optional(),
});

const SORT_FIELDS = [
  'total',
  'succeeded',
  'failed',
  'failureRate',
  'timeSaved',
  'runTime',
  'averageRunTime',
  'workflowName',
] as const;

const byWorkflowQuery = insightsRangeQuery.extend({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z
    .enum(SORT_FIELDS.flatMap((field) => [`${field}:asc`, `${field}:desc`]) as [string, ...string[]])
    .default('total:desc'),
});

export function insightsRangeOf(query: z.output<typeof insightsRangeQuery>): InsightsRange {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    projectId: query.projectId,
    timeZone: query.timeZone,
  };
}

export function registerInsightsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const deps = ctx.serviceDeps;

  app.get('/insights/summary', async (request) => {
    const auth = await requireScope(request, 'insights:list');
    const query = parse(insightsRangeQuery, request.query);
    return { data: await insightsSummary(deps, auth.tenant.id, insightsRangeOf(query)) };
  });

  app.get('/insights/by-workflow', async (request) => {
    const auth = await requireScope(request, 'insights:list');
    const query = parse(byWorkflowQuery, request.query);
    const readFilter = await ctx.access.listFilter(auth, 'workflow:read');
    const page = await insightsByWorkflow(
      deps,
      auth.tenant.id,
      {
        ...insightsRangeOf(query),
        skip: query.skip,
        take: query.take,
        sortBy: query.sortBy as `${(typeof SORT_FIELDS)[number]}:${'asc' | 'desc'}`,
      },
      readFilter,
    );
    return { data: page };
  });

  app.get('/insights/by-time', async (request) => {
    const auth = await requireScope(request, 'insights:list');
    const query = parse(insightsRangeQuery, request.query);
    return { data: await insightsByTime(deps, auth.tenant.id, insightsRangeOf(query)) };
  });

  app.get('/insights/by-time/time-saved', async (request) => {
    const auth = await requireScope(request, 'insights:list');
    const query = parse(insightsRangeQuery, request.query);
    return { data: await insightsByTime(deps, auth.tenant.id, insightsRangeOf(query), 'timeSaved') };
  });

  app.get('/insights/settings', async (request) => {
    const auth = await requireScope(request, 'insights:list');
    return { data: await insightsSettings(deps, auth.tenant.id) };
  });
}
