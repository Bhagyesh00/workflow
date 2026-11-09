/**
 * Phase 6 S1 C0d, the run contract: every run and every context outside a run carries the project it belongs
 * to. `buildServices` needs `projectId`, `getProjectId` returns the workflow row's project, a run with no row
 * gets the stored one, a move while queued gets the new one, `allow` reaches the credentials provider, the
 * service creates fall back to the workspace's default project, the pre-run, save and publish checks are
 * wired, and the push envelope names the workflow.
 */
import { createBaseContext, type ExecutionServices } from '@workflow/core';
import {
  ExpressionEvaluator,
  type NodePackage,
  type NodeType,
  Workflow,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '../src/services/bus';
import { PushService } from '../src/services/bus';
import type { ExecutionService, StoredRunOptions } from '../src/services/executions';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

const usable = vi.hoisted(() => ({
  calls: [] as Array<{ tenantId: string; projectId: string; nodes: string[] }>,
}));

vi.mock('../src/services/credential-usable', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/credential-usable')>();
  return {
    ...original,
    assertCredentialsUsable: async (...args: Parameters<typeof original.assertCredentialsUsable>) => {
      const [, tenantId, projectId, definition] = args;
      usable.calls.push({ tenantId, projectId, nodes: definition.nodes.map((n) => n.name) });
      return original.assertCredentialsUsable(...args);
    },
  };
});

/** answers the project its context reads, so a run shows which project it ran in */
const probeType: NodeType = {
  description: {
    name: 'test.p6s1Probe',
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
    return [[{ json: { projectId: ctx.getProjectId(), tenantId: ctx.getTenantId() } }]];
  },
};

const probePackage: NodePackage = { name: 'p6s1-run-contract', credentials: [], nodes: [probeType] };

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [probePackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  usable.calls.length = 0;
  vi.restoreAllMocks();
});

const nodes = () => [node('Start', 'core.manualTrigger'), node('Probe', 'test.p6s1Probe', {}, [200, 0])];
const definitionOf = (id?: string): WorkflowDefinition => ({
  ...(id ? { id } : {}),
  name: 'Probe',
  nodes: nodes(),
  connections: chain('Start', 'Probe'),
  settings: {},
});

async function tenantRow(tenantId: string) {
  const row = await server.ctx.repos.tenants.get(tenantId);
  if (!row) throw new Error('no tenant');
  return row;
}

/** a saved workflow with the probe, and its row */
async function savedProbe() {
  const owner = await signup(server.app);
  const wf = await createWorkflow(owner.client, { nodes: nodes(), connections: chain('Start', 'Probe') });
  const row = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
  if (!row) throw new Error('no workflow row');
  return { owner, wf, row };
}

async function teamProject(tenantId: string, name: string) {
  return server.ctx.repos.projects.create(tenantId, { name, type: 'team' });
}

/** the project the probe saw in a run */
async function probedProject(started: { finished?: Promise<{ lastNodeOutput?: unknown } | undefined> }) {
  const outcome = await started.finished;
  const output = outcome?.lastNodeOutput as Array<Array<{ json: { projectId: string } }>> | undefined;
  return output?.[0]?.[0]?.json.projectId;
}

describe('buildServices', () => {
  it('needs a project and hands it to the engine with the allowed credentials', async () => {
    const { owner } = await savedProbe();
    const tenant = await tenantRow(owner.tenant.id);
    const project = await teamProject(tenant.id, 'Builds');
    const provider = vi.spyOn(server.ctx.credentials, 'provider');
    const forProject = vi.spyOn(server.ctx.dataTables, 'forProject');
    const variables = vi.spyOn(server.ctx.repos.variables, 'map');

    // @ts-expect-error a caller that misses the project fails the type check
    const missing: Parameters<ExecutionService['buildServices']>[0] = {
      tenant,
      executionId: '',
      mode: 'manual',
    };
    expect(missing.tenant.id).toBe(tenant.id);

    const services = await server.ctx.executions.buildServices({
      tenant,
      executionId: '',
      projectId: project.id,
      allowCredentials: ['cred-a'],
      mode: 'manual',
      workflowId: 'w-1',
    });
    expect(services.projectId).toBe(project.id);
    expect(provider).toHaveBeenCalledWith(tenant.id, project.id, { allow: ['cred-a'] });
    expect(forProject).toHaveBeenCalledWith(tenant.id, project.id, { workflowId: 'w-1' });
    expect(variables).toHaveBeenCalledWith(tenant.id, project.id);
  });

  it('getProjectId of a context returns the project of its services', async () => {
    const { owner } = await savedProbe();
    const tenant = await tenantRow(owner.tenant.id);
    const project = await teamProject(tenant.id, 'Context');
    const services: ExecutionServices = await server.ctx.executions.buildServices({
      tenant,
      executionId: '',
      projectId: project.id,
      mode: 'manual',
    });
    const definition = definitionOf();
    const workflow = new Workflow(definition, server.ctx.registries.nodeTypes);
    const ctx = createBaseContext({
      workflow,
      node: workflow.nodes.Probe!,
      services,
      evaluator: new ExpressionEvaluator({ timeoutMs: 1000 }),
      signal: new AbortController().signal,
    });
    expect(ctx.getProjectId()).toBe(project.id);
  });
});

