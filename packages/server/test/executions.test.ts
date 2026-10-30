import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;
let baseUrl: string;

beforeAll(async () => {
  server = await createTestServer();
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

interface SseEvent {
  event: string;
  data: any;
}

/** open GET /rest/push and collect events */
async function openPush(cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/rest/push`, { headers: { cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await waitFor(async () => events.some((e) => e.event === 'connected'), { message: 'SSE connection' });
  return {
    events,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

describe('manual executions', () => {
  it('persists run data and streams push events to the tenant only', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const wf = await createWorkflow(a.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Set', 'greeting', '={{ "hello " + $json.name }}'),
        node(
          'Code',
          'core.code',
          {
            mode: 'runOnceForAllItems',
            jsCode:
              'console.log("from code"); return items.map(i => ({ json: { ...i.json, len: i.json.greeting.length } }));',
          },
          [400, 0],
        ),
      ],
      connections: chain('Start', 'Set', 'Code'),
    });
    const pushA = await openPush(a.client.cookie!);
    const pushB = await openPush(b.client.cookie!);
    try {
      const { executionId } = await a.client.data(
        a.client.post(`/rest/workflows/${wf.id}/run`, { triggerItems: [{ json: { name: 'Ada' } }] }),
      );
      await waitFor(async () => pushA.events.find((e) => e.event === 'executionFinished'), {
        message: 'finish event',
      });
      const names = pushA.events.map((e) => e.event).filter((e) => e !== 'connected' && e !== 'ping');
      expect(names).toEqual([
        'executionStarted',
        'nodeExecuteBefore',
        'nodeExecuteAfter',
        'nodeExecuteBefore',
        'nodeExecuteAfter',
        'nodeExecuteBefore',
        'consoleMessage',
        'nodeExecuteAfter',
        'executionFinished',
      ]);
      expect(pushA.events.find((e) => e.event === 'executionStarted')!.data).toEqual({
        executionId,
        workflowId: wf.id,
        mode: 'manual',
      });
      const after = pushA.events.filter((e) => e.event === 'nodeExecuteAfter')[1].data;
      expect(after).toMatchObject({ executionId, nodeName: 'Set', runIndex: 0 });
      expect(after.taskData.data.main[0][0].json).toEqual({ name: 'Ada', greeting: 'hello Ada' });
      expect(pushA.events.find((e) => e.event === 'consoleMessage')!.data).toEqual({
        executionId,
        nodeName: 'Code',
        args: ['from code'],
      });
      expect(pushA.events.find((e) => e.event === 'executionFinished')!.data).toEqual({
        executionId,
        workflowId: wf.id,
        status: 'success',
      });
      // tenant B saw nothing of tenant A
      expect(pushB.events.filter((e) => e.event !== 'connected')).toEqual([]);

      const execution = await a.client.data(a.client.get(`/rest/executions/${executionId}`));
      expect(execution).toMatchObject({
        id: executionId,
        workflowId: wf.id,
        workflowName: 'Test workflow',
        mode: 'manual',
        status: 'success',
      });
      expect(execution.durationMs).toBeGreaterThanOrEqual(0);
      expect(execution.workflowData.nodes).toHaveLength(3);
      expect(outputOf(execution.state, 'Code')).toEqual([{ name: 'Ada', greeting: 'hello Ada', len: 9 }]);
      const list = await a.client.data(a.client.get(`/rest/executions?workflowId=${wf.id}&status=success`));
      expect(list.map((e: { id: string }) => e.id)).toEqual([executionId]);
      expect(list[0]).not.toHaveProperty('state');
    } finally {
      await pushA.close();
      await pushB.close();
    }
  });

  it('runs unsaved workflow data with pin data and partial execution', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const workflowData = {
      name: 'Draft',
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('A', 'a', 1),
        node('Boom', 'test.fail', {}, [400, 0]),
      ],
      connections: chain('Start', 'A', 'Boom'),
    };
    const { executionId } = await client.data(
      client.post(`/rest/workflows/${wf.id}/run`, {
        workflowData,
        destinationNode: 'A',
        pinData: { Start: [{ json: { pinned: true } }] },
      }),
    );
    const row = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(row.status).toBe('success');
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'A')).toEqual([{ pinned: true, a: 1 }]);
    expect(execution.state.resultData.runData.Boom).toBeUndefined();
  });

  it('starts trigger nodes in manual mode through manualTriggerFunction', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval'), setNode('Set', 'seen', '={{ $json.tick }}')],
      connections: chain('Interval', 'Set'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Set')).toEqual([{ tick: 1, seen: '1' }]);
  });

  it('records failures, retries from the failed node and stops waiting executions', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Before', 'x', 1),
        node('Boom', 'test.fail', {}, [400, 0]),
      ],
      connections: chain('Start', 'Before', 'Boom'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorMessage: 'Intentional failure', errorNode: 'Boom' });

    // fix the workflow, retry with the current version: earlier nodes are not executed again
    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        nodes: current.nodes.map((n: { name: string }) =>
          n.name === 'Boom' ? { ...n, type: 'core.noOp', parameters: {} } : n,
        ),
      }),
    );
    const retry = await client.data(
      client.post(`/rest/executions/${executionId}/retry`, { useCurrentWorkflow: true }),
    );
    const retried = await waitForExecution(server.ctx, tenant.id, retry.executionId);
    expect(retried).toMatchObject({ status: 'success', mode: 'retry', retryOf: executionId });
    expect((await server.ctx.repos.executions.get(tenant.id, executionId))?.retrySuccessId).toBe(
      retry.executionId,
    );
    const retryData = await client.data(client.get(`/rest/executions/${retry.executionId}`));
    expect(outputOf(retryData.state, 'Boom')).toEqual([{ x: 1 }]);
    expect((await client.post(`/rest/executions/${retry.executionId}/retry`, {})).statusCode).toBe(409);

    // stop a waiting execution, then delete it
    const waitWf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', {}, [200, 0])],
      connections: chain('Start', 'Wait'),
    });
    const waiting = await client.data(client.post(`/rest/workflows/${waitWf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, waiting.executionId, ['waiting']);
    expect(await client.data(client.post(`/rest/executions/${waiting.executionId}/stop`))).toEqual({
      status: 'canceled',
    });
    expect(await client.data(client.delete(`/rest/executions/${waiting.executionId}`))).toEqual({ ok: true });
    expect((await client.get(`/rest/executions/${waiting.executionId}`)).statusCode).toBe(404);
  });

  it('stops a running execution', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Slow', 'test.sleep', { ms: 10_000 }, [200, 0])],
      connections: chain('Start', 'Slow'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['running']);
    const stopped = await client.data(client.post(`/rest/executions/${executionId}/stop`));
    expect(stopped.status).toBe('canceled');
    const row = await server.ctx.repos.executions.get(tenant.id, executionId);
    expect(row?.stoppedAt).toBeTruthy();
  });

  it('respects saveManualExecutions and saveDataSuccessExecution', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger')],
      settings: { saveManualExecutions: false },
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitFor(async () => !(await server.ctx.repos.executions.get(tenant.id, executionId)), {
      message: 'execution to be discarded',
    });
  });

  it('enforces plan limits on concurrent executions', async () => {
    const { client, tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { concurrentExecutions: 1 } });
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', {}, [200, 0])],
      connections: chain('Start', 'Wait'),
    });
    // waiting executions do not count as running
    const first = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, first.executionId, ['waiting']);
    await server.ctx.repos.executions.update(tenant.id, first.executionId, { status: 'running' });
    const blocked = await client.post(`/rest/workflows/${wf.id}/run`, {});
    expect(blocked.statusCode).toBe(429);
    // manual test runs do not count towards the monthly quota
    const usage = (await client.data(client.get('/rest/settings'))).usage;
    expect(usage.executions).toBe(0);
  });
});

