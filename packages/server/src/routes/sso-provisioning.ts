/**
 * /rest/sso/provisioning/config and /rest/sso/role-mapping-rules (P6-11, L9). The config needs
 * `provisioning:manage`; the rules `roleMappingRule:list`, `:create`, `:update` (also the move) and `:delete`.
 * The service checks the expression (2000 characters, a dry run), the role and the projects of the workspace.
 */
import type { DataObject } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';
import { idParams } from '../http/schemas';

const ruleBody = z.object({
  type: z.enum(['instance', 'project']),
  expression: z.string().min(1).max(2000),
  role: z.string().trim().min(1).max(128),
  projectIds: z.array(z.uuid()).max(500).optional(),
});
const rulePatch = ruleBody.partial();
const moveBody = z.object({ position: z.number().int().min(0).max(100000) });

export function registerProvisioningRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/sso/provisioning/config', async (request) => {
    const auth = await requireScope(request, 'provisioning:manage');
    return { data: await ctx.provisioning.getConfig(auth.tenant.id) };
  });

  app.patch('/sso/provisioning/config', async (request) => {
    const auth = await requireScope(request, 'provisioning:manage');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return { data: await ctx.provisioning.saveConfig(auth.tenant.id, body as DataObject, auth.user.id) };
  });

  app.get('/sso/role-mapping-rules', async (request) => {
    const auth = await requireScope(request, 'roleMappingRule:list');
    return { data: await ctx.provisioning.listRules(auth.tenant.id) };
  });

  app.post('/sso/role-mapping-rules', async (request) => {
    const auth = await requireScope(request, 'roleMappingRule:create');
    const body = parse(ruleBody, request.body ?? {});
    return { data: await ctx.provisioning.createRule(auth.tenant.id, auth.user.id, body) };
  });

  app.post('/sso/role-mapping-rules/:id/move', async (request) => {
    const auth = await requireScope(request, 'roleMappingRule:update');
    const { id } = parse(idParams, request.params);
    const { position } = parse(moveBody, request.body ?? {});
    return { data: await ctx.provisioning.moveRule(auth.tenant.id, auth.user.id, id, position) };
  });

  app.patch('/sso/role-mapping-rules/:id', async (request) => {
    const auth = await requireScope(request, 'roleMappingRule:update');
    const { id } = parse(idParams, request.params);
    const body = parse(rulePatch, request.body ?? {});
    return { data: await ctx.provisioning.updateRule(auth.tenant.id, auth.user.id, id, body) };
  });

  app.delete('/sso/role-mapping-rules/:id', async (request) => {
    const auth = await requireScope(request, 'roleMappingRule:delete');
    const { id } = parse(idParams, request.params);
    await ctx.provisioning.deleteRule(auth.tenant.id, auth.user.id, id);
    return { data: { ok: true } };
  });
}
