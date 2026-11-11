/**
 * P6-53 (L8), the write and run side of execution data redaction: the workspace floor on
 * `/settings/security` and the public policy, a workflow's policy against the floor (422, legacy values,
 * seeding), the scopes that raise or lower it, the snapshot a run takes (the strictest of its own, the floor
 * and its parent's), and what the manual push may carry.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type {
  RedactionChannels,
  RedactionFloor,
  RedactionPolicy,
  WorkflowDefinition,
} from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  assertRedactionChange,
  clearTask,
  inheritedChannels,
  pushableError,
  pushableTaskData,
  seedRedactionSettings,
  snapshotRedaction,
} from '../src/services/redaction/policy';
import {
  addToProject,
  chain,
  createTestServer,
  executionsOf,
  node,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestClient,
  type TestServer,
  teamProjectOf,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const BELOW_FLOOR = 'Workflow redaction policy cannot be weaker than the workspace floor.';
const POLICIES: RedactionPolicy[] = ['none', 'manual-only', 'non-manual', 'all'];
const FLOORS: RedactionFloor[] = ['off', 'production', 'all'];

/** the channels a policy and a floor redact, written out here so a change of the table shows in this test */
const POLICY_CHANNELS: Record<RedactionPolicy, RedactionChannels> = {
  none: { production: false, manual: false },
  'manual-only': { production: false, manual: true },
  'non-manual': { production: true, manual: false },
  all: { production: true, manual: true },
};
const FLOOR_CHANNELS: Record<RedactionFloor, RedactionChannels> = {
  off: { production: false, manual: false },
  production: { production: true, manual: false },
  all: { production: true, manual: true },
};

let server: TestServer;
let baseUrl: string;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
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
  return signup(server.app, { remoteAddress: `10.53.${Math.floor(address / 250)}.${(address % 250) + 1}` });
};

const setFloor = (owner: Owner, floor: RedactionFloor) =>
  owner.client.data<{ redaction: { floor: RedactionFloor } }>(
    owner.client.post('/rest/settings/security', { redaction: { floor } }),
  );

const flow = (settings: Record<string, unknown> = {}) => ({
  name: `Flow ${randomUUID().slice(0, 6)}`,
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'secret', 'canary-value')],
  connections: chain('Start', 'Set'),
  settings,
});

/** PATCH /workflows/:id with the version the row holds now */
async function patchFlow(client: TestClient, id: string, body: Record<string, unknown>) {
  const row = await client.data<{ versionId: string }>(client.get(`/rest/workflows/${id}`));
  return client.patch(`/rest/workflows/${id}`, { versionId: row.versionId, ...body });
}

const createFlow = (client: TestClient, settings?: Record<string, unknown>) =>
  client.post('/rest/workflows', { ...flow(settings) });

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

/** a saved workflow run through the service in `mode` and read back through the route */
async function runAndRead(owner: Owner, settings: Record<string, unknown>, mode: 'manual' | 'trigger') {
  const row = await workflowIn(
    server,
    owner.tenant.id,
    await teamProjectOf(server, owner.tenant.id),
    flow(settings),
  );
  const started = await server.ctx.executions.start({
    tenantId: owner.tenant.id,
    workflow: definitionOf(row),
    workflowId: row.id,
    mode,
    startNode: 'Start',
    userId: owner.user.id,
    wait: true,
  });
  await started.finished;
  return owner.client.data<{
    state: { resultData: { runData: Record<string, Array<{ data?: { main?: unknown[][] } }>> } };
    redactionInfo?: { isRedacted: boolean; reason: string; canReveal: boolean };
  }>(owner.client.get(`/rest/executions/${started.executionId}`));
}

