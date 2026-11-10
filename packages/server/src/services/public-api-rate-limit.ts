/**
 * P6-83 (L15): the public API rate limits per API key, read from the key's tenant
 * (`tenants.settings.publicApiRateLimit` over `config.publicApiRateLimit`), so several mains need no reload.
 * Global and endpoint counters, read and write, in Redis or memory; 0 means no limit; over a limit 429 with
 * `X-RateLimit-Limit`, `-Remaining`, `-Reset`. Not enabled: today's fixed 600 per minute per key stays.
 * `RateLimitSettingsService` reads and writes the setting (`securitySettings:manage`, audit
 * `public_api_rate_limit.updated`).
 * Stub from C0; L15 fills it (nothing calls `checkRateLimit` until L15 wires routes/public-api.ts).
 */
import type { ServiceDeps } from '../context';
import type { PublicApiRateLimit } from '../plans';

export interface RateLimitRequest {
  tenantId: string;
  apiKeyId: string;
  method: string;
  /** the route's pattern (the endpoint counter's key) */
  route: string;
}

/** `allowed` false: answer 429; the headers go on every answer */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** seconds until the window resets */
  resetSeconds: number;
}

export async function checkRateLimit(
  _deps: ServiceDeps,
  _request: RateLimitRequest,
): Promise<RateLimitResult> {
  // stub (L15)
  throw new Error('not implemented (L15)');
}

export class RateLimitSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workspace's limits, defaults filled */
  async get(_tenantId: string): Promise<PublicApiRateLimit> {
    // stub (L15)
    throw new Error('not implemented (L15)');
  }

  async update(
    _tenantId: string,
    _patch: Partial<PublicApiRateLimit>,
    _actor?: { userId?: string; ip?: string },
  ): Promise<PublicApiRateLimit> {
    // stub (L15)
    throw new Error('not implemented (L15)');
  }
}
