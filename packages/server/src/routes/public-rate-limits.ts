/**
 * Public API rate limit settings (P6-83, L15): GET and PUT `/settings/rate-limits`, the workspace's public API
 * limits (the answer of REST `/settings/policies/rate-limits`), `securitySettings:manage` for the user and the
 * key. PUBLIC_RATE_LIMIT_ROUTES is final and shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it). Each
 * handler is a stub until L15 fills it.
 */
import type { ApiRoute } from './public-api';

const notImplemented = async (): Promise<never> => {
  // stub (L15)
  throw new Error('not implemented (L15)');
};

export const PUBLIC_RATE_LIMIT_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/settings/rate-limits',
    summary: 'Get the public API rate limits of the workspace',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    response: 'RateLimitSettings',
    handler: notImplemented,
  },
  {
    method: 'PUT',
    path: '/settings/rate-limits',
    summary: 'Change the public API rate limits (only the fields sent; 0 means no limit)',
    tag: 'Security policy',
    access: { scope: 'securitySettings:manage' },
    scope: 'securitySettings:manage',
    response: 'RateLimitSettings',
    handler: notImplemented,
  },
];