describe('the workspace floor', () => {
  it('reads off by default, saves through POST /settings/security and audits the change', async () => {
    const owner = await fresh();
    const first = await owner.client.data(owner.client.get('/rest/settings/security'));
    expect(first.redaction).toEqual({ floor: 'off' });
    expect((await setFloor(owner, 'production')).redaction.floor).toBe('production');
    expect((await owner.client.data(owner.client.get('/rest/settings/security'))).redaction.floor).toBe(
      'production',
    );
    // the personal space flags keep their value when only the floor is sent
    expect((await owner.client.data(owner.client.get('/rest/settings/security'))).personalSpaceSharing).toBe(
      true,
    );
    const rows = await server.ctx.database.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, owner.tenant.id), eq(auditLog.action, 'tenant.security_policy_updated')),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ redactionFloor: 'production' });
    // GET /settings carries it for the editor
    expect((await owner.client.data(owner.client.get('/rest/settings'))).redactionFloor).toBe('production');
  });

  it('refuses a value that is no floor and a member without the scope', async () => {
    const owner = await fresh();
    const bad = await owner.client.post('/rest/settings/security', { redaction: { floor: 'strict' } });
    expect(bad.statusCode).toBe(400);
    const member = await realMember(owner);
    const denied = await member.client.post('/rest/settings/security', { redaction: { floor: 'all' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    expect((await owner.client.data(owner.client.get('/rest/settings/security'))).redaction.floor).toBe(
      'off',
    );
  });

  it('is per workspace: another workspace keeps its own floor', async () => {
    const a = await fresh();
    const b = await fresh();
    await setFloor(a, 'all');
    expect((await b.client.data(b.client.get('/rest/settings/security'))).redaction.floor).toBe('off');
    expect((await createFlow(b.client, { redactionPolicy: 'none' })).statusCode).toBe(200);
    expect((await createFlow(a.client, { redactionPolicy: 'none' })).statusCode).toBe(422);
  });

  it('is `redactionEnforcement.floor` on the public security policy', async () => {
    const owner = await fresh();
    const made = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'floor-key' }));
    const call = (method: 'GET' | 'PUT', payload?: unknown) =>
      server.app.inject({
        method,
        url: '/api/v1/settings/security-policy',
        headers: { 'x-api-key': made.key as string },
        payload: payload as object,
      });
    expect((await call('GET')).json().data.redactionEnforcement).toEqual({ floor: 'off' });
    const put = await call('PUT', { redactionEnforcement: { floor: 'all' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.redactionEnforcement).toEqual({ floor: 'all' });
    expect((await owner.client.data(owner.client.get('/rest/settings/security'))).redaction.floor).toBe(
      'all',
    );
    expect((await call('PUT', { redactionEnforcement: { floor: 'x' } })).statusCode).toBe(400);
  });
});

