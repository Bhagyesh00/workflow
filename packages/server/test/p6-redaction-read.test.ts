/**
 * P6-53 (L8), the read side of execution data redaction: a list row's blank error text, the detail with its
 * items cleared and `redactionInfo`, reveal (scope, 403 code, audit rows), a page of 100 runs with one facts
 * query, the public API, the binary file of a redacted run, another workspace, and what a sub-workflow
 * reports to its caller.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowDefinition } from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog } from '../src/db/schema';
import { getExecution } from '../src/routes/executions';
import {
  addToProject,
  chain,
  createTestServer,
  node,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

const CANARY = 'canary-read-value';
const CANARY_ERROR = 'canary-read-error';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000', BINARY_DATA_MODE: 'filesystem' },
    { startMain: false },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

type Owner = Awaited<ReturnType<typeof signup>>;

/** signup allows 20 calls an hour per IP: each workspace signs up from its own address */
let address = 0;
const fresh = () => {
  address += 1;
  return signup(server.app, { remoteAddress: `10.54.${Math.floor(address / 250)}.${(address % 250) + 1}` });
};

const definitionOf = (row: {
  id: string;
  name: string;
  nodes: unknown;
  connections: unknown;
  settings: unknown;
}) =>
  ({
    id: row.id,
    name: row.name,
    nodes: row.nodes,
    connections: row.connections,
    settings: row.settings,
  }) as WorkflowDefinition;

const okFlow = (settings: Record<string, unknown> = {}) => ({
  name: `Flow ${randomUUID().slice(0, 6)}`,
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'secret', CANARY)],
  connections: chain('Start', 'Set'),
  settings,
});

const failingFlow = (settings: Record<string, unknown> = {}) => ({
  name: `Failing ${randomUUID().slice(0, 6)}`,
  nodes: [
    node('Start', 'core.manualTrigger'),
    node('Boom', 'core.stopAndError', { errorMessage: CANARY_ERROR }, [200, 0]),
  ],
  connections: chain('Start', 'Boom'),
  settings,
});

/** the start node of every flow here is the first node */
async function run(
  owner: Owner,
  row: { id: string; name: string; nodes: unknown; connections: unknown; settings: unknown },
  mode: 'manual' | 'trigger' = 'manual',
) {
  const started = await server.ctx.executions.start({
    tenantId: owner.tenant.id,
    workflow: definitionOf(row),
    workflowId: row.id,
    mode,
    startNode: (row.nodes as Array<{ name: string }>)[0].name,
    userId: owner.user.id,
    wait: true,
  });
  await started.finished;
  return started.executionId;
}

const detailOf = (client: Owner['client'], id: string, query = '') =>
  client.data(client.get(`/rest/executions/${id}${query}`));

const itemsOf = (detail: any, name: string) => detail.state.resultData.runData[name][0].data?.main?.[0] ?? [];

/** an owner, a project editor and a project admin on the team project, and a saved flow in it */
async function scene(settings: Record<string, unknown> = { redactionPolicy: 'all' }, flow = okFlow) {
  const owner = await fresh();
  const team = await teamProjectOf(server, owner.tenant.id);
  const editor = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
  const admin = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, admin.user.id, 'project:admin');
  const row = await workflowIn(server, owner.tenant.id, team, flow(settings));
  return { owner, team, editor, admin, row };
}

