/**
 * Public API rate limit settings (P6-83, L15): GET and PUT `/settings/rate-limits`, the workspace's public API
 * limits (the answer of REST `/settings/policies/rate-limits`), `securitySettings:manage` for the user and the
 * key. PUBLIC_RATE_LIMIT_ROUTES is shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 */
import type { ApiRoute } from './public-api';
import { rateLimitPatchSchema } from './rate-limit-settings';

export const PUBLIC_RATE_LIMIT_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/settings/rate-limits',
    summary: 'Get the public API rate limits of the workspace',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    response: 'RateLimitSettings',
    handler: async (ctx, { auth }) => ({ data: await ctx.rateLimitSettings.get(auth.tenant.id) }),
  },
  {
    method: 'PUT',
    path: '/settings/rate-limits',
    summary: 'Change the public API rate limits (only the fields sent; 0 means no limit)',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    body: rateLimitPatchSchema,
    response: 'RateLimitSettings',
    handler: async (ctx, { auth, body, request }) => ({
      data: await ctx.rateLimitSettings.update(auth.tenant.id, body, {
        userId: auth.user.id,
        ip: request.ip,
      }),
    }),
  },
];
