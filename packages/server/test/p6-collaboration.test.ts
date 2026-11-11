/**
 * P6-81 (L14): presence and the write lock of a workflow. A second user sees the first and gets read-only
 * (the lock is the first writer's); their save is 423, the same user's other tab 409, a save with no client
 * id and a public API write pass; a restore by another user is 423; a lock expires 2 minutes after the last
 * heartbeat and presence after 15 (a fake clock); a take over moves the lock; a close frees it; presence of
 * a workspace never reaches another. Pushes go out with `{ workflowId }`. One block runs on Redis (db 5) and
 * checks that every key holds the tenant id. The second user of the lock cases is a true `member` of the team
 * project (`project:editor`), one case runs as an admin; a take over that lands between a heartbeat's, a
 * repeat request's or a release's read and write keeps its lock (memory and Redis).
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_TTL_MS, WRITE_LOCK_TTL_MS } from '../src/services/collaboration';
import {
  addToProject,
  createTestServer,
  createWorkflow,
  flushRedis,
  memberAs,
  node,
  realMember,
  resetDatabase,
  signup,
  TEST_REDIS,
  type TestClient,
  type TestServer,
  teamProjectOf,
} from './helpers';

const LOCKED = 'Cannot modify workflow while it is being edited by a user in the editor.';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const presence = (client: TestClient, id: string, tab: string, action: string) =>
  client.request('POST', `/rest/workflows/${id}/presence`, { action }, { 'push-ref': tab });
const access = (client: TestClient, id: string, tab: string, action: string) =>
  client.request('POST', `/rest/workflows/${id}/write-access`, { action }, { 'push-ref': tab });
/** a save of the current version (the body needs the version the caller read) */
const save = async (client: TestClient, id: string, tab: string | undefined, name: string) => {
  const { versionId } = await client.data<{ versionId: string }>(client.get(`/rest/workflows/${id}`));
  return client.request(
    'PATCH',
    `/rest/workflows/${id}`,
    { name, versionId },
    tab ? { 'push-ref': tab } : {},
  );
};

/**
 * an owner with a team workflow, a true member of the team project (`project:editor`) and an admin of the same
 * workspace
 */
async function setup() {
  const owner = await signup(server.app);
  const admin = await memberAs(owner, 'admin');
  const member = await realMember(owner);
  await addToProject(
    server,
    owner.tenant.id,
    await teamProjectOf(server, owner.tenant.id),
    member.user.id,
    'project:editor',
  );
  const workflow = await createWorkflow(owner.client, {
    name: 'Shared',
    nodes: [node('Start', 'core.manualTrigger', {})],
  });
  return { owner, admin, member, workflow, id: workflow.id };
}

/**
 * runs `during` once, right after the first lock read of `service`: the moment between a read and the write that
 * follows it (the read stays what it was)
 */
function duringFirstLockRead(service: object, during: () => Promise<unknown>): void {
  const target = service as { lockOf(...args: unknown[]): Promise<unknown> };
  const read = target.lockOf.bind(target);
  let pending = true;
  vi.spyOn(target, 'lockOf').mockImplementation(async (...args: unknown[]) => {
    const lock = await read(...args);
    if (pending) {
      pending = false;
      await during();
    }
    return lock;
  });
}

const stateOf = async (res: Promise<{ json(): any; statusCode: number }>) => {
  const r = await res;
  expect(r.statusCode).toBe(200);
  return r.json().data as {
    collaborators: Array<{ userId: string; name: string; email: string; lastSeen: string }>;
    writeLock: { userId: string; clientId: string; name: string; expiresAt: string } | null;
  };
};