describe('sub-workflows and error workflows', () => {
  it('runs a sub-workflow from its Execute Workflow Trigger and enforces the caller policy', async () => {
    const { client, tenant } = await signup(server.app);
    const child = await createWorkflow(client, {
      name: 'Child',
      nodes: [
        node('Manual', 'core.manualTrigger', {}, [0, -200]),
        node('Called', 'core.executeWorkflowTrigger', {}, [0, 0]),
        setNode('Double', 'doubled', '={{ $json.n * 2 }}'),
      ],
      connections: chain('Called', 'Double'),
    });
    const parent = await createWorkflow(client, {
      name: 'Parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await client.data(
      client.post(`/rest/workflows/${parent.id}/run`, {
        triggerItems: [{ json: { n: 2 } }, { json: { n: 5 } }],
      }),
    );
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Call')).toEqual([
      { n: 2, doubled: '4' },
      { n: 5, doubled: '10' },
    ]);
    const children = await server.ctx.repos.executions.list(tenant.id, { workflowId: child.id, limit: 10 });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      mode: 'integrated',
      parentExecutionId: executionId,
      status: 'success',
    });

    // allow-list without the parent: the call fails
    const current = await client.data(client.get(`/rest/workflows/${child.id}`));
    await client.data(
      client.patch(`/rest/workflows/${child.id}`, {
        versionId: current.versionId,
        settings: { callerPolicy: 'allowList', callerIds: ['00000000-0000-0000-0000-000000000000'] },
      }),
    );
    const denied = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const deniedRow = await waitForExecution(server.ctx, tenant.id, denied.executionId);
    expect(deniedRow.status).toBe('error');
    expect(deniedRow.errorMessage).toMatch(/does not allow being called by this workflow/);

    const v = await client.data(client.get(`/rest/workflows/${child.id}`));
    await client.data(
      client.patch(`/rest/workflows/${child.id}`, {
        versionId: v.versionId,
        settings: { callerPolicy: 'none' },
      }),
    );
    const none = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    expect((await waitForExecution(server.ctx, tenant.id, none.executionId)).errorMessage).toMatch(
      /does not allow being called by other workflows/,
    );

    const v2 = await client.data(client.get(`/rest/workflows/${child.id}`));
    await client.data(
      client.patch(`/rest/workflows/${child.id}`, {
        versionId: v2.versionId,
        settings: { callerPolicy: 'allowList', callerIds: [parent.id] },
      }),
    );
    const allowed = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    expect((await waitForExecution(server.ctx, tenant.id, allowed.executionId)).status).toBe('success');

    // another tenant's workflow id cannot be called
    const other = await signup(server.app);
    const foreign = await createWorkflow(other.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    const foreignRun = await other.client.data(other.client.post(`/rest/workflows/${foreign.id}/run`, {}));
    expect(
      (await waitForExecution(server.ctx, other.tenant.id, foreignRun.executionId)).errorMessage,
    ).toMatch(/was not found/);
  });

  it('runs the error workflow when a production execution fails', async () => {
    const { client, tenant } = await signup(server.app);
    const handler = await createWorkflow(client, {
      name: 'On error',
      nodes: [
        node('Error Trigger', 'core.errorTrigger'),
        setNode('Note', 'handled', true as unknown as string),
      ],
      connections: chain('Error Trigger', 'Note'),
    });
    const failing = await createWorkflow(client, {
      name: 'Fragile',
      nodes: [
        node('Hook', 'core.webhook', { path: 'fragile', httpMethod: 'POST' }, [0, 0], { webhookId: 'f' }),
        node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0]),
      ],
      connections: chain('Hook', 'Boom'),
      settings: { errorWorkflow: handler.id },
    });
    await client.data(client.post(`/rest/workflows/${failing.id}/activate`));
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/fragile`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const errorRun = await waitFor(
      async () =>
        (await server.ctx.repos.executions.list(tenant.id, { workflowId: handler.id, limit: 5 }))[0],
      { message: 'error workflow execution' },
    );
    await waitForExecution(server.ctx, tenant.id, errorRun.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${errorRun.id}`));
    expect(errorRun.mode).toBe('error');
    const [item] = outputOf(data.state, 'Error Trigger');
    const failedExecution = (
      await server.ctx.repos.executions.list(tenant.id, { workflowId: failing.id, limit: 5 })
    )[0];
    expect(item).toMatchObject({
      execution: {
        id: failedExecution.id,
        lastNodeExecuted: 'Boom',
        mode: 'webhook',
        error: { message: 'kaputt' },
      },
      workflow: { id: failing.id, name: 'Fragile' },
    });
    expect((item.execution as { url: string }).url).toContain(failedExecution.id);
    expect((item.execution as { error: { stack?: string } }).error.stack).toBeUndefined();

    // manual runs never trigger the error workflow
    const manual = await client.data(client.post(`/rest/workflows/${failing.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, manual.executionId);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await server.ctx.repos.executions.list(tenant.id, { workflowId: handler.id, limit: 5 }),
    ).toHaveLength(1);
  });
});

describe('wait and resume', () => {
  it('resumes through /webhook-waiting with the request body as the waiting node output', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Url', 'resumeUrl', '={{ $execution.resumeUrl }}'),
        node('Wait', 'test.wait', {}, [400, 0]),
        setNode('After', 'done', 'yes', [600, 0]),
      ],
      connections: chain('Start', 'Url', 'Wait', 'After'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const waiting = await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    expect(waiting.waitTill!.getTime()).toBeGreaterThan(Date.now());
    const before = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(before.state, 'Url')[0].resumeUrl).toBe(
      `http://localhost:5678/webhook-waiting/${executionId}`,
    );

    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook-waiting/${executionId}`,
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(after.state, 'After')).toEqual([{ approved: true, done: 'yes' }]);

    const again = await server.app.inject({
      method: 'POST',
      url: `/webhook-waiting/${executionId}`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it("calls the waiting node's webhook() when it has one", async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.waitHook', {}, [200, 0])],
      connections: chain('Start', 'Wait'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    expect(
      (await server.app.inject({ method: 'GET', url: `/webhook-waiting/${executionId}` })).statusCode,
    ).toBe(404);
    const rejected = await server.app.inject({
      method: 'POST',
      url: `/webhook-waiting/${executionId}`,
      payload: { reject: true },
    });
    expect(rejected.statusCode).toBe(403);
    expect((await server.ctx.repos.executions.get(tenant.id, executionId))?.status).toBe('waiting');
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook-waiting/${executionId}`,
      payload: { ok: 1 },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(after.state, 'Wait')).toEqual([{ resumedWith: { ok: 1 }, via: 'webhook()' }]);
  });

  it('resumes timed waits through the wait tracker', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', { ms: 300 }, [200, 0]),
        setNode('After', 'resumed', 'yes', [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'After'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    expect(await server.ctx.waitTracker.check()).toBe(0);
    await new Promise((r) => setTimeout(r, 350));
    expect(await server.ctx.waitTracker.check()).toBe(1);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(after.state, 'After')).toEqual([{ resumed: 'yes' }]);
  });
});

describe('pruning', () => {
  it('deletes old executions and their binary data', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const old = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const fresh = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, old.executionId);
    await waitForExecution(server.ctx, tenant.id, fresh.executionId);
    await server.ctx.repos.executions.update(tenant.id, old.executionId, {
      stoppedAt: new Date(Date.now() - 30 * 86_400_000),
    });
    const dir = path.join(server.ctx.config.binaryData.dir, tenant.id, old.executionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'blob'), 'x');

    expect(await server.ctx.pruner.prune()).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(await server.ctx.repos.executions.get(tenant.id, old.executionId)).toBeUndefined();
    expect(await server.ctx.repos.executions.get(tenant.id, fresh.executionId)).toBeDefined();
  });
});
