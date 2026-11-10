/**
 * P6-34 (L13): the public projects routes, as n8n's: /projects (list, create, update, delete), the members of a
 * project, and the two transfers. A key does what its user may do: the project admin manages the members, a
 * project viewer does not, a member who is no relation sees nothing of the project.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

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

const api = (
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

let keyCount = 0;
/** a label is unique per user since P6-21, so each key gets its own */
async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k${keyCount}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  return { owner, member, ownerKey: await keyOf(owner.client), memberKey: await keyOf(member.client) };
}

describe('projects', () => {
  it('creates, lists, renames and deletes a team project', async () => {
    const { ownerKey } = await setup();
    const made = await api(ownerKey, 'POST', '/projects', { name: 'Billing', description: 'Invoices' });
    expect(made.statusCode).toBe(201);
    const project = made.json().data;
    expect(project).toMatchObject({ name: 'Billing', type: 'team', description: 'Invoices' });
    const list = (await api(ownerKey, 'GET', '/projects')).json();
    expect(list.data.map((p: { id: string }) => p.id)).toContain(project.id);
    expect(list.nextCursor).toBeNull();
    const renamed = await api(ownerKey, 'PUT', `/projects/${project.id}`, { name: 'Finance' });
    expect(renamed.json().data.name).toBe('Finance');
    expect((await api(ownerKey, 'DELETE', `/projects/${project.id}`)).statusCode).toBe(200);
    expect(
      (await api(ownerKey, 'GET', '/projects')).json().data.map((p: { id: string }) => p.id),
    ).not.toContain(project.id);
  });

  it('pages the list with limit and cursor', async () => {
    const { ownerKey, owner } = await setup();
    for (const name of ['P1', 'P2', 'P3']) await projectIn(server, owner.tenant.id, name);
    const first = (await api(ownerKey, 'GET', '/projects?limit=2')).json();
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await api(ownerKey, 'GET', `/projects?limit=2&cursor=${first.nextCursor}`)).json();
    const ids = [...first.data, ...second.data].map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it('a member lists only its projects, and creating a project is for owner and admin', async () => {
    const { memberKey, owner, member } = await setup();
    const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
    await projectIn(server, owner.tenant.id, 'Beta');
    await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:viewer');
    const list = (await api(memberKey, 'GET', '/projects')).json();
    const names = list.data.map((p: { name: string; type: string }) => p.name);
    expect(names).toContain('Alpha');
    expect(names).not.toContain('Beta');
    const refused = await api(memberKey, 'POST', '/projects', { name: 'Mine' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
  });

  it('update and delete need the scope in that project; a viewer, a stranger and another workspace are refused', async () => {
    const { memberKey, owner, member } = await setup();
    const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
    const beta = await projectIn(server, owner.tenant.id, 'Beta');
    await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:viewer');
    expect((await api(memberKey, 'PUT', `/projects/${alpha.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await api(memberKey, 'DELETE', `/projects/${alpha.id}`)).statusCode).toBe(403);
    expect((await api(memberKey, 'PUT', `/projects/${beta.id}`, { name: 'x' })).statusCode).toBe(403);
    await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:admin');
    expect((await api(memberKey, 'PUT', `/projects/${alpha.id}`, { name: 'Renamed' })).statusCode).toBe(200);
    const other = await setup();
    expect((await api(other.ownerKey, 'PUT', `/projects/${alpha.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await api(other.ownerKey, 'DELETE', `/projects/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('delete with transferId moves the work to the other project', async () => {
    const { ownerKey, owner } = await setup();
    const from = await projectIn(server, owner.tenant.id, 'From');
    const to = await projectIn(server, owner.tenant.id, 'To');
    const workflow = await workflowIn(server, owner.tenant.id, from.id, { name: 'Moves' });
    const res = await api(ownerKey, 'DELETE', `/projects/${from.id}?transferId=${to.id}`);
    expect(res.statusCode).toBe(200);
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, workflow.id))?.projectId).toBe(to.id);
  });

  it('a key scope narrower than the route is refused', async () => {
    const { owner } = await setup();
    const key = await keyOf(owner.client, ['project:list']);
    expect((await api(key, 'GET', '/projects')).statusCode).toBe(200);
    expect((await api(key, 'POST', '/projects', { name: 'x' })).statusCode).toBe(403);
  });
});

describe('project members', () => {
  it('lists, adds, changes and removes a member', async () => {
    const { ownerKey, owner, member } = await setup();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    const added = await api(ownerKey, 'POST', `/projects/${project.id}/users`, {
      relations: [{ userId: member.user.id, role: 'project:viewer' }],
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().data.conflicts).toEqual([]);
    const listed = (await api(ownerKey, 'GET', `/projects/${project.id}/users`)).json();
    expect(listed.data).toContainEqual(
      expect.objectContaining({ userId: member.user.id, email: member.email, role: 'project:viewer' }),
    );
    // the same user with another role is a conflict, and nothing was added
    const again = await api(ownerKey, 'POST', `/projects/${project.id}/users`, {
      relations: [{ userId: member.user.id, role: 'project:editor' }],
    });
    expect(again.statusCode).toBe(409);
    const changed = await api(ownerKey, 'PATCH', `/projects/${project.id}/users/${member.user.id}`, {
      role: 'project:editor',
    });
    expect(changed.statusCode).toBe(200);
    expect(
      (await server.ctx.repos.projects.relations.get(owner.tenant.id, project.id, member.user.id))?.role,
    ).toBe('project:editor');
    const removed = await api(ownerKey, 'DELETE', `/projects/${project.id}/users/${member.user.id}`);
    expect(removed.statusCode).toBe(200);
    expect(
      await server.ctx.repos.projects.relations.get(owner.tenant.id, project.id, member.user.id),
    ).toBeUndefined();
  });

  it('only a manager of the members changes them; a viewer of the project may list', async () => {
    const { memberKey, owner, member } = await setup();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    await addToProject(server, owner.tenant.id, project.id, member.user.id, 'project:viewer');
    expect((await api(memberKey, 'GET', `/projects/${project.id}/users`)).statusCode).toBe(200);
    const body = { relations: [{ userId: member.user.id, role: 'project:admin' }] };
    const refused = await api(memberKey, 'POST', `/projects/${project.id}/users`, body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    expect(
      (
        await api(memberKey, 'PATCH', `/projects/${project.id}/users/${member.user.id}`, {
          role: 'project:admin',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api(memberKey, 'DELETE', `/projects/${project.id}/users/${member.user.id}`)).statusCode,
    ).toBe(403);
    // a stranger to the project cannot even list it
    const stranger = await realMember(owner);
    const strangerKey = await keyOf(stranger.client);
    expect((await api(strangerKey, 'GET', `/projects/${project.id}/users`)).statusCode).toBe(403);
  });
});

describe('transfers', () => {
  it('moves a workflow and a credential with the move scope on the row and create in the destination', async () => {
    const { memberKey, owner, member } = await setup();
    const from = await projectIn(server, owner.tenant.id, 'From');
    const to = await projectIn(server, owner.tenant.id, 'To');
    const secret = await projectIn(server, owner.tenant.id, 'Secret');
    await addToProject(server, owner.tenant.id, from.id, member.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, to.id, member.user.id, 'project:editor');
    const workflow = await workflowIn(server, owner.tenant.id, from.id, { name: 'Moves' });
    const credential = await credentialIn(server, owner.tenant.id, from.id);
    const wf = await api(memberKey, 'PUT', `/workflows/${workflow.id}/transfer`, {
      destinationProjectId: to.id,
    });
    expect(wf.statusCode).toBe(200);
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, workflow.id))?.projectId).toBe(to.id);
    const cr = await api(memberKey, 'PUT', `/credentials/${credential.id}/transfer`, {
      destinationProjectId: to.id,
    });
    expect(cr.statusCode).toBe(200);
    expect((await server.ctx.repos.credentials.get(owner.tenant.id, credential.id))?.projectId).toBe(to.id);
    // a destination the user cannot create in is refused, and a row in no project of the user is 403
    const back = await api(memberKey, 'PUT', `/workflows/${workflow.id}/transfer`, {
      destinationProjectId: secret.id,
    });
    expect(back.statusCode).toBe(403);
    const hidden = await workflowIn(server, owner.tenant.id, secret.id, { name: 'Hidden' });
    const refused = await api(memberKey, 'PUT', `/workflows/${hidden.id}/transfer`, {
      destinationProjectId: to.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    expect(
      (await api(memberKey, 'PUT', `/workflows/${randomUUID()}/transfer`, { destinationProjectId: to.id }))
        .statusCode,
    ).toBe(404);
  });
});
