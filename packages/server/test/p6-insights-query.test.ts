/**
 * P6-05 (L11) insights reads: GET /rest/insights/{summary,by-workflow,by-time,by-time/time-saved,settings}
 * and public GET /api/v1/insights/summary. The tables are filled through the repository with known buckets,
 * so every number is exact. The collection from real runs is p6-insights-collect.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import { insightsByWorkflow, resolveInsightsRange } from '../src/services/insights/query';
import {
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  teamProjectOf,
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

type Owner = Awaited<ReturnType<typeof signup>>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

interface Bucket {
  at: number;
  /** 0 hour, 1 day, 2 week */
  unit?: 0 | 1 | 2;
  success?: number;
  failure?: number;
  runtime?: number;
  saved?: number;
}

/** a workflow with the buckets the insights hold for it */
async function seeded(owner: Owner, name: string, buckets: Bucket[], projectId?: string) {
  const project = projectId ?? (await teamProjectOf(server, owner.tenant.id));
  const workflow = await workflowIn(server, owner.tenant.id, project, { name });
  const projectRow = await server.ctx.repos.projects.get(owner.tenant.id, project);
  const meta = await server.ctx.repos.insights.upsertMetadata([
    {
      tenantId: owner.tenant.id,
      workflowId: workflow.id,
      workflowName: name,
      projectId: project,
      projectName: projectRow?.name ?? null,
    },
  ]);
  const metaId = meta.get(workflow.id) as number;
  const rows = buckets.flatMap((b) =>
    (
      [
        [2, b.success],
        [3, b.failure],
        [1, b.runtime],
        [0, b.saved],
      ] as const
    )
      .filter(([, value]) => value !== undefined)
      .map(([type, value]) => ({
        tenantId: owner.tenant.id,
        metaId,
        type,
        periodUnit: b.unit ?? 0,
        periodStart: new Date(b.at),
        value: value as number,
      })),
  );
  await server.ctx.repos.insights.addPeriods(rows);
  return { id: workflow.id, projectId: project, metaId };
}

const get = <T = any>(client: TestClient, path: string) =>
  client.data<T>(client.get(`/rest/insights${path}`));

