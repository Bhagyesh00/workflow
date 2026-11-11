/**
 * P6-78 (L11): `execute` and `execute-batch`. A run goes through `executions.start` in this process with mode
 * `cli` (never `WorkflowService.run`), so it is no manual run and works on a protected workspace, and the
 * `workflowStart` policy still judges it. The context has no listener (as cli.ts builds it): `startMain` is off.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandIo } from '../src/commands/command-io';
import { executeCommand } from '../src/commands/execute';
import { executeBatchCommand } from '../src/commands/execute-batch';
import {
  chain,
  createTestServer,
  flushRedis,
  node,
  policyDeny,
  protectWorkspace,
  setNode,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;
beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server?.close();
});

let ipCounter = 0;
const nextIp = () => `10.80.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface FakeIo {
  io: CommandIo;
  stdout: () => string;
  stderr: () => string;
  files: Map<string, string>;
}

function fakeIo(files: Record<string, string> = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const store = new Map(Object.entries(files));
  return {
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      readFile: async (file) => {
        const data = store.get(file);
        if (data === undefined) throw new Error(`No such file: ${file}`);
        return data;
      },
      writeFile: async (file, data) => {
        store.set(file, data);
      },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    files: store,
  };
}

async function workspace() {
  const s = await signup(server.app, { remoteAddress: nextIp(), projects: 'real' });
  const personal = await server.ctx.repos.projects.getPersonal(s.tenant.id, s.user.id);
  return { ...s, slug: s.tenant.slug, tenantId: s.tenant.id, personalId: personal!.id };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

/** a workflow that ends with one item `{ <field>: <value> }` */
const okWorkflow = (a: Workspace, name: string, value = 'hello') =>
  workflowIn(server, a.tenantId, a.personalId, {
    name,
    nodes: [node('Start', 'core.manualTrigger'), setNode('Make', 'greeting', value)],
    connections: chain('Start', 'Make'),
  });

/** a workflow whose last node raises an error */
const failingWorkflow = (a: Workspace, name: string) =>
  workflowIn(server, a.tenantId, a.personalId, {
    name,
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Boom', 'core.stopAndError', { errorMessage: 'stopped on purpose' }, [200, 0]),
    ],
    connections: chain('Start', 'Boom'),
  });

const executionsOf = async (tenantId: string, workflowId: string) =>
  (
    await server.ctx.database.pool.query(
      'select id, mode, status from executions where tenant_id = $1 and workflow_id = $2 order by started_at',
      [tenantId, workflowId],
    )
  ).rows as Array<{ id: string; mode: string; status: string }>;

describe('P6-78 execute', () => {
  it('runs the workflow in mode cli through the execution service and prints its result', async () => {
    const a = await workspace();
    const wf = await okWorkflow(a, 'Greeter', `hi-${randomUUID().slice(0, 6)}`);
    const run = vi.spyOn(server.ctx.workflows, 'run');
    const start = vi.spyOn(server.ctx.executions, 'start');
    const f = fakeIo();
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], f.io)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({ mode: 'cli', tenantId: a.tenantId, workflowId: wf.id });
    run.mockRestore();
    start.mockRestore();
    const [row] = await executionsOf(a.tenantId, wf.id);
    expect(row).toMatchObject({ mode: 'cli', status: 'success' });
    const result = JSON.parse(f.stdout());
    expect(result).toMatchObject({ executionId: row.id, status: 'success', lastNodeExecuted: 'Make' });
    expect(result.data).toEqual([expect.objectContaining({ greeting: expect.stringMatching(/^hi-/) })]);
  });

  it('prints only the output items with --rawOutput', async () => {
    const a = await workspace();
    const wf = await okWorkflow(a, 'Raw', 'plain-value');
    const f = fakeIo();
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id, '--rawOutput'], f.io)).toBe(
      0,
    );
    expect(JSON.parse(f.stdout())).toEqual([expect.objectContaining({ greeting: 'plain-value' })]);
  });

  it('runs on a protected workspace: it is no manual run', async () => {
    const a = await workspace();
    const wf = await okWorkflow(a, 'Protected run');
    await protectWorkspace(server, a.tenantId);
    const f = fakeIo();
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], f.io)).toBe(0);
    expect((await executionsOf(a.tenantId, wf.id))[0].status).toBe('success');
  });

  it('exits non-zero with the error text when the run fails', async () => {
    const a = await workspace();
    const wf = await failingWorkflow(a, 'Fails');
    const f = fakeIo();
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], f.io)).toBe(1);
    expect(f.stderr()).toContain('stopped on purpose');
    expect((await executionsOf(a.tenantId, wf.id))[0]).toMatchObject({ mode: 'cli', status: 'error' });
  });

  it('applies the workflowStart policy: a blocked node type fails the run', async () => {
    const a = await workspace();
    const wf = await okWorkflow(a, 'Blocked at start');
    await policyDeny(server, a.tenantId, 'node', 'core.set');
    const f = fakeIo();
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], f.io)).toBe(1);
    expect(f.stderr()).toContain('core.set');
  });

  it("refuses an unknown workflow, another workspace's workflow and a missing --id", async () => {
    const a = await workspace();
    const b = await workspace();
    const theirs = await okWorkflow(b, 'Theirs');
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', randomUUID()], fakeIo().io)).toBe(1);
    expect(await executeCommand(server.ctx, ['--tenant', a.slug, '--id', theirs.id], fakeIo().io)).toBe(1);
    expect(await executionsOf(b.tenantId, theirs.id)).toHaveLength(0);
    expect(await executeCommand(server.ctx, ['--tenant', a.slug], fakeIo().io)).toBe(2);
  });
});

