/**
 * P6-58 (S5 L1): the run events. A two-node run emits `workflow.started`, `node.started`, `node.finished` per node
 * and `workflow.success` in that order with its execution id; a failure, a wait and its resume, a stop and a crash
 * emit their events; tenant B's run reaches no event of tenant A; a Code node emits the two runner events; a failing
 * run with `redactionPolicy: 'all'` emits `workflow.failed` with no `errorMessage`; no node data is in any event.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/services/events/stream';
import {
  captureEvents,
  chain,
  createTestServer,
  createWorkflow,
  node,
  setNode,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

const CANARY = 'canary-value-9f2c41';
const CANARY_ERROR = 'canary-error-text-77ab';

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;
let other: Awaited<ReturnType<typeof signup>>;
let capture: ReturnType<typeof captureEvents>;

beforeAll(async () => {
  server = await createTestServer();
  owner = await signup(server.app, { remoteAddress: '10.58.0.1' });
  other = await signup(server.app, { remoteAddress: '10.58.0.2' });
}, 120_000);
afterAll(async () => {
  await server?.close();
});
afterEach(() => capture?.stop());

async function run(
  who: typeof owner,
  nodes: WorkflowNode[],
  connections: unknown,
  settings?: Record<string, unknown>,
) {
  const name = `Events ${randomUUID().slice(0, 8)}`;
  const created = await createWorkflow(who.client, {
    name,
    nodes,
    connections,
    ...(settings ? { settings } : {}),
  });
  const workflow = { ...created, name };
  const { executionId } = await who.client.data<{ executionId: string }>(
    who.client.post(`/rest/workflows/${workflow.id}/run`, {}),
  );
  return { workflow, executionId };
}

/** the events of one execution in emit order, after the stream has delivered them */
async function eventsOf(executionId: string): Promise<StreamEvent[]> {
  await server.ctx.events.flush();
  return capture.events.filter((event) => event.payload.executionId === executionId);
}

const namesOf = (events: StreamEvent[]) => events.map((event) => event.eventName);

