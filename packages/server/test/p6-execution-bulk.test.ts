/**
 * P6-85 (L17): POST /rest/executions/stopMany and /rest/executions/delete. Both take the filter of the list (or
 * ids for a selection) and act only on runs the caller may stop (`workflow:execute`) or delete
 * (`execution:delete`) in their projects; a run of another project, another workspace or with no workflow stays.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
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
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function seed(
  tenantId: string,
  workflowId: string | null,
  fields: { mode?: string; status?: string; startedAt?: Date; customData?: Record<string, string> } = {},
): Promise<string> {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    {
      id,
      workflowId,
      workflowName: 'Run',
      mode: fields.mode ?? 'manual',
      status: fields.status ?? 'waiting',
      startedAt: fields.startedAt ?? new Date(),
      customData: fields.customData ?? {},
    },
    { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
  );
  return id;
}

/** a time after every seeded run: the bound a filter delete needs */
const LATER = '2099-01-01T00:00:00Z';

const statusOf = async (tenantId: string, id: string) =>
  (await server.ctx.repos.executions.get(tenantId, id))?.status;
const exists = async (tenantId: string, id: string) =>
  !!(await server.ctx.repos.executions.get(tenantId, id));

/** an owner, a member who edits Alpha and only views Beta, a workflow in each, and one more in Gamma */
async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  const gamma = await projectIn(server, owner.tenant.id, 'Gamma');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:editor');
  await addToProject(server, owner.tenant.id, beta.id, member.user.id, 'project:viewer');
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id);
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id);
  const inGamma = await workflowIn(server, owner.tenant.id, gamma.id);
  return { owner, member, alpha, beta, gamma, inAlpha, inBeta, inGamma };
}

describe('stop many (P6-85)', () => {
  it('stops only the runs the caller may execute', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const mine = await seed(t, s.inAlpha.id);
    const viewed = await seed(t, s.inBeta.id);
    const hidden = await seed(t, s.inGamma.id);
    const orphan = await seed(t, null);
    const finished = await seed(t, s.inAlpha.id, { status: 'success' });

    const res = await s.member.client.post('/rest/executions/stopMany', { filter: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ stopped: 1 });
    expect(await statusOf(t, mine)).toBe('canceled');
    expect(await statusOf(t, viewed)).toBe('waiting');
    expect(await statusOf(t, hidden)).toBe('waiting');
    expect(await statusOf(t, orphan)).toBe('waiting');
    expect(await statusOf(t, finished)).toBe('success');
  });

  it('a selection by ids stops those runs, and not an id outside the caller access', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const a1 = await seed(t, s.inAlpha.id);
    const a2 = await seed(t, s.inAlpha.id);
    const b1 = await seed(t, s.inBeta.id);
    const res = await s.member.client.post('/rest/executions/stopMany', { filter: { ids: [a1, b1] } });
    expect(res.json().data).toEqual({ stopped: 1 });
    expect(await statusOf(t, a1)).toBe('canceled');
    expect(await statusOf(t, a2)).toBe('waiting');
    expect(await statusOf(t, b1)).toBe('waiting');
  });

  it('the filter narrows what stops (workflow, mode, dates, custom data)', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const old = await seed(t, s.inAlpha.id, { startedAt: new Date('2026-01-01T00:00:00Z') });
    const webhook = await seed(t, s.inAlpha.id, {
      mode: 'webhook',
      startedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const tagged = await seed(t, s.inAlpha.id, {
      customData: { orderId: '7' },
      startedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const owner = s.owner.client;
    expect(
      (
        await owner.post('/rest/executions/stopMany', { filter: { startedBefore: '2026-02-01T00:00:00Z' } })
      ).json().data,
    ).toEqual({ stopped: 1 });
    expect(await statusOf(t, old)).toBe('canceled');
    expect(
      (
        await owner.post('/rest/executions/stopMany', {
          filter: { mode: 'webhook', workflowId: s.inAlpha.id },
        })
      ).json().data,
    ).toEqual({ stopped: 1 });
    expect(await statusOf(t, webhook)).toBe('canceled');
    expect(await statusOf(t, tagged)).toBe('waiting');
    expect(
      (
        await owner.post('/rest/executions/stopMany', {
          filter: { customDataKey: 'orderId', customDataValue: '7', customDataExact: true },
        })
      ).json().data,
    ).toEqual({ stopped: 1 });
    expect(await statusOf(t, tagged)).toBe('canceled');
  });

  it('stops a run of a workflow shared into the project the caller edits, and not an unshared one', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    await server.ctx.repos.shares.set(t, 'workflow', s.inGamma.id, [s.alpha.id]);
    const shared = await seed(t, s.inGamma.id);
    const unshared = await seed(t, s.inBeta.id);
    const res = await s.member.client.post('/rest/executions/stopMany', {
      filter: { ids: [shared, unshared], projectId: s.alpha.id },
    });
    expect(res.json().data).toEqual({ stopped: 1 });
    expect(await statusOf(t, shared)).toBe('canceled');
    expect(await statusOf(t, unshared)).toBe('waiting');
  });

  it('a filter on archived narrows a stop', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const archivedWf = await workflowIn(server, t, s.alpha.id);
    await server.ctx.repos.workflows.setArchived(t, archivedWf.id, true);
    const archivedRun = await seed(t, archivedWf.id);
    const liveRun = await seed(t, s.inAlpha.id);
    const res = await s.owner.client.post('/rest/executions/stopMany', { filter: { archived: true } });
    expect(res.json().data).toEqual({ stopped: 1 });
    expect(await statusOf(t, archivedRun)).toBe('canceled');
    expect(await statusOf(t, liveRun)).toBe('waiting');
  });

  it('a status filter that holds no active status stops nothing', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const run = await seed(t, s.inAlpha.id);
    const res = await s.owner.client.post('/rest/executions/stopMany', { filter: { status: 'success' } });
    expect(res.json().data).toEqual({ stopped: 0 });
    expect(await statusOf(t, run)).toBe('waiting');
  });

  it('the owner reaches every project and the runs with no workflow; another workspace is untouched', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const other = await signup(server.app);
    const otherWf = await workflowIn(server, other.tenant.id, other.client.defaultProjectId!);
    const foreign = await seed(other.tenant.id, otherWf.id);
    const runs = [await seed(t, s.inAlpha.id), await seed(t, s.inGamma.id), await seed(t, null)];
    const res = await s.owner.client.post('/rest/executions/stopMany', { filter: {} });
    expect(res.json().data).toEqual({ stopped: 3 });
    for (const id of runs) expect(await statusOf(t, id)).toBe('canceled');
    expect(await statusOf(other.tenant.id, foreign)).toBe('waiting');
  });

  it('needs a signed-in user and a valid filter', async () => {
    const s = await setup();
    const anon = new TestClient(server.app);
    expect((await anon.post('/rest/executions/stopMany', { filter: {} })).statusCode).toBe(401);
    expect(
      (await s.owner.client.post('/rest/executions/stopMany', { filter: { mode: 'nope' } })).statusCode,
    ).toBe(400);
  });

  it('works through more than one batch', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const all: string[] = [];
    for (let i = 0; i < 130; i++) all.push(await seed(t, s.inAlpha.id));
    const res = await s.member.client.post('/rest/executions/stopMany', { filter: {} });
    expect(res.json().data).toEqual({ stopped: 130 });
    expect(await statusOf(t, all[0])).toBe('canceled');
    expect(await statusOf(t, all[129])).toBe('canceled');
  });
});

