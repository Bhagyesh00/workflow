/**
 * P6-04 (L2): the type policy on every run path. One check at run start (`ExecutionService.run`), so a run
 * of a workflow with a blocked type fails as an execution holding the violation, whatever started it: a
 * trigger start, a retry, a resume, a queued run on a worker, a sub-workflow (saved or inline).
 * A manual run is refused before it starts; start-up leaves a blocked published workflow unstarted; the
 * store failing at start fails the run (fail closed). The webhook phase (a webhook, a form, a chat, a resume
 * URL, the MCP Server Trigger) is judged before the node runs or decrypts (403, no run); every trigger start
 * is judged, a settings reload included; the decrypt point judges the type of the credential it decrypts.
 * Every allowed and refused action is a true member's (a `project:editor` of the team project); the owner
 * only sets up and writes policies.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { NodePackage, NodeType, WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import { loadModelFromSetting } from '../src/services/ai-builder/model';
import { CredentialService } from '../src/services/credentials';
import { PolicyCheckFailedError } from '../src/services/type-policies/errors';
import {
  addToProject,
  chain,
  createTestServer,
  createWorkflow,
  credentialIn,
  executionsOf,
  flushRedis,
  node,
  policyDeny,
  realMember,
  setNode,
  signup,
  TEST_REDIS,
  type TestServer,
  teamProjectOf,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const BLOCKED = (type: string) => `Node type "${type}" is blocked by a workspace policy`;
const CREDENTIAL_BLOCKED = (type: string) => `Credential type "${type}" is blocked by a workspace policy`;

/** a node that reads its `oAuth2Api` slot (a child type's credential fills it), counting the reads that got data */
let oauthReads = 0;
const oauthProbe = {
  description: {
    name: 'p6run.oauthProbe',
    displayName: 'OAuth probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'OAuth probe' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'oAuth2Api', required: true }],
    properties: [],
  },
  async execute(ctx) {
    await ctx.getCredentials('oAuth2Api');
    oauthReads++;
    return [ctx.getInputData()];
  },
} as NodeType;

const probePackage: NodePackage = { name: 'p6-run-tests', nodes: [oauthProbe], credentials: [] };

let server: TestServer;
let signups = 0;
/** a new workspace with its team project, from its own IP (signup allows 20 an hour per IP) */
const newOwner = async (on: TestServer = server) => {
  signups++;
  const owner = await signup(on.app, { remoteAddress: `10.73.${signups >> 8}.${signups & 255}` });
  return { ...owner, projectId: await teamProjectOf(on, owner.tenant.id) };
};

/** a true member of a new workspace's team project (`project:editor`), whose creates land there */
const newMember = async () => {
  const owner = await newOwner();
  const member = await realMember(owner);
  await addToProject(server, owner.tenant.id, owner.projectId, member.user.id, 'project:editor');
  member.client.defaultProjectId = owner.projectId;
  return { ...owner, client: member.client, member };
};

const failing = (): { nodes: WorkflowNode[]; connections: Record<string, unknown> } => ({
  nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
  connections: chain('Start', 'Boom'),
});

beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({}, { nodePackages: [nodesAiPackage, probePackage] });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an old workflow with a blocked type', () => {
  it('saves, refuses to publish and a manual run; its run fails as an execution holding the violation', async () => {
    const { client, tenant, projectId } = await newMember();
    const old = await workflowIn(server, tenant.id, projectId, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 }), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const current = await client.data(client.get(`/rest/workflows/${old.id}`));
    const saved = await client.patch(`/rest/workflows/${old.id}`, {
      versionId: current.versionId,
      name: 'Kept',
    });
    expect(saved.statusCode).toBe(200);

    const publish = await client.post(`/rest/workflows/${old.id}/activate`);
    expect(publish.statusCode).toBe(403);
    expect(publish.json().error.message).toBe(BLOCKED('core.set'));
    const manual = await client.post(`/rest/workflows/${old.id}/run`, {});
    expect(manual.statusCode).toBe(403);
    expect(manual.json().error.code).toBe('policy_violation');

    const row = await server.ctx.repos.workflows.get(tenant.id, old.id);
    const { executionId } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: {
        id: old.id,
        name: 'Kept',
        nodes: row!.nodes as WorkflowNode[],
        connections: row!.connections as never,
      },
      workflowId: old.id,
      mode: 'trigger',
    });
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('core.set') });
    const data = await server.ctx.repos.executions.getData(tenant.id, executionId);
    expect(JSON.stringify(data?.state)).toContain('blocked by a workspace policy');
  });
});

