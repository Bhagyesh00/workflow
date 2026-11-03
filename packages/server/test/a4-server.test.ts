/**
 * A4 server findings: R63 (token-bearing paths never reach the request logs) and R64 (activation on a
 * main that is not the leader waits for the leader's answer and rolls back like the leader path when the
 * leader fails; with no answer, as while a new leader is elected, the activation is kept for that leader).
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { NodePackage } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import { createLogger } from '../src/logger';
import { ActiveWorkflowManager } from '../src/services/active-workflows';
import type { MessageBus } from '../src/services/bus';
import type { Leadership, SingleLeader } from '../src/services/queue';
import { WorkflowService } from '../src/services/workflows';
import {
  createWorkflow,
  node,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

const a4Package: NodePackage = {
  name: 'a4-tests',
  nodes: [
    {
      description: {
        name: 'a4.failTrigger',
        displayName: 'Failing trigger',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Failing trigger' },
        inputs: [],
        outputs: ['main'],
        properties: [],
      },
      async trigger() {
        throw new Error('trigger refused to start');
      },
    },
    {
      description: {
        name: 'a4.slowTrigger',
        displayName: 'Slow trigger',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Slow trigger' },
        inputs: [],
        outputs: ['main'],
        properties: [],
      },
      async trigger() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { closeFunction: async () => {} };
      },
    },
  ],
  credentials: [],
};

let server: TestServer;
const logLines: string[] = [];

const logs = () => logLines.join('');

beforeAll(async () => {
  const config = testConfig({ LOG_LEVEL: 'info' });
  const logger = createLogger(
    'info',
    { service: 'workflow-server' },
    { write: (line: string) => logLines.push(line) },
  );
  const ctx = await createContext({
    config,
    logger,
    nodePackages: [nodesBasePackage, testPackage, a4Package],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  const app = await buildApp(ctx);
  await app.ready();
  await ctx.startMain();
  server = {
    ctx,
    app,
    async close() {
      await app.close();
      await ctx.close();
    },
  };
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await server.ctx.activeWorkflows.stopAll();
  await resetDatabase(server.ctx);
  logLines.length = 0;
});

describe('R63: token-bearing paths are redacted in request logs', () => {
  it('logs no invitation token, resume signature or execution id, on any request log line', async () => {
    const { client } = await signup(server.app);
    const invite = await client.data(
      client.post('/rest/members/invite', { email: 'new@example.com', role: 'editor' }),
    );
    const guessed = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
    const executionId = randomUUID();
    const resumePath = new URL(server.ctx.executions.resumeUrl(executionId)).pathname;
    const signature = resumePath.split('/').pop() as string;
    logLines.length = 0;

    const anonymous = new TestClient(server.app);
    const html = { accept: 'text/html' };
    // the link the invitee opens (SPA), its API form and a token that does not exist
    await anonymous.get(`/invitation/${invite.token}`, html);
    await anonymous.get(`/invitation/${guessed}?utm=1`, html);
    await anonymous.get(`/invitations/${invite.token}`, html);
    await anonymous.post(`/rest/invitations/${guessed}/accept`, { name: 'X', password: 'Passw0rd!' });
    // percent-encoded spelling of the same route
    await anonymous.get(`/%69nvitation/${guessed}`, html);
    // resume URLs: the execution id and the signature both grant the resume
    await anonymous.get(resumePath);
    await anonymous.get(`/webhook-waiting/${executionId}`);

    const output = logs();
    expect(output).toContain('incoming request');
    expect(output).toContain('request completed');
    for (const secret of [invite.token, guessed, executionId, signature]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('/invitation/[redacted]?utm=1');
    expect(output).toContain('/webhook-waiting/[redacted]');
  });

  it('keeps other URLs readable', async () => {
    const anonymous = new TestClient(server.app);
    await anonymous.get('/rest/auth/me');
    expect(logs()).toContain('/rest/auth/me');
  });
});

/** the nodes WorkflowService.update takes: as the request schema parses them, an open record per node */
type UpdateNodes = Parameters<WorkflowService['update']>[2]['nodes'];