describe('a workflow policy against the floor', () => {
  it('answers 422 below the floor on a create and on an update', async () => {
    const owner = await fresh();
    await setFloor(owner, 'production');
    const create = await createFlow(owner.client, { redactionPolicy: 'none' });
    expect(create.statusCode).toBe(422);
    expect(create.json().error.message).toBe(BELOW_FLOOR);
    // manual-only is still below a production floor
    expect((await createFlow(owner.client, { redactionPolicy: 'manual-only' })).statusCode).toBe(422);
    const ok = await owner.client.data<{ id: string; settings: { redactionPolicy?: string } }>(
      createFlow(owner.client, { redactionPolicy: 'non-manual' }),
    );
    const update = await patchFlow(owner.client, ok.id, {
      settings: { redactionPolicy: 'none' },
    });
    expect(update.statusCode).toBe(422);
    expect(update.json().error.message).toBe(BELOW_FLOOR);
    expect((await patchFlow(owner.client, ok.id, { settings: { redactionPolicy: 'all' } })).statusCode).toBe(
      200,
    );
  });

  it('lets a legacy workflow below the floor save unchanged, and seeds a new workflow from the floor', async () => {
    const owner = await fresh();
    const legacy = await owner.client.data<{ id: string }>(createFlow(owner.client));
    await setFloor(owner, 'all');
    // the same policy (none) with another name: no change of the policy, so it saves
    const rename = await patchFlow(owner.client, legacy.id, {
      name: 'Renamed',
      settings: {},
    });
    expect(rename.statusCode).toBe(200);
    expect((await patchFlow(owner.client, legacy.id, { name: 'Again' })).statusCode).toBe(200);
    const seeded = await owner.client.data<{ id: string }>(createFlow(owner.client));
    const detail = await owner.client.data(owner.client.get(`/rest/workflows/${seeded.id}`));
    expect(detail.settings.redactionPolicy).toBe('all');
    await setFloor(owner, 'production');
    const second = await owner.client.data<{ id: string }>(createFlow(owner.client, {}));
    expect(
      (await owner.client.data(owner.client.get(`/rest/workflows/${second.id}`))).settings.redactionPolicy,
    ).toBe('non-manual');
  });

  it('seeds nothing while the floor is off, and keeps a policy that is set', async () => {
    const tenant = { id: randomUUID(), settings: {} };
    expect(await seedRedactionSettings(server.ctx.serviceDeps, tenant, undefined)).toBeUndefined();
    expect(await seedRedactionSettings(server.ctx.serviceDeps, tenant, { timezone: 'UTC' })).toEqual({
      timezone: 'UTC',
    });
    const raised = { id: tenant.id, settings: { redactionFloor: 'all' as const } };
    expect(await seedRedactionSettings(server.ctx.serviceDeps, raised, { redactionPolicy: 'all' })).toEqual({
      redactionPolicy: 'all',
    });
  });

  it('judges redactCallerExecutions with the same scopes, and holds the floor on a server path', async () => {
    const owner = await fresh();
    await setFloor(owner, 'all');
    const deps = server.ctx.serviceDeps;
    const serverPath = { tenantId: owner.tenant.id };
    // no userId: no scope read, the floor still holds
    await expect(
      assertRedactionChange(deps, serverPath, null, undefined, { redactionPolicy: 'none' }),
    ).rejects.toThrow(BELOW_FLOOR);
    await expect(
      assertRedactionChange(deps, serverPath, null, undefined, { redactionPolicy: 'all' }),
    ).resolves.toBeUndefined();
    // redactCallerExecutions: false lowers the default (on), so it needs the disable scope
    const team = await teamProjectOf(server, owner.tenant.id);
    const editor = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
    const admin = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, admin.user.id, 'project:admin');
    const row = await workflowIn(server, owner.tenant.id, team, flow({ redactionPolicy: 'all' }));
    const lower = (userId: string) =>
      assertRedactionChange(
        deps,
        { tenantId: owner.tenant.id, userId },
        row.id,
        { redactionPolicy: 'all' },
        { redactionPolicy: 'all', redactCallerExecutions: false },
      );
    await expect(lower(editor.user.id)).rejects.toThrow(MISSING_SCOPE_MESSAGE);
    await expect(lower(admin.user.id)).resolves.toBeUndefined();
  });
});

describe('raising and lowering needs a scope', () => {
  it('a project editor can do neither, a project admin both', async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const editor = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
    const admin = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, admin.user.id, 'project:admin');

    // raise on a create: the caller names the project, the editor holds no enable scope there
    await expect(
      assertRedactionChange(
        server.ctx.serviceDeps,
        { tenantId: owner.tenant.id, userId: editor.user.id, projectId: team },
        null,
        undefined,
        { redactionPolicy: 'all' },
      ),
    ).rejects.toThrow(MISSING_SCOPE_MESSAGE);
    await expect(
      assertRedactionChange(
        server.ctx.serviceDeps,
        { tenantId: owner.tenant.id, userId: admin.user.id, projectId: team },
        null,
        undefined,
        { redactionPolicy: 'all' },
      ),
    ).resolves.toBeUndefined();
    const made = await admin.client.post('/rest/workflows', {
      ...flow({ redactionPolicy: 'all' }),
      projectId: team,
    });
    expect(made.statusCode).toBe(200);
    const id = made.json().data.id as string;

    // lower on an update
    const lower = await patchFlow(editor.client, id, {
      settings: { redactionPolicy: 'none' },
    });
    expect(lower.statusCode).toBe(403);
    expect(lower.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    expect(
      (await owner.client.data(owner.client.get(`/rest/workflows/${id}`))).settings.redactionPolicy,
    ).toBe('all');
    const done = await patchFlow(admin.client, id, { settings: { redactionPolicy: 'none' } });
    expect(done.statusCode).toBe(200);

    // a save that changes no redaction setting needs neither scope
    const rename = await patchFlow(editor.client, id, { name: 'Edited by the editor' });
    expect(rename.statusCode).toBe(200);
  });

  it("a create is judged in the project it goes to, not in the creator's personal project", async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const editor = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
    for (const settings of [{ redactionPolicy: 'all' }, { redactCallerExecutions: false }]) {
      const refused = await editor.client.post('/rest/workflows', { ...flow(settings), projectId: team });
      expect(refused.statusCode, JSON.stringify(settings)).toBe(403);
      expect(refused.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    }
    // with no redaction setting, and in the editor's own project, the create goes through
    expect((await editor.client.post('/rest/workflows', { ...flow(), projectId: team })).statusCode).toBe(
      200,
    );
    const own = await editor.client.post('/rest/workflows', { ...flow({ redactionPolicy: 'all' }) });
    expect(own.statusCode).toBe(200);
  });
});

