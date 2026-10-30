/** /rest/workflows/* */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';
import { paginationQuery } from '../http/pagination';
import {
  idParams,
  runSchema,
  workflowCreateSchema,
  workflowDataSchema,
  workflowUpdateSchema,
} from '../http/schemas';

export const workflowListQuery = z.object({
  search: z.string().max(128).optional(),
  tagId: z.string().max(64).optional(),
  active: z.stringbool().optional(),
  ...paginationQuery,
});

const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });

export function registerWorkflowRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { workflows } = ctx;
  const actor = (request: { auth: { user: { id: string } } | null; ip: string }) => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  app.get('/workflows', async (request) => {
    const auth = requireRole(request, 'viewer');
    return workflows.list(auth.tenant.id, parse(workflowListQuery, request.query));
  });

  app.post('/workflows', async (request) => {
    const auth = requireRole(request, 'editor');
    const body = parse(workflowCreateSchema, request.body);
    return { data: await workflows.create(auth.tenant.id, body, actor(request)) };
  });

  app.get('/workflows/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await workflows.dto(auth.tenant.id, await workflows.get(auth.tenant.id, id)) };
  });

  app.patch('/workflows/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(workflowUpdateSchema, request.body);
    return { data: await workflows.update(auth.tenant.id, id, body, actor(request)) };
  });

  app.delete('/workflows/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    await workflows.delete(auth.tenant.id, id, actor(request));
    return { data: { ok: true } };
  });

  app.post('/workflows/:id/activate', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    return { data: await workflows.setActive(auth.tenant.id, id, true, actor(request)) };
  });

  app.post('/workflows/:id/deactivate', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    return { data: await workflows.setActive(auth.tenant.id, id, false, actor(request)) };
  });

  app.post('/workflows/:id/run', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(runSchema, request.body ?? {});
    return { data: await workflows.run(auth.tenant, id, body, actor(request)) };
  });

  app.post('/workflows/:id/listen-test-webhook', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({ nodeName: z.string().min(1).max(256), workflowData: workflowDataSchema.optional() }),
      request.body,
    );
    return { data: await workflows.listenTestWebhook(auth.tenant, id, body, actor(request)) };
  });

  app.get('/workflows/:id/webhook-urls', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await workflows.webhookUrls(auth.tenant, id) };
  });

  // platform extension: activation checks without activating
  app.post('/workflows/:id/validate', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    const body = parse(z.object({ workflowData: workflowDataSchema.optional() }), request.body ?? {});
    const issues = await workflows.validate(auth.tenant.id, id, body.workflowData);
    return { data: { valid: issues.length === 0, issues } };
  });

  app.get('/workflows/:id/versions', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    const query = parse(z.object(paginationQuery), request.query);
    return workflows.listVersions(auth.tenant.id, id, query.limit, query.cursor);
  });

  app.get('/workflows/:id/versions/:versionId', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id, versionId } = parse(versionParams, request.params);
    return { data: await workflows.getVersion(auth.tenant.id, id, versionId) };
  });

  // platform extension: structural diff between versions
  app.get('/workflows/:id/versions/:versionId/diff', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id, versionId } = parse(versionParams, request.params);
    const { against } = parse(
      z.object({ against: z.union([z.uuid(), z.literal('current')]).default('current') }),
      request.query,
    );
    return { data: await workflows.diffVersions(auth.tenant.id, id, versionId, against) };
  });

  app.post('/workflows/:id/versions/:versionId/restore', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id, versionId } = parse(versionParams, request.params);
    return { data: await workflows.restoreVersion(auth.tenant.id, id, versionId, actor(request)) };
  });
}
