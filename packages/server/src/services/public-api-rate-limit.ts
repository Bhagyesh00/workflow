/**
 * P6-83 (L15): the public API rate limits per API key, read from the key's tenant
 * (`tenants.settings.publicApiRateLimit` over `config.publicApiRateLimit`), so several mains need no reload.
 * Global and endpoint counters, read and write, in Redis or memory; 0 means no limit; over a limit 429 with
 * `X-RateLimit-Limit`, `-Remaining`, `-Reset`. Not enabled: today's fixed 600 per minute per key stays.
 * `RateLimitSettingsService` reads and writes the setting (`securitySettings:manage`, audit
 * `public_api_rate_limit.updated`).
 */
import type { ServiceDeps } from '../context';
import type { PublicApiRateLimit, TenantSettings } from '../plans';

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

/** the fixed limit of a workspace that has not enabled the limits, and of the bad key counter per IP */
export const FIXED_LIMIT = 600;
export const FIXED_WINDOW_SECONDS = 60;

const LIMIT_FIELDS = [
  'globalReadLimit',
  'globalReadWindow',
  'globalWriteLimit',
  'globalWriteWindow',
  'endpointReadLimit',
  'endpointReadWindow',
  'endpointWriteLimit',
  'endpointWriteWindow',
] as const;

/** the platform defaults under what the workspace stored */
function effectiveOf(deps: ServiceDeps, stored: PublicApiRateLimit | undefined): PublicApiRateLimit {
  return { ...deps.config.publicApiRateLimit, ...(stored ?? {}) };
}

interface Counted {
  count: number;
  resetSeconds: number;
}

const memory = new Map<string, { count: number; expires: number }>();
let lastSweep = 0;

function countInMemory(key: string, windowSeconds: number): Counted {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of memory) if (v.expires <= now) memory.delete(k);
  }
  let entry = memory.get(key);
  if (!entry || entry.expires <= now) {
    entry = { count: 0, expires: now + windowSeconds * 1000 };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, resetSeconds: Math.max(1, Math.ceil((entry.expires - now) / 1000)) };
}

/** one counter step: Redis when the server has it (every main shares the count), else this process */
async function count(deps: ServiceDeps, key: string, windowSeconds: number): Promise<Counted> {
  const ctx = deps.context();
  const redis = ctx.redis;
  if (redis) {
    try {
      const full = `${deps.config.queue.prefix}:pubrl:${key}`;
      const result = (await redis.eval(
        "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return {c, redis.call('TTL', KEYS[1])}",
        1,
        full,
        String(windowSeconds),
      )) as [number, number];
      const ttl = result[1] > 0 ? result[1] : windowSeconds;
      if (result[1] < 0) await redis.expire(full, windowSeconds);
      return { count: result[0], resetSeconds: ttl };
    } catch {
      // Redis down: this process counts, so a limit still holds on this main
    }
  }
  return countInMemory(key, windowSeconds);
}

function resultOf(counted: Counted, limit: number): RateLimitResult {
  return {
    allowed: counted.count <= limit,
    limit,
    remaining: Math.max(0, limit - counted.count),
    resetSeconds: counted.resetSeconds,
  };
}

