/**
 * P6-86 (L18): public API GET /workflows/:id/dependencies, /credentials/:id/dependencies and
 * /data-tables/:id/dependencies: one paged shape `{ data, nextCursor }`, rows the key's user cannot read are
 * left out, the key needs the route's scope, another tenant is 404.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
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
});

const api = (key: string, url: string) =>
  server.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-api-key': key } });

const credNode = (credentialId: string) =>
  node('Http', 'core.httpRequest', {}, [0, 0], { credentials: { testApi: { id: credentialId, name: 'c' } } });
const callNode = (workflowId: string) =>
  node('Call', 'core.executeWorkflow', {
    source: 'database',
    workflowId: { __rl: true, mode: 'id', value: workflowId },
  });
const tableNode = (id: string) =>
  node('Table', 'core.dataTable', { dataTableId: { __rl: true, mode: 'id', value: id } });

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
  const keyOf = async (client: typeof owner.client, label: string, scopes: string[] = []) =>
    (
      await client.data(
        client.post('/rest/api-keys', { name: `${label}-${randomUUID().slice(0, 6)}`, scopes }),
      )
    ).key as string;
  return {
    owner,
    member,
    tenantId,
    alpha,
    beta,
    ownerKey: await keyOf(owner.client, 'owner'),
    memberKey: await keyOf(member.client, 'member'),
    keyOf,
  };
}

describe('public dependencies', () => {
  it('lists the workflows that use a credential, a table and a sub-workflow in one shape', async () => {
    const { ownerKey, tenantId, alpha } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    const table = await dataTableIn(server, tenantId, alpha.id, 'people');
    const sub = await workflowIn(server, tenantId, alpha.id, { name: 'Sub' });
    const errorWf = await workflowIn(server, tenantId, alpha.id, { name: 'Errors' });
    const parent = await workflowIn(server, tenantId, alpha.id, {
      name: 'Parent',
      nodes: [credNode(cred.id), tableNode(table.id), callNode(sub.id)],
      settings: { errorWorkflow: errorWf.id },
    });

    const byCredential = (await api(ownerKey, `/credentials/${cred.id}/dependencies`)).json();
    expect(byCredential).toEqual({
      data: [
        {
          key: 'credentialId',
          id: parent.id,
          name: 'Parent',
          resourceType: 'workflow',
          projectId: alpha.id,
          active: false,
        },
      ],
      nextCursor: null,
    });
    const byTable = (await api(ownerKey, `/data-tables/${table.id}/dependencies`)).json();
    expect(byTable.data.map((d: { id: string; key: string }) => [d.key, d.id])).toEqual([
      ['dataTableId', parent.id],
    ]);
    expect(byTable.nextCursor).toBeNull();
    const bySub = (await api(ownerKey, `/workflows/${sub.id}/dependencies`)).json();
    expect(bySub.data.map((d: { id: string; key: string }) => [d.key, d.id])).toEqual([
      ['workflowParent', parent.id],
    ]);
    const own = (await api(ownerKey, `/workflows/${parent.id}/dependencies`)).json();
    expect(own.data.map((d: { key: string }) => d.key)).toEqual([
      'workflowCall',
      'errorWorkflow',
      'credentialId',
      'dataTableId',
    ]);
  });

  it('pages with a cursor', async () => {
    const { ownerKey, tenantId, alpha } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    for (const name of ['A', 'B', 'C']) {
      await workflowIn(server, tenantId, alpha.id, { name, nodes: [credNode(cred.id)] });
    }
    const first = (await api(ownerKey, `/credentials/${cred.id}/dependencies?limit=2`)).json();
    expect(first.data.map((d: { name: string }) => d.name)).toEqual(['A', 'B']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await api(ownerKey, `/credentials/${cred.id}/dependencies?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.data.map((d: { name: string }) => d.name)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();
    expect((await api(ownerKey, `/credentials/${cred.id}/dependencies?cursor=zzz`)).statusCode).toBe(400);
    expect((await api(ownerKey, `/credentials/${cred.id}/dependencies?limit=251`)).statusCode).toBe(400);
  });

  it('a hidden workflow is not listed, on any of the three routes', async () => {
    const { memberKey, tenantId, alpha, beta } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    const table = await dataTableIn(server, tenantId, alpha.id, 'people');
    const sub = await workflowIn(server, tenantId, alpha.id, { name: 'Sub' });
    await workflowIn(server, tenantId, alpha.id, {
      name: 'Visible',
      nodes: [credNode(cred.id), tableNode(table.id), callNode(sub.id)],
    });
    // same project ids named from a project the member holds nothing in
    await workflowIn(server, tenantId, beta.id, {
      name: 'Hidden',
      nodes: [credNode(cred.id), tableNode(table.id), callNode(sub.id)],
    });
    for (const url of [
      `/credentials/${cred.id}/dependencies`,
      `/data-tables/${table.id}/dependencies`,
      `/workflows/${sub.id}/dependencies`,
    ]) {
      const names = (await api(memberKey, url)).json().data.map((d: { name: string }) => d.name);
      expect(names, url).toEqual(['Visible']);
    }
  });

  it('a resource the key user cannot read is refused, a missing one is 404', async () => {
    const { memberKey, tenantId, beta } = await setup();
    const cred = await credentialIn(server, tenantId, beta.id);
    const wf = await workflowIn(server, tenantId, beta.id);
    expect((await api(memberKey, `/credentials/${cred.id}/dependencies`)).statusCode).toBe(403);
    expect((await api(memberKey, `/workflows/${wf.id}/dependencies`)).statusCode).toBe(403);
    expect((await api(memberKey, `/workflows/${randomUUID()}/dependencies`)).statusCode).toBe(404);
  });

  it('the key needs the route scope', async () => {
    const { owner, keyOf, tenantId, alpha } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    const wf = await workflowIn(server, tenantId, alpha.id);
    const credOnly = await keyOf(owner.client, 'cred', ['credential:read']);
    expect((await api(credOnly, `/credentials/${cred.id}/dependencies`)).statusCode).toBe(200);
    expect((await api(credOnly, `/workflows/${wf.id}/dependencies`)).statusCode).toBe(403);
    const none = await keyOf(owner.client, 'wf', ['workflow:read']);
    expect((await api(none, `/credentials/${cred.id}/dependencies`)).statusCode).toBe(403);
    expect((await api(none, `/workflows/${wf.id}/dependencies`)).statusCode).toBe(200);
  });

  it('another tenant is 404', async () => {
    const one = await setup();
    const cred = await credentialIn(server, one.tenantId, one.alpha.id);
    const wf = await workflowIn(server, one.tenantId, one.alpha.id, { nodes: [credNode(cred.id)] });
    const two = await signup(server.app);
    const key = (await two.client.data(two.client.post('/rest/api-keys', { name: 'two', scopes: [] })))
      .key as string;
    expect((await api(key, `/credentials/${cred.id}/dependencies`)).statusCode).toBe(404);
    expect((await api(key, `/workflows/${wf.id}/dependencies`)).statusCode).toBe(404);
  });
});