describe('workflow and node events', () => {
  it('a two-node run emits started, node started and finished per node, then success, in order', async () => {
    capture = captureEvents(server.ctx);
    const { workflow, executionId } = await run(
      owner,
      [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
      chain('Start', 'Mark'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const events = await eventsOf(executionId);
    expect(namesOf(events).filter((name) => !name.startsWith('audit.'))).toEqual([
      'workflow.started',
      'node.started',
      'node.finished',
      'node.started',
      'node.finished',
      'workflow.success',
    ]);
    // n8n's two forms of the run audit: here with the person who ran it
    expect(namesOf(events)).toContain('audit.workflow.executed');
    const started = events.find((event) => event.eventName === 'workflow.started')!;
    expect(started.tenantId).toBe(owner.tenant.id);
    expect(started.payload).toMatchObject({
      executionId,
      userId: owner.user.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      isManual: true,
      mode: 'manual',
    });
    const executed = events.find((event) => event.eventName === 'audit.workflow.executed')!;
    expect(executed.payload).toMatchObject({
      userId: owner.user.id,
      _email: owner.user.email,
      globalRole: 'owner',
      workflowId: workflow.id,
    });
    const mark = events.filter((event) => event.eventName === 'node.finished')[1];
    expect(mark.payload).toMatchObject({
      workflowId: workflow.id,
      workflowName: workflow.name,
      executionId,
      nodeType: 'core.set',
      nodeName: 'Mark',
    });
    expect(typeof mark.payload.nodeId).toBe('string');
    const success = events.find((event) => event.eventName === 'workflow.success')!;
    expect(success.payload).toMatchObject({ success: true, executionId, lastNodeExecuted: 'Mark' });
    // a team project carries its name
    expect(success.payload.projectId).toBe(owner.client.defaultProjectId);
    expect(typeof success.payload.projectName).toBe('string');
  });

  it('no node data, value or item ever appears in an event', async () => {
    capture = captureEvents(server.ctx);
    const { executionId } = await run(
      owner,
      [node('Start', 'core.manualTrigger'), setNode('Mark', 'secret', CANARY)],
      chain('Start', 'Mark'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    expect((await eventsOf(executionId)).length).toBeGreaterThan(4);
    await server.ctx.events.flush();
    expect(JSON.stringify(capture.events)).not.toContain(CANARY);
  });

  it('a failure emits workflow.failed with the failing node and its message', async () => {
    capture = captureEvents(server.ctx);
    const { executionId } = await run(
      owner,
      [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', { message: CANARY_ERROR }, [200, 0])],
      chain('Start', 'Boom'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    const events = await eventsOf(executionId);
    const failed = events.find((event) => event.eventName === 'workflow.failed')!;
    expect(failed.payload).toMatchObject({
      success: false,
      executionId,
      errorMessage: CANARY_ERROR,
      errorNodeType: 'test.fail',
      lastNodeExecuted: 'Boom',
    });
    expect(namesOf(events)).not.toContain('workflow.success');
  });

  it("a failing run with redactionPolicy 'all' emits workflow.failed with no errorMessage", async () => {
    capture = captureEvents(server.ctx);
    const { executionId } = await run(
      owner,
      [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', { message: CANARY_ERROR }, [200, 0])],
      chain('Start', 'Boom'),
      { redactionPolicy: 'all' },
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    const events = await eventsOf(executionId);
    const failed = events.find((event) => event.eventName === 'workflow.failed')!;
    expect(failed.payload.success).toBe(false);
    expect(failed.payload.lastNodeExecuted).toBe('Boom');
    expect('errorMessage' in failed.payload).toBe(false);
    await server.ctx.events.flush();
    expect(JSON.stringify(capture.events)).not.toContain(CANARY_ERROR);
  });

  it('a wait emits audit.workflow.waiting; its resume emits audit.workflow.resumed and then success', async () => {
    capture = captureEvents(server.ctx);
    const { executionId } = await run(
      owner,
      [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        setNode('After', 'done', 'yes', [400, 0]),
      ],
      chain('Start', 'Wait', 'After'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['waiting']);
    expect(namesOf(await eventsOf(executionId))).toContain('audit.workflow.waiting');
    const resumePath = new URL(server.ctx.executions.resumeUrl(executionId)).pathname;
    const res = await server.app.inject({ method: 'POST', url: resumePath, payload: { approved: true } });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const names = namesOf(await eventsOf(executionId));
    expect(names.filter((name) => name === 'workflow.started')).toHaveLength(1);
    expect(names.indexOf('audit.workflow.waiting')).toBeLessThan(names.indexOf('audit.workflow.resumed'));
    expect(names.indexOf('audit.workflow.resumed')).toBeLessThan(names.lastIndexOf('workflow.success'));
    expect(names.at(-1)).toBe('workflow.success');
  });

  it('a stop of a waiting run emits workflow.cancelled', async () => {
    capture = captureEvents(server.ctx);
    const { workflow, executionId } = await run(
      owner,
      [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', {}, [200, 0])],
      chain('Start', 'Wait'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['waiting']);
    await owner.client.data(owner.client.post(`/rest/executions/${executionId}/stop`));
    const events = await eventsOf(executionId);
    const cancelled = events.find((event) => event.eventName === 'workflow.cancelled')!;
    expect(cancelled.payload).toMatchObject({
      executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
    });
  });

  it('a crash found at startup emits workflow.failed', async () => {
    capture = captureEvents(server.ctx);
    const id = randomUUID();
    const workflow = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    await server.ctx.repos.executions.create(
      owner.tenant.id,
      {
        id,
        workflowId: workflow.id,
        mode: 'webhook',
        status: 'running',
        workflowName: 'Crashy',
        startedAt: new Date(),
      } as never,
      { workflowData: { name: 'Crashy', nodes: [], connections: {}, settings: {} }, runOptions: {} },
    );
    expect(await server.ctx.executions.markCrashed()).toBeGreaterThanOrEqual(1);
    const failed = (await eventsOf(id)).find((event) => event.eventName === 'workflow.failed')!;
    expect(failed.payload).toMatchObject({
      executionId: id,
      success: false,
      isManual: false,
      mode: 'webhook',
    });
    expect('errorMessage' in failed.payload).toBe(false);
  });
});

describe('tenants', () => {
  it("tenant B's run reaches no event of tenant A", async () => {
    capture = captureEvents(server.ctx);
    const a = await run(owner, [node('Start', 'core.manualTrigger')], {});
    const b = await run(other, [node('Start', 'core.manualTrigger')], {});
    await waitForExecution(server.ctx, owner.tenant.id, a.executionId, ['success']);
    await waitForExecution(server.ctx, other.tenant.id, b.executionId, ['success']);
    await server.ctx.events.flush();
    const forA = capture.events.filter((event) => event.tenantId === owner.tenant.id);
    const forB = capture.events.filter((event) => event.tenantId === other.tenant.id);
    expect(forA.some((event) => event.payload.executionId === b.executionId)).toBe(false);
    expect(forB.some((event) => event.payload.executionId === a.executionId)).toBe(false);
    expect(forA.some((event) => event.payload.executionId === a.executionId)).toBe(true);
    expect(forB.some((event) => event.payload.executionId === b.executionId)).toBe(true);
    for (const event of capture.events) {
      if (event.payload.executionId === a.executionId) expect(event.tenantId).toBe(owner.tenant.id);
      if (event.payload.executionId === b.executionId) expect(event.tenantId).toBe(other.tenant.id);
    }
  });
});

describe('runner events', () => {
  it('a Code node emits runner.task.requested and runner.response.received around its task', async () => {
    capture = captureEvents(server.ctx);
    const { workflow, executionId } = await run(
      owner,
      [
        node('Start', 'core.manualTrigger'),
        node(
          'Code',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: `return [{ json: { secret: '${CANARY}' } }]` },
          [200, 0],
        ),
      ],
      chain('Start', 'Code'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const events = await eventsOf(executionId);
    const names = namesOf(events);
    const requested = events.find((event) => event.eventName === 'runner.task.requested')!;
    const received = events.find((event) => event.eventName === 'runner.response.received')!;
    expect(requested.payload).toMatchObject({ executionId, workflowId: workflow.id, nodeName: 'Code' });
    expect(typeof requested.payload.taskId).toBe('string');
    expect(received.payload.taskId).toBe(requested.payload.taskId);
    expect(names.indexOf('runner.task.requested')).toBeLessThan(names.indexOf('runner.response.received'));
    expect(names.indexOf('runner.response.received')).toBeLessThan(names.indexOf('workflow.success'));
    // neither the code nor its result goes into an event
    await server.ctx.events.flush();
    expect(JSON.stringify(capture.events)).not.toContain(CANARY);
  });
});