describe('a redacted run', () => {
  it('clears the items, says why, and blanks the error text in the detail and the list', async () => {
    const { owner, row } = await scene({ redactionPolicy: 'all' }, failingFlow);
    const id = await run(owner, row);
    const detail = await detailOf(owner.client, id);
    expect(detail.redactionInfo).toEqual({
      isRedacted: true,
      reason: 'workflow_redaction_policy',
      canReveal: true,
    });
    expect(detail.errorMessage).toBe('');
    expect(detail.state.resultData.error).toBeUndefined();
    expect(detail.redactedError.node).toBe('Boom');
    expect(JSON.stringify([detail.state, detail.errorMessage, detail.redactedError])).not.toContain(
      CANARY_ERROR,
    );
    const list = await owner.client.data(owner.client.get('/rest/executions'));
    const listed =
      (list as any[]).find((r) => r.id === id) ?? (list as any).results?.find((r: any) => r.id === id);
    expect(listed.errorMessage).toBe('');
  });

  it('shows the items of a run that no channel redacts, with no redactionInfo', async () => {
    const { owner, row } = await scene({ redactionPolicy: 'non-manual' });
    const manual = await detailOf(owner.client, await run(owner, row, 'manual'));
    expect(manual.redactionInfo).toBeUndefined();
    expect(itemsOf(manual, 'Set')).toHaveLength(1);
    const production = await detailOf(owner.client, await run(owner, row, 'trigger'));
    expect(production.redactionInfo?.isRedacted).toBe(true);
    expect(itemsOf(production, 'Set')).toHaveLength(0);
  });

  it('keeps its custom data, in the detail and in the list, as n8n', async () => {
    const { owner, row } = await scene({ redactionPolicy: 'all' });
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(row),
      workflowId: row.id,
      mode: 'manual',
      startNode: 'Start',
      userId: owner.user.id,
      customData: { orderId: 'order-7' },
      wait: true,
    });
    await started.finished;
    const detail = await detailOf(owner.client, started.executionId);
    expect(detail.redactionInfo?.isRedacted).toBe(true);
    expect(detail.customData).toEqual({ orderId: 'order-7' });
    expect(detail.state.resultData.customData).toEqual({ orderId: 'order-7' });
    expect(itemsOf(detail, 'Set')).toHaveLength(0);
    const list = await owner.client.data(owner.client.get(`/rest/executions?workflowId=${row.id}`));
    const rows: any[] = Array.isArray(list) ? list : ((list as any).results ?? (list as any).data ?? []);
    expect(rows.find((r) => r.id === started.executionId)?.customData).toEqual({ orderId: 'order-7' });
  });

  it('keeps the run in another workspace out of reach (404)', async () => {
    const { owner, row } = await scene();
    const id = await run(owner, row);
    const other = await fresh();
    expect((await other.client.get(`/rest/executions/${id}`)).statusCode).toBe(404);
  });

  it('the public API returns cleared items and no error text', async () => {
    const { owner, row } = await scene({ redactionPolicy: 'all' }, failingFlow);
    const id = await run(owner, row);
    const made = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'read-key' }));
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/executions/${id}?includeData=true`,
      headers: { 'x-api-key': made.key as string },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.redactionInfo.isRedacted).toBe(true);
    const body = res.json().data;
    expect(JSON.stringify([body.state, body.errorMessage, body.redactedError])).not.toContain(CANARY_ERROR);
  });
});

describe('reveal', () => {
  it('needs execution:reveal: a project editor is refused with the code, and it is logged', async () => {
    const { owner, editor, row } = await scene();
    const id = await run(owner, row);
    const seen = await detailOf(editor.client, id);
    expect(seen.redactionInfo).toMatchObject({ isRedacted: true, canReveal: false });
    const refused = await editor.client.get(`/rest/executions/${id}?redactExecutionData=false`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('EXECUTION_REVEAL_FORBIDDEN');
    expect(refused.body).not.toContain(CANARY);
    const rows = await server.ctx.database.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, owner.tenant.id), eq(auditLog.action, 'execution.data.reveal_failed')),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(editor.user.id);
    expect(rows[0].resourceId).toBe(id);
  });

  it('shows the items to a project admin and the owner, each logged once as revealed', async () => {
    const { owner, admin, row } = await scene();
    const id = await run(owner, row);
    expect((await detailOf(admin.client, id)).redactionInfo.canReveal).toBe(true);
    for (const who of [admin, owner]) {
      const revealed = await detailOf(who.client, id, '?redactExecutionData=false');
      expect(revealed.redactionInfo).toBeUndefined();
      expect(itemsOf(revealed, 'Set')[0].json.secret).toBe(CANARY);
    }
    const rows = await server.ctx.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, owner.tenant.id), eq(auditLog.action, 'execution.data.revealed')));
    expect(rows.map((r) => r.userId).sort()).toEqual([admin.user.id, owner.user.id].sort());
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain(CANARY);
  });

  it('writes no audit row when the run is not redacted', async () => {
    const { owner, row } = await scene({});
    const id = await run(owner, row);
    expect(itemsOf(await detailOf(owner.client, id, '?redactExecutionData=false'), 'Set')).toHaveLength(1);
    const rows = await server.ctx.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, owner.tenant.id), eq(auditLog.action, 'execution.data.revealed')));
    expect(rows).toHaveLength(0);
  });

  it('a file of a redacted run is refused to a viewer without the scope and served with it', async () => {
    const { owner, editor, row } = await scene();
    const id = await run(owner, row);
    const stored = await server.ctx.executions
      .binaryStore(owner.tenant.id)
      .store(new TextEncoder().encode('file body'.padEnd(70_000, '.')), {
        mimeType: 'text/plain',
        executionId: id,
      });
    const url = `/rest/binary-data?id=${encodeURIComponent(stored.id!)}`;
    const refused = await editor.client.get(url);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('EXECUTION_REVEAL_FORBIDDEN');
    expect((await editor.client.get(`${url}&redactExecutionData=false`)).statusCode).toBe(403);
    const served = await owner.client.get(`${url}&redactExecutionData=false`);
    expect(served.statusCode).toBe(200);
    expect(served.body.startsWith('file body')).toBe(true);
  });
});

describe('a page of runs', () => {
  it('100 runs make one facts query and every error text is blank', async () => {
    const { owner, row } = await scene();
    const total = 100;
    for (let i = 0; i < total; i += 1) {
      await server.ctx.repos.executions.create(
        owner.tenant.id,
        {
          id: randomUUID(),
          workflowId: row.id,
          workflowName: row.name,
          mode: 'trigger',
          status: 'error',
          errorMessage: `${CANARY_ERROR} ${i}`,
        },
        {
          workflowData: { nodes: row.nodes },
          runOptions: { redaction: { production: true, manual: true } },
        },
      );
    }
    const spy = vi.spyOn(server.ctx.repos.executions, 'redactionFacts');
    try {
      const res = await owner.client.get(`/rest/executions?limit=100`);
      expect(res.statusCode).toBe(200);
      const rows = res.json().data as any;
      const list: any[] = Array.isArray(rows) ? rows : (rows.results ?? rows.data ?? []);
      expect(list).toHaveLength(total);
      expect(list.every((r) => r.errorMessage === '')).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what a sub-workflow reports to its caller', () => {
  const child = (settings: Record<string, unknown>, extra: Array<ReturnType<typeof node>> = []) => ({
    name: `Child ${randomUUID().slice(0, 6)}`,
    nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Double', 'doubled', CANARY), ...extra],
    connections: chain('Called', 'Double', ...extra.map((n) => n.name)),
    settings,
  });
  const call = (name: string, childId: string, x = 200) =>
    node(name, 'test.callWorkflow', { workflowId: childId }, [x, 0]);
  const parent = (settings: Record<string, unknown>, ...calls: Array<ReturnType<typeof node>>) => ({
    name: `Parent ${randomUUID().slice(0, 6)}`,
    nodes: [node('Start', 'core.manualTrigger'), ...calls],
    connections: chain('Start', ...calls.map((c) => c.name)),
    settings,
  });

  async function parentRun(
    owner: Owner,
    team: string,
    settings: Record<string, unknown>,
    ...calls: Array<ReturnType<typeof node>>
  ) {
    const row = await workflowIn(server, owner.tenant.id, team, parent(settings, ...calls));
    const id = await run(owner, row);
    return detailOf(owner.client, id);
  }

  it('a child with policy all makes its caller redacted, whatever the caller says', async () => {
    const { owner, team } = await scene();
    const kid = await workflowIn(server, owner.tenant.id, team, child({ redactionPolicy: 'all' }));
    const detail = await parentRun(owner, team, { redactionPolicy: 'none' }, call('Call', kid.id));
    expect(detail.redactionInfo).toMatchObject({ isRedacted: true, reason: 'sub_workflow_redaction_policy' });
    expect(itemsOf(detail, 'Call')).toHaveLength(0);
    expect(JSON.stringify(detail)).not.toContain(CANARY);
  });

  it('a child that sets redactCallerExecutions to false leaves its caller alone', async () => {
    const { owner, team } = await scene();
    const kid = await workflowIn(
      server,
      owner.tenant.id,
      team,
      child({ redactionPolicy: 'all', redactCallerExecutions: false }),
    );
    const detail = await parentRun(owner, team, { redactionPolicy: 'none' }, call('Call', kid.id));
    expect(detail.redactionInfo).toBeUndefined();
    expect(itemsOf(detail, 'Call').length).toBeGreaterThan(0);
  });

  it("a grandchild's channel still passes up through a child that does not redact its caller", async () => {
    const { owner, team } = await scene();
    const grand = await workflowIn(server, owner.tenant.id, team, child({ redactionPolicy: 'all' }));
    const middle = await workflowIn(
      server,
      owner.tenant.id,
      team,
      child({ redactionPolicy: 'none', redactCallerExecutions: false }, [call('Down', grand.id, 600)]),
    );
    const detail = await parentRun(owner, team, { redactionPolicy: 'none' }, call('Call', middle.id));
    expect(detail.redactionInfo).toMatchObject({ isRedacted: true, reason: 'sub_workflow_redaction_policy' });
  });

  it('a failed child still raises its caller', async () => {
    const { owner, team } = await scene();
    const kid = await workflowIn(server, owner.tenant.id, team, {
      ...failingFlow({ redactionPolicy: 'all' }),
      nodes: [
        node('Called', 'core.executeWorkflowTrigger'),
        node('Boom', 'core.stopAndError', { errorMessage: CANARY_ERROR }, [200, 0]),
      ],
      connections: chain('Called', 'Boom'),
    });
    const detail = await parentRun(owner, team, { redactionPolicy: 'none' }, call('Call', kid.id));
    expect(detail.status).toBe('error');
    expect(detail.redactionInfo).toMatchObject({ isRedacted: true, reason: 'sub_workflow_redaction_policy' });
    expect(detail.errorMessage).toBe('');
    // the caller's row holds the child's error text: blank in the list and in a read without data too
    const list = await owner.client.data(
      owner.client.get(`/rest/executions?workflowId=${detail.workflowId}`),
    );
    const rows: any[] = Array.isArray(list) ? list : ((list as any).results ?? (list as any).data ?? []);
    expect(rows.find((r) => r.id === detail.id)?.errorMessage).toBe('');
    const viewer = { tenantId: owner.tenant.id, userId: owner.user.id };
    const summary = await getExecution(server.ctx, viewer, detail.id, { includeData: false });
    expect(summary.errorMessage).toBe('');
    expect(summary.redactionInfo).toMatchObject({
      isRedacted: true,
      reason: 'sub_workflow_redaction_policy',
    });
    expect(JSON.stringify(summary)).not.toContain(CANARY_ERROR);
  });

  it('a file in the folder of a run redacted only through its callee is refused without reveal', async () => {
    const { owner, team, editor } = await scene();
    const kid = await workflowIn(server, owner.tenant.id, team, child({ redactionPolicy: 'all' }));
    const detail = await parentRun(owner, team, { redactionPolicy: 'none' }, call('Call', kid.id));
    expect(detail.redactionInfo).toMatchObject({ isRedacted: true, reason: 'sub_workflow_redaction_policy' });
    const stored = await server.ctx.executions
      .binaryStore(owner.tenant.id)
      .store(new TextEncoder().encode('parent file'.padEnd(70_000, '.')), {
        mimeType: 'text/plain',
        executionId: detail.id,
      });
    const url = `/rest/binary-data?id=${encodeURIComponent(stored.id!)}`;
    const refused = await editor.client.get(url);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('EXECUTION_REVEAL_FORBIDDEN');
    expect((await editor.client.get(`${url}&redactExecutionData=false`)).statusCode).toBe(403);
    const served = await owner.client.get(`${url}&redactExecutionData=false`);
    expect(served.statusCode).toBe(200);
    expect(served.body.startsWith('parent file')).toBe(true);
  });

  it('a second call to a redacting child counts even when the first call is to a plain one', async () => {
    const { owner, team } = await scene();
    const plain = await workflowIn(server, owner.tenant.id, team, child({}));
    const loud = await workflowIn(server, owner.tenant.id, team, child({ redactionPolicy: 'all' }));
    const detail = await parentRun(
      owner,
      team,
      { redactionPolicy: 'none' },
      call('First', plain.id),
      call('Second', loud.id, 400),
    );
    expect(detail.redactionInfo?.isRedacted).toBe(true);
  });
});