describe('run paths', () => {
  it('a webhook call is refused before the node runs or decrypts its credential: 403, no run', async () => {
    const { client, tenant, projectId } = await newMember();
    const basic = await credentialIn(server, tenant.id, projectId, {
      type: 'httpBasicAuth',
      data: { user: 'hook', password: 'hook-secret' },
    });
    const wf = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'policy-hook', authentication: 'basicAuth' },
          [0, 0],
          { webhookId: 'ph', credentials: { httpBasicAuth: { id: basic.id, name: basic.name } } },
        ),
        setNode('Set', 'a', 1),
      ],
      connections: chain('Webhook', 'Set'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await policyDeny(server, tenant.id, 'credential', 'httpBasicAuth');
    const decrypt = vi.spyOn(server.ctx.credentials, 'decrypt');
    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/policy-hook`,
      headers: { authorization: `Basic ${Buffer.from('hook:hook-secret').toString('base64')}` },
      payload: { v: 1 },
    });
    expect({ status: res.statusCode, error: res.json().error }).toEqual({
      status: 403,
      error: { code: 'policy_violation', message: CREDENTIAL_BLOCKED('httpBasicAuth') },
    });
    expect(build).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toEqual([]);
  });

  it('a resume URL is refused before the waiting node runs: 403, the run still waits', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'core.wait', { resume: 'webhook', httpMethod: 'POST' }, [200, 0]),
        setNode('Set', 'a', 1, [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'Set'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    const res = await server.app.inject({
      method: 'POST',
      url: new URL(server.ctx.executions.resumeUrl(executionId)).pathname,
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toEqual({ code: 'policy_violation', message: BLOCKED('core.set') });
    expect(build).not.toHaveBeenCalled();
    expect((await server.ctx.repos.executions.get(tenant.id, executionId))?.status).toBe('waiting');
  });

  it('an MCP Server Trigger call is refused before the trigger or its tools run: 403', async () => {
    const { client, tenant } = await newMember();
    const path = `policy-${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(client, {
      nodes: [
        node('MCP Server Trigger', 'ai.mcpTrigger', { path }, [0, 0], { webhookId: randomUUID() }),
        node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
      ],
      connections: {
        Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] },
      },
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await policyDeny(server, tenant.id, 'node', 'ai.toolCalculator');
    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    const res = await server.app.inject({
      method: 'POST',
      url: `/mcp/${tenant.slug}/${path}`,
      headers: {
        host: new URL(server.ctx.config.mcp.baseUrl).host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(BLOCKED('ai.toolCalculator'));
    expect(build).not.toHaveBeenCalled();
  });

  it('a retry fails', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, failing());
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    expect(await waitForExecution(server.ctx, tenant.id, executionId)).toMatchObject({
      status: 'error',
      errorMessage: 'Intentional failure',
    });
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    const retry = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    const failed = await waitForExecution(server.ctx, tenant.id, retry.executionId);
    expect(failed).toMatchObject({ status: 'error', mode: 'retry', errorMessage: BLOCKED('test.fail') });
  });

  it('a resume fails', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        setNode('Set', 'a', 1, [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'Set'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const resumed = await server.ctx.executions.resume(tenant.id, executionId);
    expect(resumed?.executionId).toBe(executionId);
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('core.set') });
  });

  it('a saved sub-workflow with a blocked type fails, and so does its caller', async () => {
    const { client, tenant, projectId } = await newMember();
    const child = await workflowIn(server, tenant.id, projectId, failing());
    const parent = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    expect((await waitForExecution(server.ctx, tenant.id, executionId)).status).toBe('error');
    const sub = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, child.id))[0], {
      message: 'the sub-run',
    });
    expect(await waitForExecution(server.ctx, tenant.id, sub.id)).toMatchObject({
      status: 'error',
      errorMessage: BLOCKED('test.fail'),
    });
  });

  it('an inline sub-workflow with a blocked type fails', async () => {
    const { client, tenant } = await newMember();
    const parent = await createWorkflow(client, {
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
                node('Inner start', 'core.executeWorkflowTrigger'),
                node('Nothing', 'core.noOp', {}, [200, 0]),
              ],
              connections: chain('Inner start', 'Nothing'),
            }),
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Run inline'),
    });
    await policyDeny(server, tenant.id, 'node', 'core.noOp');
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed.status).toBe('error');
    const runs = await executionsOf(server.ctx, tenant.id);
    const inline = runs.find((run) => run.id !== executionId);
    expect(inline).toBeDefined();
    expect(await waitForExecution(server.ctx, tenant.id, inline!.id)).toMatchObject({
      status: 'error',
      errorMessage: BLOCKED('core.noOp'),
    });
  });

  it('the store failing at start fails the run (fail closed)', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'a', 1)],
      connections: chain('Start', 'Set'),
    });
    await server.ctx.policySnapshots.invalidate(tenant.id);
    vi.spyOn(server.ctx.repos.typePolicies, 'loadTenant').mockRejectedValue(new Error('database down'));
    const manual = await client.post(`/rest/workflows/${wf.id}/run`, {});
    expect(manual.statusCode).toBe(503);
    expect(manual.json().error.code).toBe('policy_check_failed');
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    const { executionId } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: {
        id: wf.id,
        name: 'x',
        nodes: row!.nodes as WorkflowNode[],
        connections: row!.connections as never,
      },
      workflowId: wf.id,
      mode: 'trigger',
    });
    expect(await waitForExecution(server.ctx, tenant.id, executionId)).toMatchObject({
      status: 'error',
      errorMessage: 'Could not verify policy for workflowStart, so the action was blocked',
    });
  });
});

