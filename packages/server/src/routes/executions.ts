/**
 * /rest/executions/* and /rest/binary-data. P6-25: a run follows its workflow: the routes check
 * `execution:*` (or `workflow:execute`) on the run, which resolves through its workflow's projects; a run
 * with no workflow (`workflow_id` null) holds only the global scopes, so owner and admin. The list passes the
 * caller's access filter. `PATCH /executions/:id` (annotations) needs `execution:read` on the run (P6-39).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ExecutionRow } from '../db/schema';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor, page, paginationQuery } from '../http/pagination';
import { annotationPatchSchema, idParams } from '../http/schemas';
import type { ExecutionAnnotationDTO } from '../repositories';
import { isUuid } from '../repositories/util';
import type { AccessFilter } from '../services/access';
import { type ExecutionViewer, redactExecution, redactSummaries } from '../services/redaction/read';

/**
 * P6-53 (S3): `?redactExecutionData=false` asks to reveal a redacted run (the reveal rules apply); `true` or
 * absent reads it as the policy shows it
 */
const redactExecutionDataParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

const executionReadQuery = z.object({ redactExecutionData: redactExecutionDataParam });

/** the viewer of a read: the signed-in user (a session or an API key) in its workspace */
export const viewerOf = (auth: Pick<AuthContext, 'tenant' | 'user'>): ExecutionViewer => ({
  tenantId: auth.tenant.id,
  userId: auth.user.id,
});

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;

/** P6-85: the run modes the list filters by */
export const EXECUTION_MODES = [
  'manual',
  'trigger',
  'webhook',
  'internal',
  'retry',
  'integrated',
  'cli',
  'evaluation',
  'chat',
  'error',
] as const;

/** P6-85: an ISO date or time in a query */
export const isoInstant = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO date or time')
  .transform((v) => new Date(v));

export const executionListQuery = z.object({
  workflowId: z.string().max(64).optional(),
  /**
   * P6-25: the runs of this project's workflows (owned by it or shared into it); it narrows the caller's
   * access filter, so a project the caller holds nothing in answers an empty list (as the workflows list)
   */
  projectId: z.uuid().optional(),
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
  /** P6-85: runs started at or after / at or before this time */
  startedAfter: isoInstant.optional(),
  startedBefore: isoInstant.optional(),
  /** P6-85 (REST only, as n8n): the run mode */
  mode: z.enum(EXECUTION_MODES).optional(),
  /** P6-85 (REST only): the run's workflow is archived (`true`) or not (`false`) */
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
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
    // P6-15: the run used a user's own connection of a private credential (the editor shows an icon)
    usedPrivateCredentials: row.usedPrivateCredentials,
    annotation,
  };
}

export async function listExecutions(
  ctx: ServerContext,
  /** P6-53 (S3): who reads the page; the rows go through `redactSummaries` */
  viewer: ExecutionViewer,
  query: z.output<typeof executionListQuery>,
  /** P6-25: the caller's access filter (`AccessService.listFilter(auth, 'execution:list')`) */
  options: { filter?: AccessFilter } = {},
) {
  const { tenantId } = viewer;
  const rows = await ctx.repos.executions.list(tenantId, {
    filter: options.filter,
    projectId: query.projectId,
    workflowId: query.workflowId,
    status: query.status,
    workflowVersionId: query.workflowVersionId,
    annotationTags: query.annotationTags,
    vote: query.vote,
    customDataKey: query.customDataKey,
    customDataValue: query.customDataValue,
    customDataExact: query.customDataExact,
    startedAfter: query.startedAfter,
    startedBefore: query.startedBefore,
    mode: query.mode,
    archived: query.archived,
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.createdAt, r.id));
  // one annotation query per page
  const annotations = await ctx.repos.annotations.forExecutions(
    tenantId,
    data.map((r) => r.id),
  );
  const summaries = data.map((r) => executionSummary(r, annotations.get(r.id) ?? null));
  // P6-53 (S3): one `redactionFacts` query per page (L8); a redacted row's `errorMessage` is blank
  return { data: await redactSummaries(ctx.serviceDeps, viewer, summaries), nextCursor };
}

/**
 * One run for one viewer. P6-53 (S3): the row and its data go through `redactExecution`; a redacted read
 * carries `redactionInfo` (and `redactedError`), `reveal` (`?redactExecutionData=false`) applies the reveal
 * rules. A tool never passes `reveal`.
 */
export async function getExecution(
  ctx: ServerContext,
  viewer: ExecutionViewer,
  id: string,
  options: { includeData?: boolean; reveal?: boolean } = {},
) {
  const { tenantId } = viewer;
  const includeData = options.includeData ?? true;
  const stored = await ctx.repos.executions.get(tenantId, id);
  if (!stored) throw ApiError.notFound('Execution');
  const annotation =
    (await ctx.repos.annotations.forExecutions(tenantId, [stored.id])).get(stored.id) ?? null;
  const read = await redactExecution(
    ctx.serviceDeps,
    viewer,
    stored,
    includeData ? await ctx.repos.executions.getData(tenantId, id) : undefined,
    { reveal: options.reveal },
  );
  const redaction = {
    ...(read.redactionInfo ? { redactionInfo: read.redactionInfo } : {}),
    ...(read.redactedError !== undefined ? { redactedError: read.redactedError } : {}),
  };
  if (!includeData) return { ...executionSummary(read.row, annotation), ...redaction };
  return {
    ...executionSummary(read.row, annotation),
    workflowData: read.data?.workflowData ?? null,
    state: read.data?.state ?? null,
    ...redaction,
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
  /** P6-53 (S3): `false` asks to reveal the file of a redacted run (the reveal rules apply) */
  redactExecutionData: redactExecutionDataParam,
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
  /** P6-53 (S3): `?redactExecutionData=false` */
  reveal = false,
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
  const run = await ctx.repos.executions.get(auth.tenant.id, folder);
  if (run) {
    await requireScope(request, 'execution:read', { executionId: folder });
    // P6-53 (S3): a run's file follows its data: the same decision as `redactExecution` (no data loaded; L8
    // judges the run's `redactionFacts` against the viewer). Redacted for this viewer: 403; with reveal, the
    // reveal rules apply (`redactExecution` refuses or reveals).
    const read = await redactExecution(ctx.serviceDeps, viewerOf(auth), run, undefined, { reveal });
    if (read.redactionInfo?.isRedacted) {
      throw new ApiError(
        403,
        'EXECUTION_REVEAL_FORBIDDEN',
        "Couldn't read the file: the data of this execution is redacted",
      );
    }
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
    await assertBinaryAccess(ctx, request, auth, query.id, query.redactExecutionData === false);
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
    return listExecutions(ctx, viewerOf(auth), query, { filter });
  });

  app.get('/executions/:id', async (request) => {
    const { auth, id } = await onExecution(request, 'execution:read');
    const { redactExecutionData } = parse(executionReadQuery, request.query ?? {});
    const scopes = [...(await ctx.access.scopesForAuth(auth, { executionId: id }))].sort();
    const execution = await getExecution(ctx, viewerOf(auth), id, { reveal: redactExecutionData === false });
    return { data: { ...execution, scopes } };
  });

  // P3-09: tags and / or vote; n8n's `execution:read` on the run (P6-39)
  app.patch('/executions/:id', async (request) => {
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
