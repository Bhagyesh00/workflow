/**
 * /rest/settings/security (P6-33, L12): GET and POST the personal space policy, `securitySettings:manage`
 * (global), as n8n's security settings controller. C0 registers both with their final path and gate; the
 * handlers reach `ctx.securitySettings`, a stub that throws until L12.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

const policyBody = z.object({
  personalSpacePublishing: z.boolean().optional(),
  personalSpaceSharing: z.boolean().optional(),
});

export function registerSecuritySettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { securitySettings } = ctx;

  app.get('/settings/security', async (request) => {
    const auth = await requireScope(request, 'securitySettings:manage');
    return { data: await securitySettings.get(auth.tenant.id) };
  });

  app.post('/settings/security', async (request) => {
    const auth = await requireScope(request, 'securitySettings:manage');
    const body = parse(policyBody, request.body);
    return { data: await securitySettings.update(auth.tenant.id, body, auth.user.id) };
  });
}
