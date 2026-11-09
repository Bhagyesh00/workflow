/**
 * P6-40 (L25), the run paths: two true members, one in project A and one in project B, and every way a run
 * can reach a resource. Nothing crosses. A credential by id and by name, `$vars`, the data table node, vault
 * `$secrets`, the vector store key (the run's project id), the sub-workflow caller policy, the error workflow,
 * inline sub-workflow credentials, a production webhook run, a poll (schedule) run, and a run that was
 * queued while its workflow moved. Each test also runs the same path with the project's own resource and
 * expects it to pass, so a refusal is not a broken path.
 */
import { randomUUID } from 'node:crypto';
import type { NodePackage, NodeType, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  SecretProvider,
  SecretProviderSettings,
  SecretProviderType,
} from '../src/services/secrets/types';
import {
  addToProject,
  chain,
  createTestServer,
  credentialIn,
  dataTableIn,
  executionsOf,
  node,
  projectIn,
  realMember,
  resetDatabase,
  setNode,
  signup as signupFrom,
  type TestServer,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const NO_ACCESS = 'does not have access to the credential';
const NOT_REACHABLE = 'The credential in use pulls secrets from an external store that is not reachable';
const CALLER = /can only be called by workflows of its own project/;

// ---------------------------------------------------------------------------------------------
// a fake vault, and a node that answers the project its run reads (the vector store key's input)

const vaults = new Map<string, Record<string, unknown>>();

class MemoryProvider implements SecretProvider {
  private secrets: Record<string, unknown> = {};
  constructor(private readonly settings: SecretProviderSettings) {}
  private read() {
    const secrets = vaults.get(String(this.settings.token));
    if (!secrets) throw new Error('no such vault');
    return { ...secrets };
  }
  async init() {}
  async connect() {
    this.read();
  }
  async update() {
    this.secrets = this.read();
  }
  async test() {
    return { success: true };
  }
  getSecret(name: string) {
    return this.secrets[name];
  }
  hasSecret(name: string) {
    return Object.hasOwn(this.secrets, name);
  }
  getSecretNames() {
    return Object.keys(this.secrets);
  }
  async disconnect() {}
}

const memoryType: SecretProviderType = {
  name: 'memoryVault',
  displayName: 'Memory vault',
  properties: [
    { displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } },
  ],
  create: (settings) => new MemoryProvider(settings),
};

const probeType: NodeType = {
  description: {
    name: 'test.p6IsolationProbe',
    displayName: 'Project probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Probe' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    return [[{ json: { projectId: ctx.getProjectId() } }]];
  },
};
const probePackage: NodePackage = { name: 'p6-isolation', credentials: [], nodes: [probeType] };

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { secretProviderTypes: [memoryType], nodePackages: [probePackage] },
  );
}, 120_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let signups = 0;
const signup = () => {
  signups++;
  return signupFrom(server.app, { remoteAddress: `10.94.${signups >> 8}.${signups & 255}` });
};

const repos = () => server.ctx.repos;

/** an owner, projects A and B, and a true member who edits each (ann in A, ben in B) */
async function world() {
  const owner = await signup();
  const tenantId = owner.tenant.id;
  const a = await projectIn(server, tenantId, 'A');
  const b = await projectIn(server, tenantId, 'B');
  const ann = await realMember(owner);
  const ben = await realMember(owner);
  await addToProject(server, tenantId, a.id, ann.user.id, 'project:editor');
  await addToProject(server, tenantId, b.id, ben.user.id, 'project:editor');
  return { owner, tenantId, a, b, ann, ben };
}
type World = Awaited<ReturnType<typeof world>>;
type Who = { client: World['owner']['client'] };

const useNode = (credential: { id: string | null; name: string }) =>
  node('Use', 'test.useCredential', {}, [200, 0], { credentials: { testApi: credential } });

const flow = (...nodes: WorkflowNode[]) => ({
  nodes: [node('Start', 'core.manualTrigger'), ...nodes],
  connections: chain('Start', ...nodes.map((n) => n.name)),
});