describe('the snapshot a run takes', () => {
  it.each(POLICIES.flatMap((policy) => FLOORS.map((floor) => [policy, floor] as const)))(
    'policy %s with floor %s: manual and production runs read as the table says',
    async (policy, floor) => {
      const owner = await fresh();
      const own = POLICY_CHANNELS[policy];
      const min = FLOOR_CHANNELS[floor];
      const expected = { production: own.production || min.production, manual: own.manual || min.manual };
      // the floor set after the workflow was saved (a legacy workflow below the floor keeps running)
      const row = await workflowIn(
        server,
        owner.tenant.id,
        await teamProjectOf(server, owner.tenant.id),
        flow({
          redactionPolicy: policy,
        }),
      );
      await setFloor(owner, floor);
      const snapshot = await snapshotRedaction(
        server.ctx.serviceDeps,
        (await server.ctx.repos.tenants.get(owner.tenant.id))!,
        definitionOf(row),
      );
      expect({ production: snapshot?.production === true, manual: snapshot?.manual === true }).toEqual(
        expected,
      );
      for (const mode of ['manual', 'trigger'] as const) {
        const started = await server.ctx.executions.start({
          tenantId: owner.tenant.id,
          workflow: definitionOf(row),
          workflowId: row.id,
          mode,
          startNode: 'Start',
          userId: owner.user.id,
          wait: true,
        });
        await started.finished;
        const detail = await owner.client.data(owner.client.get(`/rest/executions/${started.executionId}`));
        const redacted = mode === 'manual' ? expected.manual : expected.production;
        expect(detail.redactionInfo?.isRedacted === true, `${policy}/${floor}/${mode}`).toBe(redacted);
        const items = detail.state.resultData.runData.Set[0].data.main[0] as unknown[];
        expect(items.length, `${policy}/${floor}/${mode}`).toBe(redacted ? 0 : 1);
      }
    },
  );

  it('a sub-run takes the strictest of its own and its parent', async () => {
    const owner = await fresh();
    const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id))!;
    const deps = server.ctx.serviceDeps;
    const child = (policy: RedactionPolicy) => ({ settings: { redactionPolicy: policy } });
    expect(await snapshotRedaction(deps, tenant, child('none'))).toBeUndefined();
    const inherited = await snapshotRedaction(deps, tenant, child('none'), {
      production: true,
      manual: false,
    });
    expect(inherited).toMatchObject({
      production: true,
      manual: false,
      reason: 'sub_workflow_redaction_policy',
    });
    const own = await snapshotRedaction(deps, tenant, child('all'), { production: true, manual: false });
    expect(own).toMatchObject({ production: true, manual: true, reason: 'workflow_redaction_policy' });
    // a parent never lowers its child
    expect(
      await snapshotRedaction(deps, tenant, child('non-manual'), { production: false, manual: false }),
    ).toMatchObject({
      production: true,
      manual: false,
    });
  });

  it("a sub-run inherits both channels once the channel of its parent's own mode is on", () => {
    const manualOnly = { production: false, manual: true };
    expect(inheritedChannels(manualOnly, 'manual')).toEqual({ production: true, manual: true });
    expect(inheritedChannels(manualOnly, 'trigger')).toEqual(manualOnly);
    expect(inheritedChannels({ production: true, manual: false }, 'integrated')).toEqual({
      production: true,
      manual: true,
    });
    expect(inheritedChannels(undefined, 'manual')).toBeUndefined();
  });

  /** a member who reads runs but cannot reveal them, the run of `childId` read as them */
  async function childRunAs(owner: Owner, team: string, childId: string) {
    const member = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, member.user.id, 'project:editor');
    const [run] = await executionsOf(server.ctx, owner.tenant.id, childId);
    expect(run, 'the child ran').toBeDefined();
    return member.client.data(member.client.get(`/rest/executions/${run.id}`));
  }

  const called = (settings: Record<string, unknown>) => ({
    name: `Called ${randomUUID().slice(0, 6)}`,
    nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Echo', 'seen', 'yes')],
    connections: chain('Called', 'Echo'),
    settings,
  });
  const caller = (settings: Record<string, unknown>, ...ids: string[]) => ({
    name: `Caller ${randomUUID().slice(0, 6)}`,
    nodes: [
      node('Start', 'core.manualTrigger'),
      setNode('Set', 'secret', 'canary-sub-value', [200, 0]),
      ...ids.map((id, i) =>
        node(`Call ${i + 1}`, 'test.callWorkflow', { workflowId: id }, [400 + 200 * i, 0]),
      ),
    ],
    connections: chain('Start', 'Set', ...ids.map((_, i) => `Call ${i + 1}`)),
    settings,
  });
  const runManually = async (owner: Owner, row: Parameters<typeof definitionOf>[0]) => {
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(row),
      workflowId: row.id,
      mode: 'manual',
      startNode: 'Start',
      userId: owner.user.id,
      wait: true,
    });
    await started.finished;
  };

  it('a manual parent that redacts its manual runs only still protects the child that holds its data', async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const child = await workflowIn(server, owner.tenant.id, team, called({}));
    // the legacy value, still accepted through the API
    const parent = await workflowIn(
      server,
      owner.tenant.id,
      team,
      caller({ redactionPolicy: 'manual-only' }, child.id),
    );
    await runManually(owner, parent);
    const detail = await childRunAs(owner, team, child.id);
    expect(detail.redactionInfo).toMatchObject({ isRedacted: true, canReveal: false });
    expect(JSON.stringify(detail.state)).not.toContain('canary-sub-value');
  });

  it('a later sub-workflow call starts from the channels an earlier callee raised', async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const loud = await workflowIn(server, owner.tenant.id, team, called({ redactionPolicy: 'all' }));
    const quiet = await workflowIn(server, owner.tenant.id, team, called({ redactionPolicy: 'none' }));
    const parent = await workflowIn(
      server,
      owner.tenant.id,
      team,
      caller({ redactionPolicy: 'none' }, loud.id, quiet.id),
    );
    await runManually(owner, parent);
    const detail = await childRunAs(owner, team, quiet.id);
    expect(detail.redactionInfo).toMatchObject({
      isRedacted: true,
      reason: 'sub_workflow_redaction_policy',
      canReveal: false,
    });
    expect(JSON.stringify(detail.state)).not.toContain('canary-sub-value');
  });
});

