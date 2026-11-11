/**
 * /rest bulk run actions (P6-85, L17), as n8n's executions controller: POST `/executions/stopMany`
 * (`{ filter }`, a selection as `ids` in the filter; only runs of projects where the caller holds
 * `workflow:execute`; answers `{ stopped }`) and POST `/executions/delete` (`{ ids, filters, deleteBefore }`;
 * `execution:delete` per row; none accessible gives "Execution not found"; answers `{ deleted }`). Both are in
 * the list filter form of `GET /executions` (from S1): no scope on the route, every row is checked against the
 * caller's access in the service.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { deleteMany, stopMany } from '../services/execution-bulk';
import { EXECUTION_MODES, isoInstant } from './executions';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;

const ids = z.array(z.uuid()).max(1000);

/** the filter of the list, as the editor sends it in a body (`status` one value or a list, dates as ISO text) */
const bulkFilter = z.object({
  ids: ids.optional(),
  workflowId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z
    .union([z.string().max(200), z.array(z.enum(STATUSES)).max(STATUSES.length)])
    .optional()
    .transform((v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    )
    .pipe(z.array(z.enum(STATUSES)).optional()),
  mode: z.enum(EXECUTION_MODES).optional(),
  startedAfter: isoInstant.optional(),
  startedBefore: isoInstant.optional(),
  annotationTags: z.array(z.uuid()).max(20).optional(),
  vote: z.enum(['up', 'down']).optional(),
  workflowVersionId: z.uuid().optional(),
  customDataKey: z.string().min(1).max(50).optional(),
  customDataValue: z.string().max(255).optional(),
  customDataExact: z.boolean().optional(),
});

const stopBody = z.object({ filter: bulkFilter.default({}) });

const deleteBody = z.object({
  ids: ids.optional(),
  filters: bulkFilter.optional(),
  deleteBefore: isoInstant.optional(),
});

export function registerExecutionBulkRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/executions/stopMany', async (request) => {
    const auth = requireAuth(request);
    const { filter } = parse(stopBody, request.body ?? {});
    return { data: await stopMany(ctx.serviceDeps, auth, filter) };
  });

  app.post('/executions/delete', async (request) => {
    const auth = requireAuth(request);
    const body = parse(deleteBody, request.body ?? {});
    if (!body.ids?.length && !body.filters && !body.deleteBefore) {
      // a delete with nothing to select is refused (it would reach every run)
      throw ApiError.badRequest('Give ids, filters or deleteBefore');
    }
    return { data: await deleteMany(ctx.serviceDeps, auth, body) };
  });
}
