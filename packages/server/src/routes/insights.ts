/**
 * /rest/insights (P6-05, L11), as n8n's insights controller: GET `/insights/summary`, `/insights/by-workflow`,
 * `/insights/by-time` and `/insights/by-time/time-saved`, all `insights:list` (a `projectId` in the query narrows
 * to one project; an unknown one is 404). GET `/insights/settings` carries what n8n sends in its frontend
 * settings (summary and dashboard on, the date ranges with their granularity, the earliest data date), also
 * `insights:list`. Paths and scope gates are final; each handler is a stub until L11 fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

const INSIGHTS_PATHS = [
  '/insights/summary',
  '/insights/by-workflow',
  '/insights/by-time',
  '/insights/by-time/time-saved',
  '/insights/settings',
] as const;

export function registerInsightsRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  for (const path of INSIGHTS_PATHS) {
    app.get(path, async (request) => {
      await requireScope(request, 'insights:list');
      // stub (L11)
      throw new Error('not implemented (L11)');
    });
  }
}