/** a manual run through the route; the HTTP status when the run is refused, else the finished row and detail */
async function runAs(who: Who, tenantId: string, workflowId: string) {
  const res = await who.client.post(`/rest/workflows/${workflowId}/run`, {});
  if (res.statusCode >= 400)
    return { status: res.statusCode, text: res.body, execution: undefined, detail: undefined };
  const { executionId } = res.json().data as { executionId: string };
  const execution = await waitForExecution(server.ctx, tenantId, executionId);
  const detail = await who.client.data(who.client.get(`/rest/executions/${executionId}`));
  return { status: 200, text: JSON.stringify(detail), execution, detail };
}

const outputJson = (detail: any, nodeName: string) =>
  (detail.state.resultData.runData[nodeName]?.[0]?.data?.main?.[0] ?? []).map((i: any) => i.json);

const definitionOf = (row: {
  id: string;
  name: string;
  nodes: unknown;
  connections: unknown;
  settings: unknown;
}): WorkflowDefinition => ({
  id: row.id,
  name: row.name,
  nodes: row.nodes as WorkflowNode[],
  connections: row.connections as WorkflowDefinition['connections'],
  settings: row.settings as WorkflowDefinition['settings'],
});

async function runSaved(
  tenantId: string,
  row: Parameters<typeof definitionOf>[0],
  mode: 'manual' | 'trigger' = 'manual',
) {
  const started = await server.ctx.executions.start({
    tenantId,
    workflow: definitionOf(row),
    workflowId: row.id,
    mode,
    startNode: (row.nodes as WorkflowNode[])[0].name,
    wait: true,
  });
  return { executionId: started.executionId, outcome: (await started.finished)! };
}

// ---------------------------------------------------------------------------------------------

describe('credential at run', () => {
  it("by id: another project's credential is refused for its own member and for the owner, the project's own runs", async () => {
    const w = await world();
    const foreign = await credentialIn(server, w.tenantId, w.b.id, { data: { apiKey: 'b-secret' } });
    const own = await credentialIn(server, w.tenantId, w.a.id, { data: { apiKey: 'a-key' } });
    const bad = await workflowIn(server, w.tenantId, w.a.id, flow(useNode({ id: foreign.id, name: 'x' })));
    const good = await workflowIn(server, w.tenantId, w.a.id, flow(useNode({ id: own.id, name: 'x' })));

    for (const who of [w.ann, w.owner]) {
      const refused = await runAs(who, w.tenantId, bad.id);
      expect(refused.status).toBe(400);
      expect(refused.text).toContain(NO_ACCESS);
      expect(refused.text).not.toContain('b-secret');
    }
    expect(await executionsOf(server.ctx, w.tenantId, bad.id)).toHaveLength(0);

    const ran = await runAs(w.ann, w.tenantId, good.id);
    expect(ran.execution?.status).toBe('success');
    expect(outputJson(ran.detail, 'Use')).toMatchObject([{ keyLength: 5 }]);
    // B's member never runs A's workflow at all
    expect((await runAs(w.ben, w.tenantId, good.id)).status).toBe(403);
  });

  it("by name: the same name in two projects resolves in the workflow's project only", async () => {
    const w = await world();
    await credentialIn(server, w.tenantId, w.b.id, { name: 'Shared name', data: { apiKey: 'b-long-key' } });
    const wf = await workflowIn(server, w.tenantId, w.a.id, flow(useNode({ id: null, name: 'Shared name' })));
    const refused = await runAs(w.ann, w.tenantId, wf.id);
    expect(refused.status).toBe(400);
    // a name no usable row of the project holds is the invalid-credential answer, whether or not B holds it
    expect(refused.text).toContain('uses invalid credential');
    expect(refused.text).not.toContain(NO_ACCESS);

    await credentialIn(server, w.tenantId, w.a.id, { name: 'Shared name', data: { apiKey: 'a' } });
    const ran = await runAs(w.ann, w.tenantId, wf.id);
    expect(ran.execution?.status).toBe('success');
    // the key of A's credential (1 character), never B's (10)
    expect(outputJson(ran.detail, 'Use')).toMatchObject([{ keyLength: 1 }]);
  });

  it('a share opens it, and taking the share back closes it on the next run', async () => {
    const w = await world();
    const foreign = await credentialIn(server, w.tenantId, w.b.id, { data: { apiKey: 'abc' } });
    const wf = await workflowIn(server, w.tenantId, w.a.id, flow(useNode({ id: foreign.id, name: 'x' })));
    await repos().shares.set(w.tenantId, 'credential', foreign.id, [w.a.id]);
    expect((await runAs(w.ann, w.tenantId, wf.id)).execution?.status).toBe('success');
    await repos().shares.set(w.tenantId, 'credential', foreign.id, []);
    expect((await runAs(w.ann, w.tenantId, wf.id)).status).toBe(400);
  });
});

