import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
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

type Client = Awaited<ReturnType<typeof signup>>['client'];

async function errorHandler(client: Client) {
  return createWorkflow(client, {
    name: 'Handler',
    nodes: [node('Error Trigger', 'core.errorTrigger'), setNode('Seen', 'seen', 'yes')],
    connections: chain('Error Trigger', 'Seen'),
  });
}

async function activeWebhook(
  client: Client,
  webhookPath: string,
  extra: { parameters?: Record<string, unknown>; nodes?: ReturnType<typeof node>[]; settings?: object } = {},
) {
  const nodes = extra.nodes ?? [];
  const wf = await createWorkflow(client, {
    nodes: [
      node(
        'Webhook',
        'core.webhook',
        { httpMethod: 'POST', path: webhookPath, ...extra.parameters },
        [0, 0],
        { webhookId: webhookPath },
      ),
      ...nodes,
    ],
    connections: chain('Webhook', ...nodes.map((n) => n.name)),
    settings: extra.settings as Record<string, unknown> | undefined,
  });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return wf;
}

/** a JSON body of roughly `kb` kilobytes, stored on disk once converted to a file */
const bigBody = (kb: number) => ({ blob: 'x'.repeat(kb * 1024) });

describe('R42: crashed executions run the error workflow', () => {
  async function runningRow(client: Client, tenantId: string, handlerId: string) {
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger')],
      settings: { errorWorkflow: handlerId },
    });
    const id = randomUUID();
    await server.ctx.repos.executions.create(
      tenantId,
      {
        id,
        workflowId: wf.id,
        workflowName: 'Crashing',
        mode: 'trigger',
        status: 'running',
        startedAt: new Date(),
      },
      {
        workflowData: {
          id: wf.id,
          name: 'Crashing',
          nodes: [],
          connections: {},
          settings: { errorWorkflow: handlerId },
        },
        runOptions: {},
      },
    );
    return id;
  }

  it('starts the error workflow when a redelivered job finds its execution running', async () => {
    const { client, tenant } = await signup(server.app);
    const handler = await errorHandler(client);
    const id = await runningRow(client, tenant.id, handler.id);
    await server.ctx.executions.runQueued(
      { tenantId: tenant.id, executionId: id, kind: 'run' },
      { redelivered: true },
    );
    expect((await server.ctx.repos.executions.get(tenant.id, id))?.status).toBe('crashed');
    const handled = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
      message: 'error workflow execution',
      timeout: 3000,
    });
    await waitForExecution(server.ctx, tenant.id, handled.id, ['success']);
    const data = await server.ctx.repos.executions.getData(tenant.id, handled.id);
    const trigger = (data!.state as any).resultData.runData['Error Trigger'][0].data.main[0][0].json;
    expect(trigger.execution.id).toBe(id);
    expect(trigger.execution.error.message).toBe('The worker running this execution stopped unexpectedly');
  });

  it('starts the error workflow for executions left running by a previous process', async () => {
    const { client, tenant } = await signup(server.app);
    const handler = await errorHandler(client);
    const id = await runningRow(client, tenant.id, handler.id);
    // a restarted regular-mode process closes the row on startup
    const restarted = await createTestServer({}, { reset: false });
    try {
      expect((await restarted.ctx.repos.executions.get(tenant.id, id))?.status).toBe('crashed');
      const handled = await waitFor(
        async () => (await executionsOf(restarted.ctx, tenant.id, handler.id))[0],
        {
          message: 'error workflow execution',
          timeout: 3000,
        },
      );
      await waitForExecution(restarted.ctx, tenant.id, handled.id, ['success']);
    } finally {
      await restarted.close();
    }
  });
});

