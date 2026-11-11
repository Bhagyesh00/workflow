/**
 * P6-83 (L15): the demo's public API rate limit settings (Settings > Security): GET and PUT
 * `/settings/policies/rate-limits`, `securitySettings:manage`. Not enabled by default (the fixed 600 per minute per
 * key); the fields sent change, the others keep their value; 0 means no limit, windows are seconds.
 */
import type { RateLimitSettings } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';

const DEFAULTS: RateLimitSettings = {
  enabled: false,
  globalReadLimit: 1200,
  globalReadWindow: 60,
  globalWriteLimit: 600,
  globalWriteWindow: 60,
  endpointReadLimit: 1000,
  endpointReadWindow: 60,
  endpointWriteLimit: 500,
  endpointWriteWindow: 60,
};

const LIMITS = ['globalReadLimit', 'globalWriteLimit', 'endpointReadLimit', 'endpointWriteLimit'] as const;
const WINDOWS = [
  'globalReadWindow',
  'globalWriteWindow',
  'endpointReadWindow',
  'endpointWriteWindow',
] as const;

export function registerRateLimitRoutes(backend: MockBackend): void {
  // per workspace; a reset backend registers again and starts from the defaults
  const byTenant = new Map<string, RateLimitSettings>();
  const settingsOf = (tenantId: string): RateLimitSettings => {
    let settings = byTenant.get(tenantId);
    if (!settings) {
      settings = copy(DEFAULTS);
      byTenant.set(tenantId, settings);
    }
    return settings;
  };

  backend.on('GET', '/settings/policies/rate-limits', () => {
    const { tenant } = backend.requireScope('securitySettings:manage');
    return copy(settingsOf(tenant.id));
  });

  backend.on('PUT', '/settings/policies/rate-limits', ({ body }) => {
    const { tenant } = backend.requireScope('securitySettings:manage');
    const next = copy(settingsOf(tenant.id));
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        throw new HttpError(400, 'invalid_body', 'enabled must be true or false');
      next.enabled = body.enabled;
    }
    for (const [fields, min] of [
      [LIMITS, 0],
      [WINDOWS, 1],
    ] as const) {
      for (const field of fields) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
          throw new HttpError(400, 'invalid_body', `${field} must be a whole number of ${min} or more`);
        next[field] = value;
      }
    }
    byTenant.set(tenant.id, next);
    return copy(next);
  });
}
