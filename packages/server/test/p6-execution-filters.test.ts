/**
 * P6-85 (L17): GET /rest/executions narrows by `startedAfter`, `startedBefore`, `mode`, `archived`, and (from S1
 * and P5-61) `projectId` and custom data (key, value, exact or part). Each filter answers only the runs it names,
 * inside the caller's access, and another workspace's runs never show.
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
  type TestClient,
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
  fields: {
    mode?: string;
    status?: string;
    startedAt?: Date | null;
    customData?: Record<string, string>;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    {
      id,
      workflowId,
      workflowName: 'Run',
      mode: fields.mode ?? 'manual',
      status: fields.status ?? 'success',
      startedAt: fields.startedAt === undefined ? new Date() : fields.startedAt,
      customData: fields.customData ?? {},
    },
    { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
  );
  return id;
}

async function ids(client: TestClient, query: string): Promise<string[]> {
  const res = await client.get(`/rest/executions?${query}`);
  expect(res.statusCode).toBe(200);
  return (res.json().data as Array<{ id: string }>).map((e) => e.id).sort();
}

const at = (iso: string) => new Date(iso);

describe('execution list filters (P6-85)', () => {
  it('startedAfter and startedBefore bound the start time, both ends included', async () => {
    const a = await signup(server.app);
    const wf = await workflowIn(server, a.tenant.id, a.client.defaultProjectId!);
    const old = await seed(a.tenant.id, wf.id, { startedAt: at('2026-01-01T00:00:00Z') });
    const mid = await seed(a.tenant.id, wf.id, { startedAt: at('2026-02-01T00:00:00Z') });
    const late = await seed(a.tenant.id, wf.id, { startedAt: at('2026-03-01T00:00:00Z') });
    const never = await seed(a.tenant.id, wf.id, { status: 'new', startedAt: null });

    expect(await ids(a.client, 'startedAfter=2026-02-01T00:00:00Z')).toEqual([mid, late].sort());
    expect(await ids(a.client, 'startedBefore=2026-02-01T00:00:00Z')).toEqual([old, mid].sort());
    expect(
      await ids(a.client, 'startedAfter=2026-01-15T00:00:00Z&startedBefore=2026-02-15T00:00:00Z'),
    ).toEqual([mid]);
    // a day alone
    expect(await ids(a.client, 'startedAfter=2026-03-01')).toEqual([late]);
    // no filter lists the run that has not started too
    expect(await ids(a.client, '')).toEqual([old, mid, late, never].sort());
  });

  it('refuses a date that is not a date', async () => {
    const a = await signup(server.app);
    const res = await a.client.get('/rest/executions?startedAfter=yesterday');
    expect(res.statusCode).toBe(400);
  });

  it('mode narrows to one run mode and refuses an unknown one', async () => {
    const a = await signup(server.app);
    const wf = await workflowIn(server, a.tenant.id, a.client.defaultProjectId!);
    const manual = await seed(a.tenant.id, wf.id, { mode: 'manual' });
    const webhook = await seed(a.tenant.id, wf.id, { mode: 'webhook' });
    const trigger = await seed(a.tenant.id, wf.id, { mode: 'trigger' });
    expect(await ids(a.client, 'mode=webhook')).toEqual([webhook]);
    expect(await ids(a.client, 'mode=manual')).toEqual([manual]);
    expect(await ids(a.client, 'mode=trigger&status=success')).toEqual([trigger]);
    expect((await a.client.get('/rest/executions?mode=nope')).statusCode).toBe(400);
  });

  it('archived keeps the runs of archived workflows, or of the others', async () => {
    const a = await signup(server.app);
    const project = a.client.defaultProjectId!;
    const live = await workflowIn(server, a.tenant.id, project);
    const gone = await workflowIn(server, a.tenant.id, project);
    await server.ctx.repos.workflows.setArchived(a.tenant.id, gone.id, true);
    const ofLive = await seed(a.tenant.id, live.id);
    const ofGone = await seed(a.tenant.id, gone.id);
    expect(await ids(a.client, 'archived=true')).toEqual([ofGone]);
    expect(await ids(a.client, 'archived=false')).toEqual([ofLive]);
    expect(await ids(a.client, '')).toEqual([ofLive, ofGone].sort());
  });

  it('projectId keeps one project, and a member sees only the projects they belong to', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
    const beta = await projectIn(server, owner.tenant.id, 'Beta');
    await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:viewer');
    const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id);
    const inBeta = await workflowIn(server, owner.tenant.id, beta.id);
    const runA = await seed(owner.tenant.id, inAlpha.id);
    const runB = await seed(owner.tenant.id, inBeta.id);
    expect(await ids(owner.client, `projectId=${alpha.id}`)).toEqual([runA]);
    expect(await ids(owner.client, `projectId=${beta.id}`)).toEqual([runB]);
    expect(await ids(member.client, '')).toEqual([runA]);
    // a project the member holds nothing in answers an empty list
    expect(await ids(member.client, `projectId=${beta.id}`)).toEqual([]);
  });

  it('custom data matches exactly, or by part, and the filters combine', async () => {
    const a = await signup(server.app);
    const wf = await workflowIn(server, a.tenant.id, a.client.defaultProjectId!);
    const one = await seed(a.tenant.id, wf.id, { customData: { orderId: '1042' }, mode: 'webhook' });
    const two = await seed(a.tenant.id, wf.id, { customData: { orderId: '1042-b' }, mode: 'manual' });
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=1042')).toEqual([one, two].sort());
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=1042&customDataExact=true')).toEqual([
      one,
    ]);
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=1042&mode=manual')).toEqual([two]);
  });

  it('another workspace is never listed', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const wfA = await workflowIn(server, a.tenant.id, a.client.defaultProjectId!);
    const wfB = await workflowIn(server, b.tenant.id, b.client.defaultProjectId!);
    const mine = await seed(a.tenant.id, wfA.id, { mode: 'webhook' });
    await seed(b.tenant.id, wfB.id, { mode: 'webhook' });
    expect(await ids(a.client, 'mode=webhook&startedAfter=2020-01-01')).toEqual([mine]);
  });
});
