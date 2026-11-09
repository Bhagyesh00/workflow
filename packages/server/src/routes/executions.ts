/**
 * /rest/executions/* and /rest/binary-data. P6-25: a run follows its workflow: the routes check
 * `execution:*` (or `workflow:execute`) on the run, which resolves through its workflow's projects; a run
 * with no workflow (`workflow_id` null) holds only the global scopes, so owner and admin. The list passes the
 * caller's access filter. `PATCH /executions/:id` keeps today's editor gate until the cutover (L24).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ExecutionRow } from '../db/schema';
import { type AuthContext, requireAuth, requireRole, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor, page, paginationQuery } from '../http/pagination';
import { annotationPatchSchema, idParams } from '../http/schemas';
import type { ExecutionAnnotationDTO } from '../repositories';
import { isUuid } from '../repositories/util';
import type { AccessFilter } from '../services/access';

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
  /** P5-61: highlighted data (custom data) filter; the value is a part of it unless `customDataExact` */
  customDataKey: z.string().min(1).max(50).optional(),
  customDataValue: z.string().max(255).optional(),
  customDataExact: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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
  /** P6-25: the caller's access filter (`AccessService.listFilter(auth, 'execution:list')`) */
  options: { filter?: AccessFilter } = {},
) {
  const rows = await ctx.repos.executions.list(tenantId, {
    filter: options.filter,
    workflowId: query.workflowId,
    status: query.status,
    workflowVersionId: query.workflowVersionId,
    annotationTags: query.annotationTags,
    vote: query.vote,
    customDataKey: query.customDataKey,
    customDataValue: query.customDataValue,
    customDataExact: query.customDataExact,
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

/** a part of a file id that could leave its folder */
const unsafePart = (part: string) => !part || part === '.' || part === '..' || /[\\:]/.test(part);

/**
 * P6-25: who may read a stored file (`fs:<tenantId>/<folder>/.../<file>`, as the filesystem store names it):
 * - `<executionId>/<file>`: `execution:read` on that run (through its workflow);
 * - `<threadId>/<file>`: an Assistant thread attachment, its thread owner only;
 * - `activation/<workflowId>/<file>`: a webhook lifecycle hook's file, `workflow:read` on that workflow;
 *   `activation/<file>` (stored before files named their workflow): the global scope, owner and admin.
 * Anything else (another workspace, a path trick, a trigger's staging folder) is 404.
 */
async function assertBinaryAccess(
  ctx: ServerContext,
  request: FastifyRequest,
  auth: AuthContext,
  id: string,
): Promise<void> {
  const notFound = () => ApiError.notFound('Binary data');
  if (!id.startsWith('fs:')) throw notFound();
  const parts = id.slice(3).split('/');
  if (parts.length < 3 || parts[0] !== auth.tenant.id || parts.some(unsafePart)) throw notFound();
  const folder = parts[1];
  if (folder === 'activation') {
    if (parts.length === 3) {
      await requireScope(request, 'workflow:read');
      return;
    }
    if (parts.length !== 4 || !isUuid(parts[2])) throw notFound();
    await requireScope(request, 'workflow:read', { workflowId: parts[2] });
    return;
  }
  if (parts.length !== 3 || !isUuid(folder)) throw notFound();
  if (await ctx.repos.executions.get(auth.tenant.id, folder)) {
    await requireScope(request, 'execution:read', { executionId: folder });
    return;
  }
  if (await ctx.repos.assistantThreads.get(auth.tenant.id, auth.user.id, folder)) return;
  throw notFound();
}

export function registerExecutionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // platform extension: binary data referenced from run data (`fs:<tenantId>/...`), checked by its folder
  app.get('/binary-data', async (request, reply) => {
    const auth = requireAuth(request);
    const query = parse(binaryQuery, request.query);
    await assertBinaryAccess(ctx, request, auth, query.id);
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

  /** the gate of a route on one run: sign-in, the `:id` parameter, then the scope on that run */
  const onExecution = async (request: FastifyRequest, scope: Parameters<typeof requireScope>[1]) => {
    requireAuth(request);
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, scope, { executionId: id });
    return { auth, id };
  };

  app.get('/executions', async (request) => {
    // no scope on the route (as n8n): the list shows the runs of the workflows the caller may read
    const auth = requireAuth(request);
    const query = parse(executionListQuery, request.query);
    const filter = await ctx.access.listFilter(auth, 'execution:list');
    return listExecutions(ctx, auth.tenant.id, query, { filter });
  });

  app.get('/executions/:id', async (request) => {
    const { auth, id } = await onExecution(request, 'execution:read');
    const scopes = [...(await ctx.access.scopesForAuth(auth, { executionId: id }))].sort();
    return { data: { ...(await getExecution(ctx, auth.tenant.id, id)), scopes } };
  });

  // P3-09: tags and / or vote. Today's editor gate stays until the cutover (L24; n8n: `execution:read`)
  app.patch('/executions/:id', async (request) => {
    requireRole(request, 'editor');
    const { auth, id } = await onExecution(request, 'execution:read');
    const body = parse(annotationPatchSchema, request.body);
    return {
      data: await ctx.annotations.annotate(auth.tenant.id, id, body, {
        userId: auth.user.id,
        ip: request.ip,
      }),
    };
  });

  app.post('/executions/:id/retry', async (request) => {
    const { auth, id } = await onExecution(request, 'workflow:execute');
    const body = parse(z.object({ useCurrentWorkflow: z.boolean().optional() }), request.body ?? {});
    const { executionId } = await ctx.executions.retry(auth.tenant.id, id, {
      useCurrentWorkflow: body.useCurrentWorkflow,
      userId: auth.user.id,
    });
    return { data: { executionId } };
  });

  app.post('/executions/:id/stop', async (request) => {
    const { auth, id } = await onExecution(request, 'workflow:execute');
    return { data: { status: await ctx.executions.stop(auth.tenant.id, id) } };
  });

  app.delete('/executions/:id', async (request) => {
    const { auth, id } = await onExecution(request, 'execution:delete');
    await deleteExecution(ctx, auth.tenant.id, id);
    return { data: { ok: true } };
  });
}
