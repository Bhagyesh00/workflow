/**
 * P6-49 (L4): the public API rows of the node and credential type policies (`/api/v1/node-type-policies/*`,
 * `/api/v1/credential-type-policies/*`): a key needs `nodeTypePolicy:manage` or `credentialTypePolicy:manage`
 * as well as the user's own scope, a write sends the version it read, the paged lists answer
 * `{ data, nextCursor }`, and every summary says "Preview:".
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_TYPE_POLICY_ROUTES } from '../src/routes/public-type-policies';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
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

const call = (
  key: string,
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  const keyOf = async (client: typeof owner.client, scopes: string[]) =>
    (await client.data(client.post('/rest/api-keys', { name: `k-${randomUUID().slice(0, 8)}`, scopes })))
      .key as string;
  return {
    owner,
    member,
    tenantId,
    alpha,
    beta,
    keyOf,
    nodeKey: await keyOf(owner.client, ['nodeTypePolicy:manage']),
    credentialKey: await keyOf(owner.client, ['credentialTypePolicy:manage']),
    plainKey: await keyOf(owner.client, ['workflow:list']),
  };
}

const audits = async (tenantId: string) =>
  (await server.ctx.repos.audit.list(tenantId, 100)).map((row) => row.action);

describe('public type policy rows', () => {
  it('are 22 rows, each with the kind scope as access and key scope, and a "Preview:" summary', () => {
    expect(PUBLIC_TYPE_POLICY_ROUTES).toHaveLength(22);
    for (const row of PUBLIC_TYPE_POLICY_ROUTES) {
      const scope = row.path.startsWith('/node-type-policies')
        ? 'nodeTypePolicy:manage'
        : 'credentialTypePolicy:manage';
      expect(row.scope).toBe(scope);
      expect(row.access).toMatchObject({ scope });
      expect(row.summary.startsWith('Preview:')).toBe(true);
    }
  });

  it('write and read the workspace scope with a key that holds the scope', async () => {
    const { nodeKey, tenantId } = await setup();
    const read = await call(nodeKey, 'GET', '/node-type-policies/instance');
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ id: null, defaultAction: 'allow', version: 0, kind: 'node' });
    const written = await call(nodeKey, 'PUT', '/node-type-policies/instance', {
      defaultAction: 'deny',
      expectedVersion: 0,
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().data).toMatchObject({ defaultAction: 'deny', version: 1 });
    const stale = await call(nodeKey, 'PUT', '/node-type-policies/instance', {
      defaultAction: 'allow',
      expectedVersion: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(await audits(tenantId)).toContain('type_policy.scope.updated');
  });

  it('refuse a key without the kind scope (403), the other kind scope included', async () => {
    const { plainKey, nodeKey, credentialKey } = await setup();
    for (const [method, path, body] of [
      ['GET', '/node-type-policies/instance', undefined],
      ['PUT', '/node-type-policies/instance', { defaultAction: 'deny', expectedVersion: 0 }],
      ['GET', '/node-type-policies/policies', undefined],
      ['POST', '/node-type-policies/policies', { name: 'x', rules: [] }],
      ['GET', '/credential-type-policies/instance', undefined],
    ] as const) {
      expect((await call(plainKey, method, path, body)).statusCode).toBe(403);
    }
    expect((await call(nodeKey, 'GET', '/credential-type-policies/instance')).statusCode).toBe(403);
    expect((await call(credentialKey, 'GET', '/node-type-policies/instance')).statusCode).toBe(403);
    expect((await call(credentialKey, 'GET', '/credential-type-policies/instance')).statusCode).toBe(200);
  });

  it('refuse a key whose user is a member: the user scope is missing, so the key cannot hold it', async () => {
    const { member } = await setup();
    const made = await member.client.post('/rest/api-keys', {
      name: `m-${randomUUID().slice(0, 8)}`,
      scopes: ['nodeTypePolicy:manage'],
    });
    expect(made.statusCode).toBe(400);
  });

  it('create, get, list, change and delete a document with the paged shape', async () => {
    const { credentialKey, tenantId } = await setup();
    const created = await call(credentialKey, 'POST', '/credential-type-policies/policies', {
      name: 'oauth only',
      rules: [{ action: 'deny', selector: { extends: 'oAuth2Api' } }],
    });
    expect(created.statusCode).toBe(200);
    const doc = created.json().data;
    expect(doc).toMatchObject({ name: 'oauth only', version: 1, kind: 'credential' });
    const list = await call(credentialKey, 'GET', '/credential-type-policies/policies');
    expect(list.json()).toMatchObject({ nextCursor: null });
    expect(list.json().data.map((p: { id: string }) => p.id)).toEqual([doc.id]);
    expect(
      (await call(credentialKey, 'GET', `/credential-type-policies/policies/${doc.id}`)).json().data.id,
    ).toBe(doc.id);
    const patched = await call(credentialKey, 'PATCH', `/credential-type-policies/policies/${doc.id}`, {
      description: 'changed',
      expectedVersion: 1,
    });
    expect(patched.json().data).toMatchObject({ description: 'changed', version: 2 });
    expect(
      (await call(credentialKey, 'DELETE', `/credential-type-policies/policies/${doc.id}`)).statusCode,
    ).toBe(400);
    const removed = await call(
      credentialKey,
      'DELETE',
      `/credential-type-policies/policies/${doc.id}?expectedVersion=2`,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ ok: true });
    expect(
      (await call(credentialKey, 'GET', `/credential-type-policies/policies/${doc.id}`)).statusCode,
    ).toBe(404);
    const actions = await audits(tenantId);
    expect(actions).toEqual(
      expect.arrayContaining([
        'type_policy.document.created',
        'type_policy.document.updated',
        'type_policy.document.deleted',
      ]),
    );
  });

  it('attach documents to a scope and list them paged', async () => {
    const { nodeKey, tenantId } = await setup();
    const doc = (
      await call(nodeKey, 'POST', '/node-type-policies/policies', {
        name: 'p',
        rules: [{ action: 'deny', selector: { name: 'core.code' } }],
      })
    ).json().data;
    const scope = (
      await call(nodeKey, 'PUT', '/node-type-policies/instance', {
        defaultAction: 'allow',
        expectedVersion: 0,
      })
    ).json().data;
    const put = await call(nodeKey, 'PUT', `/node-type-policies/scopes/${scope.id}/attachments`, {
      attachments: [{ policyId: doc.id, priority: 3, isFloor: false }],
      expectedVersion: scope.version,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      data: [{ policyId: doc.id, priority: 3, isFloor: false }],
      nextCursor: null,
    });
    const get = await call(nodeKey, 'GET', `/node-type-policies/scopes/${scope.id}/attachments`);
    expect(get.json().data).toEqual([{ policyId: doc.id, priority: 3, isFloor: false }]);
    expect(
      (await call(nodeKey, 'GET', `/node-type-policies/scopes/${randomUUID()}/attachments`)).statusCode,
    ).toBe(404);
    expect(await audits(tenantId)).toContain('type_policy.attachments.updated');
  });

  it('read a project scope with a key whose user administers that project, and not another project', async () => {
    const { owner, member, tenantId, alpha, beta, keyOf } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:admin');
    // the owner makes the key; a project admin holds the scope in its project only
    const ownerKey = await keyOf(owner.client, ['nodeTypePolicy:manage']);
    const read = await call(ownerKey, 'GET', `/node-type-policies/projects/${alpha.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ projectId: alpha.id, defaultAction: 'allow', version: 0 });
    const written = await call(ownerKey, 'PUT', `/node-type-policies/projects/${beta.id}`, {
      defaultAction: 'deny',
      expectedVersion: 0,
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().data).toMatchObject({ projectId: beta.id, defaultAction: 'deny', version: 1 });
    // a project scope never delegates
    const delegate = await call(ownerKey, 'PUT', `/node-type-policies/projects/${alpha.id}`, {
      defaultAction: 'delegate',
      expectedVersion: 0,
    });
    expect(delegate.statusCode).toBe(400);
    // an unknown project is 404
    expect((await call(ownerKey, 'GET', `/node-type-policies/projects/${randomUUID()}`)).statusCode).toBe(
      404,
    );
  });

  it('answer another workspace 404, never the first one data', async () => {
    const { nodeKey } = await setup();
    const other = await signup(server.app);
    const otherKey = (
      await other.client.data(
        other.client.post('/rest/api-keys', {
          name: `o-${randomUUID().slice(0, 8)}`,
          scopes: ['nodeTypePolicy:manage'],
        }),
      )
    ).key as string;
    const doc = (
      await call(nodeKey, 'POST', '/node-type-policies/policies', { name: 'mine', rules: [] })
    ).json().data;
    expect((await call(otherKey, 'GET', `/node-type-policies/policies/${doc.id}`)).statusCode).toBe(404);
    expect((await call(otherKey, 'GET', '/node-type-policies/policies')).json().data).toEqual([]);
  });
});
