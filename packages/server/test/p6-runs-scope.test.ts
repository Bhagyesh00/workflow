/**
 * P6-25 (L5): runs follow the access to their workflow. A true `member` (invited as `member`, given a project
 * role through `addToProject`) reads the runs of its projects only, with `scopes` from the workflow in the
 * detail; a run with no workflow is owner and admin only. An inline sub-run belongs to the workflow that
 * called it (and a retry of it keeps the inline definition); the caller policy compares both projects; an
 * error workflow of another project is refused by the same check.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowRow } from '../src/db/schema';
import { assertCallerAllowed, type StoredRunOptions } from '../src/services/executions';
import {
  addToProject,
  chain,
  createTestServer,
  executionsOf,
  memberAs,
  node,
  projectIn,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

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

/** an owner, a member and two team projects; the member is `role` in `alpha` and nothing in `beta` */
async function setup(role = 'project:viewer') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, { name: 'In beta' });
  return { owner, member, alpha, beta, inAlpha, inBeta, tenantId: owner.tenant.id };
}

/** a finished run row of `workflowId` (null = a run with no workflow) */
async function runOf(tenantId: string, workflowId: string | null, status = 'error'): Promise<string> {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    {
      id,
      workflowId,
      workflowName: 'Run',
      mode: 'manual',
      status,
      startedAt: new Date(),
      stoppedAt: new Date(),
    },
    { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
  );
  return id;
}

const definitionOf = (row: WorkflowRow): WorkflowDefinition => ({
  id: row.id,
  name: row.name,
  nodes: row.nodes as WorkflowNode[],
  connections: row.connections as WorkflowDefinition['connections'],
  settings: row.settings as WorkflowDefinition['settings'],
});

/** run a saved workflow from its first node and wait for the result */
async function runSaved(tenantId: string, row: WorkflowRow, mode: 'manual' | 'trigger' = 'manual') {
  const started = await server.ctx.executions.start({
    tenantId,
    workflow: definitionOf(row),
    workflowId: row.id,
    mode,
    startNode: (row.nodes as WorkflowNode[])[0].name,
    wait: true,
  });
  const outcome = await started.finished!;
  return { executionId: started.executionId, outcome };
}

const calledWorkflow = (settings: Record<string, unknown> = {}) => ({
  name: 'Child',
  nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Double', 'doubled', 'yes')],
  connections: chain('Called', 'Double'),
  settings,
});

const callerOf = (childId: string) => ({
  name: 'Parent',
  nodes: [
    node('Start', 'core.manualTrigger'),
    node('Call', 'test.callWorkflow', { workflowId: childId }, [200, 0]),
  ],
  connections: chain('Start', 'Call'),
});

/** a parent whose Execute Workflow node runs `inline` (source "Workflow JSON") */
const inlineCaller = (inline: { nodes: WorkflowNode[]; connections: unknown }) => ({
  name: 'Inline parent',
  nodes: [
    node('Start', 'core.manualTrigger'),
    node(
      'Run inline',
      'core.executeWorkflow',
      { source: 'parameter', workflowJson: JSON.stringify({ name: 'Inline', ...inline }) },
      [200, 0],
    ),
  ],
  connections: chain('Start', 'Run inline'),
});

