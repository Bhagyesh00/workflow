/**
 * P3-18 version history compaction on the server: per tenant, per workflow; redundant versions go,
 * the current, published, named, described and review-pinned versions stay; hourly optimize and
 * daily trim run on timers that stop with the service.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowReviewRequests, workflowVersions } from '../src/db/schema';
import { HistoryCompactionService } from '../src/services/history-compaction';
import { createTestServer, createWorkflow, resetDatabase, signup, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ WORKFLOW_HISTORY_COMPACTION_BATCH_DELAY_MS: '0' }, { startMain: false });
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

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const trigger: WorkflowNode = {
  id: 't',
  name: 'Trigger',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const set = (value: string): WorkflowNode => ({
  id: 's',
  name: 'Set',
  type: 'core.noOp',
  typeVersion: 1,
  position: [200, 0],
  parameters: { value },
});

async function workflowOf(owner: Awaited<ReturnType<typeof signup>>) {
  return createWorkflow(owner.client, { nodes: [trigger] });
}

async function addVersion(
  tenantId: string,
  workflowId: string,
  createdAt: Date,
  partial: {
    nodes?: WorkflowNode[];
    authorId?: string | null;
    versionName?: string | null;
    description?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await server.ctx.database.db.insert(workflowVersions).values({
    id,
    tenantId,
    workflowId,
    name: 'Test workflow',
    nodes: partial.nodes ?? [trigger],
    connections: {},
    settings: {},
    authorId: partial.authorId ?? null,
    versionName: partial.versionName ?? null,
    description: partial.description ?? null,
    autosaved: true,
    createdAt,
  });
  return id;
}

async function versionIds(workflowId: string): Promise<string[]> {
  const { rows } = await server.ctx.database.pool.query(
    'SELECT id FROM workflow_versions WHERE workflow_id = $1 ORDER BY created_at, id',
    [workflowId],
  );
  return rows.map((r) => r.id);
}

const setPointer = (column: 'version_id' | 'published_version_id', workflowId: string, versionId: string) =>
  server.ctx.database.pool.query(`UPDATE workflows SET ${column} = $1 WHERE id = $2`, [
    versionId,
    workflowId,
  ]);

describe('P3-18 history compaction (optimize)', () => {
  it('removes redundant versions in every tenant; published, described, named and other-author ones stay', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const wfA = await workflowOf(a);
    const wfB = await workflowOf(b);
    const u = a.user.id;

    // tenant A: v1 -> v2 only adds (2 min): v1 goes; v2 published; v3 described; v4 followed by b's user
    const v1 = await addVersion(a.tenant.id, wfA.id, ago(60 * MIN), { authorId: u, nodes: [trigger] });
    const v2 = await addVersion(a.tenant.id, wfA.id, ago(58 * MIN), {
      authorId: u,
      nodes: [trigger, set('a')],
    });
    const v3 = await addVersion(a.tenant.id, wfA.id, ago(56 * MIN), {
      authorId: u,
      nodes: [trigger, set('ab')],
      description: 'before the API change',
    });
    const v4 = await addVersion(a.tenant.id, wfA.id, ago(54 * MIN), {
      authorId: u,
      nodes: [trigger, set('abc')],
    });
    const v5 = await addVersion(a.tenant.id, wfA.id, ago(52 * MIN), {
      authorId: b.user.id,
      nodes: [trigger, set('abcd')],
    });
    await setPointer('published_version_id', wfA.id, v2);

    // tenant B: w1 named, w2 -> w3 only adds: w2 goes
    const w1 = await addVersion(b.tenant.id, wfB.id, ago(60 * MIN), { versionName: 'Keep me' });
    const w2 = await addVersion(b.tenant.id, wfB.id, ago(58 * MIN), { nodes: [trigger, set('x')] });
    const w3 = await addVersion(b.tenant.id, wfB.id, ago(57 * MIN), { nodes: [trigger, set('xy')] });

    // a timeline row of the removed version keeps its event, without the version
    await server.ctx.publishHistory.record('activated', {
      tenantId: a.tenant.id,
      workflowId: wfA.id,
      versionId: v1,
      userId: u,
    });

    expect(await server.ctx.historyCompaction.runOnce('optimize', NOW)).toBe(2);
    expect(await versionIds(wfA.id)).toEqual([v2, v3, v4, v5, wfA.versionId]);
    expect(await versionIds(wfB.id)).toEqual([w1, w3, wfB.versionId]);
    expect(await versionIds(wfB.id)).not.toContain(w2);
    const timeline = await server.ctx.publishHistory.list(a.tenant.id, wfA.id, { skip: 0, take: 20 });
    expect(timeline.data).toMatchObject([{ event: 'activated', versionId: null }]);

    // a second pass finds nothing more
    expect(await server.ctx.historyCompaction.runOnce('optimize', NOW)).toBe(0);
  });

  it('never removes the current version or one pinned by an open review', async () => {
    const owner = await signup(server.app);
    const wf = await workflowOf(owner);
    const current = await addVersion(owner.tenant.id, wf.id, ago(60 * MIN));
    await addVersion(owner.tenant.id, wf.id, ago(59 * MIN), { nodes: [trigger, set('a')] });
    await setPointer('version_id', wf.id, current);

    // 29 min after the previous version (no merge across that gap); its successor only adds
    const pinned = await addVersion(owner.tenant.id, wf.id, ago(30 * MIN), { nodes: [trigger, set('ab')] });
    await addVersion(owner.tenant.id, wf.id, ago(29 * MIN), { nodes: [trigger, set('abc')] });
    await server.ctx.database.db.insert(workflowReviewRequests).values({
      tenantId: owner.tenant.id,
      workflowId: wf.id,
      workflowVersionId: pinned,
      title: 'Review the change',
    });
    const before = await versionIds(wf.id);

    expect(await server.ctx.historyCompaction.runOnce('optimize', NOW)).toBe(0);
    expect(await versionIds(wf.id)).toEqual(before);
  });

  it('waits for a publish that holds the workflow row and keeps the version it published', async () => {
    const owner = await signup(server.app);
    const wf = await workflowOf(owner);
    // v1 -> v2 only adds (2 min): v1 is redundant until a publish points at it
    const v1 = await addVersion(owner.tenant.id, wf.id, ago(60 * MIN));
    await addVersion(owner.tenant.id, wf.id, ago(58 * MIN), { nodes: [trigger, set('a')] });

    // a publish of v1 that has written its pointer but not committed yet
    const publish = await server.ctx.database.pool.connect();
    let pass: Promise<number> | undefined;
    try {
      await publish.query('BEGIN');
      await publish.query('UPDATE workflows SET published_version_id = $1 WHERE id = $2', [v1, wf.id]);
      let settled = false;
      pass = server.ctx.historyCompaction.runOnce('optimize', NOW).finally(() => {
        settled = true;
      });
      // the pass either ends (it did not wait) or blocks on the workflow row lock
      for (let i = 0; i < 250 && !settled; i++) {
        const { rows } = await server.ctx.database.pool.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0].waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await publish.query('COMMIT');
    } finally {
      publish.release();
    }

    expect(await pass).toBe(0);
    expect(await versionIds(wf.id)).toContain(v1);
  });

  it('leaves versions younger than 15 minutes and older than 2.25 hours alone', async () => {
    const owner = await signup(server.app);
    const wf = await workflowOf(owner);
    await addVersion(owner.tenant.id, wf.id, ago(3 * 60 * MIN));
    await addVersion(owner.tenant.id, wf.id, ago(3 * 60 * MIN - MIN), { nodes: [trigger, set('a')] });
    await addVersion(owner.tenant.id, wf.id, ago(10 * MIN), { nodes: [trigger, set('ab')] });
    await addVersion(owner.tenant.id, wf.id, ago(9 * MIN), { nodes: [trigger, set('abc')] });
    expect(await server.ctx.historyCompaction.runOnce('optimize', NOW)).toBe(0);
    expect(await versionIds(wf.id)).toHaveLength(5);
  });
});

describe('P3-18 history compaction (trim)', () => {
  it('keeps one version per minute in versions 6 to 8 days old, and every named one', async () => {
    const owner = await signup(server.app);
    const wf = await workflowOf(owner);
    const minute = Math.floor(ago(7 * DAY).getTime() / MIN) * MIN;
    const at = (s: number) => new Date(minute + s * 1000);
    const first = await addVersion(owner.tenant.id, wf.id, at(5));
    const named = await addVersion(owner.tenant.id, wf.id, at(10), { versionName: 'Named' });
    const second = await addVersion(owner.tenant.id, wf.id, at(20), { nodes: [] });
    const last = await addVersion(owner.tenant.id, wf.id, at(50));
    const next = await addVersion(owner.tenant.id, wf.id, at(65));
    const old = await addVersion(owner.tenant.id, wf.id, ago(9 * DAY));
    const older = await addVersion(owner.tenant.id, wf.id, ago(9 * DAY + 1000));

    expect(await server.ctx.historyCompaction.runOnce('trim', NOW)).toBe(2);
    const left = await versionIds(wf.id);
    expect(left).not.toContain(first);
    expect(left).not.toContain(second);
    expect(left).toEqual([older, old, named, last, next, wf.versionId]);
  });
});

describe('P3-18 history compaction (schedule)', () => {
  it('optimize runs hourly and trim daily until stop()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { config, database, repos, logger } = server.ctx;
    const service = new HistoryCompactionService({
      config,
      database,
      repos,
      logger,
      context: () => server.ctx,
    });
    const run = vi.spyOn(service, 'runOnce').mockResolvedValue(0);

    service.start();
    service.start(); // a second start does not double the timers
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(run.mock.calls).toEqual([['optimize']]);
    await vi.advanceTimersByTimeAsync(DAY - 60 * MIN);
    expect(run.mock.calls.filter(([mode]) => mode === 'optimize')).toHaveLength(24);
    expect(run.mock.calls.filter(([mode]) => mode === 'trim')).toHaveLength(1);

    service.stop();
    run.mockClear();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(run).not.toHaveBeenCalled();
  });

  it('a failed pass is logged and the next one still runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { config, database, repos, logger } = server.ctx;
    const service = new HistoryCompactionService({
      config,
      database,
      repos,
      logger,
      context: () => server.ctx,
    });
    const warn = vi.spyOn(logger, 'warn');
    const run = vi.spyOn(service, 'runOnce').mockRejectedValueOnce(new Error('db down')).mockResolvedValue(0);
    service.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'optimize' }),
      'History compaction failed',
    );
    service.stop();
  });
});
