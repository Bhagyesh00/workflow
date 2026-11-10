/**
 * /rest bulk run actions (P6-85, L17), as n8n's executions controller: POST `/executions/stopMany`
 * (`{ filter }`, a selection as `ids` in the filter; only runs of projects where the caller holds
 * `workflow:execute`; answers `{ stopped }`) and POST `/executions/delete` (`{ ids, filters, deleteBefore }`;
 * `execution:delete` per row; none accessible gives "Execution not found"). Both are in the list filter form of
 * `GET /executions` (from S1): no scope on the route, every row is checked against the caller's access filter.
 * Paths and the filter form are final; each handler is a stub until L17 fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';

export function registerExecutionBulkRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/executions/stopMany', async (request) => {
    const auth = requireAuth(request);
    // L17 narrows the runs to the projects of `accessibleProjectIds(auth, 'workflow:execute')`
    await ctx.access.listFilter(auth, 'workflow:execute');
    // stub (L17)
    throw new Error('not implemented (L17)');
  });

  app.post('/executions/delete', async (request) => {
    const auth = requireAuth(request);
    await ctx.access.listFilter(auth, 'execution:delete');
    // stub (L17)
    throw new Error('not implemented (L17)');
  });
}