export async function checkRateLimit(deps: ServiceDeps, request: RateLimitRequest): Promise<RateLimitResult> {
  const tenant = await deps.repos.tenants.get(request.tenantId);
  const stored = (tenant?.settings as TenantSettings | null | undefined)?.publicApiRateLimit;
  const limits = effectiveOf(deps, stored);
  const base = `${request.tenantId}:${request.apiKeyId}`;
  if (!limits.enabled) {
    return resultOf(await count(deps, `${base}:fixed`, FIXED_WINDOW_SECONDS), FIXED_LIMIT);
  }
  const op = request.method === 'GET' || request.method === 'HEAD' ? 'Read' : 'Write';
  const globalLimit = limits[`global${op}Limit`];
  const endpointLimit = limits[`endpoint${op}Limit`];
  const results: RateLimitResult[] = [];
  if (globalLimit > 0) {
    const window = limits[`global${op}Window`];
    results.push(resultOf(await count(deps, `${base}:global:${op}`, window), globalLimit));
  }
  if (endpointLimit > 0) {
    const window = limits[`endpoint${op}Window`];
    results.push(
      resultOf(
        await count(deps, `${base}:endpoint:${op}:${request.method}:${request.route}`, window),
        endpointLimit,
      ),
    );
  }
  if (results.length === 0) return { allowed: true, limit: 0, remaining: 0, resetSeconds: 0 };
  const refused = results.filter((r) => !r.allowed);
  const pool = refused.length > 0 ? refused : results;
  // the tightest counter speaks: the refusing one with the longest wait, else the fewest left
  return refused.length > 0
    ? pool.reduce((a, b) => (b.resetSeconds > a.resetSeconds ? b : a))
    : pool.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

/** the count of a key so far, read without adding to it (Redis when the server has it, else this process) */
async function peek(deps: ServiceDeps, key: string, windowSeconds: number): Promise<Counted> {
  const redis = deps.context().redis;
  if (redis) {
    try {
      const full = `${deps.config.queue.prefix}:pubrl:${key}`;
      const result = (await redis.eval(
        "return {tonumber(redis.call('GET', KEYS[1]) or 0), redis.call('TTL', KEYS[1])}",
        1,
        full,
      )) as [number, number];
      return { count: result[0], resetSeconds: result[1] > 0 ? result[1] : windowSeconds };
    } catch {
      // Redis down: read this process, as count() does
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.expires <= Date.now()) return { count: 0, resetSeconds: windowSeconds };
  return { count: entry.count, resetSeconds: Math.max(1, Math.ceil((entry.expires - Date.now()) / 1000)) };
}

/**
 * Whether an IP is already over its bad key limit, asked before the key lookup so a flood of well-formed
 * unknown keys costs no database read once the 429 is due. It adds nothing to the count.
 */
export async function peekBadKeyRate(deps: ServiceDeps, ip: string): Promise<RateLimitResult> {
  const counted = await peek(deps, `badkey:${ip}`, FIXED_WINDOW_SECONDS);
  // the call that follows would be the next one counted: it is refused when this many already are
  return resultOf({ ...counted, count: counted.count + 1 }, FIXED_LIMIT);
}

/** the per-IP counter of calls with a missing or bad key: 600 per minute */
export async function checkBadKeyRate(deps: ServiceDeps, ip: string): Promise<RateLimitResult> {
  return resultOf(await count(deps, `badkey:${ip}`, FIXED_WINDOW_SECONDS), FIXED_LIMIT);
}

export class RateLimitSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workspace's limits, defaults filled */
  async get(tenantId: string): Promise<PublicApiRateLimit> {
    const tenant = await this.deps.repos.tenants.get(tenantId);
    return effectiveOf(
      this.deps,
      (tenant?.settings as TenantSettings | null | undefined)?.publicApiRateLimit,
    );
  }

  async update(
    tenantId: string,
    patch: Partial<PublicApiRateLimit>,
    actor?: { userId?: string; ip?: string },
  ): Promise<PublicApiRateLimit> {
    const { repos } = this.deps;
    const tenant = await repos.tenants.get(tenantId);
    const settings = (tenant?.settings ?? {}) as TenantSettings;
    const next = effectiveOf(this.deps, settings.publicApiRateLimit);
    const changed: string[] = [];
    if (patch.enabled !== undefined && patch.enabled !== next.enabled) {
      next.enabled = patch.enabled;
      changed.push('enabled');
    }
    for (const field of LIMIT_FIELDS) {
      const value = patch[field];
      if (value !== undefined && value !== next[field]) {
        next[field] = value;
        changed.push(field);
      }
    }
    // P6-78: only the `publicApiRateLimit` key, merged
    await repos.tenants.mergeSettings(tenantId, { publicApiRateLimit: next });
    await repos.audit.add(tenantId, {
      userId: actor?.userId,
      action: 'public_api_rate_limit.updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { changed, enabled: next.enabled },
      ...(actor?.ip ? { ip: actor.ip } : {}),
    });
    return next;
  }
}
