/**
 * P6-77 (S4 L10): the five public rows the CLI needs. Workflow tags (GET, PUT), the stop of a run, and the
 * credential list and read, which answer names and types only. A key does what its user may do.
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
/** a label is unique per user, so each key gets its own */
async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await client.data(
    client.post('/rest/api-keys', { name: `cli${keyCount}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

async function seedRun(tenantId: string, workflowId: string, status: string): Promise<string> {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    {
      id,
      workflowId,
      workflowName: 'Run',
      mode: 'manual',
      status,
      startedAt: new Date(),
      customData: {},
    },
    { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
  );
  return id;
}

/** an owner, a true member who edits Alpha and has nothing in Beta, a workflow and a credential in each */
async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
  const inAlpha = await workflowIn(server, tenantId, alpha.id);
  const inBeta = await workflowIn(server, tenantId, beta.id);
  const credAlpha = await credentialIn(server, tenantId, alpha.id, { name: 'Alpha cred' });
  const credBeta = await credentialIn(server, tenantId, beta.id, { name: 'Beta cred' });
  return {
    owner,
    member,
    tenantId,
    alpha,
    beta,
    inAlpha,
    inBeta,
    credAlpha,
    credBeta,
    ownerKey: await keyOf(owner.client),
    memberKey: await keyOf(member.client),
  };
}

async function makeTag(owner: { client: TestClient }, name: string): Promise<string> {
  const made = await owner.client.data(owner.client.post('/rest/tags', { name }));
  return made.id as string;
}

describe('workflow tags', () => {
  it('sets and lists the tags with [{ id }], as n8n', async () => {
    const s = await setup();
    const a = await makeTag(s.owner, 'billing');
    const b = await makeTag(s.owner, 'alpha');
    expect((await api(s.ownerKey, 'GET', `/workflows/${s.inAlpha.id}/tags`)).json().data).toEqual([]);
    const put = await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{ id: a }, { id: b }]);
    expect(put.statusCode).toBe(200);
    expect(put.json().data.map((t: { name: string }) => t.name)).toEqual(['alpha', 'billing']);
    const got = (await api(s.ownerKey, 'GET', `/workflows/${s.inAlpha.id}/tags`)).json();
    expect(got.data.map((t: { id: string }) => t.id).sort()).toEqual([a, b].sort());
    expect(got.data[0]).toHaveProperty('createdAt');
    expect(got.nextCursor).toBeNull();
    const replaced = await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{ id: a }]);
    expect(replaced.json().data.map((t: { id: string }) => t.id)).toEqual([a]);
    expect((await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [])).json().data).toEqual([]);
  });

  it('refuses a tag that does not exist and a bad body', async () => {
    const s = await setup();
    const unknown = await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{ id: randomUUID() }]);
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    expect(unknown.statusCode).toBeLessThan(500);
    expect((await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, { id: 'x' })).statusCode).toBe(
      400,
    );
    expect((await api(s.ownerKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{}])).statusCode).toBe(400);
  });

  it('follows the user: a member edits Alpha and meets 403 on Beta', async () => {
    const s = await setup();
    const tag = await makeTag(s.owner, 'shared');
    const ok = await api(s.memberKey, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{ id: tag }]);
    expect(ok.statusCode).toBe(200);
    for (const [method, payload] of [
      ['GET', undefined],
      ['PUT', [{ id: tag }]],
    ] as const) {
      const res = await api(s.memberKey, method, `/workflows/${s.inBeta.id}/tags`, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('a workflow of another workspace is 404', async () => {
    const s = await setup();
    const other = await signup(server.app);
    const team = await server.ctx.repos.projects.oldestTeam(other.tenant.id);
    const foreign = await workflowIn(server, other.tenant.id, team!.id);
    expect((await api(s.ownerKey, 'GET', `/workflows/${foreign.id}/tags`)).statusCode).toBe(404);
    expect((await api(s.ownerKey, 'PUT', `/workflows/${foreign.id}/tags`, [])).statusCode).toBe(404);
  });

  it('a key without the scope gets 403 (the protected lock of PUT is tested in L7)', async () => {
    const s = await setup();
    const tag = await makeTag(s.owner, 'locked');
    const noScope = await keyOf(s.owner.client, ['workflow:list']);
    expect((await api(noScope, 'GET', `/workflows/${s.inAlpha.id}/tags`)).statusCode).toBe(403);
    const reader = await keyOf(s.owner.client, ['workflowTags:list']);
    expect((await api(reader, 'GET', `/workflows/${s.inAlpha.id}/tags`)).statusCode).toBe(200);
    expect((await api(reader, 'PUT', `/workflows/${s.inAlpha.id}/tags`, [{ id: tag }])).statusCode).toBe(403);
  });
});

describe('POST /executions/:id/stop', () => {
  it('stops a waiting run and answers its status', async () => {
    const s = await setup();
    const run = await seedRun(s.tenantId, s.inAlpha.id, 'waiting');
    const res = await api(s.ownerKey, 'POST', `/executions/${run}/stop`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: run, status: 'canceled' });
    expect((await server.ctx.repos.executions.get(s.tenantId, run))?.status).toBe('canceled');
  });

  it('needs workflow:execute on the run: a member stops Alpha runs, not Beta runs', async () => {
    const s = await setup();
    const inAlpha = await seedRun(s.tenantId, s.inAlpha.id, 'waiting');
    const inBeta = await seedRun(s.tenantId, s.inBeta.id, 'waiting');
    expect((await api(s.memberKey, 'POST', `/executions/${inAlpha}/stop`, {})).statusCode).toBe(200);
    const denied = await api(s.memberKey, 'POST', `/executions/${inBeta}/stop`, {});
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(FORBIDDEN);
    expect((await server.ctx.repos.executions.get(s.tenantId, inBeta))?.status).toBe('waiting');
  });

  it('a key without execution:stop gets 403; another workspace run and an unknown id are 404', async () => {
    const s = await setup();
    const run = await seedRun(s.tenantId, s.inAlpha.id, 'waiting');
    const noScope = await keyOf(s.owner.client, ['execution:read']);
    expect((await api(noScope, 'POST', `/executions/${run}/stop`, {})).statusCode).toBe(403);
    const other = await signup(server.app);
    const otherKey = await keyOf(other.client);
    expect((await api(otherKey, 'POST', `/executions/${run}/stop`, {})).statusCode).toBe(404);
    expect((await api(s.ownerKey, 'POST', `/executions/${randomUUID()}/stop`, {})).statusCode).toBe(404);
  });
});

describe('GET /credentials and /credentials/:id', () => {
  it('lists names and types, never data', async () => {
    const s = await setup();
    const res = await api(s.ownerKey, 'GET', '/credentials');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([s.credAlpha.id, s.credBeta.id]));
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'type', 'updatedAt']);
    }
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.nextCursor).toBeNull();
  });

  it('narrows the list to the caller: its projects and the global credentials', async () => {
    const s = await setup();
    const global = await credentialIn(server, s.tenantId, s.beta.id, { name: 'Everyone', isGlobal: true });
    const ids = (await api(s.memberKey, 'GET', '/credentials')).json().data.map((c: { id: string }) => c.id);
    expect(ids).toContain(s.credAlpha.id);
    expect(ids).toContain(global.id);
    expect(ids).not.toContain(s.credBeta.id);
  });

  it('pages with a cursor', async () => {
    const s = await setup();
    const first = (await api(s.ownerKey, 'GET', '/credentials?limit=1')).json();
    expect(first.data).toHaveLength(1);
    expect(typeof first.nextCursor).toBe('string');
    const second = (await api(s.ownerKey, 'GET', `/credentials?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect(second.nextCursor).toBeNull();
    expect((await api(s.ownerKey, 'GET', '/credentials?cursor=not-a-cursor')).statusCode).toBe(400);
  });

  it('reads one credential with no data; a hidden one is 403 and another workspace 404', async () => {
    const s = await setup();
    const got = await api(s.memberKey, 'GET', `/credentials/${s.credAlpha.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().data).toMatchObject({ id: s.credAlpha.id, name: 'Alpha cred', type: 'testApi' });
    expect(got.json().data).not.toHaveProperty('data');
    expect(JSON.stringify(got.json())).not.toContain('secret');
    const hidden = await api(s.memberKey, 'GET', `/credentials/${s.credBeta.id}`);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(FORBIDDEN);
    const other = await signup(server.app);
    const otherKey = await keyOf(other.client);
    expect((await api(otherKey, 'GET', `/credentials/${s.credAlpha.id}`)).statusCode).toBe(404);
    expect((await api(s.ownerKey, 'GET', `/credentials/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('a key without credential:read or credential:list gets 403', async () => {
    const s = await setup();
    const reader = await keyOf(s.owner.client, ['workflow:list']);
    expect((await api(reader, 'GET', '/credentials')).statusCode).toBe(403);
    expect((await api(reader, 'GET', `/credentials/${s.credAlpha.id}`)).statusCode).toBe(403);
    const lister = await keyOf(s.owner.client, ['credential:list']);
    expect((await api(lister, 'GET', '/credentials')).statusCode).toBe(200);
    expect((await api(lister, 'GET', `/credentials/${s.credAlpha.id}`)).statusCode).toBe(403);
  });
});