describe('presence', () => {
  it('a second user sees the first, and the first sees the second after a push', async () => {
    const { owner, admin, id } = await setup();
    const send = vi.spyOn(server.ctx.push, 'send');
    const first = await stateOf(presence(owner.client, id, 'tab-a', 'open'));
    expect(first.collaborators.map((c) => c.userId)).toEqual([owner.user.id]);
    const second = await stateOf(presence(admin.client, id, 'tab-b', 'open'));
    expect(second.collaborators.map((c) => c.userId).sort()).toEqual([owner.user.id, admin.user.id].sort());
    expect(second.collaborators[0]?.email).toBeTruthy();
    const changed = send.mock.calls.filter((c) => c[1] === 'collaboratorsChanged');
    expect(changed).toHaveLength(2);
    expect(changed[1]?.[2]).toMatchObject({ workflowId: id });
    // `{ workflowId }` is on the envelope, so a user with no read is filtered
    expect(changed[1]?.[3]).toEqual({ workflowId: id });
    expect(changed[1]?.[0]).toBe(owner.tenant.id);
  });

  it('a second tab of one user is one collaborator; a heartbeat sends no push; close removes the tab', async () => {
    const { owner, id } = await setup();
    await presence(owner.client, id, 'tab-a', 'open');
    const send = vi.spyOn(server.ctx.push, 'send');
    const both = await stateOf(presence(owner.client, id, 'tab-b', 'open'));
    expect(both.collaborators).toHaveLength(1);
    await stateOf(presence(owner.client, id, 'tab-a', 'heartbeat'));
    expect(send).not.toHaveBeenCalled();
    const afterOne = await stateOf(presence(owner.client, id, 'tab-a', 'close'));
    expect(afterOne.collaborators).toHaveLength(1);
    const gone = await stateOf(presence(owner.client, id, 'tab-b', 'close'));
    expect(gone.collaborators).toEqual([]);
    expect(send.mock.calls.filter((c) => c[1] === 'collaboratorsChanged')).toHaveLength(1);
  });

  it('presence expires 15 minutes after the last heartbeat', async () => {
    const { owner, admin, id } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    await presence(owner.client, id, 'tab-a', 'open');
    vi.setSystemTime(Date.now() + PRESENCE_TTL_MS - 1000);
    await presence(admin.client, id, 'tab-b', 'open');
    const early = await stateOf(presence(admin.client, id, 'tab-b', 'heartbeat'));
    expect(early.collaborators).toHaveLength(2);
    vi.setSystemTime(Date.now() + 2000);
    const late = await stateOf(presence(admin.client, id, 'tab-b', 'heartbeat'));
    expect(late.collaborators.map((c) => c.userId)).toEqual([admin.user.id]);
  });

  it('needs the push-ref header, a known action and read access; another workspace gets 404', async () => {
    const { owner, id } = await setup();
    const noRef = await owner.client.post(`/rest/workflows/${id}/presence`, { action: 'open' });
    expect(noRef.statusCode).toBe(400);
    expect((await presence(owner.client, id, 'tab-a', 'dance')).statusCode).toBe(400);
    expect((await access(owner.client, id, 'tab-a', 'steal')).statusCode).toBe(400);

    const stranger = await realMember(owner);
    const denied = await presence(stranger.client, id, 'tab-x', 'open');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('User is missing a scope required to perform this action');

    const foreign = await signup(server.app);
    const other = await presence(foreign.client, id, 'tab-y', 'open');
    expect([403, 404]).toContain(other.statusCode);
    expect((await stateOf(presence(owner.client, id, 'tab-a', 'open'))).collaborators).toHaveLength(1);
  });

  it("a workspace's presence and lock never show in another (keys and answers)", async () => {
    const one = await setup();
    const two = await setup();
    await presence(one.owner.client, one.id, 'tab-a', 'open');
    await access(one.owner.client, one.id, 'tab-a', 'request');
    const mine = await stateOf(presence(two.owner.client, two.id, 'tab-a', 'open'));
    expect(mine.collaborators.map((c) => c.userId)).toEqual([two.owner.user.id]);
    expect(mine.writeLock).toBeNull();
    // the other workspace's service call under this workspace's tenant sees nothing either
    const crossed = await server.ctx.collaboration.state(two.owner.tenant.id, one.id);
    expect(crossed).toEqual({ collaborators: [], writeLock: null });
  });
});