describe('$vars', () => {
  it("a run reads its own project's value over the global one, never another project's", async () => {
    const w = await world();
    await w.owner.client.data(w.owner.client.post('/rest/variables', { key: 'REGION', value: 'global' }));
    await w.owner.client.data(
      w.owner.client.post('/rest/variables', { key: 'REGION', value: 'from-a', projectId: w.a.id }),
    );
    await w.owner.client.data(
      w.owner.client.post('/rest/variables', { key: 'ONLY_B', value: 'b-only', projectId: w.b.id }),
    );
    const read = (expression: string) => flow(setNode('Read', 'value', expression));
    const inA = await workflowIn(server, w.tenantId, w.a.id, read('={{ $vars.REGION }}'));
    const inB = await workflowIn(server, w.tenantId, w.b.id, read('={{ $vars.REGION }}'));
    const aWantsB = await workflowIn(server, w.tenantId, w.a.id, read('={{ $vars.ONLY_B }}'));

    expect(outputJson((await runAs(w.ann, w.tenantId, inA.id)).detail, 'Read')[0].value).toBe('from-a');
    expect(outputJson((await runAs(w.ben, w.tenantId, inB.id)).detail, 'Read')[0].value).toBe('global');
    const hidden = await runAs(w.ann, w.tenantId, aWantsB.id);
    expect(hidden.text).not.toContain('b-only');
  });
});

describe('data table node', () => {
  const tableNode = (parameters: Record<string, unknown>) =>
    node('Table', 'core.dataTable', parameters, [200, 0]);
  const getRows = (mode: 'id' | 'name', value: string) =>
    tableNode({
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode, value },
      returnAll: true,
    });

  it("a run reads its own project's table by id and by name, and never another project's", async () => {
    const w = await world();
    const mine = await dataTableIn(server, w.tenantId, w.a.id, 'Orders');
    const theirs = await dataTableIn(server, w.tenantId, w.b.id, 'Ledger');

    const own = await workflowIn(server, w.tenantId, w.a.id, flow(getRows('id', mine.id)));
    expect((await runAs(w.ann, w.tenantId, own.id)).execution?.status).toBe('success');

    const byId = await workflowIn(server, w.tenantId, w.a.id, flow(getRows('id', theirs.id)));
    const byName = await workflowIn(server, w.tenantId, w.a.id, flow(getRows('name', 'Ledger')));
    for (const wf of [byId, byName]) {
      const run = await runAs(w.ann, w.tenantId, wf.id);
      expect(run.execution?.status).toBe('error');
      expect(run.text).not.toContain('secret');
    }
    // the same name lives in both projects without a mix-up
    await dataTableIn(server, w.tenantId, w.a.id, 'Ledger');
    const afterCreate = await runAs(w.ann, w.tenantId, byName.id);
    expect(afterCreate.execution?.status).toBe('success');
  });
});

