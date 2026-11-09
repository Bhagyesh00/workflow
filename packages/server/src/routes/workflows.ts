/** /rest/workflows/* */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';
import { paginationQuery } from '../http/pagination';
import {
  idParams,
  importUrlSchema,
  publishSchema,
  runSchema,
  versionPatchSchema,
  workflowCreateSchema,
  workflowDataSchema,
  workflowUpdateSchema,
} from '../http/schemas';

/** "a,b,c" -> ['a', 'b', 'c'] (empty parts dropped) */
const commaList = (item: z.ZodString, max: number) =>
  z
    .string()
    .max(max * 300)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).max(max).optional());

export const workflowListQuery = z.object({
  search: z.string().max(128).optional(),
  tagId: z.string().max(64).optional(),
  active: z.stringbool().optional(),
  /** P3-07: a folder id or 'root'; omitted = every folder */
  folderId: z.union([z.uuid(), z.literal('root')]).optional(),
  /** P6-22: only workflows of (owned by or shared with) this project */
  projectId: z.uuid().optional(),
  /** P6-22: only workflows shared with the caller's personal project (the Shared page) */
  onlySharedWithMe: z.stringbool().optional(),
  /** P6-22: every row carries the caller's `scopes` */
  includeScopes: z.stringbool().optional(),
  /** P3-07: archived workflows are hidden unless 'true' (only them) or 'all' */
  archived: z.enum(['false', 'true', 'all']).default('false'),
  /** P3-01 command bar: node type ids matching the search (comma separated, at most 20) */
  nodeTypes: commaList(z.string().min(1).max(256), 20),
  /** P3-01 command bar: also match tag names */
  matchTags: z.stringbool().optional(),
  ...paginationQuery,
});

const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });

/** the project a create route names (the gate reads it before the body is parsed) */
const projectPeek = z.object({ projectId: z.uuid().nullish() });
const createBody = workflowCreateSchema.extend({ projectId: z.uuid().nullish() });
const importBody = importUrlSchema.extend({ projectId: z.uuid().nullish() });

const moveBody = z.object({
  workflowIds: z.array(z.uuid()).min(1).max(100),
  folderId: z.uuid().nullable(),
});

const timelineQuery = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
});

