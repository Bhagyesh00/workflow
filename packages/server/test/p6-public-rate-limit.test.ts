/**
 * P6-83 (L15): the public API rate limits per API key. Read from the key's workspace: over a limit 429 with
 * `X-RateLimit-*`, a key with the scope reads and writes the settings, not enabled keeps 600 per minute per
 * key, a bad key flood from one IP gets 429, a second workspace has its own counters.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  signup as baseSignup,
  createTestServer,
  resetDatabase,
  type TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let ip = 1;
const signup = () =>
  baseSignup(server.app, { remoteAddress: `127.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` });

async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k-${randomUUID().slice(0, 8)}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

const call = (
  key: string,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: unknown,
  from = '127.0.0.1',
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    remoteAddress: from,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const tag = () => ({ name: `t-${randomUUID().slice(0, 8)}` });

const ZERO = {
  globalReadLimit: 0,
  globalWriteLimit: 0,
  endpointReadLimit: 0,
  endpointWriteLimit: 0,
};

async function setup() {
  const owner = await signup();
  return { owner, key: await keyOf(owner.client) };
}

describe('limits', () => {
  it('answers 429 over the global read limit, with the headers on every answer', async () => {
    const { key } = await setup();
    const set = await call(key, 'PUT', '/settings/rate-limits', {
      enabled: true,
      ...ZERO,
      globalReadLimit: 3,
      globalReadWindow: 60,
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().data.globalReadLimit).toBe(3);
    const seen: Array<string | number | string[] | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(key, 'GET', '/tags');
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      seen.push(res.headers['x-ratelimit-remaining']);
    }
    expect(seen).toEqual(['2', '1', '0']);
    const over = await call(key, 'GET', '/tags');
    expect(over.statusCode).toBe(429);
    expect(over.headers['x-ratelimit-limit']).toBe('3');
    expect(over.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(over.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    expect(over.json().error.code).toBe('rate_limited');
  });

  it('counts reads and writes apart, and the endpoint counter per route', async () => {
    const { key } = await setup();
    await call(key, 'PUT', '/settings/rate-limits', {
      enabled: true,
      ...ZERO,
      endpointReadLimit: 2,
      endpointReadWindow: 60,
      globalWriteLimit: 2,
      globalWriteWindow: 60,
    });
    expect((await call(key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await call(key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await call(key, 'GET', '/tags')).statusCode).toBe(429);
    // another route has its own endpoint counter
    expect((await call(key, 'GET', '/variables')).statusCode).toBe(200);
    // writes are a counter of their own
    expect((await call(key, 'POST', '/tags', tag())).statusCode).toBe(200);
    expect((await call(key, 'POST', '/tags', tag())).statusCode).toBe(200);
    const over = await call(key, 'POST', '/tags', tag());
    expect(over.statusCode).toBe(429);
    expect(over.headers['x-ratelimit-limit']).toBe('2');
  });

  it('counts per key: a second key of the workspace has its own counter', async () => {
    const { owner, key } = await setup();
    const other = await keyOf(owner.client);
    await call(key, 'PUT', '/settings/rate-limits', { enabled: true, ...ZERO, globalReadLimit: 1 });
    expect((await call(key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await call(key, 'GET', '/tags')).statusCode).toBe(429);
    expect((await call(other, 'GET', '/tags')).statusCode).toBe(200);
  });

  it('means no limit at 0 and sends no headers', async () => {
    const { key } = await setup();
    await call(key, 'PUT', '/settings/rate-limits', { enabled: true, ...ZERO });
    for (let i = 0; i < 5; i++) {
      const res = await call(key, 'GET', '/tags');
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('gives a second workspace its own counters and its own settings', async () => {
    const a = await setup();
    const b = await setup();
    await call(a.key, 'PUT', '/settings/rate-limits', { enabled: true, ...ZERO, globalReadLimit: 1 });
    expect((await call(a.key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await call(a.key, 'GET', '/tags')).statusCode).toBe(429);
    expect((await call(b.key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await call(b.key, 'GET', '/tags')).statusCode).toBe(200);
    const read = await call(b.key, 'GET', '/settings/rate-limits');
    expect(read.json().data.enabled).toBe(false);
  });
});

describe('not enabled', () => {
  it('keeps the fixed 600 per minute per key', async () => {
    const { key } = await setup();
    let firstRefused = 0;
    for (let i = 1; i <= 601; i++) {
      const res = await call(key, 'GET', '/tags');
      if (res.statusCode === 429 && !firstRefused) firstRefused = i;
    }
    expect(firstRefused).toBe(601);
  }, 120_000);
});

describe('bad keys', () => {
  it('counts a bad key flood per IP: 600 answer 401, then 429', async () => {
    const bad = `wfk_deadbeef_${'x'.repeat(24)}`;
    const from = `127.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    let firstRefused = 0;
    for (let i = 1; i <= 601; i++) {
      const res = await call(bad, 'GET', '/tags', undefined, from);
      if (res.statusCode === 429 && !firstRefused) firstRefused = i;
      else if (!firstRefused) expect(res.statusCode).toBe(401);
    }
    expect(firstRefused).toBe(601);
    // another IP is not counted
    expect((await call(bad, 'GET', '/tags', undefined, '127.78.0.10')).statusCode).toBe(401);
  }, 120_000);
});

describe('settings', () => {
  it('reads and writes through REST and the public API, with the audit row, and refuses a bad body', async () => {
    const { owner, key } = await setup();
    const rest = await owner.client.data<Record<string, unknown>>(
      owner.client.get('/rest/settings/policies/rate-limits'),
    );
    expect(rest.enabled).toBe(false);
    expect(rest.globalReadLimit).toBe(server.ctx.config.publicApiRateLimit.globalReadLimit);
    const put = await owner.client.put('/rest/settings/policies/rate-limits', {
      enabled: true,
      endpointWriteLimit: 7,
    });
    expect(put.statusCode).toBe(200);
    const viaKey = await call(key, 'GET', '/settings/rate-limits');
    expect(viaKey.json().data).toMatchObject({ enabled: true, endpointWriteLimit: 7 });
    const negative = await owner.client.put('/rest/settings/policies/rate-limits', { globalReadLimit: -1 });
    expect(negative.statusCode).toBe(400);
    expect((await call(key, 'PUT', '/settings/rate-limits', { nope: 1 })).statusCode).toBe(400);
    const rows = (
      await server.ctx.database.pool.query(
        "select metadata from audit_log where tenant_id = $1 and action = 'public_api_rate_limit.updated'",
        [owner.tenant.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.changed).toEqual(['enabled', 'endpointWriteLimit']);
  });

  it('refuses a key without the scope, serves a key with it', async () => {
    const { owner } = await setup();
    const narrow = await keyOf(owner.client, ['workflow:list']);
    expect((await call(narrow, 'GET', '/settings/rate-limits')).statusCode).toBe(403);
    const wide = await keyOf(owner.client, ['securitySettings:manage']);
    expect((await call(wide, 'GET', '/settings/rate-limits')).statusCode).toBe(200);
    expect((await call(wide, 'PUT', '/settings/rate-limits', { enabled: false })).statusCode).toBe(200);
  });
});