describe('vault $secrets', () => {
  async function projectVault(
    w: World,
    projectId: string,
    providerKey: string,
    secrets: Record<string, unknown>,
  ) {
    const token = `token-${randomUUID()}`;
    vaults.set(token, secrets);
    await w.owner.client.data(
      w.owner.client.post(`/rest/secret-providers/projects/${projectId}/connections`, {
        providerKey,
        type: 'memoryVault',
        settings: { token },
        isEnabled: true,
      }),
    );
  }
  const usingSecret = (w: World, projectId: string, expression: string) =>
    credentialIn(server, w.tenantId, projectId, { data: { apiKey: expression } }).then((cred) =>
      workflowIn(server, w.tenantId, projectId, flow(useNode({ id: cred.id, name: cred.name }))),
    );

  it("project A's vault answers A's run and refuses B's, without the value", async () => {
    const w = await world();
    await projectVault(w, w.a.id, 'vaultA', { key: 'value-of-a' });
    const inA = await usingSecret(w, w.a.id, '={{ $secrets.vaultA.key }}');
    const inB = await usingSecret(w, w.b.id, '={{ $secrets.vaultA.key }}');

    const ok = await runAs(w.ann, w.tenantId, inA.id);
    expect(ok.execution?.status).toBe('success');
    expect(outputJson(ok.detail, 'Use')).toMatchObject([{ keyLength: 10 }]);

    const refused = await runAs(w.ben, w.tenantId, inB.id);
    expect(refused.execution?.status).toBe('error');
    expect(refused.text).toContain(NOT_REACHABLE);
    expect(refused.text).not.toContain('value-of-a');
  });
});

describe('vector store key', () => {
  it("a node's project id is its workflow row's project, so the same key in two projects is two stores", async () => {
    const w = await world();
    const probe = () => flow(node('Probe', 'test.p6IsolationProbe', {}, [200, 0]));
    const inA = await workflowIn(server, w.tenantId, w.a.id, probe());
    const inB = await workflowIn(server, w.tenantId, w.b.id, probe());
    const seenA = outputJson((await runAs(w.ann, w.tenantId, inA.id)).detail, 'Probe')[0].projectId;
    const seenB = outputJson((await runAs(w.ben, w.tenantId, inB.id)).detail, 'Probe')[0].projectId;
    expect(seenA).toBe(w.a.id);
    expect(seenB).toBe(w.b.id);
    expect(seenA).not.toBe(seenB);
  });
});