describe('execution routes by workflow scope', () => {
  it('a project viewer gets execution:read and no execution:delete in the detail scopes', async () => {
    const { member, inAlpha, tenantId } = await setup('project:viewer');
    const id = await runOf(tenantId, inAlpha.id);
    const res = await member.client.get(`/rest/executions/${id}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.id).toBe(id);
    expect(data.scopes).toContain('execution:read');
    expect(data.scopes).not.toContain('execution:delete');
    // the viewer cannot delete, retry or stop it
    const del = await member.client.delete(`/rest/executions/${id}`);
    expect(del.statusCode).toBe(403);
    expect(del.json().error.message).toBe(FORBIDDEN);
    expect((await member.client.post(`/rest/executions/${id}/retry`, {})).statusCode).toBe(403);
    expect((await member.client.post(`/rest/executions/${id}/stop`, {})).statusCode).toBe(403);
    expect(await server.ctx.repos.executions.get(tenantId, id)).toBeDefined();
  });

  it('a project editor deletes the runs of its project', async () => {
    const { member, inAlpha, tenantId } = await setup('project:editor');
    const id = await runOf(tenantId, inAlpha.id);
    const data = await member.client.data(member.client.get(`/rest/executions/${id}`));
    expect(data.scopes).toContain('execution:delete');
    expect((await member.client.delete(`/rest/executions/${id}`)).statusCode).toBe(200);
    expect(await server.ctx.repos.executions.get(tenantId, id)).toBeUndefined();
  });

  it('a member cannot read, delete, retry or stop a run of another project', async () => {
    const { member, inBeta, tenantId } = await setup('project:editor');
    const id = await runOf(tenantId, inBeta.id);
    for (const res of [
      await member.client.get(`/rest/executions/${id}`),
      await member.client.delete(`/rest/executions/${id}`),
      await member.client.post(`/rest/executions/${id}/retry`, {}),
      await member.client.post(`/rest/executions/${id}/stop`, {}),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('lists only the runs the caller can read; a run with no workflow is owner and admin only', async () => {
    const { owner, member, inAlpha, inBeta, tenantId } = await setup();
    const admin = await memberAs(owner, 'admin');
    const own = await runOf(tenantId, inAlpha.id);
    const hidden = await runOf(tenantId, inBeta.id);
    const orphan = await runOf(tenantId, null);

    const ids = async (client: typeof owner.client, query = '') =>
      ((await client.data(client.get(`/rest/executions${query}`))) as Array<{ id: string }>).map((r) => r.id);
    expect(await ids(member.client)).toEqual([own]);
    expect(await ids(member.client, `?workflowId=${inBeta.id}`)).toEqual([]);
    expect(new Set(await ids(owner.client))).toEqual(new Set([own, hidden, orphan]));
    expect(new Set(await ids(admin.client))).toEqual(new Set([own, hidden, orphan]));

    const res = await member.client.get(`/rest/executions/${orphan}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(FORBIDDEN);
    expect((await owner.client.get(`/rest/executions/${orphan}`)).statusCode).toBe(200);
    expect((await admin.client.get(`/rest/executions/${orphan}`)).statusCode).toBe(200);
  });

  it('a run of another workspace is 404', async () => {
    const { owner } = await setup();
    const other = await signup(server.app);
    const otherProject = await projectIn(server, other.tenant.id, 'Other');
    const foreign = await workflowIn(server, other.tenant.id, otherProject.id);
    const id = await runOf(other.tenant.id, foreign.id);
    expect((await owner.client.get(`/rest/executions/${id}`)).statusCode).toBe(404);
    expect((await owner.client.delete(`/rest/executions/${id}`)).statusCode).toBe(404);
    expect((await owner.client.post(`/rest/executions/${id}/retry`, {})).statusCode).toBe(404);
  });
});

describe('inline sub-runs', () => {
  it('record the parent workflow, so the parent project reads them', async () => {
    const { member, alpha, tenantId } = await setup('project:viewer');
    const parent = await workflowIn(server, tenantId, alpha.id, {
      ...inlineCaller({
        nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Mark', 'inline', 'yes')],
        connections: chain('Called', 'Mark'),
      }),
    });
    const { executionId, outcome } = await runSaved(tenantId, parent);
    expect(outcome.status).toBe('success');
    const sub = (await executionsOf(server.ctx, tenantId, parent.id)).find(
      (r) => r.parentExecutionId === executionId,
    );
    expect(sub).toBeDefined();
    expect(sub!.workflowId).toBe(parent.id);
    const data = await server.ctx.repos.executions.getData(tenantId, sub!.id);
    expect((data!.runOptions as StoredRunOptions).inlineSource).toBe(true);
    expect((data!.workflowData as unknown as WorkflowDefinition).id).toBe(parent.id);

    const res = await member.client.get(`/rest/executions/${sub!.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.workflowId).toBe(parent.id);
  });

  it('a retry with the current workflow keeps the inline definition', async () => {
    const { owner, alpha, tenantId } = await setup();
    const parent = await workflowIn(server, tenantId, alpha.id, {
      ...inlineCaller({
        nodes: [node('Called', 'core.executeWorkflowTrigger'), node('Fail', 'test.fail', {}, [200, 0])],
        connections: chain('Called', 'Fail'),
      }),
    });
    const { executionId } = await runSaved(tenantId, parent);
    const sub = (await executionsOf(server.ctx, tenantId, parent.id)).find(
      (r) => r.parentExecutionId === executionId,
    );
    expect(sub?.status).toBe('error');

    const retried = await owner.client.data(
      owner.client.post(`/rest/executions/${sub!.id}/retry`, { useCurrentWorkflow: true }),
    );
    await waitForExecution(server.ctx, tenantId, retried.executionId);
    const data = await server.ctx.repos.executions.getData(tenantId, retried.executionId);
    const names = (data!.workflowData as unknown as WorkflowDefinition).nodes.map((n) => n.name);
    // the inline nodes, not the parent's
    expect(names).toEqual(['Called', 'Fail']);
    expect((data!.runOptions as StoredRunOptions).inlineSource).toBe(true);
    const row = await server.ctx.repos.executions.get(tenantId, retried.executionId);
    expect(row?.workflowId).toBe(parent.id);
  });
});

describe('sub-workflow caller policy', () => {
  it('a workflow with no policy is called from its own project only (WORKFLOW_CALLER_POLICY_DEFAULT_OPTION)', async () => {
    const { alpha, beta, tenantId } = await setup();
    const sameChild = await workflowIn(server, tenantId, alpha.id, calledWorkflow());
    const same = await workflowIn(server, tenantId, alpha.id, callerOf(sameChild.id));
    expect((await runSaved(tenantId, same)).outcome.status).toBe('success');

    const otherChild = await workflowIn(server, tenantId, beta.id, calledWorkflow());
    const across = await workflowIn(server, tenantId, alpha.id, callerOf(otherChild.id));
    const refused = await runSaved(tenantId, across);
    expect(refused.outcome.status).toBe('error');
    expect(refused.outcome.error?.message).toMatch(/can only be called by workflows of its own project/);
    expect(await executionsOf(server.ctx, tenantId, otherChild.id)).toHaveLength(0);
  });

  it('an explicit any is called from every project, and sameProject refuses the other one', async () => {
    const { alpha, beta, tenantId } = await setup();
    const open = await workflowIn(server, tenantId, beta.id, calledWorkflow({ callerPolicy: 'any' }));
    const toOpen = await workflowIn(server, tenantId, alpha.id, callerOf(open.id));
    expect((await runSaved(tenantId, toOpen)).outcome.status).toBe('success');

    const closed = await workflowIn(
      server,
      tenantId,
      beta.id,
      calledWorkflow({ callerPolicy: 'sameProject' }),
    );
    const toClosed = await workflowIn(server, tenantId, alpha.id, callerOf(closed.id));
    expect((await runSaved(tenantId, toClosed)).outcome.status).toBe('error');
  });

  it('assertCallerAllowed compares both project ids and takes the configured default', () => {
    const caller = { workflowId: 'w1', projectId: 'p1' };
    expect(() => assertCallerAllowed('Child', {}, caller, 'p1', 'sameProject')).not.toThrow();
    expect(() => assertCallerAllowed('Child', {}, caller, 'p2', 'sameProject')).toThrow(
      'Workflow "Child" can only be called by workflows of its own project',
    );
    expect(() => assertCallerAllowed('Child', {}, caller, 'p2', 'any')).not.toThrow();
    expect(() =>
      assertCallerAllowed('Child', { callerPolicy: 'sameProject' }, caller, 'p2', 'any'),
    ).toThrow();
    expect(() => assertCallerAllowed('Child', { callerPolicy: 'any' }, caller, 'p2', 'none')).not.toThrow();
    // no caller project (a run with no workflow and no stored project) never passes sameProject
    expect(() => assertCallerAllowed('Child', {}, { workflowId: undefined }, 'p1', 'sameProject')).toThrow();
    expect(() =>
      assertCallerAllowed(
        'Child',
        { callerPolicy: 'allowList', callerIds: ['w1'] },
        caller,
        'p2',
        'sameProject',
      ),
    ).not.toThrow();
    expect(() => assertCallerAllowed('Child', { callerPolicy: 'none' }, caller, 'p1', 'any')).toThrow(
      'does not allow being called by other workflows',
    );
    expect(server.ctx.config.workflowCallerPolicyDefault).toBe('sameProject');
  });
});

describe('error workflow', () => {
  const errorWorkflow = (settings: Record<string, unknown> = {}) => ({
    name: 'On error',
    nodes: [node('Error Trigger', 'core.errorTrigger')],
    settings,
  });
  const failing = (errorWorkflowId: string) => ({
    name: 'Failing',
    nodes: [node('Start', 'core.manualTrigger'), node('Fail', 'test.fail', {}, [200, 0])],
    connections: chain('Start', 'Fail'),
    settings: { errorWorkflow: errorWorkflowId },
  });
  const errorRuns = async (tenantId: string, workflowId: string) =>
    (await executionsOf(server.ctx, tenantId, workflowId)).filter((r) => r.mode === 'error');

  it('runs one of the same project', async () => {
    const { alpha, tenantId } = await setup();
    const handler = await workflowIn(server, tenantId, alpha.id, errorWorkflow());
    const source = await workflowIn(server, tenantId, alpha.id, failing(handler.id));
    expect((await runSaved(tenantId, source, 'trigger')).outcome.status).toBe('error');
    await waitFor(async () => (await errorRuns(tenantId, handler.id)).length === 1, {
      message: 'the error workflow run',
    });
  });

  it('refuses one of another project, and runs it when its policy is any', async () => {
    const { alpha, beta, tenantId } = await setup();
    const foreign = await workflowIn(server, tenantId, beta.id, errorWorkflow());
    const source = await workflowIn(server, tenantId, alpha.id, failing(foreign.id));
    expect((await runSaved(tenantId, source, 'trigger')).outcome.status).toBe('error');
    await new Promise((r) => setTimeout(r, 300));
    expect(await errorRuns(tenantId, foreign.id)).toHaveLength(0);

    const open = await workflowIn(server, tenantId, beta.id, errorWorkflow({ callerPolicy: 'any' }));
    const source2 = await workflowIn(server, tenantId, alpha.id, failing(open.id));
    await runSaved(tenantId, source2, 'trigger');
    await waitFor(async () => (await errorRuns(tenantId, open.id)).length === 1, {
      message: 'the error workflow run',
    });
  });

  it('refuses one of another project after an activation failure', async () => {
    const { alpha, beta, tenantId } = await setup();
    const foreign = await workflowIn(server, tenantId, beta.id, errorWorkflow());
    const source = await workflowIn(server, tenantId, alpha.id, failing(foreign.id));
    await expect(
      server.ctx.executions.runActivationErrorWorkflow(tenantId, source.id, { message: 'boom' }),
    ).rejects.toThrow(/can only be called by workflows of its own project/);
    expect(await errorRuns(tenantId, foreign.id)).toHaveLength(0);

    const own = await workflowIn(server, tenantId, alpha.id, errorWorkflow());
    const source2 = await workflowIn(server, tenantId, alpha.id, failing(own.id));
    await server.ctx.executions.runActivationErrorWorkflow(tenantId, source2.id, { message: 'boom' });
    await waitFor(async () => (await errorRuns(tenantId, own.id)).length === 1, {
      message: 'the error workflow run',
    });
  });
});
