/**
 * P6-58 (S5 L1): the queue and worker events, in queue mode on Redis (db /2 only). A run enqueued on a main emits
 * `queue.job.enqueued` there and `queue.job.dequeued` and `queue.job.completed` on the worker, each with the
 * execution id, the workflow id and the job's tenant; a job that fails emits `queue.job.failed` without its error
 * text; a stalled job's tenant is read from the job data; `worker.started` and `worker.stopped` reach only the
 * workspaces with an enabled destination subscribed to them, and name the worker by its instance id.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import { logDestinations } from '../src/db/schema';
import { createQueueEventListener } from '../src/services/events/queue-events';
import {
  captureEvents,
  createTestServer,
  createWorkflow,
  flushRedis,
  node,
  signup,
  TEST_REDIS,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

const PREFIX = `p6q-${randomUUID().slice(0, 8)}`;
const QUEUE_ENV = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: PREFIX };

let main: TestServer;
let worker: ServerContext;
let owner: Awaited<ReturnType<typeof signup>>;
let other: Awaited<ReturnType<typeof signup>>;
let onMain: ReturnType<typeof captureEvents>;
let onWorker: ReturnType<typeof captureEvents>;

const newWorker = () =>
  createContext({
    config: testConfig({ ...QUEUE_ENV, BINARY_DATA_DIR: main.ctx.config.binaryData.dir }),
    nodePackages: [nodesBasePackage, testPackage],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
    migrate: false,
  });

beforeAll(async () => {
  await flushRedis();
  main = await createTestServer(QUEUE_ENV);
  owner = await signup(main.app, { remoteAddress: '10.58.1.1' });
  other = await signup(main.app, { remoteAddress: '10.58.1.2' });
  worker = await newWorker();
  onMain = captureEvents(main.ctx);
  onWorker = captureEvents(worker);
  await worker.startWorker();
}, 120_000);
afterAll(async () => {
  onMain?.stop();
  onWorker?.stop();
  await worker?.close();
  await main?.close();
});

async function runOnQueue(who: typeof owner) {
  const workflow = await createWorkflow(who.client, { nodes: [node('Start', 'core.manualTrigger')] });
  const { executionId } = await who.client.data<{ executionId: string }>(
    who.client.post(`/rest/workflows/${workflow.id}/run`, {}),
  );
  return { workflow, executionId };
}

const jobEvents = (from: ReturnType<typeof captureEvents>, executionId: string) =>
  from.events.filter((e) => e.eventName.startsWith('queue.job.') && e.payload.executionId === executionId);

describe('queue job events', () => {
  it('enqueued on the main; dequeued and completed on the worker; each with the tenant and the workflow', async () => {
    const { workflow, executionId } = await runOnQueue(owner);
    await waitForExecution(main.ctx, owner.tenant.id, executionId, ['success']);
    await waitFor(
      async () => {
        await worker.events.flush();
        return jobEvents(onWorker, executionId).some((e) => e.eventName === 'queue.job.completed');
      },
      { message: 'the completed job event' },
    );
    await main.ctx.events.flush();
    const enqueued = jobEvents(onMain, executionId);
    expect(enqueued.map((e) => e.eventName)).toEqual(['queue.job.enqueued']);
    expect(enqueued[0].tenantId).toBe(owner.tenant.id);
    expect(enqueued[0].payload).toMatchObject({ executionId, workflowId: workflow.id });
    expect(typeof enqueued[0].payload.jobId).toBe('string');
    const taken = jobEvents(onWorker, executionId);
    expect(taken.map((e) => e.eventName)).toEqual(['queue.job.dequeued', 'queue.job.completed']);
    for (const event of taken) {
      expect(event.tenantId).toBe(owner.tenant.id);
      expect(event.payload).toMatchObject({ executionId, workflowId: workflow.id });
    }
  });

  it("tenant B's job reaches no event of tenant A", async () => {
    const a = await runOnQueue(owner);
    const b = await runOnQueue(other);
    await waitForExecution(main.ctx, owner.tenant.id, a.executionId, ['success']);
    await waitForExecution(main.ctx, other.tenant.id, b.executionId, ['success']);
    await waitFor(
      async () => {
        await worker.events.flush();
        return jobEvents(onWorker, b.executionId).some((e) => e.eventName === 'queue.job.completed');
      },
      { message: 'the completed job event of B' },
    );
    await main.ctx.events.flush();
    for (const event of [...onMain.events, ...onWorker.events]) {
      if (event.payload.executionId === a.executionId) expect(event.tenantId).toBe(owner.tenant.id);
      if (event.payload.executionId === b.executionId) expect(event.tenantId).toBe(other.tenant.id);
    }
  });

  it('a job that fails emits queue.job.failed with the error class and never its text', async () => {
    const boom = vi
      .spyOn(worker.executions, 'runQueued')
      .mockRejectedValueOnce(new Error('canary-job-error-5d1e'));
    try {
      const { executionId } = await runOnQueue(owner);
      await waitFor(
        async () => {
          await worker.events.flush();
          return jobEvents(onWorker, executionId).some((e) => e.eventName === 'queue.job.failed');
        },
        { message: 'the failed job event' },
      );
      const failed = jobEvents(onWorker, executionId).find((e) => e.eventName === 'queue.job.failed')!;
      expect(failed.tenantId).toBe(owner.tenant.id);
      expect(failed.payload).toMatchObject({ executionId, errorName: 'Error' });
      expect(JSON.stringify(onWorker.events)).not.toContain('canary-job-error-5d1e');
    } finally {
      boom.mockRestore();
    }
  });

  it("a stalled job's tenant is read from the job data", async () => {
    const executionId = randomUUID();
    const jobId = `stalled-${randomUUID().slice(0, 8)}`;
    const redis = main.ctx.redis!;
    await redis.hset(
      `${PREFIX}:bull:executions:${jobId}`,
      'data',
      JSON.stringify({ executionId, tenantId: other.tenant.id, kind: 'run' }),
    );
    createQueueEventListener(main.ctx.serviceDeps).stalled(jobId);
    await waitFor(
      async () => {
        await main.ctx.events.flush();
        return onMain.events.some((e) => e.eventName === 'queue.job.stalled');
      },
      { message: 'the stalled job event' },
    );
    const stalled = onMain.events.find((e) => e.eventName === 'queue.job.stalled')!;
    expect(stalled.tenantId).toBe(other.tenant.id);
    expect(stalled.payload).toMatchObject({ executionId, jobId });
    await redis.del(`${PREFIX}:bull:executions:${jobId}`);
  });
});

describe('worker events', () => {
  it('worker.started and worker.stopped reach only the workspaces whose destination subscribes to them', async () => {
    const { db } = main.ctx.database;
    await db.insert(logDestinations).values([
      { tenantId: owner.tenant.id, type: 'webhook', enabled: true, subscribedEvents: ['worker'] },
      // a destination that subscribes to other events, and one that is off
      { tenantId: other.tenant.id, type: 'webhook', enabled: true, subscribedEvents: ['workflow'] },
      { tenantId: other.tenant.id, type: 'syslog', enabled: false, subscribedEvents: ['worker'] },
    ]);
    const second = await newWorker();
    const seen = captureEvents(second);
    try {
      await second.startWorker();
      await waitFor(
        async () => {
          await second.events.flush();
          return seen.events.some((e) => e.eventName === 'worker.started');
        },
        { message: 'worker.started' },
      );
      await second.close();
      await second.events.flush();
      const workerEvents = seen.events.filter((e) => e.eventName.startsWith('worker.'));
      expect(workerEvents.map((e) => e.eventName)).toEqual(['worker.started', 'worker.stopped']);
      for (const event of workerEvents) {
        expect(event.tenantId).toBe(owner.tenant.id);
        expect(event.payload).toEqual({ workerId: second.instance.id });
      }
    } finally {
      seen.stop();
      await second.close().catch(() => {});
    }
  }, 60_000);
});