describe('a retry', () => {
  const failingChild = {
    name: 'Failing child',
    nodes: [
      node('Called', 'core.executeWorkflowTrigger'),
      setNode('Set', 'secret', 'canary-retry-value'),
      node('Boom', 'core.stopAndError', { errorMessage: 'stopped here' }, [400, 0]),
    ],
    connections: chain('Called', 'Set', 'Boom'),
    settings: {},
  };

  it('of a child redacted through its caller stays redacted for a project editor who retries it', async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const editor = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
    const child = await workflowIn(server, owner.tenant.id, team, failingChild);
    const parent = await workflowIn(server, owner.tenant.id, team, {
      name: 'Redacting parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
      settings: { redactionPolicy: 'all' },
    });
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(parent),
      workflowId: parent.id,
      mode: 'manual',
      startNode: 'Start',
      userId: owner.user.id,
      wait: true,
    });
    await started.finished;
    const [original] = await executionsOf(server.ctx, owner.tenant.id, child.id);
    const seen = await editor.client.data(editor.client.get(`/rest/executions/${original.id}`));
    expect(seen.redactionInfo).toMatchObject({ isRedacted: true, canReveal: false });

    const { executionId } = await editor.client.data<{ executionId: string }>(
      editor.client.post(`/rest/executions/${original.id}/retry`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId);
    const retried = await editor.client.data(editor.client.get(`/rest/executions/${executionId}`));
    expect(retried.redactionInfo).toMatchObject({ isRedacted: true, canReveal: false });
    expect(JSON.stringify(retried.state)).not.toContain('canary-retry-value');
  });

  it('of a run that used a private connection is private to no one when another user retries it', async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const editor = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, editor.user.id, 'project:editor');
    const row = await workflowIn(server, owner.tenant.id, team, flow());
    const id = randomUUID();
    await server.ctx.repos.executions.create(
      owner.tenant.id,
      {
        id,
        workflowId: row.id,
        workflowName: row.name,
        mode: 'manual',
        status: 'error',
        usedPrivateCredentials: true,
      },
      {
        workflowData: { ...definitionOf(row) } as unknown as Record<string, unknown>,
        runOptions: { startNode: 'Start', userId: owner.user.id },
      },
    );
    const { executionId } = await editor.client.data<{ executionId: string }>(
      editor.client.post(`/rest/executions/${id}/retry`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId);
    for (const who of [editor, owner]) {
      const read = await who.client.data(who.client.get(`/rest/executions/${executionId}`));
      expect(read.redactionInfo).toMatchObject({
        isRedacted: true,
        reason: 'credential_access',
        canReveal: false,
      });
    }
  });
});