describe('sub-workflows', () => {
  const child = (settings: Record<string, unknown> = {}) => ({
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

  it('caller policy: a workflow of another project is not called by default; any opens it; the same project always passes', async () => {
    const w = await world();
    const sameChild = await workflowIn(server, w.tenantId, w.a.id, child());
    const same = await workflowIn(server, w.tenantId, w.a.id, callerOf(sameChild.id));
    expect((await runSaved(w.tenantId, same)).outcome.status).toBe('success');

    const foreignChild = await workflowIn(server, w.tenantId, w.b.id, child());
    const across = await workflowIn(server, w.tenantId, w.a.id, callerOf(foreignChild.id));
    const refused = await runSaved(w.tenantId, across);
    expect(refused.outcome.status).toBe('error');
    expect(refused.outcome.error?.message).toMatch(CALLER);
    expect(await executionsOf(server.ctx, w.tenantId, foreignChild.id)).toHaveLength(0);

    const open = await workflowIn(server, w.tenantId, w.b.id, child({ callerPolicy: 'any' }));
    const toOpen = await workflowIn(server, w.tenantId, w.a.id, callerOf(open.id));
    expect((await runSaved(w.tenantId, toOpen)).outcome.status).toBe('success');
  });

  it("inline sub-workflow credentials are checked against the parent's project", async () => {
    const w = await world();
    const foreign = await credentialIn(server, w.tenantId, w.b.id, { data: { apiKey: 'b-key' } });
    const own = await credentialIn(server, w.tenantId, w.a.id, { data: { apiKey: 'a-key' } });
    const inlineParent = (credentialId: string) => ({
      name: 'Inline parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Run inline',
          'core.executeWorkflow',
          {
            source: 'parameter',
            workflowJson: JSON.stringify({
              name: 'Inline',
              nodes: [
                node('Called', 'core.executeWorkflowTrigger'),
                useNode({ id: credentialId, name: 'x' }),
              ],
              connections: chain('Called', 'Use'),
            }),
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Run inline'),
    });
    const bad = await workflowIn(server, w.tenantId, w.a.id, inlineParent(foreign.id));
    const good = await workflowIn(server, w.tenantId, w.a.id, inlineParent(own.id));

    const refused = await runAs(w.ann, w.tenantId, bad.id);
    expect(refused.execution?.status).toBe('error');
    expect(refused.text).toContain(NO_ACCESS);
    expect(refused.text).not.toContain('b-key');
    expect((await runAs(w.ann, w.tenantId, good.id)).execution?.status).toBe('success');
  });
});

describe('error workflow', () => {
  const handler = (settings: Record<string, unknown> = {}) => ({
    name: 'On error',
    nodes: [node('Error Trigger', 'core.errorTrigger')],
    settings,
  });
  const failing = (errorWorkflow: string) => ({
    name: 'Failing',
    nodes: [node('Start', 'core.manualTrigger'), node('Fail', 'test.fail', {}, [200, 0])],
    connections: chain('Start', 'Fail'),
    settings: { errorWorkflow },
  });
  const errorRuns = async (tenantId: string, id: string) =>
    (await executionsOf(server.ctx, tenantId, id)).filter((r) => r.mode === 'error');

  it('a handler of the same project runs; one of another project does not, until its policy is any', async () => {
    const w = await world();
    const own = await workflowIn(server, w.tenantId, w.a.id, handler());
    const failOwn = await workflowIn(server, w.tenantId, w.a.id, failing(own.id));
    expect((await runSaved(w.tenantId, failOwn, 'trigger')).outcome.status).toBe('error');
    await waitFor(async () => (await errorRuns(w.tenantId, own.id)).length === 1, {
      message: 'the error run',
    });

    const foreign = await workflowIn(server, w.tenantId, w.b.id, handler());
    const failForeign = await workflowIn(server, w.tenantId, w.a.id, failing(foreign.id));
    await runSaved(w.tenantId, failForeign, 'trigger');
    await new Promise((r) => setTimeout(r, 300));
    expect(await errorRuns(w.tenantId, foreign.id)).toHaveLength(0);
    await expect(
      server.ctx.executions.runActivationErrorWorkflow(w.tenantId, failForeign.id, { message: 'boom' }),
    ).rejects.toThrow(CALLER);

    const open = await workflowIn(server, w.tenantId, w.b.id, handler({ callerPolicy: 'any' }));
    const failOpen = await workflowIn(server, w.tenantId, w.a.id, failing(open.id));
    await runSaved(w.tenantId, failOpen, 'trigger');
    await waitFor(async () => (await errorRuns(w.tenantId, open.id)).length === 1, {
      message: 'the open handler run',
    });
  });
});

describe('production webhook and poll runs', () => {
  const hook = () =>
    node('Webhook', 'core.webhook', { httpMethod: 'POST', path: `p6-${randomUUID().slice(0, 8)}` }, [0, 0], {
      webhookId: randomUUID(),
    });

  /** publishes A's workflow with `credential` while A may use it, then takes the share back (A "lost" it) */
  async function publishedThenLost(
    w: World,
    trigger: WorkflowNode,
    credential: { id: string },
    shared: boolean,
    takeBack = true,
  ) {
    if (shared) await repos().shares.set(w.tenantId, 'credential', credential.id, [w.a.id]);
    const wf = await w.owner.client.data<{ id: string }>(
      w.owner.client.post('/rest/workflows', {
        name: 'Published',
        projectId: w.a.id,
        nodes: [trigger, useNode({ id: credential.id, name: 'x' })],
        connections: chain(trigger.name, 'Use'),
        settings: {},
      }),
    );
    await w.owner.client.data(w.owner.client.post(`/rest/workflows/${wf.id}/activate`));
    if (shared && takeBack) await repos().shares.set(w.tenantId, 'credential', credential.id, []);
    return wf;
  }

  it("a webhook run of A's workflow naming B's credential fails with n8n's text; A's own passes", async () => {
    const w = await world();
    const foreign = await credentialIn(server, w.tenantId, w.b.id, { data: { apiKey: 'b-secret' } });
    const own = await credentialIn(server, w.tenantId, w.a.id, { data: { apiKey: 'a-key' } });
    const lostHook = hook();
    const ownHook = hook();
    const lost = await publishedThenLost(w, lostHook, foreign, true);
    const mine = await publishedThenLost(w, ownHook, own, false);
    const call = (trigger: WorkflowNode) =>
      server.app.inject({
        method: 'POST',
        url: `/webhook/${w.owner.tenant.slug}/${trigger.parameters.path}`,
        payload: {},
      });

    const refused = await call(lostHook);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain(NO_ACCESS);
    expect(refused.body).not.toContain('b-secret');
    expect(await executionsOf(server.ctx, w.tenantId, lost.id)).toHaveLength(0);

    const accepted = await call(ownHook);
    expect(accepted.statusCode).toBeLessThan(300);
    await waitFor(async () => (await executionsOf(server.ctx, w.tenantId, mine.id))[0], {
      message: 'the webhook run',
    });
    const [run] = await executionsOf(server.ctx, w.tenantId, mine.id);
    expect((await waitForExecution(server.ctx, w.tenantId, run.id)).status).toBe('success');
  });

  it("a poll (schedule) run of A's workflow naming B's credential is refused; A's own passes", async () => {
    const w = await world();
    const foreign = await credentialIn(server, w.tenantId, w.b.id, { data: { apiKey: 'b-secret' } });
    const own = await credentialIn(server, w.tenantId, w.a.id, { data: { apiKey: 'a-key' } });
    const poller = () =>
      node('Poller', 'test.poll', { pollTimes: { item: [{ mode: 'everyHour', minute: 59 }] } });
    const mine = await publishedThenLost(w, poller(), own, false);
    await waitFor(async () => (await executionsOf(server.ctx, w.tenantId, mine.id)).length >= 1, {
      message: 'the first poll',
    });
    const [first] = await executionsOf(server.ctx, w.tenantId, mine.id);
    expect((await waitForExecution(server.ctx, w.tenantId, first.id)).status).toBe('success');

    const lost = await publishedThenLost(w, poller(), foreign, true, false);
    // the activation poll ran while A could use it; after the share went, the next start of its triggers is refused
    await waitFor(async () => (await executionsOf(server.ctx, w.tenantId, lost.id)).length >= 1, {
      message: 'the activation poll',
    });
    await repos().shares.set(w.tenantId, 'credential', foreign.id, []);
    const before = (await executionsOf(server.ctx, w.tenantId, lost.id)).length;
    await server.ctx.activeWorkflows.startTriggers(w.tenantId, lost.id, 'activate');
    await new Promise((r) => setTimeout(r, 500));
    expect(await executionsOf(server.ctx, w.tenantId, lost.id)).toHaveLength(before);
  });
});

describe('resume and queue', () => {
  it('a move while queued runs in the new project, not the one the run was queued with', async () => {
    const w = await world();
    const wf = await workflowIn(
      server,
      w.tenantId,
      w.a.id,
      flow(node('Probe', 'test.p6IsolationProbe', {}, [200, 0])),
    );
    const row = (await repos().workflows.get(w.tenantId, wf.id))!;
    // the run was queued with project A stored; the workflow's project then moved to B
    await repos().projects.moveResources(w.tenantId, w.a.id, w.b.id);
    const started = await server.ctx.executions.start({
      tenantId: w.tenantId,
      workflow: definitionOf(row),
      workflowId: wf.id,
      mode: 'manual',
      startNode: 'Start',
      projectId: w.a.id,
      wait: true,
    });
    const outcome = await started.finished;
    const output = outcome?.lastNodeOutput as Array<Array<{ json: { projectId: string } }>> | undefined;
    expect(output?.[0]?.[0]?.json.projectId).toBe(w.b.id);
  });
});
