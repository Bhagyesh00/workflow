import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  ORIGIN,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

describe('auth', () => {
  it('signs up, reads the profile, logs out and logs back in', async () => {
    const { client, user, tenant, role } = await signup(server.app, {
      email: 'Ada@Example.com',
      workspaceName: 'Acme Corp!',
    });
    expect(role).toBe('owner');
    expect(user.email).toBe('ada@example.com');
    expect(tenant.slug).toBe('acme-corp');

    const me = await client.data(client.get('/rest/auth/me'));
    expect(me.user.id).toBe(user.id);
    expect(me.tenants).toEqual([{ id: tenant.id, name: 'Acme Corp!', slug: 'acme-corp', role: 'owner' }]);

    // the session token itself is never stored, only its sha256
    const token = client.cookie!.split('=')[1];
    const { rows } = await server.ctx.database.pool.query('select id from sessions');
    expect(rows.map((r) => r.id)).toEqual([sha256(token)]);

    expect((await client.post('/rest/auth/logout')).statusCode).toBe(200);
    expect(client.cookie).toBeUndefined();
    expect((await client.get('/rest/auth/me')).statusCode).toBe(401);
    const { rows: after } = await server.ctx.database.pool.query('select id from sessions');
    expect(after).toHaveLength(0);

    const login = await client.post('/rest/auth/login', { email: 'ADA@example.com', password: 'Passw0rd!' });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.tenant.id).toBe(tenant.id);
    expect((await client.get('/rest/auth/me')).statusCode).toBe(200);
  });

  it('sets a hardened session cookie', async () => {
    const client = new TestClient(server.app);
    const res = await client.post('/rest/auth/signup', {
      email: 'cookie@example.com',
      password: 'Passw0rd!',
      name: 'C',
      workspaceName: 'Cookies',
    });
    const cookie = res.cookies.find((c) => c.name === 'wf_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/rest');
    expect(cookie.maxAge).toBe(14 * 86400);
    expect(cookie.secure).toBeFalsy();
  });

  it('creates unique workspace slugs and rejects duplicate emails and weak passwords', async () => {
    const a = await signup(server.app, { workspaceName: 'Team' });
    const b = await signup(server.app, { workspaceName: 'Team' });
    expect(a.tenant.slug).toBe('team');
    expect(b.tenant.slug).toBe('team-2');

    const client = new TestClient(server.app);
    const dup = await client.post('/rest/auth/signup', {
      email: a.user.email,
      password: 'Passw0rd!',
      name: 'X',
      workspaceName: 'X',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('conflict');

    const weak = await client.post('/rest/auth/signup', {
      email: 'weak@example.com',
      password: 'password',
      name: 'X',
      workspaceName: 'X',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('weak_password');

    const invalid = await client.post('/rest/auth/signup', { email: 'not-an-email', password: 'Passw0rd!' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('validation_error');
  });

  it('rejects wrong passwords and rate-limits login per IP and email', async () => {
    const { user } = await signup(server.app);
    const client = new TestClient(server.app);
    const wrong = await client.post('/rest/auth/login', { email: user.email, password: 'nope-1234' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toEqual({ code: 'invalid_credentials', message: 'Wrong email or password' });
    const unknown = await client.post('/rest/auth/login', {
      email: 'ghost@example.com',
      password: 'nope-1234',
    });
    expect(unknown.statusCode).toBe(401);

    // LOGIN_RATE_LIMIT_MAX=5 in tests: 4 more attempts are allowed, the 6th is limited
    for (let i = 0; i < 4; i++) await client.post('/rest/auth/login', { email: user.email, password: 'x' });
    const limited = await client.post('/rest/auth/login', { email: user.email, password: 'Passw0rd!' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');

    // another email from the same IP has its own budget
    const other = await client.post('/rest/auth/login', {
      email: 'someone@example.com',
      password: 'x1234567',
    });
    expect(other.statusCode).toBe(401);
  });

  it('rejects cross-origin and non-JSON mutating requests (CSRF)', async () => {
    const { client } = await signup(server.app);
    const evil = await client.post(
      '/rest/workflows',
      { name: 'x', nodes: [] },
      { origin: 'https://evil.example' },
    );
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('csrf_origin');

    const noOrigin = await server.app.inject({
      method: 'POST',
      url: '/rest/workflows',
      headers: { cookie: client.cookie!, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', nodes: [] }),
    });
    expect(noOrigin.statusCode).toBe(403);

    const form = await server.app.inject({
      method: 'POST',
      url: '/rest/workflows',
      headers: {
        cookie: client.cookie!,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'name=x',
    });
    expect(form.statusCode).toBe(415);

    // body-less mutations without a content type are fine from the right origin
    const logout = await server.app.inject({
      method: 'POST',
      url: '/rest/auth/logout',
      headers: { cookie: client.cookie!, origin: ORIGIN },
    });
    expect(logout.statusCode).toBe(200);

    // reads are not affected
    expect((await client.get('/rest/settings', { origin: 'https://evil.example' })).statusCode).toBe(200);
  });

  it('switches between workspaces the user belongs to', async () => {
    const owner = await signup(server.app, { workspaceName: 'Main' });
    const other = await signup(server.app, { workspaceName: 'Other' });
    const accepted = await memberAs(owner, 'editor', { email: other.user.email, name: 'Other' });
    expect(accepted.tenant.id).toBe(owner.tenant.id);
    expect(accepted.role).toBe('editor');

    const me = await other.client.data(other.client.get('/rest/auth/me'));
    expect(me.tenants.map((t: { slug: string }) => t.slug).sort()).toEqual(['main', 'other']);
    const switched = await other.client.data(
      other.client.post('/rest/auth/switch-tenant', { tenantId: owner.tenant.id }),
    );
    expect(switched.tenant.id).toBe(owner.tenant.id);
    expect(switched.role).toBe('editor');
    expect((await other.client.data(other.client.get('/rest/auth/me'))).tenant.id).toBe(owner.tenant.id);

    const stranger = await signup(server.app);
    const denied = await stranger.client.post('/rest/auth/switch-tenant', { tenantId: owner.tenant.id });
    expect(denied.statusCode).toBe(404);
  });
});

describe('members and roles', () => {
  it('invites a viewer who can read but not write', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const invite = await owner.client.data(
      owner.client.post('/rest/members/invite', { email: 'viewer@example.com', role: 'viewer' }),
    );
    expect(invite.inviteUrl).toContain(invite.token);

    const viewer = new TestClient(server.app);
    const joined = await viewer.data(
      viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'Viewer', password: 'Passw0rd!' }),
    );
    expect(joined.role).toBe('viewer');
    // invitations are single-use
    const again = await new TestClient(server.app).post(`/rest/invitations/${invite.token}/accept`, {
      name: 'V',
      password: 'Passw0rd!',
    });
    expect(again.statusCode).toBe(404);

    expect((await viewer.get('/rest/workflows')).statusCode).toBe(200);
    expect((await viewer.get(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
    expect((await viewer.get('/rest/credentials')).statusCode).toBe(200);

    const writes = [
      await viewer.post('/rest/workflows', { name: 'x', nodes: [] }),
      await viewer.patch(`/rest/workflows/${wf.id}`, { versionId: wf.versionId, name: 'y' }),
      await viewer.delete(`/rest/workflows/${wf.id}`),
      await viewer.post(`/rest/workflows/${wf.id}/run`, {}),
      await viewer.post('/rest/credentials', { name: 'c', type: 'testApi', data: {} }),
      await viewer.post('/rest/tags', { name: 't' }),
      await viewer.post('/rest/variables', { key: 'K', value: 'v' }),
      await viewer.post('/rest/members/invite', { email: 'x@example.com', role: 'viewer' }),
    ];
    for (const res of writes) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    const cred = await owner.client.data(
      owner.client.post('/rest/credentials', { name: 'c', type: 'testApi', data: { apiKey: 'secret' } }),
    );
    expect((await viewer.get(`/rest/credentials/${cred.id}`)).statusCode).toBe(403);

    const members = await owner.client.data(owner.client.get('/rest/members'));
    expect(members.map((m: { role: string }) => m.role).sort()).toEqual(['owner', 'viewer']);
  });

  it('manages roles and protects the last owner', async () => {
    const owner = await signup(server.app);
    const { client: admin, user } = await memberAs(owner, 'admin', {
      email: 'admin@example.com',
      name: 'Admin',
    });
    const adminId = user.id;

    // admins cannot touch owners or grant ownership
    expect((await admin.patch(`/rest/members/${owner.user.id}`, { role: 'viewer' })).statusCode).toBe(403);
    expect(
      (await admin.post('/rest/members/invite', { email: 'o@example.com', role: 'owner' })).statusCode,
    ).toBe(403);
    // the only owner cannot demote themselves
    const demote = await owner.client.patch(`/rest/members/${owner.user.id}`, { role: 'admin' });
    expect(demote.statusCode).toBe(409);

    await owner.client.data(owner.client.patch(`/rest/members/${adminId}`, { role: 'editor' }));
    expect(
      (await admin.post('/rest/members/invite', { email: 'z@example.com', role: 'viewer' })).statusCode,
    ).toBe(403);

    await owner.client.data(owner.client.delete(`/rest/members/${adminId}`));
    // removing a member ends their sessions in that workspace
    expect((await admin.get('/rest/auth/me')).statusCode).toBe(401);

    const audit = await owner.client.data(owner.client.get('/rest/audit-log'));
    const actions = audit.map((a: { action: string }) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['member.invited', 'member.joined', 'member.role_changed', 'member.removed']),
    );
  });

  it('creates API keys that are shown once and stored hashed', async () => {
    const owner = await signup(server.app);
    const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'CI' }));
    expect(key.key).toMatch(/^wfk_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
    const list = await owner.client.data(owner.client.get('/rest/api-keys'));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('key');
    const { rows } = await server.ctx.database.pool.query('select key_hash from api_keys');
    expect(rows[0].key_hash).toBe(sha256(key.key));

    const res = await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key.key } });
    expect(res.statusCode).toBe(200);
    await owner.client.data(owner.client.delete(`/rest/api-keys/${key.id}`));
    const revoked = await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key.key } });
    expect(revoked.statusCode).toBe(401);
  });

  it('allows an editor served from CORS_ORIGINS', async () => {
    const devOrigin = 'http://localhost:5173';
    const cors = await createTestServer({ CORS_ORIGINS: devOrigin }, { startMain: false, reset: false });
    try {
      const client = new TestClient(cors.app, devOrigin);
      const preflight = await cors.app.inject({
        method: 'OPTIONS',
        url: '/rest/auth/login',
        headers: { origin: devOrigin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(devOrigin);
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
      const res = await client.post('/rest/auth/signup', {
        email: 'dev@example.com',
        password: 'Passw0rd!',
        name: 'Dev',
        workspaceName: 'Dev',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(devOrigin);
      const evil = await cors.app.inject({
        method: 'OPTIONS',
        url: '/rest/auth/login',
        headers: { origin: 'https://evil.example' },
      });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it('audits failed logins of existing accounts', async () => {
    const { client, user } = await signup(server.app);
    await new TestClient(server.app).post('/rest/auth/login', { email: user.email, password: 'wrong-pass1' });
    const audit = await client.data(client.get('/rest/audit-log'));
    expect(audit.map((a: { action: string }) => a.action)).toContain('auth.login_failed');
  });

  it('honours SIGNUP_ENABLED=false', async () => {
    const closed = await createTestServer({ SIGNUP_ENABLED: 'false' }, { startMain: false, reset: false });
    try {
      const res = await new TestClient(closed.app).post('/rest/auth/signup', {
        email: 'no@example.com',
        password: 'Passw0rd!',
        name: 'No',
        workspaceName: 'No',
      });
      expect(res.statusCode).toBe(403);
      const settings = await closed.app.inject({ url: '/rest/settings' });
      expect(settings.json().data.features.signup).toBe(false);
    } finally {
      await closed.close();
    }
  });
});