describe('delete many (P6-85)', () => {
  it('deletes a selection the caller may delete and leaves another project rows', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const mine = await seed(t, s.inAlpha.id, { status: 'success' });
    const viewed = await seed(t, s.inBeta.id, { status: 'success' });
    const res = await s.member.client.post('/rest/executions/delete', { ids: [mine, viewed] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ deleted: 1 });
    expect(await exists(t, mine)).toBe(false);
    expect(await exists(t, viewed)).toBe(true);
  });

  it('answers "Execution not found" when none of the ids is accessible', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const viewed = await seed(t, s.inBeta.id, { status: 'success' });
    const hidden = await seed(t, s.inGamma.id, { status: 'success' });
    const res = await s.member.client.post('/rest/executions/delete', {
      ids: [viewed, hidden, randomUUID()],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message ?? res.json().error?.message).toMatch(/Execution not found/);
    expect(await exists(t, viewed)).toBe(true);
    expect(await exists(t, hidden)).toBe(true);
  });

  it('deletes by filter inside the access: another project and the runs with no workflow stay', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const a1 = await seed(t, s.inAlpha.id, { status: 'success', mode: 'webhook' });
    const a2 = await seed(t, s.inAlpha.id, { status: 'error', mode: 'manual' });
    const b1 = await seed(t, s.inBeta.id, { status: 'success', mode: 'webhook' });
    const orphan = await seed(t, null, { status: 'success', mode: 'webhook' });
    const res = await s.member.client.post('/rest/executions/delete', {
      filters: { mode: 'webhook' },
      deleteBefore: LATER,
    });
    expect(res.json().data).toEqual({ deleted: 1 });
    expect(await exists(t, a1)).toBe(false);
    expect(await exists(t, a2)).toBe(true);
    expect(await exists(t, b1)).toBe(true);
    expect(await exists(t, orphan)).toBe(true);

    const all = await s.owner.client.post('/rest/executions/delete', {
      filters: { mode: 'webhook' },
      deleteBefore: LATER,
    });
    expect(all.json().data).toEqual({ deleted: 2 });
    expect(await exists(t, b1)).toBe(false);
    expect(await exists(t, orphan)).toBe(false);
    expect(await exists(t, a2)).toBe(true);
  });

  it('deleteBefore removes the runs that started at or before it, within the filters', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const old = await seed(t, s.inAlpha.id, {
      status: 'success',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const edge = await seed(t, s.inAlpha.id, {
      status: 'success',
      startedAt: new Date('2026-02-01T00:00:00Z'),
    });
    const late = await seed(t, s.inAlpha.id, {
      status: 'success',
      startedAt: new Date('2026-03-01T00:00:00Z'),
    });
    const oldBeta = await seed(t, s.inBeta.id, {
      status: 'success',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const res = await s.member.client.post('/rest/executions/delete', {
      deleteBefore: '2026-02-01T00:00:00Z',
    });
    expect(res.json().data).toEqual({ deleted: 2 });
    expect(await exists(t, old)).toBe(false);
    expect(await exists(t, edge)).toBe(false);
    expect(await exists(t, late)).toBe(true);
    expect(await exists(t, oldBeta)).toBe(true);
    const narrowed = await s.owner.client.post('/rest/executions/delete', {
      deleteBefore: '2026-12-01T00:00:00Z',
      filters: { workflowId: s.inBeta.id },
    });
    expect(narrowed.json().data).toEqual({ deleted: 1 });
    expect(await exists(t, late)).toBe(true);
  });

  it('a run still waiting is stopped before it is deleted', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const waiting = await seed(t, s.inAlpha.id, { status: 'waiting' });
    const res = await s.owner.client.post('/rest/executions/delete', { ids: [waiting] });
    expect(res.json().data).toEqual({ deleted: 1 });
    expect(await exists(t, waiting)).toBe(false);
  });

  it('refuses a delete that names nothing, so it never reaches every run', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const run = await seed(t, s.inAlpha.id, { status: 'success' });
    expect((await s.owner.client.post('/rest/executions/delete', {})).statusCode).toBe(400);
    expect((await s.owner.client.post('/rest/executions/delete', { ids: [] })).statusCode).toBe(400);
    expect(await exists(t, run)).toBe(true);
  });

  it('refuses filters with no ids and no deleteBefore, and deletes nothing', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const run = await seed(t, s.inAlpha.id, { status: 'success', mode: 'webhook' });
    const orphan = await seed(t, null, { status: 'success' });
    for (const body of [
      { filters: {} },
      { filters: { mode: 'webhook' } },
      { ids: [], filters: { workflowId: s.inAlpha.id } },
    ]) {
      const res = await s.owner.client.post('/rest/executions/delete', body);
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/Give ids or deleteBefore/);
    }
    expect(await exists(t, run)).toBe(true);
    expect(await exists(t, orphan)).toBe(true);
  });

  it('a filter on archived narrows a delete: runs of a workflow that is not archived stay', async () => {
    const s = await setup();
    const t = s.owner.tenant.id;
    const archivedWf = await workflowIn(server, t, s.alpha.id);
    await server.ctx.repos.workflows.setArchived(t, archivedWf.id, true);
    const gone = await seed(t, archivedWf.id, { status: 'success' });
    const stays = await seed(t, s.inAlpha.id, { status: 'success' });
    const res = await s.owner.client.post('/rest/executions/delete', {
      filters: { archived: true },
      deleteBefore: LATER,
    });
    expect(res.json().data).toEqual({ deleted: 1 });
    expect(await exists(t, gone)).toBe(false);
    expect(await exists(t, stays)).toBe(true);
  });

  it('another workspace is untouched, and its ids answer not found', async () => {
    const s = await setup();
    const other = await signup(server.app);
    const otherWf = await workflowIn(server, other.tenant.id, other.client.defaultProjectId!);
    const foreign = await seed(other.tenant.id, otherWf.id, { status: 'success' });
    const byId = await s.owner.client.post('/rest/executions/delete', { ids: [foreign] });
    expect(byId.statusCode).toBe(404);
    const byFilter = await s.owner.client.post('/rest/executions/delete', {
      filters: { mode: 'manual' },
      deleteBefore: LATER,
    });
    expect(byFilter.json().data).toEqual({ deleted: 0 });
    expect(await exists(other.tenant.id, foreign)).toBe(true);
  });

  it('needs a signed-in user', async () => {
    const anon = new TestClient(server.app);
    expect((await anon.post('/rest/executions/delete', { ids: [randomUUID()] })).statusCode).toBe(401);
  });
});
