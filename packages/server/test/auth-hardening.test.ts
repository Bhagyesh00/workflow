/** OAuth2 popup isolation, per-tab workspace binding, invitation links and token material on save. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, TestClient, type TestServer } from './helpers';

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

/** a user who belongs to two workspaces, signed in to `home` */
async function twoWorkspaces() {
  const owner = await signup(server.app, { workspaceName: 'Workspace A' });
  const member = await signup(server.app, { workspaceName: 'Workspace B' });
  const invite = await owner.client.data(
    owner.client.post('/rest/members/invite', { email: member.user.email, role: 'editor' }),
  );
  await new TestClient(server.app).data(
    new TestClient(server.app).post(`/rest/invitations/${invite.token}/accept`, {
      name: 'Member',
      password: 'Passw0rd!',
    }),
  );
  return { owner, member, a: owner.tenant.id, b: member.tenant.id };
}

describe('OAuth2 popup (R10)', () => {
  it('lets the editor keep a handle on popups it opens', async () => {
    const res = await server.app.inject({ url: '/rest/auth/me' });
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  });

  it('serves the callback page without opener isolation so it can post back', async () => {
    const res = await server.app.inject({ url: '/rest/oauth2/callback?error=access_denied' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('"status":"error"');
    expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });
});

describe('workspace binding per tab (R11)', () => {
  it('rejects a request made for a workspace the session no longer uses', async () => {
    const { owner, member, a, b } = await twoWorkspaces();
    // tab 2 switches the shared session to workspace A; tab 1 still shows B
    await member.client.data(member.client.post('/rest/auth/switch-tenant', { tenantId: a }));
    const stale = await member.client.request(
      'POST',
      '/rest/credentials',
      { name: 'B secret', type: 'testApi', data: { apiKey: 'b-secret' } },
      { 'x-tenant-id': b },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('tenant_changed');
    expect(await owner.client.data(owner.client.get('/rest/credentials'))).toEqual([]);

    const reads = await member.client.get('/rest/workflows', { 'x-tenant-id': b });
    expect(reads.statusCode).toBe(409);
  });

  it('accepts matching requests and leaves auth calls and header-less clients alone', async () => {
    const { member, a, b } = await twoWorkspaces();
    const ok = await member.client.request(
      'POST',
      '/rest/credentials',
      { name: 'B key', type: 'testApi', data: { apiKey: 'b' } },
      { 'x-tenant-id': b },
    );
    expect(ok.statusCode).toBe(200);
    // the switch itself and /auth/me run while the tab still names the old workspace
    const switched = await member.client.request(
      'POST',
      '/rest/auth/switch-tenant',
      { tenantId: a },
      {
        'x-tenant-id': b,
      },
    );
    expect(switched.statusCode).toBe(200);
    const me = await member.client.get('/rest/auth/me', { 'x-tenant-id': b });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.tenant.id).toBe(a);
    expect((await member.client.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('rejects a push stream opened for a workspace the session no longer uses', async () => {
    const { member, a, b } = await twoWorkspaces();
    await member.client.data(member.client.post('/rest/auth/switch-tenant', { tenantId: a }));
    // EventSource cannot set headers: the tab names its workspace in the URL instead
    const stale = await member.client.get(`/rest/push?tenantId=${b}`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('tenant_changed');
  });

  it('allows the header in cross-origin preflights', async () => {
    const res = await server.app.inject({ method: 'OPTIONS', url: '/rest/credentials' });
    expect(res.headers['access-control-allow-headers']).toContain('x-tenant-id');
  });
});

describe('invitation links (R13, R40)', () => {
  it('points at the editor route /invitation/:token', async () => {
    const owner = await signup(server.app);
    const invite = await owner.client.data(
      owner.client.post('/rest/members/invite', { email: 'new@example.com', role: 'editor' }),
    );
    expect(new URL(invite.inviteUrl).pathname).toBe(`/invitation/${invite.token}`);
  });
});

describe('OAuth2 token material (R16)', () => {
  async function oauthCredential() {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Provider',
        type: 'testPkceOAuth2Api',
        data: { clientId: 'client-1', clientSecret: 'client-secret', scope: 'read' },
      }),
    );
    const read = async () =>
      server.ctx.credentials.decrypt((await server.ctx.repos.credentials.get(tenant.id, credential.id))!);
    return { client, tenant, credential, read };
  }

  it('keeps stored tokens when a form save sends an empty token object', async () => {
    const { client, tenant, credential, read } = await oauthCredential();
    await server.ctx.credentials.saveData(tenant.id, credential.id, {
      ...(await read()),
      oauthTokenData: { access_token: 'real-token', refresh_token: 'refresh' },
    });
    const form = await client.data(client.get(`/rest/credentials/${credential.id}`));
    await client.data(
      client.patch(`/rest/credentials/${credential.id}`, {
        data: { ...form.data, scope: 'read write', oauthTokenData: {} },
      }),
    );
    const after = await read();
    expect(after.oauthTokenData).toEqual({ access_token: 'real-token', refresh_token: 'refresh' });
    expect(after.scope).toBe('read write');
    const status = await client.data(
      client.post('/rest/credentials/test', {
        type: 'testPkceOAuth2Api',
        id: credential.id,
        data: form.data,
      }),
    );
    expect(status.status).toBe('OK');
  });

  it('never stores token material sent by the browser', async () => {
    const { client, credential, read } = await oauthCredential();
    await client.data(
      client.patch(`/rest/credentials/${credential.id}`, {
        data: { clientId: 'client-1', oauthTokenData: { access_token: 'forged' } },
      }),
    );
    expect(await read()).not.toHaveProperty('oauthTokenData');
  });
});
