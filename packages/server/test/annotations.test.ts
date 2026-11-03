/** Execution annotations (P3-09): annotation tags, PATCH /executions/:id, list filters. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
type Owner = Awaited<ReturnType<typeof signup>>;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function member(owner: Owner, role: 'admin' | 'editor' | 'viewer') {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  await client.data(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: role, password: 'Passw0rd!' }),
  );
  return client;
}

const tag = (client: TestClient, name: string) =>
  client.data<{ id: string; name: string }>(client.post('/rest/annotation-tags', { name }));

/** a finished execution row of a fresh workflow */
async function execution(owner: Owner) {
  const wf = await createWorkflow(owner.client, {
    nodes: [node('Start', 'core.manualTrigger')],
    connections: chain('Start'),
  });
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    owner.tenant.id,
    { id, workflowId: wf.id, workflowName: 'W', mode: 'manual', status: 'success', startedAt: new Date() },
    { workflowData: { id: wf.id, name: 'W', nodes: [], connections: {}, settings: {} }, runOptions: {} },
  );
  return id;
}

const ids = (res: { json(): any }) =>
  res
    .json()
    .data.map((e: { id: string }) => e.id)
    .sort();

describe('annotation tags', () => {
  it('create, list with usage count, rename, delete', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const a = await tag(client, 'billing');
    const b = await tag(client, 'ops');
    const run = await execution(owner);
    await client.data(client.patch(`/rest/executions/${run}`, { tags: [a.id] }));
    const list = await client.data<Array<{ name: string; usageCount?: number }>>(
      client.get('/rest/annotation-tags?withUsageCount=true'),
    );
    expect(list.map((t) => [t.name, t.usageCount])).toEqual([
      ['billing', 1],
      ['ops', 0],
    ]);
    const plain = await client.data<Array<{ usageCount?: number }>>(client.get('/rest/annotation-tags'));
    expect(plain[0].usageCount).toBeUndefined();
    const renamed = await client.data(client.patch(`/rest/annotation-tags/${b.id}`, { name: 'support' }));
    expect(renamed.name).toBe('support');
    expect((await client.delete(`/rest/annotation-tags/${b.id}`)).statusCode).toBe(200);
    expect((await client.delete(`/rest/annotation-tags/${b.id}`)).statusCode).toBe(404);
  });

  it('a duplicate name is 409 whatever the case; the name is 1..24 characters', async () => {
    const { client } = await signup(server.app);
    await tag(client, 'Billing');
    expect((await client.post('/rest/annotation-tags', { name: 'bILLING' })).statusCode).toBe(409);
    const other = await tag(client, 'ops');
    expect((await client.patch(`/rest/annotation-tags/${other.id}`, { name: 'BILLING' })).statusCode).toBe(
      409,
    );
    expect((await client.post('/rest/annotation-tags', { name: '' })).statusCode).toBe(400);
    expect((await client.post('/rest/annotation-tags', { name: 'x'.repeat(25) })).statusCode).toBe(400);
    expect((await client.post('/rest/annotation-tags', { name: 'x'.repeat(24) })).statusCode).toBe(200);
  });

  it('a viewer reads but cannot write (403); another tenant sees 404 and its own list', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const t = await tag(owner.client, 'mine');
    expect((await viewer.get('/rest/annotation-tags')).statusCode).toBe(200);
    expect((await viewer.post('/rest/annotation-tags', { name: 'x' })).statusCode).toBe(403);
    expect((await viewer.patch(`/rest/annotation-tags/${t.id}`, { name: 'y' })).statusCode).toBe(403);
    expect((await viewer.delete(`/rest/annotation-tags/${t.id}`)).statusCode).toBe(403);
    const other = await signup(server.app);
    expect((await other.client.patch(`/rest/annotation-tags/${t.id}`, { name: 'z' })).statusCode).toBe(404);
    expect((await other.client.delete(`/rest/annotation-tags/${t.id}`)).statusCode).toBe(404);
    expect((await other.client.data(other.client.get('/rest/annotation-tags'))).length).toBe(0);
    // the same name is free in another workspace
    expect((await other.client.post('/rest/annotation-tags', { name: 'mine' })).statusCode).toBe(200);
  });
});