describe('R64: activation on a main that is not the leader', () => {
  const notLeader: Leadership = { isLeader: false, start: async () => {}, stop: async () => {} };

  const follower = (triggerStartTimeoutMs?: number, bus: MessageBus = server.ctx.bus) =>
    new ActiveWorkflowManager({
      config: server.ctx.config,
      database: server.ctx.database,
      repos: server.ctx.repos,
      nodeTypes: server.ctx.registries.nodeTypes,
      executions: server.ctx.executions,
      logger: server.ctx.logger,
      bus,
      leadership: notLeader,
      triggerStartTimeoutMs,
    });

  it('rolls back when the leader cannot start the trigger, and the leader logs it', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Broken', 'a4.failTrigger')] });
    const warn = vi.spyOn(server.ctx.logger, 'warn');

    const error = await follower()
      .activate(tenant.id, wf.id)
      .then(
        () => undefined,
        (e) => e,
      );

    expect(error).toMatchObject({ statusCode: 400, code: 'activation_failed' });
    expect(error.details).toEqual([{ node: 'Broken', message: 'trigger refused to start' }]);
    expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(false);
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([]);
    expect(warn.mock.calls.some((call) => call[1] === 'Trigger activation failed')).toBe(true);
    warn.mockRestore();
  });

  it('keeps the activation when the leader starts the trigger', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 1000 })],
    });

    const row = await follower().activate(tenant.id, wf.id);

    expect(row.active).toBe(true);
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
  });

  it('keeps the activation when no main answers, and the next leader starts the triggers', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 1000 })],
    });
    const leadership = server.ctx.leadership as SingleLeader;
    const warn = vi.spyOn(server.ctx.logger, 'warn');
    // the leader is gone and no main is elected yet: nobody answers the start request
    leadership.isLeader = false;
    try {
      const row = await follower(200).activate(tenant.id, wf.id);

      expect(row.active).toBe(true);
      expect(warn.mock.calls.some((call) => call[1] === 'No main answered the trigger start')).toBe(true);
      expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([]);
    } finally {
      leadership.isLeader = true;
      warn.mockRestore();
    }
    await server.ctx.activeWorkflows.startAll();
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
  });

  it('keeps the activation when the start request cannot be published in time', {
    timeout: 5000,
  }, async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 1000 })],
    });
    // the broker takes the start request but never confirms it
    const stalledBus: MessageBus = {
      publish: () => new Promise<void>(() => {}),
      subscribe: (channel, handler) => server.ctx.bus.subscribe(channel, handler),
      close: async () => {},
    };
    const warn = vi.spyOn(server.ctx.logger, 'warn');
    try {
      const row = await follower(100, stalledBus).activate(tenant.id, wf.id);

      expect(row.active).toBe(true);
      expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(true);
      expect(warn.mock.calls.some((call) => call[1] === 'No main answered the trigger start')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps an active workflow active when a new version is published while no main leads', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 1000 })],
    });
    await server.ctx.activeWorkflows.activate(tenant.id, wf.id);
    const followerWorkflows = new WorkflowService({
      config: server.ctx.config,
      database: server.ctx.database,
      repos: server.ctx.repos,
      nodeTypes: server.ctx.registries.nodeTypes,
      executions: server.ctx.executions,
      activeWorkflows: follower(200),
      testWebhooks: server.ctx.testWebhooks,
      favorites: server.ctx.favorites,
      publishHistory: server.ctx.publishHistory,
      reviews: server.ctx.reviews,
      context: () => server.ctx,
    });
    const leadership = server.ctx.leadership as SingleLeader;
    // the leader crashes: its triggers are gone and the next main is not elected yet
    await server.ctx.activeWorkflows.stopAll();
    leadership.isLeader = false;
    try {
      const saved = await followerWorkflows.update(
        tenant.id,
        wf.id,
        { nodes: [node('Interval', 'test.interval', { intervalMs: 2000 })] as UpdateNodes },
        {},
      );
      // P3-10: the save is a draft; publishing it asks the (missing) leader to restart the triggers
      expect(saved.activationError).toBeUndefined();
      expect(saved.publishedVersionId).toBe(wf.versionId);
      const published = await followerWorkflows.setActive(tenant.id, wf.id, true, {});

      expect(published.active).toBe(true);
      expect(published.publishedVersionId).toBe(saved.versionId);
      expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(true);
    } finally {
      leadership.isLeader = true;
    }
    await server.ctx.activeWorkflows.startAll();
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
  });

  it('keeps a start that the leader finishes after the follower stopped waiting', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Slow', 'a4.slowTrigger')] });

    const row = await follower(100).activate(tenant.id, wf.id);

    expect(row.active).toBe(true);
    // the leader's start is still running when the follower gives up; it is kept once it is done
    await waitFor(async () => server.ctx.activeWorkflows.runningWorkflowIds.length === 1, { timeout: 5000 });
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
  });
});

describe('R35: a run that starts at Loop Over Items with the run data of an earlier execution', () => {
  const read = (name: string, position: [number, number]) =>
    node(
      name,
      'core.set',
      {
        assignments: {
          assignments: [
            { id: '1', name: 'orig', value: "={{ $('Trigger').item.json.name }}", type: 'string' },
          ],
        },
        includeOtherFields: true,
      },
      position,
    );
  const connections = {
    Trigger: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
    Loop: {
      main: [[{ node: 'After', type: 'main', index: 0 }], [{ node: 'Body', type: 'main', index: 0 }]],
    },
    Body: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
  };
  const nodes = [
    node('Trigger', 'core.manualTrigger'),
    node('Loop', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
    read('Body', [400, 100]),
    read('After', [400, -100]),
  ];

  it('gives the start node the earlier output of the node before it, so every batch pairs back', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes, connections });
    const first = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {
        triggerItems: [{ json: { name: 'A' } }, { json: { name: 'B' } }, { json: { name: 'C' } }],
      }),
    );
    await waitForExecution(server.ctx, tenant.id, first.executionId);
    const earlier = await client.data<{ state: { resultData: { runData: Record<string, unknown[]> } } }>(
      client.get(`/rest/executions/${first.executionId}`),
    );

    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {
        startNode: 'Loop',
        runData: earlier.state.resultData.runData,
      }),
    );
    const row = await waitForExecution(server.ctx, tenant.id, executionId);
    const execution = await client.data<{ state: any }>(client.get(`/rest/executions/${executionId}`));
    expect(execution.state.resultData.error?.message).toBeUndefined();
    expect(row.status).toBe('success');
    const runData = execution.state.resultData.runData;
    expect(runData.Trigger).toHaveLength(1);
    expect(runData.Body.map((task: any) => task.data.main[0].map((i: any) => i.json.orig))).toEqual([
      ['A'],
      ['B'],
      ['C'],
    ]);
    expect(runData.After).toHaveLength(1);
    expect(runData.After[0].data.main[0].map((i: any) => i.json.orig)).toEqual(['A', 'B', 'C']);
  });

  it('rejects run data that is not a list of task results per node', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes, connections });
    const res = await client.request('POST', `/rest/workflows/${wf.id}/run`, {
      startNode: 'Loop',
      runData: { Trigger: { data: 'nope' } },
    });
    expect(res.statusCode).toBe(400);
  });
});