describe('P6-78 execute-batch', () => {
  it('reports the success and failure counts, a non-zero exit on a failure, and prints no item data', async () => {
    const a = await workspace();
    const good = await okWorkflow(a, 'Good', `batch-secret-${randomUUID().slice(0, 6)}`);
    const bad = await failingWorkflow(a, 'Bad');
    const f = fakeIo();
    expect(
      await executeBatchCommand(server.ctx, ['--tenant', a.slug, '--ids', `${good.id},${bad.id}`], f.io),
    ).toBe(1);
    const summary = JSON.parse(f.stdout());
    expect(summary).toMatchObject({ total: 2, succeeded: 1, failed: 1, skipped: 0 });
    expect(summary.results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      [good.id, 'success'],
      [bad.id, 'error'],
    ]);
    expect(f.stdout()).not.toContain('batch-secret');
    expect((await executionsOf(a.tenantId, good.id))[0].mode).toBe('cli');
  });

  it('exits 0 when every run succeeds, with --concurrency and --output', async () => {
    const a = await workspace();
    const one = await okWorkflow(a, 'One');
    const two = await okWorkflow(a, 'Two');
    const f = fakeIo();
    expect(
      await executeBatchCommand(
        server.ctx,
        [
          '--tenant',
          a.slug,
          '--ids',
          `${one.id},${two.id}`,
          '--concurrency',
          '2',
          '--output',
          '/summary.json',
        ],
        f.io,
      ),
    ).toBe(0);
    expect(JSON.parse(f.files.get('/summary.json') ?? '{}')).toMatchObject({
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(f.stdout()).toContain('2 succeeded');
    expect(
      await executeBatchCommand(
        server.ctx,
        ['--tenant', a.slug, '--ids', one.id, '--concurrency', '0'],
        fakeIo().io,
      ),
    ).toBe(2);
  });

  it('retries a failing workflow --retries times, and skips the ids of --skipList', async () => {
    const a = await workspace();
    const bad = await failingWorkflow(a, 'Retried');
    const skipped = await okWorkflow(a, 'Skipped');
    const f = fakeIo({ '/skip.txt': `${skipped.id}\n` });
    expect(
      await executeBatchCommand(
        server.ctx,
        ['--tenant', a.slug, '--ids', `${bad.id},${skipped.id}`, '--retries', '2', '--skipList', '/skip.txt'],
        f.io,
      ),
    ).toBe(1);
    expect(JSON.parse(f.stdout())).toMatchObject({ total: 2, succeeded: 0, failed: 1, skipped: 1 });
    expect(await executionsOf(a.tenantId, bad.id)).toHaveLength(3);
    expect(await executionsOf(a.tenantId, skipped.id)).toHaveLength(0);
  });

  it('counts an unknown id as a failure and a missing --ids as a bad call; "all" runs every workflow', async () => {
    const a = await workspace();
    const one = await okWorkflow(a, 'Only');
    const f = fakeIo();
    expect(
      await executeBatchCommand(server.ctx, ['--tenant', a.slug, '--ids', `${one.id},${randomUUID()}`], f.io),
    ).toBe(1);
    expect(JSON.parse(f.stdout())).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(await executeBatchCommand(server.ctx, ['--tenant', a.slug], fakeIo().io)).toBe(2);
    const all = fakeIo();
    expect(await executeBatchCommand(server.ctx, ['--tenant', a.slug, '--ids', 'all'], all.io)).toBe(0);
    expect(JSON.parse(all.stdout())).toMatchObject({ total: 1, succeeded: 1 });
  });
});
