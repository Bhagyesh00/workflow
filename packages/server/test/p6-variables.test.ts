/**
 * P6-31 (L10): global variables (`variable:*`) and project variables (`projectVariable:*` on the project).
 * In a run the project's value wins over the global one. A member is a true `member` with a project relation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/http/auth';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

const MISSING_SCOPE = 'User is missing a scope required to perform this action';

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

const repos = () => server.ctx.repos;

let ipCounter = 0;
const ws = () =>
  signup(server.app, { remoteAddress: `10.63.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

type Owner = Awaited<ReturnType<typeof ws>>;

const postVariable = (who: { client: Owner['client'] }, body: unknown) =>
  who.client.post('/rest/variables', body);

describe('$vars', () => {
  it("takes the project's value over the global one, and only inside that project", async () => {
    const owner = await ws();
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    await owner.client.data(postVariable(owner, { key: 'REGION', value: 'global' }));
    await owner.client.data(postVariable(owner, { key: 'ONLY_A', value: 'a', projectId: a.id }));
    const inA = await owner.client.data(
      postVariable(owner, { key: 'REGION', value: 'from-a', projectId: a.id }),
    );
    expect(inA).toMatchObject({ key: 'REGION', value: 'from-a', projectId: a.id });

    expect(await repos().variables.map(owner.tenant.id, a.id)).toEqual({ REGION: 'from-a', ONLY_A: 'a' });
    expect(await repos().variables.map(owner.tenant.id, b.id)).toEqual({ REGION: 'global' });
    expect(await repos().variables.map(owner.tenant.id)).toEqual({ REGION: 'global' });
  });
});

describe('global variables', () => {
  it('a true member reads them but cannot write', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const made = await owner.client.data(postVariable(owner, { key: 'SHARED', value: 'v' }));
    expect(made.projectId).toBeNull();

    const list = await member.client.data<Array<{ key: string }>>(member.client.get('/rest/variables'));
    expect(list.map((v) => v.key)).toEqual(['SHARED']);
    expect((await member.client.get(`/rest/variables/${made.id}`)).statusCode).toBe(200);

    const write = await postVariable(member, { key: 'MINE', value: 'x' });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.message).toBe(MISSING_SCOPE);
    expect((await member.client.patch(`/rest/variables/${made.id}`, { value: 'x' })).statusCode).toBe(403);
    expect((await member.client.delete(`/rest/variables/${made.id}`)).statusCode).toBe(403);
    expect((await repos().variables.get(owner.tenant.id, made.id))?.value).toBe('v');
  });

  it("a second global variable with the same key is 409 with n8n's text", async () => {
    const owner = await ws();
    await owner.client.data(postVariable(owner, { key: 'DUP', value: '1' }));
    const again = await postVariable(owner, { key: 'DUP', value: '2' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('A global variable with key "DUP" already exists');
  });
});

describe('project variables', () => {
  it('a project admin makes one, a project viewer cannot, and a stranger sees neither', async () => {
    const owner = await ws();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    const admin = await realMember(owner);
    const viewer = await realMember(owner);
    const stranger = await realMember(owner);
    await addToProject(server, owner.tenant.id, project.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, project.id, viewer.user.id, 'project:viewer');

    const made = await admin.client.data(
      postVariable(admin, { key: 'TEAM_KEY', value: 't', projectId: project.id }),
    );
    expect(made.projectId).toBe(project.id);

    const denied = await postVariable(viewer, { key: 'NOPE', value: 'x', projectId: project.id });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);

    // the viewer reads, the stranger gets the hidden-row 403
    expect((await viewer.client.get(`/rest/variables/${made.id}`)).statusCode).toBe(200);
    const hidden = await stranger.client.get(`/rest/variables/${made.id}`);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(MISSING_SCOPE);
    expect((await stranger.client.get(`/rest/variables?projectId=${project.id}`)).statusCode).toBe(403);

    // lists: the viewer sees the project's variable, the stranger does not
    const mine = await viewer.client.data<Array<{ key: string }>>(
      viewer.client.get(`/rest/variables?projectId=${project.id}`),
    );
    expect(mine.map((v) => v.key)).toEqual(['TEAM_KEY']);
    const all = await stranger.client.data<Array<{ key: string }>>(stranger.client.get('/rest/variables'));
    expect(all.map((v) => v.key)).not.toContain('TEAM_KEY');
    const seen = await viewer.client.data<Array<{ key: string }>>(viewer.client.get('/rest/variables'));
    expect(seen.map((v) => v.key)).toContain('TEAM_KEY');
  });

  it('the same key twice in one project is 409, but a project may reuse a global key', async () => {
    const owner = await ws();
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    await owner.client.data(postVariable(owner, { key: 'K', value: 'g' }));
    await owner.client.data(postVariable(owner, { key: 'K', value: 'a', projectId: a.id }));
    await owner.client.data(postVariable(owner, { key: 'K', value: 'b', projectId: b.id }));
    const dup = await postVariable(owner, { key: 'K', value: 'again', projectId: a.id });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe('A variable with key "K" already exists in the specified project');
  });

  it("the service refuses a create in a project without the scope, with n8n's text", async () => {
    const owner = await ws();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    const viewer = await realMember(owner);
    await addToProject(server, owner.tenant.id, project.id, viewer.user.id, 'project:viewer');
    const user = (await repos().users.get(viewer.user.id))!;
    const tenant = (await repos().tenants.get(owner.tenant.id))!;
    const auth: AuthContext = { user, tenant, role: 'member' };
    await expect(
      server.ctx.variables.create(auth, { key: 'X', value: 'y', projectId: project.id }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'You are not allowed to create a variable in this project',
    });
  });

  it('updates, moves between global and a project, and deletes', async () => {
    const owner = await ws();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    const made = await owner.client.data(postVariable(owner, { key: 'MOVER', value: '1' }));

    const edited = await owner.client.data(owner.client.patch(`/rest/variables/${made.id}`, { value: '2' }));
    expect(edited).toMatchObject({ value: '2', projectId: null });

    const moved = await owner.client.data(
      owner.client.patch(`/rest/variables/${made.id}`, { projectId: project.id }),
    );
    expect(moved.projectId).toBe(project.id);
    expect(await repos().variables.map(owner.tenant.id)).toEqual({});
    expect(await repos().variables.map(owner.tenant.id, project.id)).toEqual({ MOVER: '2' });

    const back = await owner.client.data(
      owner.client.patch(`/rest/variables/${made.id}`, { projectId: null }),
    );
    expect(back.projectId).toBeNull();

    expect((await owner.client.delete(`/rest/variables/${made.id}`)).statusCode).toBe(200);
    expect((await owner.client.get(`/rest/variables/${made.id}`)).statusCode).toBe(404);
  });
});

describe('other workspaces', () => {
  it("another workspace's variable and project are 404 and never listed", async () => {
    const owner = await ws();
    const other = await ws();
    const theirs = await owner.client.data(postVariable(owner, { key: 'THEIRS', value: 'x' }));
    const theirProject = await projectIn(server, owner.tenant.id, 'Theirs');

    expect((await other.client.get(`/rest/variables/${theirs.id}`)).statusCode).toBe(404);
    expect((await other.client.patch(`/rest/variables/${theirs.id}`, { value: 'y' })).statusCode).toBe(404);
    expect((await other.client.delete(`/rest/variables/${theirs.id}`)).statusCode).toBe(404);
    expect(await other.client.data(other.client.get('/rest/variables'))).toEqual([]);
    expect((await postVariable(other, { key: 'X', value: 'y', projectId: theirProject.id })).statusCode).toBe(
      404,
    );
    expect((await repos().variables.get(owner.tenant.id, theirs.id))?.value).toBe('x');
  });
});