describe('the manual push', () => {
  const task = (value: string) => ({
    startTime: 1,
    executionTime: 1,
    executionStatus: 'success' as const,
    source: [],
    data: { main: [[{ json: { value } }]] },
  });

  it('pushableTaskData clears the items of a manual channel and keeps the task shape', () => {
    const plain = task('x');
    expect(pushableTaskData(undefined, plain, undefined)).toBe(plain);
    expect(pushableTaskData({ production: true, manual: false }, plain, undefined)).toBe(plain);
    const cleared = pushableTaskData({ production: false, manual: true }, plain, undefined);
    expect(cleared.data?.main).toEqual([[]]);
    expect(cleared.executionStatus).toBe('success');
    // the channel a sub-workflow reported raises the snapshot
    const state = {
      resultData: {
        runData: {
          Call: [{ ...plain, metadata: { subWorkflowRedaction: { production: false, manual: true } } }],
        },
      },
    } as never;
    expect(pushableTaskData(undefined, plain, state).data?.main).toEqual([[]]);
  });

  it('pushableError drops the error text when a channel is on', () => {
    const error = { name: 'Error', message: 'secret value', node: 'Boom', description: 'more secret' };
    expect(pushableError(undefined, error, undefined)).toBe(error);
    const out = pushableError({ production: false, manual: true }, error, undefined)!;
    expect(out.node).toBe('Boom');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(pushableError({ production: true, manual: false }, undefined, undefined)).toBeUndefined();
  });

  it("pushableError judges the channel of the run's own mode when it is given", () => {
    const error = { name: 'Error', message: 'secret value', node: 'Boom' };
    const production = { production: true, manual: false };
    expect(pushableError(production, error, undefined, 'manual')).toBe(error);
    expect(pushableError(production, error, undefined, 'trigger')?.message).not.toContain('secret');
    expect(
      pushableError({ production: false, manual: true }, error, undefined, 'manual')?.message,
    ).not.toContain('secret');
  });

  it('clearTask keeps the engine metadata and drops what a node set', () => {
    const cleared = clearTask({
      ...task('x'),
      metadata: {
        subExecution: { executionId: 'e1' },
        usedCredentialIds: ['c1'],
        subWorkflowRedaction: { production: true, manual: true },
        tracing: { userEmail: 'canary@example.com' },
        resumeFormUrl: 'https://example.com/form-waiting/e1',
      },
    });
    expect(cleared.metadata).toEqual({
      subExecution: { executionId: 'e1' },
      usedCredentialIds: ['c1'],
      subWorkflowRedaction: { production: true, manual: true },
    });
    expect(clearTask({ ...task('x'), metadata: { tracing: { a: 1 } } }).metadata).toBeUndefined();
  });

  /** open GET /rest/push and collect the events */
  async function openPush(cookie: string) {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/rest/push`, { headers: { cookie }, signal: controller.signal });
    const events: Array<{ event: string; data: any }> = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at = buffer.indexOf('\n\n');
          while (at >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (event) events.push({ event, data: data ? JSON.parse(data) : null });
            at = buffer.indexOf('\n\n');
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

  it('a redacted manual run pushes no node output, no console line and an error without text', async () => {
    const owner = await fresh();
    await setFloor(owner, 'all');
    const wf = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/workflows', {
        name: 'Pushed',
        nodes: [
          node('Start', 'core.manualTrigger'),
          setNode('Set', 'greeting', 'canary-push-value'),
          node(
            'Code',
            'core.code',
            { mode: 'runOnceForAllItems', jsCode: 'console["log"]("canary-console"); return items;' },
            [400, 0],
          ),
          node('Boom', 'core.stopAndError', { errorMessage: 'canary-error-text' }, [600, 0]),
        ],
        connections: chain('Start', 'Set', 'Code', 'Boom'),
        settings: {},
      }),
    );
    const push = await openPush(owner.client.cookie!);
    try {
      await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
      const finished = await waitFor(async () => push.events.find((e) => e.event === 'executionFinished'), {
        message: 'finish event',
      });
      const seen = JSON.stringify(push.events);
      expect(seen).not.toContain('canary-push-value');
      expect(seen).not.toContain('canary-console');
      expect(seen).not.toContain('canary-error-text');
      expect(push.events.some((e) => e.event === 'consoleMessage')).toBe(false);
      const after = push.events.filter((e) => e.event === 'nodeExecuteAfter');
      expect(after.length).toBeGreaterThan(0);
      for (const event of after) expect(event.data.taskData.data?.main?.[0] ?? []).toEqual([]);
      expect(finished.data.status).toBe('error');
      expect(finished.data.error.node).toBe('Boom');
    } finally {
      await push.close();
    }
  });

  it("a manual run's node data reaches the user who ran it only; another reader gets the events cleared", async () => {
    const owner = await fresh();
    const team = await teamProjectOf(server, owner.tenant.id);
    const reader = await realMember(owner);
    await addToProject(server, owner.tenant.id, team, reader.user.id, 'project:viewer');
    const wf = await workflowIn(server, owner.tenant.id, team, {
      name: 'Shared run',
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Set', 'greeting', 'canary-push-value'),
        node(
          'Code',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: 'console["log"]("canary-console"); return items;' },
          [400, 0],
        ),
        node('Boom', 'core.stopAndError', { errorMessage: 'canary-error-text' }, [600, 0]),
      ],
      connections: chain('Start', 'Set', 'Code', 'Boom'),
      settings: {},
    });
    const mine = await openPush(owner.client.cookie!);
    const theirs = await openPush(reader.client.cookie!);
    try {
      await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
      for (const stream of [mine, theirs]) {
        await waitFor(async () => stream.events.find((e) => e.event === 'executionFinished'), {
          message: 'finish event',
        });
      }
      // the control: the user who ran it sees it all
      const own = JSON.stringify(mine.events);
      for (const canary of ['canary-push-value', 'canary-console', 'canary-error-text']) {
        expect(own).toContain(canary);
      }
      const seen = JSON.stringify(theirs.events);
      for (const canary of ['canary-push-value', 'canary-console', 'canary-error-text']) {
        expect(seen).not.toContain(canary);
      }
      expect(theirs.events.some((e) => e.event === 'consoleMessage')).toBe(false);
      const after = theirs.events.filter((e) => e.event === 'nodeExecuteAfter');
      expect(after.length).toBeGreaterThan(0);
      for (const event of after) expect(event.data.taskData.data?.main?.[0] ?? []).toEqual([]);
      const finished = theirs.events.find((e) => e.event === 'executionFinished')!;
      expect(finished.data).toMatchObject({ status: 'error', error: { node: 'Boom' } });
    } finally {
      await mine.close();
      await theirs.close();
    }
  });
});

describe('runs read for the editor', () => {
  it('a manual run read through runAndRead shows its items when no policy applies', async () => {
    const owner = await fresh();
    const detail = await runAndRead(owner, {}, 'manual');
    expect(detail.redactionInfo).toBeUndefined();
    expect(detail.state.resultData.runData.Set[0].data?.main?.[0]).toHaveLength(1);
  });
});
