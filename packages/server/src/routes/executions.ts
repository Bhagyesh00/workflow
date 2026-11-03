/** /rest/executions/* */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ExecutionRow } from '../db/schema';
import { requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor, page, paginationQuery } from '../http/pagination';
import { annotationPatchSchema, idParams } from '../http/schemas';
import type { ExecutionAnnotationDTO } from '../repositories';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;

export const executionListQuery = z.object({
  workflowId: z.string().max(64).optional(),
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  /** P3-09: annotation tag ids, comma separated (an execution needs all of them) */
  annotationTags: z
    .string()
    .max(20 * 40)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.uuid()).max(20).optional()),
  vote: z.enum(['up', 'down']).optional(),
  /** P3-10: executions of one workflow version */
  workflowVersionId: z.uuid().optional(),
  ...paginationQuery,
});

export function executionSummary(row: ExecutionRow, annotation: ExecutionAnnotationDTO | null = null) {
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
    workflowVersionId: row.workflowVersionId,
    annotation,
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
    workflowVersionId: query.workflowVersionId,
    annotationTags: query.annotationTags,
    vote: query.vote,
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.createdAt, r.id));
  // one annotation query per page
  const annotations = await ctx.repos.annotations.forExecutions(
    tenantId,
    data.map((r) => r.id),
  );
  return { data: data.map((r) => executionSummary(r, annotations.get(r.id) ?? null)), nextCursor };
}

export async function getExecution(ctx: ServerContext, tenantId: string, id: string, includeData = true) {
  const row = await ctx.repos.executions.get(tenantId, id);
  if (!row) throw ApiError.notFound('Execution');
  const annotation = (await ctx.repos.annotations.forExecutions(tenantId, [row.id])).get(row.id) ?? null;
  if (!includeData) return executionSummary(row, annotation);
  const data = await ctx.repos.executions.getData(tenantId, id);
  return {
    ...executionSummary(row, annotation),
    workflowData: data?.workflowData ?? null,
    state: data?.state ?? null,
  };
}

export async function deleteExecution(ctx: ServerContext, tenantId: string, id: string) {
  const row = await ctx.repos.executions.get(tenantId, id);
  if (!row) throw ApiError.notFound('Execution');
  if (['new', 'running', 'waiting'].includes(row.status)) await ctx.executions.stop(tenantId, id);
  await ctx.repos.executions.delete(tenantId, id);
  await ctx.executions.removeBinaryData(tenantId, id);
}

/** inline display is limited to types that cannot run script on this origin */
const INLINE_SAFE =
  /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain|application\/json)$/i;

const binaryQuery = z.object({
  id: z.string().min(4).max(1024),
  action: z.enum(['view', 'download']).default('view'),
  mimeType: z.string().max(255).optional(),
  fileName: z.string().max(255).optional(),
});

export function registerExecutionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // platform extension: binary data referenced from run data (`fs:<tenantId>/...`), tenant-checked
  app.get('/binary-data', async (request, reply) => {
    const auth = requireRole(request, 'viewer');
    const query = parse(binaryQuery, request.query);
    let data: Uint8Array;
    try {
      data = await ctx.executions
        .binaryStore(auth.tenant.id)
        .getBuffer({ id: query.id, data: '', mimeType: query.mimeType ?? 'application/octet-stream' });
    } catch {
      throw ApiError.notFound('Binary data');
    }
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(query.mimeType ?? '')
      ? query.mimeType!
      : 'application/octet-stream';
    const inline = query.action === 'view' && INLINE_SAFE.test(mimeType);
    const fileName = (query.fileName ?? 'file').replace(/["\\\r\n]/g, '_');
    return reply
      .header('content-type', mimeType)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`)
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300')
      .send(Buffer.from(data));
  });

  app.get('/executions', async (request) => {
    const auth = requireRole(request, 'viewer');
    return listExecutions(ctx, auth.tenant.id, parse(executionListQuery, request.query));
  });

  app.get('/executions/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await getExecution(ctx, auth.tenant.id, id) };
  });

  // P3-09: tags and / or vote
  app.patch('/executions/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(annotationPatchSchema, request.body);
    if (!(await ctx.repos.executions.get(auth.tenant.id, id))) throw ApiError.notFound('Execution');
    return {
      data: await ctx.annotations.annotate(auth.tenant.id, id, body, {
        userId: auth.user.id,
        ip: request.ip,
      }),
    };
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
