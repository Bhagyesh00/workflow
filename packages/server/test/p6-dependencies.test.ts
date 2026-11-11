/**
 * P6-86 (L18): /rest/workflow-dependencies. Counts and details are computed from workflows.nodes and
 * settings; rows the caller cannot read are dropped and the counts follow; 100 ids at most; another
 * tenant's resources are absent; a folder lists what outside workflows use its workflows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  folderIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const callNode = (workflowId: string, mode: 'id' | 'list' = 'id') =>
  node('Call', 'core.executeWorkflow', {
    source: 'database',
    workflowId: { __rl: true, mode, value: workflowId },
  });
const credNode = (credentialId: string) =>
  node('Http', 'core.httpRequest', {}, [0, 0], { credentials: { testApi: { id: credentialId, name: 'c' } } });
const tableNode = (value: string, mode: 'id' | 'name' = 'id') =>
  node('Table', 'core.dataTable', { dataTableId: { __rl: true, mode, value } });

/** an owner with two team projects; the member edits alpha and holds nothing in beta */
async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
  return { owner, member, tenantId, alpha, beta };
}

type Poster = { post: (url: string, body?: unknown) => Promise<{ json(): { data: any } }> };
type Detail = { key: string; id: string; name: string; resourceType: string; projectId: string | null };

const counts = async (client: Poster, resourceType: string, ids: string[]) =>
  (await client.post('/rest/workflow-dependencies/counts', { resourceType, resourceIds: ids })).json()
    .data as Record<string, Record<string, number>>;
const details = async (client: Poster, resourceType: string, ids: string[]) =>
  (await client.post('/rest/workflow-dependencies/details', { resourceType, resourceIds: ids })).json()
    .data as Record<string, Detail[]>;