describe('start-up', () => {
  it('leaves a blocked published workflow unstarted, with the violation as its activation error', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 }), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    const allowed = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 })],
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await client.data(client.post(`/rest/workflows/${allowed.id}/activate`));
    const active = server.ctx.activeWorkflows;
    expect(active.runningWorkflowIds).toEqual(expect.arrayContaining([wf.id, allowed.id]));

    await policyDeny(server, tenant.id, 'node', 'core.set');
    await active.stopAll();
    await active.startAll();
    expect(active.runningWorkflowIds).toContain(allowed.id);
    expect(active.runningWorkflowIds).not.toContain(wf.id);
    expect(active.activationErrorOf(wf.id)).toBe(BLOCKED('core.set'));
    // still published: an admin who lifts the block gets it back at the next start-up
    expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(true);
    await active.stopAll();
  });

  it('a settings save restarts no blocked triggers: the workflow is unpublished with the violation', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 }), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    const active = server.ctx.activeWorkflows;
    expect(active.runningWorkflowIds).toContain(wf.id);
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    const saved = await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        settings: { ...current.settings, timezone: 'Europe/Berlin' },
      }),
    );
    expect(saved.activationError).toMatchObject({ message: BLOCKED('core.set') });
    expect(saved.active).toBe(false);
    expect(active.runningWorkflowIds).not.toContain(wf.id);
  });
});

