/**
 * Queue mode end to end: a main (HTTP, enqueues) and a separate worker context (consumes BullMQ)
 * share only Postgres and Redis, like separate processes would.
 */
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import { RedisLeader } from '../src/services/queue';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  flushRedis,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  TEST_REDIS,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

const QUEUE_ENV = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfqueue' };

let main: TestServer;
let worker: ServerContext;

beforeAll(async () => {
  await flushRedis();
  main = await createTestServer(QUEUE_ENV);
  worker = await createContext({
    // mains and workers share the binary data directory (a volume in production)
    config: testConfig({ ...QUEUE_ENV, BINARY_DATA_DIR: main.ctx.config.binaryData.dir }),
    nodePackages: [nodesBasePackage, testPackage],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
    migrate: false,
  });
  await worker.startWorker();
});
afterAll(async () => {
  await main.close();
  await worker.close();
});
beforeEach(async () => {
  await resetDatabase(main.ctx);
});

describe('queue mode', () => {
  it('runs manual executions on the worker and relays push events through Redis', async () => {
    const { client, tenant } = await signup(main.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'where', 'worker')],
      connections: chain('Start', 'Set'),
    });
    const events: Array<{ type: string; data: any }> = [];
    const unsubscribe = await main.ctx.push.subscribe(tenant.id, (e) => events.push(e));
    try {
      const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
      await waitForExecution(main.ctx, tenant.id, executionId, ['success']);
      await waitFor(async () => events.find((e) => e.type === 'executionFinished'), {
        message: 'finish event',
      });
      expect(events.map((e) => e.type)).toEqual([
        'executionStarted',
        'nodeExecuteBefore',
        'nodeExecuteAfter',
        'nodeExecuteBefore',
        'nodeExecuteAfter',
        'executionFinished',
      ]);
      // the main never executed anything itself
      expect(main.ctx.executions.runningCount).toBe(0);
      const execution = await client.data(client.get(`/rest/executions/${executionId}`));
      expect(outputOf(execution.state, 'Set')).toEqual([{ where: 'worker' }]);
    } finally {
      unsubscribe();
    }
  });

  it('answers lastNode and responseNode webhooks with results from the worker', async () => {
    const { client, tenant } = await signup(main.app);
    const last = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'q-last', responseMode: 'lastNode' },
          [0, 0],
          {
            webhookId: 'a',
          },
        ),
        setNode('Set', 'echo', '={{ $json.body.v }}'),
      ],
      connections: chain('Webhook', 'Set'),
    });
    await client.data(client.post(`/rest/workflows/${last.id}/activate`));
    const res = await main.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/q-last`,
      payload: { v: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().echo).toBe('hi');

    const responder = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'q-respond', responseMode: 'responseNode' },
          [0, 0],
          {
            webhookId: 'b',
          },
        ),
        node('Respond', 'core.respondToWebhook', { respondWith: 'text', responseText: 'pong' }, [200, 0]),
      ],
      connections: chain('Webhook', 'Respond'),
    });
    await client.data(client.post(`/rest/workflows/${responder.id}/activate`));
    const pong = await main.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/q-respond` });
    expect(pong.statusCode).toBe(200);
    expect(pong.body).toBe('pong');
    expect(pong.headers['content-type']).toContain('text/plain');

    // chunks travel from the worker to the main over Redis, in order, each with its node run's metadata
    const streamNode = node('Stream', 'test.chunks', { text: 'a b c d' }, [200, 0]);
    const streaming = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'q-stream', responseMode: 'streaming' },
          [0, 0],
          {
            webhookId: 'c',
          },
        ),
        streamNode,
      ],
      connections: chain('Webhook', 'Stream'),
    });
    await client.data(client.post(`/rest/workflows/${streaming.id}/activate`));
    const stream = await main.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/q-stream` });
    const metadata = {
      nodeId: streamNode.id,
      nodeName: 'Stream',
      runIndex: 0,
      itemIndex: 0,
      timestamp: expect.any(Number),
    };
    expect(
      stream.body
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { type: 'begin', metadata },
      { type: 'item', content: 'a', metadata },
      { type: 'item', content: 'b', metadata },
      { type: 'item', content: 'c', metadata },
      { type: 'item', content: 'd', metadata },
      { type: 'end', metadata },
    ]);
  });

  it('resumes waiting executions and runs sub-workflows on the worker', async () => {
    const { client, tenant } = await signup(main.app);
    const child = await createWorkflow(client, {
      nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Child', 'child', 'yes')],
      connections: chain('Called', 'Child'),
    });
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'Call'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(main.ctx, tenant.id, executionId, ['waiting']);
    const res = await main.app.inject({
      method: 'POST',
      url: new URL(main.ctx.executions.resumeUrl(executionId)).pathname,
      payload: { go: 1 },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(main.ctx, tenant.id, executionId, ['success']);
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Call')).toEqual([{ go: 1, child: 'yes' }]);
    expect(await executionsOf(main.ctx, tenant.id, child.id)).toHaveLength(1);
  });

  it('stops an execution running on the worker', async () => {
    const { client, tenant } = await signup(main.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Sleep', 'test.sleep', { ms: 10_000 }, [200, 0])],
      connections: chain('Start', 'Sleep'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(main.ctx, tenant.id, executionId, ['running']);
    await waitFor(async () => worker.executions.runningCount > 0, { message: 'worker to pick up the job' });
    const stopped = await client.data(client.post(`/rest/executions/${executionId}/stop`));
    expect(stopped.status).toBe('canceled');
  });

  it('marks executions crashed when their job is redelivered after a worker died', async () => {
    const { client, tenant } = await signup(main.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const execution = await main.ctx.repos.executions.create(
      tenant.id,
      { id: crypto.randomUUID(), workflowId: wf.id, workflowName: 'x', mode: 'trigger', status: 'running' },
      { workflowData: { name: 'x', nodes: [], connections: {} }, runOptions: {} },
    );
    await worker.executions.runQueued(
      { executionId: execution.id, tenantId: tenant.id, kind: 'run' },
      { redelivered: true },
    );
    const row = await main.ctx.repos.executions.get(tenant.id, execution.id);
    expect(row).toMatchObject({
      status: 'crashed',
      errorMessage: 'The worker running this execution stopped unexpectedly',
    });
  });

  it('reports queue depth and Redis readiness', async () => {
    const ready = await main.app.inject({ url: '/healthz/readiness' });
    expect(ready.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
    const metrics = await main.app.inject({ url: '/metrics' });
    expect(metrics.body).toMatch(/workflow_queue_depth \d+/);
  });

  it('elects exactly one leader and fails over when it stops', async () => {
    expect(main.ctx.leadership.isLeader).toBe(true);
    const contender = new RedisLeader(TEST_REDIS, 'wfqueue:leader', 1000, 100);
    let elected = false;
    await contender.start(
      () => {
        elected = true;
      },
      () => {},
    );
    expect(contender.isLeader).toBe(false);
    await main.ctx.leadership.stop();
    await waitFor(async () => elected, { message: 'fail-over', timeout: 3000 });
    expect(contender.isLeader).toBe(true);
    await contender.stop();
  });
});