describe('PATCH /executions/:id', () => {
  it('sets tags and vote, answers the annotation, shows it on the summary and detail', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const a = await tag(client, 'billing');
    const run = await execution(owner);
    const first = await client.data(client.patch(`/rest/executions/${run}`, { tags: [a.id], vote: 'up' }));
    expect(first).toEqual({ vote: 'up', tags: [{ id: a.id, name: 'billing' }] });
    const detail = await client.data(client.get(`/rest/executions/${run}`));
    expect(detail.annotation).toEqual(first);
    const list = await client.data<Array<{ id: string; annotation: unknown }>>(
      client.get('/rest/executions'),
    );
    expect(list.find((e) => e.id === run)?.annotation).toEqual(first);
    // vote alone keeps the tags; vote null clears it; tags [] clears them
    expect((await client.data(client.patch(`/rest/executions/${run}`, { vote: 'down' }))).tags).toHaveLength(
      1,
    );
    expect(await client.data(client.patch(`/rest/executions/${run}`, { vote: null }))).toEqual({
      vote: null,
      tags: [{ id: a.id, name: 'billing' }],
    });
    expect(await client.data(client.patch(`/rest/executions/${run}`, { tags: [] }))).toBeNull();
    expect((await client.data(client.get(`/rest/executions/${run}`))).annotation).toBeNull();
  });

  it('refuses an empty body, a bad vote, a bad tag id (400); an unknown or other tenant id is 404', async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const mine = await tag(owner.client, 'mine');
    const theirs = await tag(other.client, 'theirs');
    const run = await execution(owner);
    expect((await owner.client.patch(`/rest/executions/${run}`, {})).statusCode).toBe(400);
    expect((await owner.client.patch(`/rest/executions/${run}`, { vote: 'meh' })).statusCode).toBe(400);
    expect((await owner.client.patch(`/rest/executions/${run}`, { tags: ['nope'] })).statusCode).toBe(400);
    const res = await owner.client.patch(`/rest/executions/${run}`, { tags: [mine.id, theirs.id] });
    expect(res.statusCode).toBe(404);
    const rows = await server.ctx.database.pool.query(
      'select 1 from execution_annotation_tags where tag_id = $1 or execution_id = $2',
      [theirs.id, run],
    );
    expect(rows.rowCount).toBe(0);
    // the other tenant cannot annotate this execution
    expect((await other.client.patch(`/rest/executions/${run}`, { vote: 'up' })).statusCode).toBe(404);
    expect((await owner.client.patch(`/rest/executions/${randomUUID()}`, { vote: 'up' })).statusCode).toBe(
      404,
    );
  });

  it('a viewer gets 403 and nothing is written', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const run = await execution(owner);
    expect((await viewer.patch(`/rest/executions/${run}`, { vote: 'up' })).statusCode).toBe(403);
    const rows = await server.ctx.database.pool.query('select 1 from execution_annotations');
    expect(rows.rowCount).toBe(0);
  });

  it('24 distinct tags fit on one execution; the same id twice counts once', async () => {
    const owner = await signup(server.app);
    const run = await execution(owner);
    const made: string[] = [];
    for (let i = 0; i < 24; i++) made.push((await tag(owner.client, `t${i}`)).id);
    const res = await owner.client.data(
      owner.client.patch(`/rest/executions/${run}`, { tags: [...made, made[0]] }),
    );
    expect(res.tags).toHaveLength(24);
  });
});

describe('execution list filters', () => {
  it('a tag finds exactly the run; two tags need both; vote filters; they combine', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const a = await tag(client, 'a');
    const b = await tag(client, 'b');
    const r1 = await execution(owner);
    const r2 = await execution(owner);
    const r3 = await execution(owner);
    await client.data(client.patch(`/rest/executions/${r1}`, { tags: [a.id, b.id], vote: 'up' }));
    await client.data(client.patch(`/rest/executions/${r2}`, { tags: [a.id], vote: 'down' }));
    await client.data(client.patch(`/rest/executions/${r3}`, { vote: 'up' }));
    expect(ids(await client.get(`/rest/executions?annotationTags=${a.id}`))).toEqual([r1, r2].sort());
    expect(ids(await client.get(`/rest/executions?annotationTags=${b.id}`))).toEqual([r1]);
    expect(ids(await client.get(`/rest/executions?annotationTags=${a.id},${b.id}`))).toEqual([r1]);
    expect(ids(await client.get('/rest/executions?vote=up'))).toEqual([r1, r3].sort());
    expect(ids(await client.get('/rest/executions?vote=down'))).toEqual([r2]);
    expect(ids(await client.get(`/rest/executions?annotationTags=${a.id}&vote=down`))).toEqual([r2]);
    expect(ids(await client.get(`/rest/executions?annotationTags=${randomUUID()}`))).toEqual([]);
    expect((await client.get('/rest/executions?annotationTags=nope')).statusCode).toBe(400);
  });

  it('deleting a tag removes it from the runs and the filter', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const a = await tag(client, 'a');
    const run = await execution(owner);
    await client.data(client.patch(`/rest/executions/${run}`, { tags: [a.id] }));
    await client.delete(`/rest/annotation-tags/${a.id}`);
    expect((await client.data(client.get(`/rest/executions/${run}`))).annotation).toBeNull();
    expect(ids(await client.get(`/rest/executions?annotationTags=${a.id}`))).toEqual([]);
    const rows = await server.ctx.database.pool.query('select 1 from execution_annotation_tags');
    expect(rows.rowCount).toBe(0);
  });

  it('another tenant never matches this tenant tags or votes', async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const a = await tag(owner.client, 'a');
    const run = await execution(owner);
    await owner.client.data(owner.client.patch(`/rest/executions/${run}`, { tags: [a.id], vote: 'up' }));
    expect(ids(await other.client.get(`/rest/executions?annotationTags=${a.id}`))).toEqual([]);
    expect(ids(await other.client.get('/rest/executions?vote=up'))).toEqual([]);
  });
});