describe('the decrypt point', () => {
  it('judges the type it decrypts: a blocked child type in its parent slot fails the run before the read', async () => {
    const { client, tenant, projectId } = await newMember();
    const child = await credentialIn(server, tenant.id, projectId, {
      type: 'testPkceOAuth2Api',
      data: { clientId: 'child-client' },
    });
    await policyDeny(server, tenant.id, 'credential', 'testPkceOAuth2Api');
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Probe', 'p6run.oauthProbe', {}, [200, 0], {
          credentials: { oAuth2Api: { id: child.id, name: child.name } },
        }),
      ],
      connections: chain('Start', 'Probe'),
    });
    oauthReads = 0;
    // the slot (`oAuth2Api`) is allowed, so the run starts; the row's own type is what the decrypt judges
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    expect(await waitForExecution(server.ctx, tenant.id, executionId)).toMatchObject({
      status: 'error',
      errorMessage: CREDENTIAL_BLOCKED('testPkceOAuth2Api'),
    });
    expect(oauthReads).toBe(0);
    const audit = (await server.ctx.repos.audit.list(tenant.id, 100)).filter(
      (row) => row.action === 'policy.blocked',
    );
    expect(audit.map((row) => row.metadata)).toEqual([
      expect.objectContaining({ point: 'credentialDecrypt', type: 'testPkceOAuth2Api' }),
    ]);
  });

  it('the AI model of the builder and the Assistant is refused before it opens when its node or credential type is blocked', async () => {
    const open = async (deniedKind: 'node' | 'credential', deniedType: string) => {
      const { tenant, projectId } = await newOwner();
      const credential = await credentialIn(server, tenant.id, projectId, {
        type: 'openAiApi',
        data: { apiKey: 'sk-policy-test-000000000000', baseUrl: 'http://127.0.0.1:9/v1' },
      });
      await policyDeny(server, tenant.id, deniedKind, deniedType);
      const row = (await server.ctx.repos.tenants.get(tenant.id))!;
      const setting = { credentialId: credential.id, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' };
      return loadModelFromSetting(server.ctx, row, setting, AbortSignal.timeout(10_000));
    };
    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    await expect(open('node', 'ai.lmChatOpenAi')).rejects.toThrow(BLOCKED('ai.lmChatOpenAi'));
    await expect(open('credential', 'openAiApi')).rejects.toThrow(CREDENTIAL_BLOCKED('openAiApi'));
    expect(build).not.toHaveBeenCalled();
  });

  it('a provider with no policy deps fails closed before the decrypt', async () => {
    const { tenant, projectId } = await newOwner();
    const { ctx } = server;
    const row = await credentialIn(server, tenant.id, projectId);
    const service = new CredentialService(ctx.repos, ctx.cipher, ctx.registries.credentialTypes);
    const decrypt = vi.spyOn(service, 'decrypt');
    const error = await service
      .provider(tenant.id, projectId)
      .get({ id: row.id, name: row.name }, 'testApi')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyCheckFailedError);
    expect((error as PolicyCheckFailedError).point).toBe('credentialDecrypt');
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe('queue mode', () => {
  const QUEUE_ENV = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfpolicy' };
  let main: TestServer;
  let worker: ServerContext;

  beforeAll(async () => {
    main = await createTestServer(QUEUE_ENV, { reset: false });
    worker = await createContext({
      config: testConfig({ ...QUEUE_ENV, BINARY_DATA_DIR: main.ctx.config.binaryData.dir }),
      nodePackages: [nodesBasePackage, testPackage],
      http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
      migrate: false,
    });
    await worker.startWorker();
  }, 120_000);

  afterAll(async () => {
    await main?.close();
    await worker?.close();
  });

  it('a queued run fails on the worker', async () => {
    const { tenant, projectId } = await newOwner(main);
    const old = await workflowIn(main, tenant.id, projectId, failing());
    await policyDeny(main, tenant.id, 'node', 'test.fail');
    const { executionId } = await main.ctx.executions.start({
      tenantId: tenant.id,
      workflow: { id: old.id, name: old.name, ...failing() } as never,
      workflowId: old.id,
      mode: 'trigger',
    });
    const failed = await waitForExecution(main.ctx, tenant.id, executionId, undefined, 20_000);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('test.fail') });
    expect(main.ctx.executions.runningCount).toBe(0);
  });
});