describe('run project', () => {
  it("a saved workflow runs in its row's project", async () => {
    const { owner, wf, row } = await savedProbe();
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(wf.id),
      workflowId: wf.id,
      mode: 'manual',
      startNode: 'Start',
      wait: true,
    });
    expect(await probedProject(started)).toBe(row.projectId);
    expect(usable.calls).toContainEqual({
      tenantId: owner.tenant.id,
      projectId: row.projectId,
      nodes: ['Start', 'Probe'],
    });
  });

  it('a run with no workflow row gets the stored project', async () => {
    const owner = await signup(server.app);
    const project = await teamProject(owner.tenant.id, 'Drafts');
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(),
      mode: 'manual',
      startNode: 'Start',
      projectId: project.id,
      wait: true,
    });
    expect(await probedProject(started)).toBe(project.id);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, started.executionId);
    expect((data?.runOptions as StoredRunOptions | undefined)?.projectId).toBe(project.id);
    expect(usable.calls).toContainEqual({
      tenantId: owner.tenant.id,
      projectId: project.id,
      nodes: ['Start', 'Probe'],
    });
  });

  it('a run with neither a row nor a stored project fails', async () => {
    const owner = await signup(server.app);
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(),
      mode: 'manual',
      startNode: 'Start',
      wait: true,
    });
    const outcome = await started.finished;
    expect(outcome?.status).toBe('error');
    expect(outcome?.error?.message).toBe('The project of this execution could not be found');
  });

  it('a move while queued wins over the project the run was started with', async () => {
    const { owner, wf, row } = await savedProbe();
    const moved = await teamProject(owner.tenant.id, 'Moved');
    await server.ctx.repos.projects.moveResources(owner.tenant.id, row.projectId, moved.id);
    // the run was queued with the old project stored; the row now names the new one
    const started = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: definitionOf(wf.id),
      workflowId: wf.id,
      mode: 'manual',
      startNode: 'Start',
      projectId: row.projectId,
      wait: true,
    });
    expect(await probedProject(started)).toBe(moved.id);
  });

  it('a retry passes the stored project on', async () => {
    const owner = await signup(server.app);
    const project = await teamProject(owner.tenant.id, 'Retries');
    const failing: WorkflowDefinition = {
      name: 'Fails',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Boom', 'core.stopAndError', { errorMessage: 'boom' }, [200, 0]),
      ],
      connections: chain('Start', 'Boom'),
      settings: {},
    };
    const first = await server.ctx.executions.start({
      tenantId: owner.tenant.id,
      workflow: failing,
      mode: 'manual',
      startNode: 'Start',
      projectId: project.id,
      wait: true,
    });
    expect((await first.finished)?.status).toBe('error');
    const retry = await server.ctx.executions.retry(owner.tenant.id, first.executionId, {});
    await retry.finished?.catch(() => undefined);
    await server.ctx.executions.waitFor(retry.executionId).catch(() => undefined);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, retry.executionId);
    expect((data?.runOptions as StoredRunOptions | undefined)?.projectId).toBe(project.id);
  });
});

describe('service creates', () => {
  it("a route create with no project goes to the caller's personal project (P6-39)", async () => {
    const owner = await signup(server.app, { projects: 'real' });
    const tenantId = owner.tenant.id;
    const personal = (await server.ctx.repos.projects.getPersonal(tenantId, owner.user.id))!.id;

    const wf = await createWorkflow(owner.client, { nodes: nodes(), connections: chain('Start', 'Probe') });
    expect((await server.ctx.repos.workflows.get(tenantId, wf.id))?.projectId).toBe(personal);

    const credential = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', { name: 'Key', type: 'testApi', data: { apiKey: 'k' } }),
    );
    expect((await server.ctx.repos.credentials.get(tenantId, credential.id))?.projectId).toBe(personal);

    const folder = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/folders', { name: 'Folder' }),
    );
    expect((await server.ctx.repos.folders.get(tenantId, folder.id))?.projectId).toBe(personal);

    const table = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/data-tables', { name: 'table', columns: [] }),
    );
    expect((await server.ctx.repos.dataTables.get(tenantId, table.id))?.projectId).toBe(personal);
  });

  it('take the given project', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await teamProject(tenantId, 'Given');
    const credential = await server.ctx.credentials.create(tenantId, {
      name: 'Key',
      type: 'testApi',
      data: { apiKey: 'k' },
      projectId: project.id,
    });
    expect(credential.projectId).toBe(project.id);
    const table = await server.ctx.dataTables.create(tenantId, {
      name: 'table',
      columns: [],
      projectId: project.id,
    });
    expect((await server.ctx.repos.dataTables.get(tenantId, table.id))?.projectId).toBe(project.id);
    const folder = await server.ctx.folders.create(
      tenantId,
      { name: 'Folder', projectId: project.id } as never,
      { userId: owner.user.id },
    );
    expect((await server.ctx.repos.folders.get(tenantId, folder.id))?.projectId).toBe(project.id);
    // a sub-folder is in its parent's project
    const child = await server.ctx.folders.create(
      tenantId,
      { name: 'Child', parentFolderId: folder.id, projectId: project.id } as never,
      { userId: owner.user.id },
    );
    expect((await server.ctx.repos.folders.get(tenantId, child.id))?.projectId).toBe(project.id);
  });
});

