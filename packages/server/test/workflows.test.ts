import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
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

const basic = () => ({
  name: 'Basic',
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'greeting', 'hi')],
  connections: chain('Start', 'Set'),
});

describe('workflows', () => {
  it('creates, reads, lists, updates and deletes', async () => {
    const { client } = await signup(server.app);
    const tag = await client.data(client.post('/rest/tags', { name: 'billing' }));
    const created = await client.data(
      client.post('/rest/workflows', { ...basic(), tagIds: [tag.id], stickyNotes: [] }),
    );
    expect(created).toMatchObject({
      name: 'Basic',
      active: false,
      settings: {},
      pinData: {},
      stickyNotes: [],
      tags: [{ id: tag.id, name: 'billing' }],
    });
    expect(Object.keys(created).sort()).toEqual(
      [
        'id',
        'name',
        'nodes',
        'connections',
        'settings',
        'pinData',
        'stickyNotes',
        'nodeGroups',
        'active',
        'versionId',
        'folderId',
        'isArchived',
        'publishedVersionId',
        'tags',
        'createdAt',
        'updatedAt',
        // P6-22: POST returns the access fields and the caller's scopes (as n8n)
        'projectId',
        'homeProject',
        'sharedWithProjects',
        'scopes',
      ].sort(),
    );

    const fetched = await client.data(client.get(`/rest/workflows/${created.id}`));
    expect(fetched.nodes).toHaveLength(2);

    const list = await client.get('/rest/workflows');
    expect(list.json()).toMatchObject({
      data: [{ id: created.id, name: 'Basic', active: false, tags: [{ id: tag.id, name: 'billing' }] }],
      nextCursor: null,
    });
    expect(list.json().data[0].nodeTypes.sort()).toEqual(['core.manualTrigger', 'core.set']);
    expect((await client.data(client.get(`/rest/workflows?tagId=${tag.id}`))).length).toBe(1);
    expect((await client.data(client.get('/rest/workflows?search=bas'))).length).toBe(1);
    expect((await client.data(client.get('/rest/workflows?search=zzz'))).length).toBe(0);
    expect((await client.data(client.get('/rest/workflows?active=true'))).length).toBe(0);

    const updated = await client.data(
      client.patch(`/rest/workflows/${created.id}`, {
        versionId: created.versionId,
        name: 'Renamed',
        tagIds: [],
      }),
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.tags).toEqual([]);
    expect(updated.versionId).not.toBe(created.versionId);

    // the editor deletes archived workflows only (P3-07)
    await client.data(client.post(`/rest/workflows/${created.id}/archive`));
    expect(await client.data(client.delete(`/rest/workflows/${created.id}`))).toEqual({ ok: true });
    expect((await client.get(`/rest/workflows/${created.id}`)).statusCode).toBe(404);
    expect((await client.get('/rest/workflows/not-a-uuid')).statusCode).toBe(400);
  });

  it('paginates with an opaque cursor', async () => {
    const { client } = await signup(server.app);
    for (let i = 0; i < 5; i++) await createWorkflow(client, { name: `W${i}`, nodes: [] });
    const first = (await client.get('/rest/workflows?limit=2')).json();
    expect(first.data.map((w: { name: string }) => w.name)).toEqual(['W4', 'W3']);
    const second = (await client.get(`/rest/workflows?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.data.map((w: { name: string }) => w.name)).toEqual(['W2', 'W1']);
    const third = (await client.get(`/rest/workflows?limit=2&cursor=${second.nextCursor}`)).json();
    expect(third.data.map((w: { name: string }) => w.name)).toEqual(['W0']);
    expect(third.nextCursor).toBeNull();
    expect((await client.get('/rest/workflows?cursor=garbage')).statusCode).toBe(400);
  });

  it('rejects invalid graphs', async () => {
    const { client } = await signup(server.app);
    const dup = await client.post('/rest/workflows', {
      name: 'Dup',
      nodes: [node('A', 'core.noOp'), node('A', 'core.noOp')],
      connections: {},
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toMatch(/Duplicate node name/);
    const bad = await client.post('/rest/workflows', { name: 'Bad', nodes: [{ name: 'x' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');
    expect(bad.json().error.details.length).toBeGreaterThan(0);
  });

  it('uses optimistic concurrency and keeps a version for every save', async () => {
    const { client, user } = await signup(server.app, { name: 'Ada' });
    const base = basic();
    const created = await createWorkflow(client, base);

    const v2 = await client.data(
      client.patch(`/rest/workflows/${created.id}`, {
        versionId: created.versionId,
        name: 'Second',
        versionMessage: 'rename',
      }),
    );
    // a stale editor tab saving with the old version id gets a 409 with the current version
    const stale = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: created.versionId,
      name: 'Stale',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'conflict',
      details: { currentVersionId: v2.versionId },
    });

    const nodes = [...base.nodes, node('Extra', 'core.noOp', {}, [400, 0])];
    const v3 = await client.data(
      client.patch(`/rest/workflows/${created.id}`, {
        versionId: v2.versionId,
        nodes,
        connections: chain('Start', 'Set', 'Extra'),
      }),
    );

    const versions = await client.data(client.get(`/rest/workflows/${created.id}/versions`));
    expect(versions.map((v: { versionId: string }) => v.versionId)).toEqual([
      v3.versionId,
      v2.versionId,
      created.versionId,
    ]);
    expect(versions[1]).toMatchObject({ authorName: 'Ada', message: 'rename' });
    expect(versions[2].message).toBe('Created');

    const snapshot = await client.data(
      client.get(`/rest/workflows/${created.id}/versions/${created.versionId}`),
    );
    expect(snapshot).toMatchObject({ versionId: created.versionId, name: 'Basic' });
    expect(snapshot.nodes).toHaveLength(2);

    // diff (platform extension)
    const diff = await client.data(
      client.get(`/rest/workflows/${created.id}/versions/${created.versionId}/diff?against=current`),
    );
    expect(diff.name).toEqual({ from: 'Basic', to: 'Second' });
    expect(diff.nodes.added).toEqual(['Extra']);
    expect(diff.connections.added).toEqual(['Set[main:0] -> Extra[0]']);

    const restored = await client.data(
      client.post(`/rest/workflows/${created.id}/versions/${created.versionId}/restore`),
    );
    expect(restored.name).toBe('Basic');
    expect(restored.nodes).toHaveLength(2);
    expect(restored.versionId).not.toBe(v3.versionId);
    const after = await client.data(client.get(`/rest/workflows/${created.id}/versions`));
    expect(after).toHaveLength(4);
    expect(after[0].message).toBe(`Restored version ${created.versionId}`);
    expect(user.id).toBeTruthy();
  });

  it('manages tags and variables with per-tenant uniqueness', async () => {
    const { client } = await signup(server.app);
    const tag = await client.data(client.post('/rest/tags', { name: 'ops' }));
    expect((await client.post('/rest/tags', { name: 'ops' })).statusCode).toBe(409);
    const renamed = await client.data(client.patch(`/rest/tags/${tag.id}`, { name: 'operations' }));
    expect(renamed.name).toBe('operations');
    // every list response carries nextCursor
    for (const url of [
      '/rest/tags',
      '/rest/variables',
      '/rest/credentials',
      '/rest/members',
      '/rest/api-keys',
    ]) {
      expect({ url, nextCursor: (await client.get(url)).json().nextCursor }).toEqual({
        url,
        nextCursor: null,
      });
    }
    const tags = await client.data(client.get('/rest/tags'));
    expect(tags).toMatchObject([{ id: tag.id, name: 'operations', usageCount: 0 }]);
    await client.data(client.delete(`/rest/tags/${tag.id}`));

    const variable = await client.data(
      client.post('/rest/variables', { key: 'API_BASE', value: 'https://x' }),
    );
    expect(variable).toMatchObject({ key: 'API_BASE', value: 'https://x' });
    expect((await client.post('/rest/variables', { key: 'API_BASE', value: 'y' })).statusCode).toBe(409);
    expect((await client.post('/rest/variables', { key: 'bad key', value: 'y' })).statusCode).toBe(400);
    const changed = await client.data(client.patch(`/rest/variables/${variable.id}`, { value: 'https://y' }));
    expect(changed.value).toBe('https://y');
    expect(await client.data(client.get('/rest/variables'))).toHaveLength(1);
    await client.data(client.delete(`/rest/variables/${variable.id}`));
    expect(await client.data(client.get('/rest/variables'))).toHaveLength(0);
  });

  it('validates activation without activating (platform extension)', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, basic());
    const result = await client.data(client.post(`/rest/workflows/${wf.id}/validate`, {}));
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toMatch(/no trigger/);

    const withCreds = await createWorkflow(client, {
      nodes: [
        node('Hook', 'core.webhook', { path: 'x', authentication: 'basicAuth' }, [0, 0], { webhookId: 'h' }),
        node('Use', 'test.useCredential', {}, [200, 0]),
      ],
      connections: chain('Hook', 'Use'),
    });
    const issues = (await client.data(client.post(`/rest/workflows/${withCreds.id}/validate`, {}))).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        { node: 'Hook', message: 'Credentials for "httpBasicAuth" are not set' },
        { node: 'Use', message: 'Credentials for "testApi" are not set' },
      ]),
    );
    const activate = await client.post(`/rest/workflows/${withCreds.id}/activate`);
    expect(activate.statusCode).toBe(400);
    expect(activate.json().error.code).toBe('activation_failed');
    expect(activate.json().error.details).toHaveLength(2);
  });

  it('serves node and credential type descriptions without functions or secrets', async () => {
    const { client } = await signup(server.app);
    const nodeTypes = await client.data(client.get('/rest/node-types'));
    expect(nodeTypes.find((t: { name: string }) => t.name === 'core.webhook')).toBeTruthy();
    const credentialTypes = await client.data(client.get('/rest/credential-types'));
    const header = credentialTypes.find((t: { name: string }) => t.name === 'httpHeaderAuth');
    expect(header).toMatchObject({ hasAuthenticate: true, isOAuth2: false });
    expect(header).not.toHaveProperty('authenticate');
    const pkce = credentialTypes.find((t: { name: string }) => t.name === 'testPkceOAuth2Api');
    expect(pkce.isOAuth2).toBe(true);
    // resolved properties include the parent's
    expect(pkce.properties.map((p: { name: string }) => p.name)).toContain('clientSecret');
    expect((await server.app.inject({ url: '/rest/node-types' })).statusCode).toBe(401);
  });
});
