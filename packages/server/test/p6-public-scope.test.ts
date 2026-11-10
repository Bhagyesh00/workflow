/**
 * P6-34 (L13): the public API checks the scopes of the key's user, not a role. A key sees and changes only
 * what its user may: the lists narrow to the user's projects, a row of another project is 403 with n8n's
 * text, another workspace's id is 404, a create goes to a project the user may create in, and the key's own
 * scopes still apply on top. A true `member` (invited as `member`, given a project role) stands for the user.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  folderIn,
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

/** an owner, a member and two team projects; the member holds `role` in `alpha` and nothing in `beta` */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, { name: 'In beta' });
  return {
    owner,
    member,
    alpha,
    beta,
    inAlpha,
    inBeta,
    memberKey: await keyOf(member.client),
    ownerKey: await keyOf(owner.client),
  };
}

describe('workflows', () => {
  it('lists only the workflows of the projects the user belongs to', async () => {
    const { memberKey, ownerKey, inAlpha, inBeta } = await setup();
    const mine = (await api(memberKey, 'GET', '/workflows')).json();
    expect(mine.data.map((w: { id: string }) => w.id)).toEqual([inAlpha.id]);
    const all = (await api(ownerKey, 'GET', '/workflows')).json();
    expect(all.data.map((w: { id: string }) => w.id).sort()).toEqual([inAlpha.id, inBeta.id].sort());
  });

  it('filters by projectId, and a project without a relation lists nothing (200, as n8n)', async () => {
    const { memberKey, ownerKey, alpha, beta, inBeta } = await setup();
    const own = (await api(memberKey, 'GET', `/workflows?projectId=${alpha.id}`)).json();
    expect(own.data).toHaveLength(1);
    const foreign = await api(memberKey, 'GET', `/workflows?projectId=${beta.id}`);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().data).toEqual([]);
    expect(foreign.body).not.toContain(inBeta.id);
    const owner = (await api(ownerKey, 'GET', `/workflows?projectId=${beta.id}`)).json();
    expect(owner.data.map((w: { id: string }) => w.id)).toEqual([inBeta.id]);
    // a project that does not exist is the same: 200 and empty (as n8n), not 404
    const missing = await api(memberKey, 'GET', `/workflows?projectId=${randomUUID()}`);
    expect(missing.statusCode).toBe(200);
    expect(missing.json().data).toEqual([]);
  });

  it('reads and changes only the workflows of its projects, with n8n’s text on the others', async () => {
    const { memberKey, inAlpha, inBeta, alpha } = await setup();
    const got = await api(memberKey, 'GET', `/workflows/${inAlpha.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().data).toMatchObject({ projectId: alpha.id });
    expect(got.json().data.scopes).toContain('workflow:update');
    for (const [method, url, payload] of [
      ['GET', `/workflows/${inBeta.id}`, undefined],
      ['PUT', `/workflows/${inBeta.id}`, { name: 'x', nodes: [], connections: {} }],
      ['DELETE', `/workflows/${inBeta.id}`, undefined],
      ['POST', `/workflows/${inBeta.id}/activate`, {}],
      ['POST', `/workflows/${inBeta.id}/archive`, {}],
    ] as const) {
      const res = await api(memberKey, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('a project viewer reads but holds no write scope', async () => {
    const { memberKey, inAlpha } = await setup('project:viewer');
    expect((await api(memberKey, 'GET', `/workflows/${inAlpha.id}`)).statusCode).toBe(200);
    const put = await api(memberKey, 'PUT', `/workflows/${inAlpha.id}`, {
      name: 'x',
      nodes: [],
      connections: {},
    });
    expect(put.statusCode).toBe(403);
    expect((await api(memberKey, 'DELETE', `/workflows/${inAlpha.id}`)).statusCode).toBe(403);
  });

  it('another workspace’s workflow is 404', async () => {
    const mine = await setup();
    const theirs = await setup();
    expect((await api(mine.memberKey, 'GET', `/workflows/${theirs.inAlpha.id}`)).statusCode).toBe(404);
    expect((await api(mine.ownerKey, 'DELETE', `/workflows/${theirs.inAlpha.id}`)).statusCode).toBe(404);
  });

  it("creates in the named project, refuses the others, and with none in the member's personal project", async () => {
    const { memberKey, ownerKey, alpha, beta } = await setup();
    const body = { name: 'New', nodes: [], connections: {} };
    const made = await api(memberKey, 'POST', '/workflows', { ...body, projectId: alpha.id });
    expect(made.statusCode).toBe(200);
    expect(made.json().data.projectId).toBe(alpha.id);
    const refused = await api(memberKey, 'POST', '/workflows', { ...body, projectId: beta.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    // no projectId: the member's personal project (P6-39)
    expect((await api(memberKey, 'POST', '/workflows', body)).statusCode).toBe(200);
    expect(
      (await api(memberKey, 'POST', '/workflows', { ...body, projectId: randomUUID() })).statusCode,
    ).toBe(404);
    const owner = await api(ownerKey, 'POST', '/workflows', { ...body, projectId: beta.id });
    expect(owner.json().data.projectId).toBe(beta.id);
  });

  it('a removed member loses the project on the next call', async () => {
    const { memberKey, member, alpha, inAlpha, owner } = await setup();
    expect((await api(memberKey, 'GET', `/workflows/${inAlpha.id}`)).statusCode).toBe(200);
    await server.ctx.repos.projects.relations.remove(owner.tenant.id, alpha.id, member.user.id);
    expect((await api(memberKey, 'GET', `/workflows/${inAlpha.id}`)).statusCode).toBe(403);
    expect((await api(memberKey, 'GET', '/workflows')).json().data).toEqual([]);
  });
});

describe('the key scope applies on top', () => {
  it('a key without the scope is refused although its user holds it', async () => {
    const { member, owner, inAlpha } = await setup();
    const narrow = await keyOf(member.client, ['workflow:list']);
    expect((await api(narrow, 'GET', '/workflows')).statusCode).toBe(200);
    expect((await api(narrow, 'GET', `/workflows/${inAlpha.id}`)).statusCode).toBe(403);
    const ownerNarrow = await keyOf(owner.client, ['tag:list']);
    expect((await api(ownerNarrow, 'GET', `/workflows/${inAlpha.id}`)).statusCode).toBe(403);
  });

  it('a key with a project scope but no relation to the project is refused', async () => {
    const { member, inBeta } = await setup();
    const key = await keyOf(member.client, ['workflow:read', 'workflow:update', 'workflow:delete']);
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await api(key, method, `/workflows/${inBeta.id}`)).statusCode, method).toBe(403);
    }
  });
});

describe('executions', () => {
  it('lists the runs of the user’s workflows and reads only those', async () => {
    const { memberKey, owner, inAlpha, inBeta, alpha, beta } = await setup();
    const make = async (workflowId: string, projectId: string) =>
      (
        await server.ctx.repos.executions.create(
          owner.tenant.id,
          {
            id: randomUUID(),
            workflowId,
            workflowName: 'W',
            mode: 'manual',
            status: 'success',
            startedAt: new Date(),
            stoppedAt: new Date(),
          },
          { workflowData: {}, runOptions: { projectId } },
        )
      ).id;
    const a = await make(inAlpha.id, alpha.id);
    const b = await make(inBeta.id, beta.id);
    const list = (await api(memberKey, 'GET', '/executions')).json();
    expect(list.data.map((e: { id: string }) => e.id)).toEqual([a]);
    expect((await api(memberKey, 'GET', `/executions/${a}`)).statusCode).toBe(200);
    const refused = await api(memberKey, 'GET', `/executions/${b}`);
    expect(refused.statusCode).toBe(403);
    expect((await api(memberKey, 'DELETE', `/executions/${b}`)).statusCode).toBe(403);
    expect((await api(memberKey, 'POST', `/executions/${b}/retry`, {})).statusCode).toBe(403);
  });
});

describe('credentials', () => {
  it('creates in a project the user may create in, deletes only its own projects’', async () => {
    const { memberKey, alpha, beta, owner } = await setup();
    const body = { name: 'Key', type: 'testApi', data: { apiKey: 'secret' } };
    const made = await api(memberKey, 'POST', '/credentials', { ...body, projectId: alpha.id });
    expect(made.statusCode).toBe(200);
    const row = await server.ctx.repos.credentials.get(owner.tenant.id, made.json().data.id);
    expect(row?.projectId).toBe(alpha.id);
    const refused = await api(memberKey, 'POST', '/credentials', { ...body, projectId: beta.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    const theirs = await credentialIn(server, owner.tenant.id, beta.id);
    const del = await api(memberKey, 'DELETE', `/credentials/${theirs.id}`);
    expect(del.statusCode).toBe(403);
    expect((await api(memberKey, 'DELETE', `/credentials/${made.json().data.id}`)).statusCode).toBe(200);
  });
});

describe('data tables', () => {
  it('lists, reads and writes only the tables of the user’s projects', async () => {
    const { memberKey, owner, alpha, beta } = await setup();
    const mine = await dataTableIn(server, owner.tenant.id, alpha.id, 'mine');
    const theirs = await dataTableIn(server, owner.tenant.id, beta.id, 'theirs');
    const list = (await api(memberKey, 'GET', '/data-tables')).json();
    expect(list.data.map((t: { id: string }) => t.id)).toEqual([mine.id]);
    expect((await api(memberKey, 'GET', `/data-tables/${mine.id}`)).json().data.projectId).toBe(alpha.id);
    for (const [method, url, payload] of [
      ['GET', `/data-tables/${theirs.id}`, undefined],
      ['PATCH', `/data-tables/${theirs.id}`, { name: 'renamed' }],
      ['DELETE', `/data-tables/${theirs.id}`, undefined],
      ['GET', `/data-tables/${theirs.id}/columns`, undefined],
      ['GET', `/data-tables/${theirs.id}/rows`, undefined],
      ['POST', `/data-tables/${theirs.id}/rows`, { data: [{}] }],
      ['DELETE', `/data-tables/${theirs.id}/rows/clear`, undefined],
    ] as const) {
      const res = await api(memberKey, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('creates in the named project and refuses the others', async () => {
    const { memberKey, alpha, beta } = await setup();
    const made = await api(memberKey, 'POST', '/data-tables', {
      name: 'cases',
      columns: [],
      projectId: alpha.id,
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().data.projectId).toBe(alpha.id);
    expect(
      (await api(memberKey, 'POST', '/data-tables', { name: 'cases2', columns: [], projectId: beta.id }))
        .statusCode,
    ).toBe(403);
  });
});

describe('variables', () => {
  it('a project variable is created and listed by projectId, and state=empty keeps the empty ones', async () => {
    const { memberKey, ownerKey, alpha, beta } = await setup('project:admin');
    const made = await api(memberKey, 'POST', '/variables', {
      key: 'ALPHA_ONE',
      value: 'x',
      projectId: alpha.id,
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().data).toMatchObject({ key: 'ALPHA_ONE', projectId: alpha.id });
    await api(memberKey, 'POST', '/variables', { key: 'ALPHA_EMPTY', value: '', projectId: alpha.id });
    const list = (await api(memberKey, 'GET', `/variables?projectId=${alpha.id}`)).json();
    expect(list.data.map((v: { key: string }) => v.key).sort()).toEqual(['ALPHA_EMPTY', 'ALPHA_ONE']);
    const empty = (await api(memberKey, 'GET', `/variables?projectId=${alpha.id}&state=empty`)).json();
    expect(empty.data.map((v: { key: string }) => v.key)).toEqual(['ALPHA_EMPTY']);
    const refused = await api(memberKey, 'POST', '/variables', {
      key: 'BETA_ONE',
      value: 'x',
      projectId: beta.id,
    });
    expect(refused.statusCode).toBe(403);
    expect((await api(memberKey, 'GET', `/variables?projectId=${beta.id}`)).statusCode).toBe(403);
    // a global variable is the owner's; the member does not create or change it
    expect((await api(memberKey, 'POST', '/variables', { key: 'GLOBAL_ONE', value: 'x' })).statusCode).toBe(
      403,
    );
    const global = await api(ownerKey, 'POST', '/variables', { key: 'GLOBAL_ONE', value: 'x' });
    expect(global.json().data.projectId).toBeNull();
    expect((await api(memberKey, 'DELETE', `/variables/${global.json().data.id}`)).statusCode).toBe(403);
    // the same key can live in a project and globally
    const same = await api(memberKey, 'POST', '/variables', {
      key: 'GLOBAL_ONE',
      value: 'y',
      projectId: alpha.id,
    });
    expect(same.statusCode).toBe(200);
  });
});

describe('folders under a project', () => {
  it('lists and creates in a project the user belongs to, 403 in the others, and the old path is gone', async () => {
    const { memberKey, owner, alpha, beta } = await setup();
    await folderIn(server, owner.tenant.id, alpha.id, 'Mine');
    const theirs = await folderIn(server, owner.tenant.id, beta.id, 'Theirs');
    const list = (await api(memberKey, 'GET', `/projects/${alpha.id}/folders`)).json();
    expect(list.data.map((f: { name: string }) => f.name)).toEqual(['Mine']);
    const made = await api(memberKey, 'POST', `/projects/${alpha.id}/folders`, { name: 'New' });
    expect(made.statusCode).toBe(200);
    expect(made.json().data.projectId).toBe(alpha.id);
    for (const [method, url] of [
      ['GET', `/projects/${beta.id}/folders`],
      ['POST', `/projects/${beta.id}/folders`],
      ['GET', `/projects/${beta.id}/folders/${theirs.id}`],
      ['DELETE', `/projects/${beta.id}/folders/${theirs.id}`],
    ] as const) {
      const res = await api(memberKey, method, url, method === 'POST' ? { name: 'x' } : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await api(memberKey, 'GET', '/folders')).statusCode).toBe(404);
  });
});

describe('evaluations', () => {
  it('a test run is read with workflow:read and started with workflow:execute on its workflow', async () => {
    const { owner, member, inAlpha, inBeta } = await setup('project:viewer');
    const key = await keyOf(member.client, ['testRun:list', 'testRun:create']);
    expect((await api(key, 'GET', `/workflows/${inAlpha.id}/test-runs`)).statusCode).toBe(200);
    // a project viewer holds workflow:read, not workflow:execute
    expect((await api(key, 'POST', `/workflows/${inAlpha.id}/test-runs`, {})).statusCode).toBe(403);
    const other = await api(key, 'GET', `/workflows/${inBeta.id}/test-runs`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.message).toBe(FORBIDDEN);
    expect(owner.tenant.id).toBeTruthy();
  });
});