describe('pre-run, save and publish checks', () => {
  it('a workflow create and a save with nodes check the credentials against its project', async () => {
    const { owner, wf, row } = await savedProbe();
    expect(usable.calls).toContainEqual({
      tenantId: owner.tenant.id,
      projectId: row.projectId,
      nodes: ['Start', 'Probe'],
    });
    usable.calls.length = 0;
    await server.ctx.workflows.update(
      owner.tenant.id,
      wf.id,
      { versionId: wf.versionId, nodes: nodes(), connections: chain('Start', 'Probe') } as never,
      { userId: owner.user.id },
    );
    expect(usable.calls).toEqual([
      { tenantId: owner.tenant.id, projectId: row.projectId, nodes: ['Start', 'Probe'] },
    ]);
  });

  it('a publish checks the version against the project', async () => {
    const owner = await signup(server.app);
    const webhook = node('Hook', 'core.webhook', { path: 'p6s1-publish', httpMethod: 'GET' });
    const wf = await createWorkflow(owner.client, { nodes: [webhook] });
    const row = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    usable.calls.length = 0;
    await server.ctx.activeWorkflows.activate(owner.tenant.id, wf.id);
    expect(usable.calls).toContainEqual({
      tenantId: owner.tenant.id,
      projectId: row?.projectId,
      nodes: ['Hook'],
    });
  });

  it('SecretsManager.assertProjectAccess refuses a vault the project has no connection for (L8 filled it)', async () => {
    const owner = await signup(server.app);
    const project = await teamProject(owner.tenant.id, 'Vaults');
    await expect(
      server.ctx.secrets.assertProjectAccess(owner.tenant.id, project.id, ['vault']),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('openSubNodes', () => {
  it('passes the project and the allowed credentials to buildServices', async () => {
    const { openSubNodes } = await import('../src/services/ai-builder/model');
    const owner = await signup(server.app);
    const tenant = await tenantRow(owner.tenant.id);
    const project = await teamProject(tenant.id, 'Models');
    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    const sub = await openSubNodes(
      server.ctx,
      tenant,
      definitionOf(),
      'Probe',
      new AbortController().signal,
      {
        projectId: project.id,
        allowCredentials: ['cred-1'],
      },
    );
    await sub.close();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, allowCredentials: ['cred-1'], mode: 'internal' }),
    );
  });
});

describe('push envelope', () => {
  it('names the workflow on the envelope and keeps the data as it was', async () => {
    const { owner, wf } = await savedProbe();
    const events: PushEvent[] = [];
    const unsubscribe = await server.ctx.push.subscribe(owner.tenant.id, (event) => events.push(event));
    try {
      const started = await server.ctx.executions.start({
        tenantId: owner.tenant.id,
        workflow: definitionOf(wf.id),
        workflowId: wf.id,
        mode: 'manual',
        startNode: 'Start',
        wait: true,
      });
      await started.finished;
      const finished = () => events.find((e) => e.type === 'executionFinished');
      await vi.waitFor(() => expect(finished()).toBeDefined(), { timeout: 10_000 });
      const startedEvent = events.find((e) => e.type === 'executionStarted');
      expect(startedEvent?.workflowId).toBe(wf.id);
      expect(startedEvent?.data).toEqual({
        executionId: started.executionId,
        workflowId: wf.id,
        mode: 'manual',
      });
      expect(finished()?.workflowId).toBe(wf.id);
      for (const event of events.filter((e) => e.type.startsWith('nodeExecute'))) {
        expect(event.workflowId).toBe(wf.id);
      }
    } finally {
      unsubscribe();
    }
  });

  it('an event with no workflow keeps the old envelope', async () => {
    const published: unknown[] = [];
    const push = new PushService({
      publish: async (_channel: string, message: unknown) => published.push(message),
    } as never);
    push.send('t1', 'workflowReviewChanged', { workflowId: '', requestId: '' });
    push.send('t1', 'executionStarted', { executionId: 'e1' }, { workflowId: 'w1' });
    expect(published).toEqual([
      { type: 'workflowReviewChanged', data: { workflowId: '', requestId: '' } },
      { type: 'executionStarted', data: { executionId: 'e1' }, workflowId: 'w1' },
    ]);
  });
});
