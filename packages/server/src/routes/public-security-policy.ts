/**
 * Public API security policy (P6-34), n8n's security-policy public controller: GET and PUT
 * `/settings/security-policy`, both `securitySettings:manage`. PUBLIC_SECURITY_POLICY_ROUTES is final and
 * shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it and runs the `access` check, then the key
 * scope). The answer is the settings (personal space publishing and sharing) and the counts the editor shows
 * beside them; `ctx.securitySettings` is the service of /rest/settings/security. This route file is the sole
 * owner of the public policy route; later items add their fields to the same two handlers.
 */
import { z } from 'zod';
import type { SecurityPolicyDTO } from '../services/security-settings';
import type { ApiRoute } from './public-api';

const policyBody = z.object({
  personalSpacePublishing: z.boolean().optional(),
  personalSpaceSharing: z.boolean().optional(),
  /** P6-53: the workspace's redaction floor (the public name of the REST `redaction`) */
  redactionEnforcement: z.object({ floor: z.enum(['off', 'production', 'all']) }).optional(),
});

/** the public shape: the REST answer with `redaction` named `redactionEnforcement` */
function publicPolicy(dto: SecurityPolicyDTO) {
  const { redaction, ...rest } = dto;
  return { ...rest, redactionEnforcement: redaction };
}

export const PUBLIC_SECURITY_POLICY_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/settings/security-policy',
    summary: 'Get the security policy of the workspace (settings and counts)',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    response: 'SecurityPolicy',
    handler: async (ctx, { auth }) => ({
      data: publicPolicy(await ctx.securitySettings.get(auth.tenant.id)),
    }),
  },
  {
    method: 'PUT',
    path: '/settings/security-policy',
    summary: 'Change the security policy (only the fields sent; turning a switch off keeps what exists)',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    body: policyBody,
    response: 'SecurityPolicy',
    handler: async (ctx, { auth, body }) => {
      const { redactionEnforcement, ...flags } = body;
      const patch = { ...flags, ...(redactionEnforcement ? { redaction: redactionEnforcement } : {}) };
      return { data: publicPolicy(await ctx.securitySettings.update(auth.tenant.id, patch, auth.user.id)) };
    },
  },
];