export function registerWorkflowRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { workflows } = ctx;
  const actor = (request: { auth: { user: { id: string } } | null; ip: string }) => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  /** the gate of a route on one workflow: sign-in, the `:id` parameter, then the scope on that row */
  const onWorkflow = async (request: FastifyRequest, scope: Scope | readonly Scope[]) => {
    requireAuth(request);
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, scope, { workflowId: id });
    return { auth, id };
  };
  const onVersion = async (request: FastifyRequest, scope: Scope | readonly Scope[]) => {
    requireAuth(request);
    const { id, versionId } = parse(versionParams, request.params);
    const auth = await requireScope(request, scope, { workflowId: id });
    return { auth, id, versionId };
  };
  /** the project a create goes to (`targetProject`: the body's, else the default) with `workflow:create` in it */
  const createTarget = async (request: FastifyRequest): Promise<{ auth: AuthContext; projectId: string }> => {
    const signedIn = requireAuth(request);
    const peek = projectPeek.safeParse(request.body ?? {});
    const projectId = await ctx.access.targetProject(
      signedIn,
      peek.success ? peek.data.projectId : undefined,
    );
    const auth = await requireScope(request, 'workflow:create', { projectId });
    return { auth, projectId };
  };

  app.get('/workflows', async (request) => {
    // no scope on the route (as n8n): `listFor` narrows the rows to the caller's `workflow:list` access filter,
    // so a member sees the projects it belongs to and a caller with nothing sees an empty list
    const auth = requireAuth(request);
    return workflows.listFor(auth, parse(workflowListQuery, request.query));
  });

  app.post('/workflows', async (request) => {
    const { auth, projectId } = await createTarget(request);
    const { projectId: _ignored, ...body } = parse(createBody, request.body);
    const created = await workflows.create(auth.tenant.id, { ...body, projectId }, actor(request));
    return { data: await workflows.dtoFor(auth, created) };
  });

  app.get('/workflows/:id', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    const row = await workflows.get(auth.tenant.id, id);
    return { data: await workflows.dtoFor(auth, await workflows.dto(auth.tenant.id, row), row) };
  });

  app.patch('/workflows/:id', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:update');
    const body = parse(workflowUpdateSchema, request.body);
    const updated = await workflows.update(auth.tenant.id, id, body, actor(request));
    return { data: await workflows.dtoFor(auth, updated) };
  });

  app.delete('/workflows/:id', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:delete');
    await workflows.delete(auth.tenant.id, id, actor(request));
    return { data: { ok: true } };
  });

  // P3-13: the URL travels in the body, never in a query string
  app.post('/workflows/from-url', async (request) => {
    const { auth } = await createTarget(request);
    const { url } = parse(importBody, request.body);
    return { data: await ctx.workflowImportUrl.importFromUrl(auth.tenant.id, url) };
  });

  // P3-07: move workflows to a folder (null = root)
  app.post('/workflows/move', async (request) => {
    // every workflow needs `workflow:update` and the folder `folder:read`; the folder and the workflows
    // share one project (the archive service refuses otherwise). A body with no ids falls back to the global scope.
    requireAuth(request);
    const peek = moveBody.partial().safeParse(request.body ?? {});
    const peeked = peek.success ? [...new Set(peek.data.workflowIds ?? [])] : [];
    let auth: AuthContext;
    if (peeked.length) {
      auth = requireAuth(request);
      for (const id of peeked) await requireScope(request, 'workflow:update', { workflowId: id });
      if (peek.success && peek.data.folderId) {
        await requireScope(request, 'folder:read', { folderId: peek.data.folderId });
      }
    } else {
      auth = await requireScope(request, 'workflow:update');
    }
    const body = parse(moveBody, request.body);
    for (const id of new Set(body.workflowIds)) await workflows.get(auth.tenant.id, id);
    return {
      data: await ctx.workflowArchive.move(auth.tenant.id, body.workflowIds, body.folderId, actor(request)),
    };
  });

  app.post('/workflows/:id/archive', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:delete');
    return { data: await ctx.workflowArchive.archive(auth.tenant.id, id, actor(request)) };
  });

  app.post('/workflows/:id/unarchive', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:delete');
    return { data: await ctx.workflowArchive.unarchive(auth.tenant.id, id, actor(request)) };
  });

  // publish (P3-10): an empty body publishes the current version
  app.post('/workflows/:id/activate', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:publish');
    const body = parse(publishSchema, request.body ?? {});
    return { data: await workflows.setActive(auth.tenant.id, id, true, actor(request), body) };
  });

  // P3-16
  app.get('/workflows/:id/publish-timeline', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    const page = parse(timelineQuery, request.query);
    await workflows.get(auth.tenant.id, id);
    return ctx.publishHistory.list(auth.tenant.id, id, page);
  });

  app.post('/workflows/:id/deactivate', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:unpublish');
    return { data: await workflows.setActive(auth.tenant.id, id, false, actor(request)) };
  });

  app.post('/workflows/:id/run', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:execute');
    const body = parse(runSchema, request.body ?? {});
    return { data: await workflows.run(auth.tenant, id, body, actor(request)) };
  });

  app.post('/workflows/:id/listen-test-webhook', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:execute');
    const body = parse(
      z.object({
        nodeName: z.string().min(1).max(256),
        workflowData: workflowDataSchema.optional(),
        // P5-59: the canvas chat runs up to the node it was opened from
        destinationNode: z.string().min(1).max(256).optional(),
      }),
      request.body,
    );
    return { data: await workflows.listenTestWebhook(auth.tenant, id, body, actor(request)) };
  });

  // the editor's "Stop listening": drop the caller tenant's test registrations of one node
  app.delete('/workflows/:id/listen-test-webhook', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:execute');
    const { nodeName } = parse(z.object({ nodeName: z.string().min(1).max(256) }), request.body);
    await workflows.stopTestWebhook(auth.tenant, id, nodeName);
    return { data: { ok: true } };
  });

  // a trigger node without a webhook (L12)
  app.post('/workflows/:id/listen-test-trigger', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:execute');
    const { nodeName } = parse(z.object({ nodeName: z.string().min(1).max(256) }), request.body);
    return { data: await workflows.listenTestTrigger(auth.tenant, id, nodeName, actor(request)) };
  });

  app.delete('/workflows/:id/listen-test-trigger', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:execute');
    await workflows.stopTestTrigger(auth.tenant, id);
    return { data: { ok: true } };
  });

  // why a published workflow's triggers are down (n8n's GET /active-workflows/error/:id)
  app.get('/active-workflows/error/:id', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    return { data: await workflows.activationError(auth.tenant.id, id) };
  });

  app.get('/workflows/:id/webhook-urls', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    return { data: await workflows.webhookUrls(auth.tenant, id), nextCursor: null };
  });

  // platform extension: activation checks without activating
  app.post('/workflows/:id/validate', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    const body = parse(z.object({ workflowData: workflowDataSchema.optional() }), request.body ?? {});
    const issues = await workflows.validate(auth.tenant.id, id, body.workflowData);
    return { data: { valid: issues.length === 0, issues } };
  });

  app.get('/workflows/:id/versions', async (request) => {
    const { auth, id } = await onWorkflow(request, 'workflow:read');
    const query = parse(z.object(paginationQuery), request.query);
    return workflows.listVersions(auth.tenant.id, id, query.limit, query.cursor);
  });

  app.get('/workflows/:id/versions/:versionId', async (request) => {
    const { auth, id, versionId } = await onVersion(request, 'workflow:read');
    return { data: await workflows.getVersion(auth.tenant.id, id, versionId) };
  });

  // platform extension: structural diff between versions
  app.get('/workflows/:id/versions/:versionId/diff', async (request) => {
    const { auth, id, versionId } = await onVersion(request, 'workflow:read');
    const { against } = parse(
      z.object({
        against: z.union([z.uuid(), z.literal('current'), z.literal('published')]).default('current'),
      }),
      request.query,
    );
    return { data: await workflows.diffVersions(auth.tenant.id, id, versionId, against) };
  });

  // P3-10: name or describe a version
  app.patch('/workflows/:id/versions/:versionId', async (request) => {
    const { auth, id, versionId } = await onVersion(request, 'workflow:update');
    const body = parse(versionPatchSchema, request.body);
    await workflows.getVersion(auth.tenant.id, id, versionId);
    return { data: await workflows.updateVersion(auth.tenant.id, id, versionId, body, actor(request)) };
  });

  app.post('/workflows/:id/versions/:versionId/restore', async (request) => {
    const { auth, id, versionId } = await onVersion(request, 'workflow:update');
    return { data: await workflows.restoreVersion(auth.tenant.id, id, versionId, actor(request)) };
  });
}
