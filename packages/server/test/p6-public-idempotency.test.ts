/**
 * P6-82 (L15): the public API's `Idempotency-Key`. A POST with the header replays its first success for 12 hours;
 * another body with the key is 422, a call still running is 409, an error releases the key, the key is unique per
 * workspace, user and key, and the stored answer is encrypted (a replay of `POST /users` returns the invite link
 * while the row holds none).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signup as baseSignup,
  createTestServer,
  memberAs,
  resetDatabase,
  type TestClient,
  type TestServer,
  teamProjectOf,
  workflowIn,
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
  vi.restoreAllMocks();
});

let ip = 1;
const signup = () =>
  baseSignup(server.app, { remoteAddress: `127.8.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` });

const post = (key: string, url: string, payload: unknown, idem?: string) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key, ...(idem === undefined ? {} : { 'idempotency-key': idem }) },
    payload: payload as object,
  });

async function keyOf(client: TestClient): Promise<string> {
  const made = await client.data(client.post('/rest/api-keys', { name: `k-${randomUUID().slice(0, 8)}` }));
  return made.key as string;
}

async function setup() {
  const owner = await signup();
  return { owner, ownerKey: await keyOf(owner.client) };
}

const rowsOf = async (tenantId: string) =>
  (
    await server.ctx.database.pool.query('select * from public_api_idempotency where tenant_id = $1', [
      tenantId,
    ])
  ).rows as Array<Record<string, any>>;

const tagName = () => `tag-${randomUUID().slice(0, 8)}`;

describe('replay', () => {
  it('answers the first success again and runs the handler once', async () => {
    const { owner, ownerKey } = await setup();
    const name = tagName();
    const first = await post(ownerKey, '/tags', { name }, 'key-1');
    expect(first.statusCode).toBe(200);
    const second = await post(ownerKey, '/tags', { name }, 'key-1');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const tags = await owner.client.data<Array<{ name: string }>>(owner.client.get('/rest/tags'));
    expect(tags.filter((t) => t.name === name)).toHaveLength(1);
    const rows = await rowsOf(owner.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('done');
  });

  it('does nothing for a call with no header, a blank header, a GET or an exempt path', async () => {
    const { owner, ownerKey } = await setup();
    expect((await post(ownerKey, '/tags', { name: tagName() })).statusCode).toBe(200);
    expect((await post(ownerKey, '/tags', { name: tagName() }, '   ')).statusCode).toBe(200);
    const wf = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    expect((await post(ownerKey, `/workflows/${wf.id}/archive`, {}, 'exempt-1')).statusCode).toBe(200);
    expect((await post(ownerKey, `/workflows/${wf.id}/unarchive`, {}, 'exempt-1')).statusCode).toBe(200);
    const get = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tags',
      headers: { 'x-api-key': ownerKey, 'idempotency-key': 'get-1' },
    });
    expect(get.statusCode).toBe(200);
    expect(await rowsOf(owner.tenant.id)).toHaveLength(0);
  });
});

describe('refusals', () => {
  it('refuses another body with the same key, 422', async () => {
    const { ownerKey } = await setup();
    expect((await post(ownerKey, '/tags', { name: tagName() }, 'k-mismatch')).statusCode).toBe(200);
    const other = await post(ownerKey, '/tags', { name: tagName() }, 'k-mismatch');
    expect(other.statusCode).toBe(422);
    expect(other.json().error.message).toBe(
      'This Idempotency-Key was already used with a different request.',
    );
  });

  it('counts the same keys in another order as another body', async () => {
    const { ownerKey } = await setup();
    const a = await post(ownerKey, '/variables', { key: 'A_1', value: '1' }, 'k-order');
    expect(a.statusCode).toBe(200);
    const b = await post(ownerKey, '/variables', { value: '1', key: 'A_1' }, 'k-order');
    expect(b.statusCode).toBe(422);
  });

  it('answers 409 while the first call is still running', async () => {
    const { owner, ownerKey } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = server.ctx.members.inviteMany.bind(server.ctx.members);
    const spy = vi.spyOn(server.ctx.members, 'inviteMany').mockImplementation(async (...args) => {
      await gate;
      return real(...args);
    });
    const body = [{ email: `slow-${randomUUID().slice(0, 8)}@example.com` }];
    const running = post(ownerKey, '/users', body, 'k-running');
    for (let i = 0; i < 100 && spy.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    const second = await post(ownerKey, '/users', body, 'k-running');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe('A request with this Idempotency-Key is already in progress.');
    release();
    expect((await running).statusCode).toBe(201);
    expect((await rowsOf(owner.tenant.id))[0].status).toBe('done');
  });

  it('refuses a header that is not 1 to 128 visible ASCII characters, 400', async () => {
    const { ownerKey } = await setup();
    const message = 'Idempotency-Key must be 1 to 128 visible ASCII characters.';
    for (const bad of ['x'.repeat(129), 'café', 'tab\tkey']) {
      const res = await post(ownerKey, '/tags', { name: tagName() }, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.message).toBe(message);
    }
    expect((await post(ownerKey, '/tags', { name: tagName() }, `  ${'y'.repeat(128)}  `)).statusCode).toBe(
      200,
    );
  });
});

describe('release and expiry', () => {
  it('releases the key when the call fails, so a retry runs', async () => {
    const { owner, ownerKey } = await setup();
    const body = [{ email: `retry-${randomUUID().slice(0, 8)}@example.com` }];
    vi.spyOn(server.ctx.members, 'inviteMany').mockRejectedValueOnce(new Error('boom'));
    const failed = await post(ownerKey, '/users', body, 'k-release');
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rowsOf(owner.tenant.id)).toHaveLength(0);
    const retry = await post(ownerKey, '/users', body, 'k-release');
    expect(retry.statusCode).toBe(201);
  });

  it('starts again on a key older than 12 hours with no prune call', async () => {
    const { owner, ownerKey } = await setup();
    const prune = vi.spyOn(server.ctx.repos.publicIdempotency, 'prune');
    const first = await post(ownerKey, '/tags', { name: tagName() }, 'k-old');
    expect(first.statusCode).toBe(200);
    await server.ctx.database.pool.query(
      "update public_api_idempotency set created_at = now() - interval '13 hours' where tenant_id = $1",
      [owner.tenant.id],
    );
    const again = await post(ownerKey, '/tags', { name: tagName() }, 'k-old');
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).not.toBe(first.json().data.id);
    expect(prune).not.toHaveBeenCalled();
    expect(await rowsOf(owner.tenant.id)).toHaveLength(1);
  });

  it('prunes old rows and keeps young ones', async () => {
    const { owner, ownerKey } = await setup();
    await post(ownerKey, '/tags', { name: tagName() }, 'k-prune-old');
    await post(ownerKey, '/tags', { name: tagName() }, 'k-prune-new');
    await server.ctx.database.pool.query(
      "update public_api_idempotency set created_at = now() - interval '2 days' where key = 'k-prune-old'",
    );
    const removed = await server.ctx.repos.publicIdempotency.prune(new Date(Date.now() - 24 * 3600 * 1000));
    expect(removed).toBe(1);
    expect((await rowsOf(owner.tenant.id)).map((r) => r.key)).toEqual(['k-prune-new']);
  });
});

describe('scope of a key', () => {
  it('keeps one key apart per user', async () => {
    const { owner, ownerKey } = await setup();
    const admin = await memberAs(owner, 'admin');
    const adminKey = await keyOf(admin.client);
    const a = await post(ownerKey, '/tags', { name: tagName() }, 'shared-key');
    const b = await post(adminKey, '/tags', { name: tagName() }, 'shared-key');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().data.id).not.toBe(b.json().data.id);
    expect(await rowsOf(owner.tenant.id)).toHaveLength(2);
  });

  it('keeps one key apart per workspace', async () => {
    const one = await setup();
    const two = await setup();
    const name = tagName();
    const a = await post(one.ownerKey, '/tags', { name }, 'tenant-key');
    const b = await post(two.ownerKey, '/tags', { name }, 'tenant-key');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().data.id).not.toBe(a.json().data.id);
    expect(await rowsOf(one.owner.tenant.id)).toHaveLength(1);
    expect(await rowsOf(two.owner.tenant.id)).toHaveLength(1);
  });

  it('answers a bad key 401 and a bad body 400 before the key is used', async () => {
    const { owner, ownerKey } = await setup();
    expect((await post('not-a-key', '/tags', { name: tagName() }, 'k-auth')).statusCode).toBe(401);
    expect((await post(ownerKey, '/tags', {}, 'k-body')).statusCode).toBe(400);
    expect(await rowsOf(owner.tenant.id)).toHaveLength(0);
  });
});

describe('the stored answer is encrypted', () => {
  it('replays the invite link of POST /users while the row holds none', async () => {
    const { owner, ownerKey } = await setup();
    const body = [{ email: `invite-${randomUUID().slice(0, 8)}@example.com` }];
    const first = await post(ownerKey, '/users', body, 'k-invite');
    expect(first.statusCode).toBe(201);
    const link = first.json().data[0].inviteAcceptUrl as string;
    expect(link).toMatch(/\/invitation\//);
    const replay = await post(ownerKey, '/users', body, 'k-invite');
    expect(replay.json().data[0].inviteAcceptUrl).toBe(link);
    const [row] = await rowsOf(owner.tenant.id);
    const token = link.split('/invitation/')[1];
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.response_enc).toMatch(/^v1\./);
  });
});