describe('summary', () => {
  it('sums the range and compares it with the same length before', async () => {
    const owner = await signup(server.app);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 2 * DAY);
    const r = resolveInsightsRange({ startDate, endDate });
    await seeded(owner, 'Flow', [
      { at: r.start.getTime() + 3 * HOUR, success: 8, failure: 2, runtime: 1000, saved: 20 },
      { at: r.start.getTime() - 3 * HOUR, success: 4, failure: 0, runtime: 400, saved: 5 },
    ]);
    const s = await get(
      owner.client,
      `/summary?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
    );
    expect(s).toEqual({
      total: { value: 10, unit: 'count', deviation: 6 },
      failed: { value: 2, unit: 'count', deviation: 2 },
      failureRate: { value: 0.2, unit: 'ratio', deviation: 0.2 },
      timeSaved: { value: 20, unit: 'minute', deviation: 15 },
      averageRunTime: { value: 100, unit: 'millisecond', deviation: 0 },
    });
  });

  it('has a null deviation when the period before had no runs, and zeros when empty', async () => {
    const owner = await signup(server.app);
    const empty = await get(owner.client, '/summary');
    for (const metric of Object.values<any>(empty))
      expect(metric).toMatchObject({ value: 0, deviation: null });
    await seeded(owner, 'Flow', [{ at: hourOf(Date.now() - HOUR), success: 3, failure: 1, runtime: 40 }]);
    const s = await get(owner.client, '/summary');
    expect(s.total).toEqual({ value: 4, unit: 'count', deviation: null });
    expect(s.failureRate.value).toBe(0.25);
    expect(s.averageRunTime.value).toBe(10);
  });

  it('answers every range, hourly data included, with the granularity of the range', async () => {
    const owner = await signup(server.app);
    const seen = hourOf(Date.now() - HOUR);
    await seeded(owner, 'Flow', [{ at: seen, success: 1, runtime: 5 }]);
    const ranges: Array<[string, number, 'hour' | 'day' | 'week']> = [
      ['day', 1, 'hour'],
      ['week', 7, 'day'],
      ['2weeks', 14, 'day'],
      ['month', 30, 'day'],
      ['quarter', 90, 'week'],
      ['6months', 180, 'week'],
      ['year', 365, 'week'],
    ];
    const settings = await get(owner.client, '/settings');
    expect(settings.dateRanges.map((r: any) => [r.key, r.licensed, r.granularity])).toEqual(
      ranges.map(([key, , granularity]) => [key, true, granularity]),
    );
    for (const [key, days, granularity] of ranges) {
      const query = `?startDate=${new Date(Date.now() - days * DAY).toISOString()}&endDate=${new Date().toISOString()}`;
      expect((await get(owner.client, `/summary${query}`)).total.value, key).toBe(1);
      const [bucket, ...rest] = await get<Array<{ date: string; values: Record<string, number> }>>(
        owner.client,
        `/by-time${query}`,
      );
      expect(rest, key).toEqual([]);
      const date = new Date(bucket.date);
      if (granularity === 'hour') expect(date.getTime(), key).toBe(seen);
      else if (granularity === 'day') expect(date.getTime(), key).toBe(Math.floor(seen / DAY) * DAY);
      else {
        expect(date.getUTCDay(), key).toBe(1);
        expect(date.getTime() % DAY, key).toBe(0);
      }
    }
  });

  it('reads only the workspace and narrows to a project', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const other = await projectIn(server, a.tenant.id, `Other ${randomUUID().slice(0, 6)}`);
    const at = hourOf(Date.now() - HOUR);
    const first = await seeded(a, 'In team', [{ at, success: 2, runtime: 10 }]);
    await seeded(a, 'In other', [{ at, success: 5, failure: 1, runtime: 60 }], other.id);
    await seeded(b, 'Foreign', [{ at, success: 100, runtime: 100 }]);

    expect((await get(a.client, '/summary')).total.value).toBe(8);
    expect((await get(a.client, `/summary?projectId=${first.projectId}`)).total.value).toBe(2);
    expect((await get(a.client, `/summary?projectId=${other.id}`)).total.value).toBe(6);
    const page = await get(a.client, `/by-workflow?projectId=${other.id}`);
    expect(page.count).toBe(1);
    expect(page.data[0]).toMatchObject({
      workflowName: 'In other',
      projectId: other.id,
      projectName: other.name,
    });
    expect((await get(b.client, '/summary')).total.value).toBe(100);

    // an unknown project, one of another workspace and one that is no id are all 404
    for (const projectId of [randomUUID(), first.projectId, 'nope']) {
      for (const path of ['/summary', '/by-workflow', '/by-time', '/by-time/time-saved']) {
        const res = await b.client.get(`/rest/insights${path}?projectId=${projectId}`);
        expect(res.statusCode, `${path} ${projectId}`).toBe(404);
      }
    }
  });
});

describe('by workflow', () => {
  async function three(owner: Owner) {
    const at = hourOf(Date.now() - HOUR);
    const alpha = await seeded(owner, 'alpha', [{ at, success: 6, failure: 2, runtime: 800, saved: 10 }]);
    const beta = await seeded(owner, 'beta', [{ at, success: 1, failure: 3, runtime: 400, saved: 40 }]);
    const gamma = await seeded(owner, 'gamma', [{ at, success: 10, runtime: 100 }]);
    return { alpha, beta, gamma };
  }
  const names = async (owner: Owner, query: string) =>
    (await get(owner.client, `/by-workflow?${query}`)).data.map((r: any) => r.workflowName);

  it('answers the rows with the numbers of each workflow, the default order is total descending', async () => {
    const owner = await signup(server.app);
    const { alpha } = await three(owner);
    const page = await get(owner.client, '/by-workflow');
    expect(page.count).toBe(3);
    expect(page.data.map((r: any) => r.workflowName)).toEqual(['gamma', 'alpha', 'beta']);
    expect(page.data.find((r: any) => r.workflowName === 'alpha')).toEqual({
      workflowId: alpha.id,
      workflowName: 'alpha',
      hasReadAccess: true,
      projectId: alpha.projectId,
      projectName: expect.any(String),
      total: 8,
      succeeded: 6,
      failed: 2,
      failureRate: 0.25,
      runTime: 800,
      averageRunTime: 100,
      timeSaved: 10,
    });
  });

  it('sorts by each key in both directions', async () => {
    const owner = await signup(server.app);
    await three(owner);
    const order: Record<string, string[]> = {
      total: ['gamma', 'alpha', 'beta'],
      succeeded: ['gamma', 'alpha', 'beta'],
      failed: ['beta', 'alpha', 'gamma'],
      failureRate: ['beta', 'alpha', 'gamma'],
      timeSaved: ['beta', 'alpha', 'gamma'],
      runTime: ['alpha', 'beta', 'gamma'],
      // alpha and beta tie on 100 ms: the name breaks it
      averageRunTime: ['alpha', 'beta', 'gamma'],
      workflowName: ['gamma', 'beta', 'alpha'],
    };
    for (const [key, desc] of Object.entries(order)) {
      expect(await names(owner, `sortBy=${key}:desc`), `${key}:desc`).toEqual(desc);
      const asc = key === 'averageRunTime' ? ['gamma', 'alpha', 'beta'] : [...desc].reverse();
      expect(await names(owner, `sortBy=${key}:asc`), `${key}:asc`).toEqual(asc);
    }
  });

  it('pages with skip and take, at most 100', async () => {
    const owner = await signup(server.app);
    await three(owner);
    const page = await get(owner.client, '/by-workflow?sortBy=workflowName:asc&skip=1&take=1');
    expect(page.count).toBe(3);
    expect(page.data.map((r: any) => r.workflowName)).toEqual(['beta']);
    expect(await names(owner, 'sortBy=workflowName:asc&skip=5')).toEqual([]);
    expect((await get(owner.client, '/by-workflow?take=100')).data).toHaveLength(3);
    for (const bad of [
      'take=101',
      'take=0',
      'skip=-1',
      'sortBy=nope:asc',
      'sortBy=total:up',
      'sortBy=total',
    ]) {
      expect((await owner.client.get(`/rest/insights/by-workflow?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('keeps the name of a deleted workflow and shows no access to it', async () => {
    const owner = await signup(server.app);
    const { gamma } = await three(owner);
    await server.ctx.database.pool.query('delete from workflows where id = $1', [gamma.id]);
    const page = await get(owner.client, '/by-workflow?sortBy=workflowName:desc');
    expect(page.count).toBe(3);
    expect(page.data[0]).toMatchObject({
      workflowId: null,
      workflowName: 'gamma',
      hasReadAccess: false,
      total: 10,
    });
  });

  it('marks the workflows the caller cannot read through the list filter', async () => {
    const owner = await signup(server.app);
    const { alpha, beta, gamma } = await three(owner);
    const rows = async (filter: Parameters<typeof insightsByWorkflow>[3]) =>
      Object.fromEntries(
        (
          await insightsByWorkflow(
            server.ctx.serviceDeps,
            owner.tenant.id,
            { sortBy: 'workflowName:asc' },
            filter,
          )
        ).data.map((r) => [r.workflowName, r.hasReadAccess]),
      );
    expect(await rows({ all: true })).toEqual({ alpha: true, beta: true, gamma: true });
    expect(await rows({ all: false, projectIds: [], workflowIds: [beta.id], credentialIds: [] })).toEqual({
      alpha: false,
      beta: true,
      gamma: false,
    });
    expect(
      await rows({ all: false, projectIds: [alpha.projectId], workflowIds: [], credentialIds: [] }),
    ).toEqual({ alpha: true, beta: true, gamma: true });
    expect(gamma.projectId).toBe(alpha.projectId);
  });
});

describe('by time', () => {
  it('buckets by day with the values of each bucket', async () => {
    const owner = await signup(server.app);
    const day = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
    await seeded(owner, 'Flow', [
      { at: day + 2 * HOUR, success: 3, failure: 1, runtime: 400, saved: 8 },
      { at: day + 9 * HOUR, success: 1, runtime: 100, saved: 2 },
      { at: day + DAY + 5 * HOUR, failure: 2, runtime: 20 },
    ]);
    const query = `?startDate=${new Date(day).toISOString()}&endDate=${new Date(day + 2 * DAY).toISOString()}`;
    const rows = await get(owner.client, `/by-time${query}`);
    expect(rows).toEqual([
      {
        date: new Date(day).toISOString(),
        values: { total: 5, succeeded: 4, failed: 1, failureRate: 0.2, averageRunTime: 100, timeSaved: 10 },
      },
      {
        date: new Date(day + DAY).toISOString(),
        values: { total: 2, succeeded: 0, failed: 2, failureRate: 1, averageRunTime: 10, timeSaved: 0 },
      },
    ]);
    expect(await get(owner.client, `/by-time/time-saved${query}`)).toEqual([
      { date: new Date(day).toISOString(), values: { timeSaved: 10 } },
      { date: new Date(day + DAY).toISOString(), values: { timeSaved: 0 } },
    ]);
  });

  it('puts a run in the day of the caller time zone (Asia/Tokyo)', async () => {
    const owner = await signup(server.app);
    const day = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
    // 20:00 UTC is 05:00 the next morning in Tokyo
    await seeded(owner, 'Flow', [{ at: day + 20 * HOUR, success: 1, runtime: 5 }]);
    const range = `startDate=${new Date(day - DAY).toISOString()}&endDate=${new Date(day + 2 * DAY).toISOString()}`;
    const utc = await get(owner.client, `/by-time?${range}`);
    expect(utc.map((r: any) => r.date)).toEqual([new Date(day).toISOString()]);
    const tokyo = await get(owner.client, `/by-time?${range}&timeZone=Asia/Tokyo`);
    // midnight of the next day in Tokyo is 15:00 UTC of the day before it
    expect(tokyo.map((r: any) => r.date)).toEqual([new Date(day + 15 * HOUR).toISOString()]);
    expect(tokyo[0].values.total).toBe(1);
  });

  it('reads whole days of the zone for a past end date', async () => {
    const owner = await signup(server.app);
    const day = Math.floor(Date.now() / DAY) * DAY - 5 * DAY;
    await seeded(owner, 'Flow', [
      { at: day + 23 * HOUR, success: 1, runtime: 5 },
      { at: day + DAY + HOUR, success: 4, runtime: 5 },
    ]);
    // the end date is in the middle of a past day: the whole day counts, the next one does not
    const summary = await get(
      owner.client,
      `/summary?startDate=${new Date(day).toISOString()}&endDate=${new Date(day + 12 * HOUR).toISOString()}`,
    );
    expect(summary.total.value).toBe(1);
  });
});

describe('checks', () => {
  it('refuses a bad time zone, a bad date and an end before the start with 400', async () => {
    const owner = await signup(server.app);
    for (const path of ['/summary', '/by-workflow', '/by-time', '/by-time/time-saved']) {
      const zone = await owner.client.get(`/rest/insights${path}?timeZone=Mars/Base`);
      expect(zone.statusCode, path).toBe(400);
      expect((await owner.client.get(`/rest/insights${path}?timeZone=%2B05:00`)).statusCode, path).toBe(400);
      expect((await owner.client.get(`/rest/insights${path}?startDate=yesterday-ish`)).statusCode, path).toBe(
        400,
      );
      const order = await owner.client.get(
        `/rest/insights${path}?startDate=2026-03-05T00:00:00Z&endDate=2026-03-04T00:00:00Z`,
      );
      expect(order.statusCode, path).toBe(400);
      expect(order.json().error.message).toBe('endDate must be the same as or after startDate');
    }
    // the same day is allowed
    const same = await owner.client.get(
      '/rest/insights/summary?startDate=2026-03-04T00:00:00Z&endDate=2026-03-04T00:00:00Z',
    );
    expect(same.statusCode).toBe(200);
  });

  it('reports the settings, the first day with data once there is one', async () => {
    const owner = await signup(server.app);
    expect(await get(owner.client, '/settings')).toMatchObject({
      summary: true,
      dashboard: true,
      earliestDataDate: null,
    });
    const at = hourOf(Date.now() - 3 * DAY);
    await seeded(owner, 'Flow', [{ at, success: 1, runtime: 1 }]);
    expect((await get(owner.client, '/settings')).earliestDataDate).toBe(new Date(at).toISOString());
  });

  it('is for insights:list: a member gets 403 on every route, a signed-out caller 401', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    for (const path of ['/summary', '/by-workflow', '/by-time', '/by-time/time-saved', '/settings']) {
      const res = await member.client.get(`/rest/insights${path}`);
      expect(res.statusCode, path).toBe(403);
      expect(res.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
      expect(
        (await server.app.inject({ method: 'GET', url: `/rest/insights${path}` })).statusCode,
        path,
      ).toBe(401);
    }
  });
});

describe('public API', () => {
  let keyCount = 0;
  const keyOf = async (client: TestClient, scopes?: string[]) => {
    keyCount += 1;
    const made = await client.data(
      client.post('/rest/api-keys', {
        name: `insights-${keyCount}-${randomUUID().slice(0, 6)}`,
        ...(scopes ? { scopes } : {}),
      }),
    );
    return made.key as string;
  };
  const api = (key: string, query = '') =>
    server.app.inject({
      method: 'GET',
      url: `/api/v1/insights/summary${query}`,
      headers: { 'x-api-key': key },
    });

  it('answers the same summary as the route, for a key with insights:read', async () => {
    const owner = await signup(server.app);
    const other = await projectIn(server, owner.tenant.id, `Other ${randomUUID().slice(0, 6)}`);
    const at = hourOf(Date.now() - HOUR);
    await seeded(owner, 'Flow', [{ at, success: 3, failure: 1, runtime: 40, saved: 7 }]);
    await seeded(owner, 'Elsewhere', [{ at, success: 5, runtime: 5 }], other.id);
    const key = await keyOf(owner.client);
    const res = await api(key);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(await get(owner.client, '/summary'));
    expect(res.json().data.total.value).toBe(9);
    const narrowed = await api(key, `?projectId=${other.id}&startDate=${new Date(at - DAY).toISOString()}`);
    expect(narrowed.json().data.total.value).toBe(5);
    expect((await api(key, `?projectId=${randomUUID()}`)).statusCode).toBe(404);
    expect((await api(key, '?startDate=junk')).statusCode).toBe(400);
  });

  it('refuses a key without insights:read, a member key and no key', async () => {
    const owner = await signup(server.app);
    const narrow = await keyOf(owner.client, ['workflow:list']);
    expect((await api(narrow)).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/insights/summary' })).statusCode).toBe(
      401,
    );
    const member = await realMember(owner);
    const memberKey = await keyOf(member.client);
    const res = await api(memberKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
  });
});