describe('R43: an execution whose result cannot be stored', () => {
  it('is closed as crashed and runs the error workflow', async () => {
    const { client, tenant } = await signup(server.app);
    const handler = await errorHandler(client);
    const wf = await activeWebhook(client, 'unstorable', {
      nodes: [setNode('Set', 'x', 'y')],
      settings: { errorWorkflow: handler.id },
    });
    const saveState = vi
      .spyOn(server.ctx.repos.executions, 'saveState')
      .mockRejectedValueOnce(new Error('value too large'));
    try {
      const res = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/unstorable` });
      expect(res.statusCode).toBe(200);
      const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
      const row = await waitForExecution(server.ctx, tenant.id, execution.id, ['crashed'], 3000);
      expect(row.stoppedAt).toBeTruthy();
      expect(row.errorMessage).toContain('value too large');
      const handled = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
        message: 'error workflow execution',
        timeout: 3000,
      });
      await waitForExecution(server.ctx, tenant.id, handled.id, ['success']);
      // counted once the error workflow ended: its own run is running while it works
      expect(await server.ctx.repos.executions.countRunning(tenant.id)).toBe(0);
    } finally {
      saveState.mockRestore();
    }
  });
});

describe('R44: binary output of executions that are not saved', () => {
  const toFile = () => node('To File', 'core.convertToFile', { operation: 'toJson' }, [200, 0]);
  const binaryReply = { responseMode: 'lastNode', responseData: 'firstEntryBinary' };

  it('answers a lastNode firstEntryBinary webhook', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWebhook(client, 'file-none', {
      parameters: binaryReply,
      nodes: [toFile()],
      settings: { saveDataSuccessExecution: 'none' },
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/file-none`,
      payload: bigBody(200),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.byteLength).toBeGreaterThan(200 * 1024);
    expect(await executionsOf(server.ctx, tenant.id)).toHaveLength(0);
  });

  it('hands the binary output of an unsaved sub-workflow to its parent', async () => {
    const { client, tenant } = await signup(server.app);
    const child = await createWorkflow(client, {
      name: 'File child',
      nodes: [node('Called', 'core.executeWorkflowTrigger'), toFile()],
      connections: chain('Called', 'To File'),
      settings: { saveDataSuccessExecution: 'none' },
    });
    await activeWebhook(client, 'file-parent', {
      parameters: binaryReply,
      nodes: [node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0])],
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/file-parent`,
      payload: bigBody(200),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.byteLength).toBeGreaterThan(200 * 1024);
  });
});

describe('R45: stopping or timing out a parent stops its sub-workflow', () => {
  async function parentAndChild(client: Client, parentSettings: Record<string, unknown> = {}) {
    const child = await createWorkflow(client, {
      name: 'Slow child',
      nodes: [
        node('Called', 'core.executeWorkflowTrigger'),
        node('Sleep', 'test.sleep', { ms: 6000 }, [200, 0]),
        setNode('After', 'after', 'yes', [400, 0]),
      ],
      connections: chain('Called', 'Sleep', 'After'),
    });
    const parent = await createWorkflow(client, {
      name: 'Parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
      settings: parentSettings,
    });
    return { child, parent };
  }

  it('stops the child at once when the parent is stopped', async () => {
    const { client, tenant } = await signup(server.app);
    const { child, parent } = await parentAndChild(client);
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const childRow = await waitFor(
      async () => {
        const [row] = await executionsOf(server.ctx, tenant.id, child.id);
        return row?.status === 'running' ? row : undefined;
      },
      { message: 'child running' },
    );
    const started = Date.now();
    const stopped = await client.data(client.post(`/rest/executions/${executionId}/stop`));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stopped.status).toBe('canceled');
    const row = await waitForExecution(server.ctx, tenant.id, childRow.id, ['canceled', 'success'], 3000);
    expect(row.status).toBe('canceled');
    const data = await server.ctx.repos.executions.getData(tenant.id, childRow.id);
    expect((data!.state as any).resultData.runData.After).toBeUndefined();
  });

  it('stops the child when the parent times out', async () => {
    const { client, tenant } = await signup(server.app);
    const { child, parent } = await parentAndChild(client, { executionTimeout: 1 });
    const started = Date.now();
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const row = await waitForExecution(
      server.ctx,
      tenant.id,
      executionId,
      ['error', 'canceled', 'success'],
      5000,
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(row.status).toBe('error');
    expect(row.errorMessage).toContain('timeout');
    const [childRow] = await executionsOf(server.ctx, tenant.id, child.id);
    expect(
      (await waitForExecution(server.ctx, tenant.id, childRow.id, ['canceled', 'success'], 3000)).status,
    ).toBe('canceled');
  });
});
