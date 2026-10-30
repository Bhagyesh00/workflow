/** /rest/executions/* */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ExecutionRow } from '../db/schema';
import { requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor, page, paginationQuery } from '../http/pagination';
import { idParams } from '../http/schemas';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;

export const executionListQuery = z.object({
  workflowId: z.string().max(64).optional(),
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  ...paginationQuery,
});

export function executionSummary(row: ExecutionRow) {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    mode: row.mode,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    durationMs: row.startedAt && row.stoppedAt ? row.stoppedAt.getTime() - row.startedAt.getTime() : null,
    errorMessage: row.errorMessage,
    errorNode: row.errorNode,
    customData: row.customData,
    waitTill: row.waitTill?.toISOString() ?? null,
    retryOf: row.retryOf,
    retrySuccessId: row.retrySuccessId,
  };
}

export async function listExecutions(
  ctx: ServerContext,
  tenantId: string,
  query: z.output<typeof executionListQuery>,
) {
  const rows = await ctx.repos.executions.list(tenantId, {
    workflowId: query.workflowId,
    status: query.status,
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.createdAt, r.id));
  return { data: data.map(executionSummary), nextCursor };
}

export async function getExecution(ctx: ServerContext, tenantId: string, id: string, includeData = true) {
  const row = await ctx.repos.executions.get(tenantId, id);
  if (!row) throw ApiError.notFound('Execution');
  if (!includeData) return executionSummary(row);
  const data = await ctx.repos.executions.getData(tenantId, id);
  return { ...executionSummary(row), workflowData: data?.workflowData ?? null, state: data?.state ?? null };
}

export async function deleteExecution(ctx: ServerContext, tenantId: string, id: string) {
  const row = await ctx.repos.executions.get(tenantId, id);
  if (!row) throw ApiError.notFound('Execution');
  if (['new', 'running', 'waiting'].includes(row.status)) await ctx.executions.stop(tenantId, id);
  await ctx.repos.executions.delete(tenantId, id);
  await ctx.executions.removeBinaryData(tenantId, id);
}

export function registerExecutionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/executions', async (request) => {
    const auth = requireRole(request, 'viewer');
    return listExecutions(ctx, auth.tenant.id, parse(executionListQuery, request.query));
  });

  app.get('/executions/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await getExecution(ctx, auth.tenant.id, id) };
  });

  app.post('/executions/:id/retry', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(z.object({ useCurrentWorkflow: z.boolean().optional() }), request.body ?? {});
    const { executionId } = await ctx.executions.retry(auth.tenant.id, id, {
      useCurrentWorkflow: body.useCurrentWorkflow,
      userId: auth.user.id,
    });
    return { data: { executionId } };
  });

  app.post('/executions/:id/stop', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    return { data: { status: await ctx.executions.stop(auth.tenant.id, id) } };
  });

  app.delete('/executions/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    await deleteExecution(ctx, auth.tenant.id, id);
    return { data: { ok: true } };
  });
}
