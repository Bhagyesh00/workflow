/**
 * P6-21 (L5): API keys, as n8n's. An expiry on create; edit (name, scopes); rotate (same row, new secret, shown
 * once); the scopes a role may give; the admin's list of every key and delete (the owner is mailed); a role
 * downgrade strips the scopes above the new role; an MCP key is never listed or touched.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiKeys, sessions } from '../src/db/schema';
import { API_KEY_SCOPES } from '../src/http/api-key-scopes';
import { startSmtpServer } from './fakes/smtp';
import {
  createTestServer,
  memberAs,
  realMember,
  resetDatabase,
  signup as baseSignup,
  type TestClient,
  type TestServer,
} from './helpers';

let smtp: Awaited<ReturnType<typeof startSmtpServer>>;
let server: TestServer;

beforeAll(async () => {
  smtp = await startSmtpServer();
  server = await createTestServer({
    LOGIN_RATE_LIMIT_MAX: '1000',
    EMAIL_MODE: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SSL: 'false',
    SMTP_STARTTLS: 'false',
    USER_MANAGEMENT_JWT_DURATION_HOURS: '2',
  });
});
afterAll(async () => {
  await server.close();
  await smtp.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  smtp.messages.length = 0;
});

let ip = 1;
/** signup allows 20 calls an hour per IP: each call comes from its own address */
const signup = (app: TestServer['app'], input: Parameters<typeof baseSignup>[1] = {}) =>
  baseSignup(app, {
    remoteAddress: `127.6.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    ...input,
  });

const MISSING = 'User is missing a scope required to perform this action';
const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;
const label = () => `key-${randomUUID().slice(0, 8)}`;

const publicApi = (key: string, url = '/workflows') =>
  server.app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
  });

const make = (client: TestClient, body: Record<string, unknown> = {}) =>
  client.post('/rest/api-keys', { name: label(), ...body });
const made = (client: TestClient, body: Record<string, unknown> = {}) => client.data(make(client, body));
const expireNow = (id: string) =>
  server.ctx.database.db
    .update(apiKeys)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(apiKeys.id, id));

describe('expiry', () => {
  it('a key with an expiry works until it is over, then stops', async () => {
    const owner = await signup(server.app);
    const key = await made(owner.client, { expiresAt: inSeconds(3600) });
    expect(key.expiresAt).toBeGreaterThan(inSeconds(3500));
    expect((await publicApi(key.key)).statusCode).toBe(200);
    const listed = await owner.client.data<Array<{ id: string; expiresAt: number }>>(
      owner.client.get('/rest/api-keys'),
    );
    expect(listed[0].expiresAt).toBe(key.expiresAt);
    await expireNow(key.id);
    expect((await publicApi(key.key)).statusCode).toBe(401);
  });

  it('a key with no expiry never ends; a past or odd expiry is a 400', async () => {
    const owner = await signup(server.app);
    const never = await made(owner.client);
    expect(never.expiresAt).toBeNull();
    expect((await publicApi(never.key)).statusCode).toBe(200);
    expect((await make(owner.client, { expiresAt: inSeconds(-60) })).statusCode).toBe(400);
    expect((await make(owner.client, { expiresAt: 1.5 })).statusCode).toBe(400);
    expect((await make(owner.client, { expiresAt: 'tomorrow' })).statusCode).toBe(400);
  });

  it('the session lasts as long as USER_MANAGEMENT_JWT_DURATION_HOURS says', async () => {
    const owner = await signup(server.app);
    const rows = await server.ctx.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, owner.user.id));
    const left = rows[0].expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(110 * 60_000);
    expect(left).toBeLessThanOrEqual(2 * 3_600_000 + 5_000);
  });
});

describe('labels', () => {
  it('has the rules of n8n: 1 to 50 characters, no markup, unique per owner', async () => {
    const owner = await signup(server.app);
    expect((await make(owner.client, { name: 'CI' })).statusCode).toBe(200);
    const twice = await make(owner.client, { name: 'CI' });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.message).toBe('There is already an API key with this label');
    expect((await make(owner.client, { name: 'x'.repeat(51) })).statusCode).toBe(400);
    expect((await make(owner.client, { name: 'x'.repeat(50) })).statusCode).toBe(200);
    expect((await make(owner.client, { name: '<b>hi</b>' })).statusCode).toBe(400);
    expect((await make(owner.client, { name: '  ' })).statusCode).toBe(400);
    // another owner may use the same label
    const other = await signup(server.app);
    expect((await make(other.client, { name: 'CI' })).statusCode).toBe(200);
  });
});

describe('scopes by role', () => {
  it('lists what the role may give: a member gets fewer than an owner', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const ownerScopes = await owner.client.data<string[]>(owner.client.get('/rest/api-keys/scopes'));
    const memberScopes = await member.client.data<string[]>(member.client.get('/rest/api-keys/scopes'));
    expect(ownerScopes).toEqual(expect.arrayContaining(['user:create', 'role:manage', 'workflow:read']));
    expect(memberScopes).toContain('workflow:read');
    expect(memberScopes).not.toContain('user:create');
    expect(memberScopes).not.toContain('role:manage');
    expect(memberScopes.length).toBeLessThan(ownerScopes.length);
    // session only
    expect((await server.app.inject({ method: 'GET', url: '/rest/api-keys/scopes' })).statusCode).toBe(401);
  });

  it('offers the key scopes a route checks under another user scope (activate, data table rows)', async () => {
    const owner = await signup(server.app);
    const ownerScopes = await owner.client.data<string[]>(owner.client.get('/rest/api-keys/scopes'));
    expect(ownerScopes).toEqual(
      expect.arrayContaining(['workflow:activate', 'dataTableRow:read', 'execution:retry', 'testRun:list']),
    );
    expect(ownerScopes.every((s) => API_KEY_SCOPES.includes(s as never))).toBe(true);
    expect(
      (await make(owner.client, { scopes: ['workflow:activate', 'dataTableRow:read'] })).statusCode,
    ).toBe(200);
  });

  it('a member cannot give a key a scope above their role, on create and on patch', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const bad = await make(member.client, {
      scopes: ['workflow:read', 'user:create'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('Invalid scopes for user role');
    expect((await make(member.client, { scopes: ['role:manage'] })).statusCode).toBe(400);
    const ok = await made(member.client, {
      scopes: ['workflow:read', 'workflow:list'],
    });
    const patched = await member.client.patch(`/rest/api-keys/${ok.id}`, {
      scopes: ['saml:manage'],
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.message).toBe('Invalid scopes for user role');
    const kept = await member.client.data<Array<{ scopes: string[] }>>(member.client.get('/rest/api-keys'));
    expect(kept[0].scopes).toEqual(['workflow:read', 'workflow:list']);
    // an owner may give any key scope
    expect((await make(owner.client, { scopes: ['user:create', 'role:manage'] })).statusCode).toBe(200);
  });
});

describe('edit', () => {
  it('changes the name and the scopes of the owner own key', async () => {
    const owner = await signup(server.app);
    const key = await made(owner.client, {
      name: 'old',
      scopes: ['workflow:read'],
    });
    const renamed = await owner.client.data(
      owner.client.patch(`/rest/api-keys/${key.id}`, {
        name: 'new',
        scopes: ['workflow:list', 'workflow:read'],
      }),
    );
    expect(renamed).toMatchObject({
      id: key.id,
      name: 'new',
      scopes: ['workflow:list', 'workflow:read'],
    });
    expect(renamed).not.toHaveProperty('key');
    // the same secret still works
    expect((await publicApi(key.key)).statusCode).toBe(200);
    // a taken label, nothing to change, an unknown scope
    await made(owner.client, { name: 'taken' });
    expect((await owner.client.patch(`/rest/api-keys/${key.id}`, { name: 'taken' })).statusCode).toBe(400);
    expect((await owner.client.patch(`/rest/api-keys/${key.id}`, {})).statusCode).toBe(400);
    expect(
      (
        await owner.client.patch(`/rest/api-keys/${key.id}`, {
          scopes: ['nope:x'],
        })
      ).statusCode,
    ).toBe(400);
    // keeping the own name is fine
    expect((await owner.client.patch(`/rest/api-keys/${key.id}`, { name: 'new' })).statusCode).toBe(200);
  });

  it('only the owner of a key edits it, even an admin with apiKey:manage', async () => {
    const owner = await signup(server.app);
    const admin = await memberAs(owner, 'admin');
    const key = await made(owner.client);
    expect((await admin.client.patch(`/rest/api-keys/${key.id}`, { name: 'mine' })).statusCode).toBe(404);
    expect((await admin.client.post(`/rest/api-keys/${key.id}/rotate`)).statusCode).toBe(404);
    expect(
      (
        await owner.client.patch(`/rest/api-keys/${randomUUID()}`, {
          name: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect((await owner.client.patch('/rest/api-keys/not-an-id', { name: 'x' })).statusCode).toBe(400);
  });
});

describe('rotate', () => {
  it('gives the same row a new secret, shown once; the old secret stops', async () => {
    const owner = await signup(server.app);
    const key = await made(owner.client, {
      scopes: ['workflow:list'],
      expiresAt: inSeconds(7200),
    });
    const rotated = await owner.client.data(owner.client.post(`/rest/api-keys/${key.id}/rotate`));
    expect(rotated).toMatchObject({
      id: key.id,
      name: key.name,
      scopes: ['workflow:list'],
    });
    expect(rotated.key).toMatch(/^wfk_/);
    expect(rotated.key).not.toBe(key.key);
    expect(rotated.expiresAt).toBe(key.expiresAt);
    expect((await publicApi(key.key)).statusCode).toBe(401);
    expect((await publicApi(rotated.key)).statusCode).toBe(200);
    const listed = await owner.client.data<Array<Record<string, unknown>>>(
      owner.client.get('/rest/api-keys'),
    );
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(rotated.key);
  });

  it('refuses an expired key', async () => {
    const owner = await signup(server.app);
    const key = await made(owner.client, { expiresAt: inSeconds(3600) });
    await expireNow(key.id);
    const res = await owner.client.post(`/rest/api-keys/${key.id}/rotate`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Cannot rotate an expired API key');
  });
});

describe('every key, for apiKey:manage', () => {
  it('an admin lists all keys with their owner and filters by owner and label', async () => {
    const owner = await signup(server.app, { name: 'Olive Owner' });
    const member = await realMember(owner, { name: 'Mia Member' });
    const admin = await memberAs(owner, 'admin');
    await made(owner.client, { name: 'deploy' });
    await made(member.client, { name: 'report' });
    const all = await admin.client.data<Array<{ name: string; ownerName: string; ownerId: string }>>(
      admin.client.get('/rest/api-keys?scope=all'),
    );
    expect(all.map((k) => [k.name, k.ownerName]).sort()).toEqual([
      ['deploy', 'Olive Owner'],
      ['report', 'Mia Member'],
    ]);
    const byOwner = await admin.client.data<Array<{ name: string }>>(
      admin.client.get(`/rest/api-keys?scope=all&ownerId=${member.user.id}`),
    );
    expect(byOwner.map((k) => k.name)).toEqual(['report']);
    const byLabel = await admin.client.data<Array<{ name: string }>>(
      admin.client.get('/rest/api-keys?scope=all&label=DEP'),
    );
    expect(byLabel.map((k) => k.name)).toEqual(['deploy']);
    // the plain list stays the caller's own
    expect(await admin.client.data(admin.client.get('/rest/api-keys'))).toEqual([]);
  });

  it('a member without apiKey:manage is refused', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const res = await member.client.get('/rest/api-keys?scope=all');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING);
  });

  it('keys of another workspace are never listed', async () => {
    const one = await signup(server.app);
    const two = await signup(server.app);
    await made(two.client, { name: 'theirs' });
    expect(await one.client.data(one.client.get('/rest/api-keys?scope=all'))).toEqual([]);
  });
});

describe('admin delete', () => {
  it('deletes another member key, mails the owner, audits it', async () => {
    const owner = await signup(server.app, { name: 'Olive Owner' });
    const member = await realMember(owner);
    const admin = await memberAs(owner, 'admin', { name: 'Ann Admin' });
    const key = await made(member.client, { name: 'ci-pipeline' });
    expect((await admin.client.delete(`/rest/api-keys/${key.id}`)).statusCode).toBe(200);
    expect((await publicApi(key.key)).statusCode).toBe(401);
    expect(await member.client.data(member.client.get('/rest/api-keys'))).toEqual([]);
    const mail = smtp.messages.filter(
      (m) => m.to.join(' ').includes(member.email) && m.data.includes('ci-pipeline'),
    );
    expect(mail).toHaveLength(1);
    const audit = await server.ctx.repos.audit.list(owner.tenant.id, {} as never);
    expect(JSON.stringify(audit)).toContain('apikey.revoked_by_admin');
  });

  it('is a 404, not a 403, for a caller without apiKey:manage, and the key stays', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const key = await made(owner.client);
    smtp.messages.length = 0;
    expect((await member.client.delete(`/rest/api-keys/${key.id}`)).statusCode).toBe(404);
    expect((await member.client.delete(`/rest/api-keys/${randomUUID()}`)).statusCode).toBe(404);
    expect((await publicApi(key.key)).statusCode).toBe(200);
    expect(smtp.messages).toHaveLength(0);
  });

  it('a caller deleting their own key sends no mail', async () => {
    const owner = await signup(server.app);
    const key = await made(owner.client);
    smtp.messages.length = 0;
    expect((await owner.client.delete(`/rest/api-keys/${key.id}`)).statusCode).toBe(200);
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('role change', () => {
  it('a downgrade strips the scopes above the new role; a key left with none is removed', async () => {
    const owner = await signup(server.app);
    const admin = await memberAs(owner, 'admin');
    const mixed = await made(admin.client, {
      scopes: ['workflow:read', 'user:create'],
    });
    const only = await made(admin.client, {
      scopes: ['user:create', 'role:manage'],
    });
    const full = await made(admin.client);
    const res = await owner.client.patch(`/rest/members/${admin.user.id}`, {
      role: 'member',
    });
    expect(res.statusCode).toBe(200);
    const left = await admin.client.data<Array<{ id: string; scopes: string[] }>>(
      admin.client.get('/rest/api-keys'),
    );
    expect(left.find((k) => k.id === mixed.id)?.scopes).toEqual(['workflow:read']);
    expect(left.find((k) => k.id === only.id)).toBeUndefined();
    // a key with no scopes is bounded by the owner's current role at each call, so it stays
    expect(left.find((k) => k.id === full.id)?.scopes).toEqual([]);
  });

  it('an upgrade leaves every key as it was', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const key = await made(member.client, { scopes: ['workflow:read'] });
    expect(
      (
        await owner.client.patch(`/rest/members/${member.user.id}`, {
          role: 'admin',
        })
      ).statusCode,
    ).toBe(200);
    const left = await member.client.data<Array<{ id: string; scopes: string[] }>>(
      member.client.get('/rest/api-keys'),
    );
    expect(left.find((k) => k.id === key.id)?.scopes).toEqual(['workflow:read']);
  });
});

describe('MCP keys', () => {
  it('are never listed, edited, rotated or deleted on the API keys routes', async () => {
    const owner = await signup(server.app);
    const mcp = await server.ctx.repos.apiKeys.create({
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      name: 'mcp',
      prefix: 'deadbeef',
      keyHash: randomUUID(),
      scopes: [],
      audience: 'mcp-server-api',
    });
    expect(await owner.client.data(owner.client.get('/rest/api-keys'))).toEqual([]);
    expect(await owner.client.data(owner.client.get('/rest/api-keys?scope=all'))).toEqual([]);
    expect((await owner.client.patch(`/rest/api-keys/${mcp.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await owner.client.post(`/rest/api-keys/${mcp.id}/rotate`)).statusCode).toBe(404);
    expect((await owner.client.delete(`/rest/api-keys/${mcp.id}`)).statusCode).toBe(404);
    const still = await server.ctx.database.db.select().from(apiKeys).where(eq(apiKeys.id, mcp.id));
    expect(still).toHaveLength(1);
  });
});