describe('write lock', () => {
  it('the first writer holds it; a project editor gets read-only and their save is 423', async () => {
    const { owner, member: admin, id } = await setup();
    const send = vi.spyOn(server.ctx.push, 'send');
    const mine = await stateOf(access(owner.client, id, 'tab-a', 'request'));
    expect(mine.writeLock).toMatchObject({ userId: owner.user.id, clientId: 'tab-a' });
    expect(new Date(mine.writeLock!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const acquired = send.mock.calls.find((c) => c[1] === 'writeAccessAcquired');
    expect(acquired?.[2]).toEqual({ workflowId: id, userId: owner.user.id, clientId: 'tab-a' });
    expect(acquired?.[3]).toEqual({ workflowId: id });

    const theirs = await stateOf(access(admin.client, id, 'tab-b', 'request'));
    expect(theirs.writeLock?.userId).toBe(owner.user.id);
    const refused = await save(admin.client, id, 'tab-b', 'By admin');
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toBe(LOCKED);
    // the holder saves
    expect((await save(owner.client, id, 'tab-a', 'By owner')).statusCode).toBe(200);
  });

  it('an admin is read-only under the lock too, and a member with no project cannot ask', async () => {
    const { owner, admin, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    const asked = await stateOf(access(admin.client, id, 'tab-b', 'request'));
    expect(asked.writeLock?.userId).toBe(owner.user.id);
    const refused = await save(admin.client, id, 'tab-b', 'By admin');
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toBe(LOCKED);
    const outsider = await realMember(owner);
    expect((await access(outsider.client, id, 'tab-o', 'request')).statusCode).toBe(403);
  });

  it("the same user's other tab gets 409, and a save with no client id passes", async () => {
    const { owner, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    const other = await save(owner.client, id, 'tab-b', 'Other tab');
    expect(other.statusCode).toBe(409);
    expect((await save(owner.client, id, undefined, 'No tab')).statusCode).toBe(200);
  });

  it('every editor write route checks it: delete, archive, unarchive, publish, unpublish, restore', async () => {
    const { owner, member: admin, id, workflow } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    const b = { 'push-ref': 'tab-b' };
    const calls: Array<[string, string]> = [
      ['DELETE', `/rest/workflows/${id}`],
      ['POST', `/rest/workflows/${id}/archive`],
      ['POST', `/rest/workflows/${id}/unarchive`],
      ['POST', `/rest/workflows/${id}/activate`],
      ['POST', `/rest/workflows/${id}/deactivate`],
      ['POST', `/rest/workflows/${id}/versions/${workflow.versionId}/restore`],
    ];
    for (const [method, url] of calls) {
      const res = await admin.client.request(method as 'POST', url, method === 'POST' ? {} : undefined, b);
      expect(res.statusCode, `${method} ${url}`).toBe(423);
      expect(res.json().error.message).toBe(LOCKED);
    }
  });

  it('a public API write passes while the editor holds the lock', async () => {
    const { owner, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    const made = await owner.client.data<{ key: string }>(
      owner.client.post('/rest/api-keys', { name: `collab-${randomUUID().slice(0, 8)}` }),
    );
    const res = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/workflows/${id}`,
      headers: { 'x-api-key': made.key },
      payload: {
        name: 'By API',
        nodes: [node('Start', 'core.manualTrigger', {})],
        connections: {},
        settings: {},
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('expires 2 minutes after the last heartbeat; a heartbeat keeps it', async () => {
    const { owner, member: admin, id } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    await access(owner.client, id, 'tab-a', 'request');
    vi.setSystemTime(Date.now() + WRITE_LOCK_TTL_MS - 1000);
    expect((await access(owner.client, id, 'tab-a', 'heartbeat')).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + WRITE_LOCK_TTL_MS - 1000);
    expect((await save(admin.client, id, 'tab-b', 'Early')).statusCode).toBe(423);
    const send = vi.spyOn(server.ctx.push, 'send');
    vi.setSystemTime(Date.now() + 2000);
    expect((await save(admin.client, id, 'tab-b', 'Late')).statusCode).toBe(200);
    expect(send.mock.calls.some((c) => c[1] === 'writeAccessReleased')).toBe(true);
    const free = await stateOf(access(admin.client, id, 'tab-b', 'request'));
    expect(free.writeLock?.userId).toBe(admin.user.id);
  });

  it('take over: request keeps the holder, force moves the lock and the old holder is read-only', async () => {
    const { owner, member: admin, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    const kept = await stateOf(access(admin.client, id, 'tab-b', 'request'));
    expect(kept.writeLock?.userId).toBe(owner.user.id);
    const send = vi.spyOn(server.ctx.push, 'send');
    const taken = await stateOf(access(admin.client, id, 'tab-b', 'force'));
    expect(taken.writeLock).toMatchObject({ userId: admin.user.id, clientId: 'tab-b' });
    expect(send.mock.calls.find((c) => c[1] === 'writeAccessAcquired')?.[2]).toEqual({
      workflowId: id,
      userId: admin.user.id,
      clientId: 'tab-b',
    });
    expect((await save(owner.client, id, 'tab-a', 'Old holder')).statusCode).toBe(423);
    expect((await save(admin.client, id, 'tab-b', 'New holder')).statusCode).toBe(200);
  });

  it('release and a presence close free the lock, and announce it', async () => {
    const { owner, member: admin, id } = await setup();
    const send = vi.spyOn(server.ctx.push, 'send');
    await access(owner.client, id, 'tab-a', 'request');
    // someone else's release changes nothing
    const kept = await stateOf(access(admin.client, id, 'tab-b', 'release'));
    expect(kept.writeLock?.userId).toBe(owner.user.id);
    const freed = await stateOf(access(owner.client, id, 'tab-a', 'release'));
    expect(freed.writeLock).toBeNull();
    expect(send.mock.calls.filter((c) => c[1] === 'writeAccessReleased')).toHaveLength(1);
    expect((await save(admin.client, id, 'tab-b', 'Free')).statusCode).toBe(200);

    await presence(admin.client, id, 'tab-b', 'open');
    await access(admin.client, id, 'tab-b', 'request');
    const closed = await stateOf(presence(admin.client, id, 'tab-b', 'close'));
    expect(closed.writeLock).toBeNull();
    expect((await save(owner.client, id, 'tab-a', 'After close')).statusCode).toBe(200);
  });

  it('a request on a workflow the user cannot write is 403 (read scope only)', async () => {
    const { owner, id } = await setup();
    const viewer = await memberAs(owner, 'viewer');
    expect((await presence(viewer.client, id, 'tab-v', 'open')).statusCode).toBe(200);
    expect((await access(viewer.client, id, 'tab-v', 'request')).statusCode).toBe(403);
  });
});

describe('a take over between a read and a write', () => {
  it('a heartbeat does not put its own lock back over the take over', async () => {
    const { owner, member, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    duringFirstLockRead(server.ctx.collaboration, () => access(member.client, id, 'tab-b', 'force'));
    await access(owner.client, id, 'tab-a', 'heartbeat');
    vi.restoreAllMocks();
    const state = await stateOf(presence(member.client, id, 'tab-b', 'heartbeat'));
    expect(state.writeLock).toMatchObject({ userId: member.user.id, clientId: 'tab-b' });
    expect((await save(member.client, id, 'tab-b', 'New holder')).statusCode).toBe(200);
    expect((await save(owner.client, id, 'tab-a', 'Old holder')).statusCode).toBe(423);
  });

  it('a repeat request of the holder does not put its own lock back over the take over', async () => {
    const { owner, member, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    duringFirstLockRead(server.ctx.collaboration, () => access(member.client, id, 'tab-b', 'force'));
    const answer = await stateOf(access(owner.client, id, 'tab-a', 'request'));
    expect(answer.writeLock).toMatchObject({ userId: member.user.id, clientId: 'tab-b' });
  });

  it("a release by the old holder does not delete the new holder's lock, and announces nothing", async () => {
    const { owner, member, id } = await setup();
    await access(owner.client, id, 'tab-a', 'request');
    duringFirstLockRead(server.ctx.collaboration, () => access(member.client, id, 'tab-b', 'force'));
    const send = vi.spyOn(server.ctx.push, 'send');
    const answer = await stateOf(access(owner.client, id, 'tab-a', 'release'));
    expect(answer.writeLock).toMatchObject({ userId: member.user.id, clientId: 'tab-b' });
    expect(send.mock.calls.some((c) => c[1] === 'writeAccessReleased')).toBe(false);
  });
});

describe('workflowSaved', () => {
  it('a save pushes workflowUpdated with the saver, on the workflow envelope', async () => {
    const { owner, id } = await setup();
    const send = vi.spyOn(server.ctx.push, 'send');
    expect((await save(owner.client, id, undefined, 'Renamed')).statusCode).toBe(200);
    const updated = send.mock.calls.find((c) => c[1] === 'workflowUpdated');
    expect(updated?.[2]).toEqual({ workflowId: id, userId: owner.user.id });
    expect(updated?.[3]).toEqual({ workflowId: id });
  });

  it('never throws when the push fails', () => {
    vi.spyOn(server.ctx.push, 'send').mockImplementation(() => {
      throw new Error('bus down');
    });
    expect(() => server.ctx.collaboration.workflowSaved('t', 'w', 'u')).not.toThrow();
  });
});

describe('Redis state', () => {
  let redisServer: TestServer;
  let probe: Redis;

  beforeAll(async () => {
    await flushRedis();
    redisServer = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000', REDIS_URL: TEST_REDIS });
    probe = new Redis(TEST_REDIS, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    await probe?.quit();
    await redisServer?.close();
    await flushRedis();
  });

  it('keeps presence and the lock in Redis, every key holds the tenant id, and the lock is one winner', async () => {
    const owner = await signup(redisServer.app);
    const admin = await memberAs(owner, 'admin');
    const wf = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger', {})] });
    const tenantId = owner.tenant.id;
    const state = await redisServer.ctx.collaboration.opened(
      tenantId,
      wf.id,
      { id: owner.user.id, email: owner.user.email, firstName: 'Own', lastName: 'Er' },
      'tab-a',
    );
    expect(state.collaborators[0]?.name).toBe('Own Er');
    const [a, b] = await Promise.all([
      redisServer.ctx.collaboration.requestWrite(
        tenantId,
        wf.id,
        { id: owner.user.id, email: 'o@x.io' },
        'tab-a',
      ),
      redisServer.ctx.collaboration.requestWrite(
        tenantId,
        wf.id,
        { id: admin.user.id, email: 'a@x.io' },
        'tab-b',
      ),
    ]);
    expect(a.writeLock?.clientId).toBe(b.writeLock?.clientId);
    const keys = (await probe.keys('*collab*')).sort();
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toContain(tenantId);
    // the lock key expires on its own, a real second clock aside
    const lockKey = keys.find((k) => k.endsWith(':lock'));
    expect(await probe.pttl(lockKey!)).toBeGreaterThan(0);
    expect(await probe.pttl(lockKey!)).toBeLessThanOrEqual(WRITE_LOCK_TTL_MS);
    await expect(redisServer.ctx.collaboration.assertNoLock(tenantId, wf.id)).rejects.toMatchObject({
      statusCode: 423,
      message: LOCKED,
    });
    await redisServer.ctx.collaboration.closed(tenantId, wf.id, a.writeLock!.userId, a.writeLock!.clientId);
    await expect(redisServer.ctx.collaboration.assertNoLock(tenantId, wf.id)).resolves.toBeUndefined();
  });

  it('a take over between a read and the write keeps its lock: heartbeat, repeat request and release', async () => {
    const owner = await signup(redisServer.app);
    const member = await realMember(owner);
    await addToProject(
      redisServer,
      owner.tenant.id,
      await teamProjectOf(redisServer, owner.tenant.id),
      member.user.id,
      'project:editor',
    );
    const wf = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger', {})] });
    const service = redisServer.ctx.collaboration;
    const tenantId = owner.tenant.id;
    const mine = { id: owner.user.id, email: owner.user.email };
    const theirs = { id: member.user.id, email: member.user.email };
    const takeOver = () => service.requestWrite(tenantId, wf.id, theirs, 'tab-b', { force: true });

    for (const act of [
      () => service.heartbeat(tenantId, wf.id, mine, 'tab-a'),
      () => service.requestWrite(tenantId, wf.id, mine, 'tab-a'),
      () => service.release(tenantId, wf.id, owner.user.id, 'tab-a'),
    ]) {
      await service.requestWrite(tenantId, wf.id, mine, 'tab-a', { force: true });
      duringFirstLockRead(service, takeOver);
      const answer = await act();
      vi.restoreAllMocks();
      expect(answer.writeLock).toMatchObject({ userId: member.user.id, clientId: 'tab-b' });
      expect((await service.state(tenantId, wf.id)).writeLock).toMatchObject({ clientId: 'tab-b' });
      await service.release(tenantId, wf.id, member.user.id, 'tab-b');
    }
  });
});