describe('counts and details', () => {
  it('a credential count matches the workflows that name it', async () => {
    const { owner, tenantId, alpha } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    const other = await credentialIn(server, tenantId, alpha.id);
    await workflowIn(server, tenantId, alpha.id, { name: 'A', nodes: [credNode(cred.id)] });
    // two nodes in one workflow count the workflow once
    await workflowIn(server, tenantId, alpha.id, {
      name: 'B',
      nodes: [credNode(cred.id), credNode(cred.id)],
    });
    const got = await counts(owner.client, 'credential', [cred.id, other.id]);
    expect(got[cred.id]).toEqual({ credentialId: 2 });
    expect(got[other.id]).toEqual({});
    const list = await details(owner.client, 'credential', [cred.id]);
    expect(list[cred.id].map((d) => [d.key, d.name, d.resourceType, d.projectId])).toEqual([
      ['credentialId', 'A', 'workflow', alpha.id],
      ['credentialId', 'B', 'workflow', alpha.id],
    ]);
  });

  it('a table shows by id and by name; a sub-workflow caller and an error workflow parent show', async () => {
    const { owner, tenantId, alpha } = await setup();
    const table = await dataTableIn(server, tenantId, alpha.id, 'people');
    const sub = await workflowIn(server, tenantId, alpha.id, { name: 'Sub' });
    const errorWf = await workflowIn(server, tenantId, alpha.id, { name: 'Errors' });
    await workflowIn(server, tenantId, alpha.id, { name: 'ById', nodes: [tableNode(table.id)] });
    await workflowIn(server, tenantId, alpha.id, { name: 'ByName', nodes: [tableNode('people', 'name')] });
    const parent = await workflowIn(server, tenantId, alpha.id, {
      name: 'Parent',
      nodes: [callNode(sub.id), tableNode(table.id)],
      settings: { errorWorkflow: errorWf.id },
    });
    expect((await counts(owner.client, 'dataTable', [table.id]))[table.id]).toEqual({ dataTableId: 3 });
    expect((await counts(owner.client, 'workflow', [sub.id]))[sub.id]).toEqual({ workflowParent: 1 });
    expect((await counts(owner.client, 'workflow', [errorWf.id]))[errorWf.id]).toEqual({
      errorWorkflowParent: 1,
    });
    const own = await details(owner.client, 'workflow', [parent.id]);
    expect(own[parent.id].map((d) => [d.key, d.id, d.resourceType])).toEqual([
      ['workflowCall', sub.id, 'workflow'],
      ['errorWorkflow', errorWf.id, 'workflow'],
      ['dataTableId', table.id, 'dataTable'],
    ]);
    const callers = await details(owner.client, 'workflow', [sub.id]);
    expect(callers[sub.id]).toMatchObject([{ key: 'workflowParent', id: parent.id, name: 'Parent' }]);
  });

  it('an inline sub-workflow names no workflow', async () => {
    const { owner, tenantId, alpha } = await setup();
    const sub = await workflowIn(server, tenantId, alpha.id, { name: 'Sub' });
    await workflowIn(server, tenantId, alpha.id, {
      nodes: [
        node('Call', 'core.executeWorkflow', {
          source: 'parameter',
          workflowId: { __rl: true, mode: 'id', value: sub.id },
        }),
      ],
    });
    expect((await counts(owner.client, 'workflow', [sub.id]))[sub.id]).toEqual({});
  });

  it('a hidden workflow is not listed and the counts follow', async () => {
    const { owner, member, tenantId, alpha, beta } = await setup();
    const cred = await credentialIn(server, tenantId, alpha.id);
    await workflowIn(server, tenantId, alpha.id, { name: 'Visible', nodes: [credNode(cred.id)] });
    await workflowIn(server, tenantId, beta.id, { name: 'Hidden', nodes: [credNode(cred.id)] });
    expect((await counts(owner.client, 'credential', [cred.id]))[cred.id]).toEqual({ credentialId: 2 });
    expect((await counts(member.client, 'credential', [cred.id]))[cred.id]).toEqual({ credentialId: 1 });
    const seen = await details(member.client, 'credential', [cred.id]);
    expect(seen[cred.id].map((d) => d.name)).toEqual(['Visible']);
  });

  it('a resource the caller cannot read is absent from the answer', async () => {
    const { member, tenantId, beta } = await setup();
    const cred = await credentialIn(server, tenantId, beta.id);
    const table = await dataTableIn(server, tenantId, beta.id, 'secret');
    const wf = await workflowIn(server, tenantId, beta.id, { nodes: [credNode(cred.id)] });
    expect(await counts(member.client, 'credential', [cred.id])).toEqual({});
    expect(await counts(member.client, 'dataTable', [table.id])).toEqual({});
    expect(await details(member.client, 'workflow', [wf.id])).toEqual({});
  });

  it('a workflow lists only the credentials its caller may read', async () => {
    const { member, tenantId, alpha, beta } = await setup();
    const mine = await credentialIn(server, tenantId, alpha.id, { name: 'mine' });
    const theirs = await credentialIn(server, tenantId, beta.id, { name: 'theirs' });
    const wf = await workflowIn(server, tenantId, alpha.id, {
      nodes: [credNode(mine.id), credNode(theirs.id)],
    });
    const seen = await details(member.client, 'workflow', [wf.id]);
    expect(seen[wf.id].map((d) => [d.key, d.name])).toEqual([['credentialId', 'mine']]);
  });

  it('refuses 101 ids, accepts 100, and ignores ids that are not uuids', async () => {
    const { owner } = await setup();
    const ids = Array.from({ length: 101 }, () => randomUUID());
    const over = await owner.client.post('/rest/workflow-dependencies/counts', {
      resourceType: 'workflow',
      resourceIds: ids,
    });
    expect(over.statusCode).toBe(400);
    const ok = await owner.client.post('/rest/workflow-dependencies/details', {
      resourceType: 'workflow',
      resourceIds: [...ids.slice(0, 99), 'not-a-uuid'],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({});
    const bad = await owner.client.post('/rest/workflow-dependencies/counts', {
      resourceType: 'folder',
      resourceIds: [],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('another tenant is absent: its resources and its workflows', async () => {
    const one = await setup();
    const cred = await credentialIn(server, one.tenantId, one.alpha.id);
    await workflowIn(server, one.tenantId, one.alpha.id, { nodes: [credNode(cred.id)] });
    const two = await signup(server.app);
    expect(await counts(two.client, 'credential', [cred.id])).toEqual({});
    // a workflow of the second tenant that names the first tenant's credential id is not counted for the first
    const mine = await credentialIn(server, two.tenant.id, two.client.defaultProjectId!);
    await workflowIn(server, two.tenant.id, two.client.defaultProjectId!, { nodes: [credNode(cred.id)] });
    expect((await counts(one.owner.client, 'credential', [cred.id]))[cred.id]).toEqual({ credentialId: 1 });
    expect((await counts(two.client, 'credential', [mine.id]))[mine.id]).toEqual({});
  });

  it('answers 401 without a session', async () => {
    const res = await new TestClient(server.app).post('/rest/workflow-dependencies/counts', {
      resourceType: 'workflow',
      resourceIds: [],
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('folder dependencies', () => {
  it('lists the outside workflows that use a workflow of the folder tree, and none inside it', async () => {
    const { owner, tenantId, alpha } = await setup();
    const folder = await folderIn(server, tenantId, alpha.id, 'Top');
    const child = await folderIn(server, tenantId, alpha.id, 'Child', folder.id);
    const inChild = await workflowIn(server, tenantId, alpha.id, { name: 'Shared', folderId: child.id });
    const inFolder = await workflowIn(server, tenantId, alpha.id, { name: 'Inside', folderId: folder.id });
    await workflowIn(server, tenantId, alpha.id, { name: 'Outside', nodes: [callNode(inChild.id)] });
    await workflowIn(server, tenantId, alpha.id, {
      name: 'Neighbour',
      folderId: folder.id,
      nodes: [callNode(inFolder.id)],
    });
    const res = await owner.client.get(
      `/rest/workflow-dependencies/projects/${alpha.id}/folders/${folder.id}`,
    );
    expect(res.statusCode).toBe(200);
    const { workflows } = res.json().data;
    expect(workflows.map((w: { name: string }) => w.name)).toEqual(['Shared']);
    expect(workflows[0].dependencies).toMatchObject([{ key: 'workflowParent', name: 'Outside' }]);
  });

  it('a folder of another project or a missing folder is 404', async () => {
    const { owner, tenantId, alpha, beta } = await setup();
    const folder = await folderIn(server, tenantId, alpha.id, 'Top');
    const other = await owner.client.get(
      `/rest/workflow-dependencies/projects/${beta.id}/folders/${folder.id}`,
    );
    expect(other.statusCode).toBe(404);
    const missing = await owner.client.get(
      `/rest/workflow-dependencies/projects/${alpha.id}/folders/${randomUUID()}`,
    );
    expect(missing.statusCode).toBe(404);
  });

  it('drops outside workflows the caller cannot read', async () => {
    const { member, tenantId, alpha, beta } = await setup();
    const folder = await folderIn(server, tenantId, alpha.id, 'Top');
    const shared = await workflowIn(server, tenantId, alpha.id, { name: 'Shared', folderId: folder.id });
    await workflowIn(server, tenantId, beta.id, { name: 'Hidden caller', nodes: [callNode(shared.id)] });
    const res = await member.client.get(
      `/rest/workflow-dependencies/projects/${alpha.id}/folders/${folder.id}`,
    );
    expect(res.json().data).toEqual({ workflows: [] });
  });
});
