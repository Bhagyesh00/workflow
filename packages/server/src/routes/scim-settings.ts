/**
 * /rest/scim/* (P6-02, L13): the workspace's SCIM settings. GET and PATCH `/scim/config`, PUT
 * `/scim/deprovisioning`, POST and DELETE `/scim/token` (mint shown once, revoke), GET
 * `/scim/transfer-targets`, all `scim:manage`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { TenantRow } from '../db/schema';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { scimSettingsOf } from '../services/scim';
import { mintScimToken } from '../services/scim-token';

const configBody = z.object({ enabled: z.boolean() });
const deprovisioningBody = z.object({
  onDelete: z.enum(['disable', 'delete']),
  dataAction: z.enum(['transfer', 'delete']),
  transferProjectId: z.uuid().nullish(),
});

export function registerScimSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos } = ctx;
  const baseUrl = `${ctx.config.baseUrl}/scim/v2`;

  async function configOf(tenantId: string) {
    const tenant = (await repos.tenants.get(tenantId)) as TenantRow;
    const token = await repos.scim.get(tenantId);
    return {
      ...scimSettingsOf(tenant),
      hasToken: Boolean(token),
      tokenHint: token?.tokenHint ?? null,
      baseUrl,
    };
  }

  /** the projects that can take a removed user's work: team projects and active members' personal ones */
  async function targets(tenantId: string) {
    const [all, members] = await Promise.all([repos.projects.listAll(tenantId), repos.memberships.listForTenant(tenantId)]);
    const active = new Set(members.filter((m) => !m.disabledAt).map((m) => m.userId));
    return all
      .filter((p) => p.type === 'team' || (p.ownerUserId !== null && active.has(p.ownerUserId)))
      .map((p) => ({ id: p.id, name: p.name, type: p.type }));
  }

  app.get('/scim/config', async (request) => {
    const auth = await requireScope(request, 'scim:manage');
    return { data: await configOf(auth.tenant.id) };
  });

  app.patch('/scim/config', async (request) => {
    const auth = await requireScope(request, 'scim:manage');
    const { enabled } = parse(configBody, request.body);
    if (enabled && !(await ctx.ssoSettings.isSsoActive(auth.tenant.id))) {
      throw ApiError.badRequest(
        'Turn on SAML or OIDC single sign-on before you enable SCIM provisioning.',
      );
    }
    await repos.scim.patchSettings(auth.tenant.id, { enabled });
    return { data: await configOf(auth.tenant.id) };
  });

  app.put('/scim/deprovisioning', async (request) => {
    const auth = await requireScope(request, 'scim:manage');
    const body = parse(deprovisioningBody, request.body);
    let transferProjectId: string | null = null;
    if (body.dataAction === 'transfer' && body.transferProjectId) {
      const project = await repos.projects.get(auth.tenant.id, body.transferProjectId);
      if (!project) throw ApiError.notFound('Project');
      if (!(await targets(auth.tenant.id)).some((target) => target.id === project.id)) {
        throw ApiError.badRequest('Pick a team project or the personal project of an active member.');
      }
      transferProjectId = project.id;
    }
    await repos.scim.patchSettings(auth.tenant.id, {
      onDelete: body.onDelete,
      dataAction: body.dataAction,
      transferProjectId,
    });
    return { data: await configOf(auth.tenant.id) };
  });

  // a new token replaces the old one; the raw token is answered once
  app.post('/scim/token', async (request, reply) => {
    const auth = await requireScope(request, 'scim:manage');
    const { token } = await mintScimToken(ctx.scim.deps, auth.tenant.id, auth.user.id);
    reply.status(201);
    return { data: { token, baseUrl } };
  });

  app.delete('/scim/token', async (request) => {
    const auth = await requireScope(request, 'scim:manage');
    if (await repos.scim.delete(auth.tenant.id)) {
      await repos.audit.add(auth.tenant.id, {
        userId: auth.user.id,
        action: 'scim.token_revoked',
        resourceType: 'tenant',
        resourceId: auth.tenant.id,
      });
    }
    return { data: { ok: true } };
  });

  app.get('/scim/transfer-targets', async (request) => {
    const auth = await requireScope(request, 'scim:manage');
    return { data: await targets(auth.tenant.id) };
  });
}
