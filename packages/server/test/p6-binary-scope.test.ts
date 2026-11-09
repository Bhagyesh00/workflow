/**
 * P6-25 (L5): GET /rest/binary-data parses the file id and checks who may read it. A run's file needs
 * `execution:read` on that run (through its workflow); an Assistant thread attachment is its thread owner's
 * only; a webhook lifecycle hook's file (`activation/<workflowId>/...`) needs `workflow:read` on that workflow,
 * and an older `activation/<file>` without one is owner and admin only. Another workspace's id, a path
 * trick or an unknown folder is 404. Inside a run a node reads, and a retry copies, only the files of this
 * run, its parent runs and the runs of workflows owned by or shared into its project.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NodePackage, NodeType, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredRunOptions } from '../src/services/executions';
import {
  addToProject,
  chain,
  createTestServer,
  memberAs,
  node,
  outputOf,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

/** binary ids the lifecycle hook of `p6.binaryHook` stored on activation */
const hookFiles: string[] = [];

const binaryHook: NodeType = {
  description: {
    name: 'p6.binaryHook',
    displayName: 'Hook that stores a file',
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Hook' },
    inputs: [],
    outputs: ['main'],
    properties: [],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'p6-binary-hook' }],
  },
  webhookMethods: {
    default: {
      async checkExists() {
        return false;
      },
      async create(ctx) {
        // above the inline threshold, so the file lands on disk
        const stored = await ctx.helpers.prepareBinaryData(new Uint8Array(70_000), 'hook.bin');
        hookFiles.push(stored.id ?? '');
        return true;
      },
      async delete() {
        return true;
      },
    },
  },
  async webhook() {
    return { workflowData: [[{ json: {} }]] };
  },
};

/** reads the file of its first input item (`binary.data`) as text */
const readFile: NodeType = {
  description: {
    name: 'p6.readFile',
    displayName: 'Read the input file',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Read' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    const data = await ctx.helpers.getBinaryDataBuffer(0, 'data');
    return [[{ json: { text: Buffer.from(data).toString() } }]];
  },
};

/** outputs one item whose file (`binary.data`) is the id in its `fileId` parameter */
const emitFile: NodeType = {
  description: {
    name: 'p6.emitFile',
    displayName: 'Output a file id',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Emit' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'File', name: 'fileId', type: 'string', default: '' }],
  },
  async execute(ctx) {
    const id = String(ctx.getNodeParameter('fileId', 0));
    return [[{ json: {}, binary: { data: { id, mimeType: 'text/plain', fileName: 'f.txt', data: '' } } }]];
  },
};

const hookPackage: NodePackage = {
  name: 'p6-binary-tests',
  nodes: [binaryHook, readFile, emitFile],
  credentials: [],
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [hookPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  hookFiles.length = 0;
});

/** a file on disk under `<tenant>/<folder>/`, as the filesystem store writes it; returns its id */
async function storedFile(tenantId: string, folder: string): Promise<string> {
  const name = randomUUID();
  const dir = path.join(server.ctx.config.binaryData.dir, tenantId, ...folder.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), 'file bytes');
  return `fs:${tenantId}/${folder}/${name}`;
}

const fetchFile = (client: TestClient, id: string) =>
  client.get(`/rest/binary-data?id=${encodeURIComponent(id)}&mimeType=text/plain&fileName=f.txt`);

async function runOf(tenantId: string, workflowId: string | null): Promise<string> {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    { id, workflowId, workflowName: 'Run', mode: 'manual', status: 'success', startedAt: new Date() },
    { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
  );
  return id;
}

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

describe('files of runs', () => {
  it('a member reads the files of runs it can read and none of another project', async () => {
    const { owner, member, inAlpha, inBeta, tenantId } = await setup();
    const own = await storedFile(tenantId, await runOf(tenantId, inAlpha.id));
    const hidden = await storedFile(tenantId, await runOf(tenantId, inBeta.id));

    const ok = await fetchFile(member.client, own);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('file bytes');
    const refused = await fetchFile(member.client, hidden);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    expect((await fetchFile(owner.client, hidden)).statusCode).toBe(200);
  });

  it('the files of a run with no workflow are owner and admin only', async () => {
    const { owner, member, tenantId } = await setup('project:admin');
    const admin = await memberAs(owner, 'admin');
    const orphan = await storedFile(tenantId, await runOf(tenantId, null));
    expect((await fetchFile(owner.client, orphan)).statusCode).toBe(200);
    expect((await fetchFile(admin.client, orphan)).statusCode).toBe(200);
    expect((await fetchFile(member.client, orphan)).statusCode).toBe(403);
  });

  it('another workspace, a path trick, an unknown folder or a non-file id is 404', async () => {
    const { owner, inAlpha, tenantId } = await setup();
    const other = await signup(server.app);
    const own = await storedFile(tenantId, await runOf(tenantId, inAlpha.id));
    expect((await fetchFile(other.client, own)).statusCode).toBe(404);
    const name = own.split('/').pop();
    for (const id of [
      `fs:${tenantId}/../${other.tenant.id}/x/${name}`,
      `fs:${tenantId}/${randomUUID()}/${name}`,
      `fs:${tenantId}/not-a-run/${name}`,
      `fs:${tenantId}/${name}`,
      `s3:${tenantId}/x/${name}`,
    ]) {
      expect((await fetchFile(owner.client, id)).statusCode, id).toBe(404);
    }
    expect((await owner.client.get('/rest/binary-data')).statusCode).toBe(400);
  });
});

describe('Assistant thread attachments', () => {
  it('are their thread owner only', async () => {
    const { owner, tenantId } = await setup();
    const admin = await memberAs(owner, 'admin');
    const thread = await server.ctx.repos.assistantThreads.create(tenantId, owner.user.id);
    const file = await storedFile(tenantId, thread.id);
    expect((await fetchFile(owner.client, file)).statusCode).toBe(200);
    expect((await fetchFile(admin.client, file)).statusCode).toBe(404);
  });
});

describe('files of webhook lifecycle hooks', () => {
  it('are stored by workflow and read by those who read the workflow', async () => {
    const { owner, member, alpha, beta, tenantId } = await setup();
    const inAlpha = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/workflows', {
        name: 'Hook in alpha',
        nodes: [node('Hook', 'p6.binaryHook', {}, [0, 0], { webhookId: randomUUID() })],
        connections: {},
        settings: {},
        projectId: alpha.id,
      }),
    );
    await owner.client.data(owner.client.post(`/rest/workflows/${inAlpha.id}/activate`));
    await waitFor(async () => hookFiles.length === 1, { message: 'the hook file' });
    expect(hookFiles[0]).toMatch(new RegExp(`^fs:${tenantId}/activation/${inAlpha.id}/`));
    expect((await fetchFile(member.client, hookFiles[0])).statusCode).toBe(200);

    const inBeta = await workflowIn(server, tenantId, beta.id, { name: 'Other' });
    const hidden = await storedFile(tenantId, `activation/${inBeta.id}`);
    expect((await fetchFile(member.client, hidden)).statusCode).toBe(403);
    expect((await fetchFile(owner.client, hidden)).statusCode).toBe(200);
    await owner.client.data(owner.client.post(`/rest/workflows/${inAlpha.id}/deactivate`));
  });

  it('an older file with no workflow in its path is owner and admin only', async () => {
    const { owner, member, tenantId } = await setup('project:admin');
    const old = await storedFile(tenantId, 'activation');
    expect((await fetchFile(owner.client, old)).statusCode).toBe(200);
    expect((await fetchFile(member.client, old)).statusCode).toBe(403);
  });
});

describe('files inside a run', () => {
  /** a workflow in `projectId`: a manual trigger (its pinned item carries the file) into `next` */
  const fileWorkflow = async (tenantId: string, projectId: string, next: WorkflowNode) =>
    workflowIn(server, tenantId, projectId, {
      name: 'Takes a file',
      nodes: [node('Start', 'core.manualTrigger'), { ...next, position: [200, 0] }],
      connections: chain('Start', next.name),
    });
  const fileItem = (id: string) => [{ json: {}, binary: { data: { id, mimeType: 'text/plain', data: '' } } }];
  const runAs = async (client: TestClient, tenantId: string, workflowId: string, id: string) => {
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${workflowId}/run`, { pinData: { Start: fileItem(id) } }),
    );
    return { executionId, row: await waitForExecution(server.ctx, tenantId, executionId) };
  };

  it('a node reads the files of its project and of shared workflows, never another project', async () => {
    const { owner, member, alpha, inAlpha, inBeta, tenantId } = await setup('project:editor');
    const reader = await fileWorkflow(tenantId, alpha.id, node('Read', 'p6.readFile'));
    const sameProject = await storedFile(tenantId, await runOf(tenantId, inAlpha.id));
    const otherProject = await storedFile(tenantId, await runOf(tenantId, inBeta.id));

    const ok = await runAs(member.client, tenantId, reader.id, sameProject);
    expect(ok.row.status).toBe('success');
    const okData = await server.ctx.repos.executions.getData(tenantId, ok.executionId);
    expect(outputOf(okData!.state, 'Read')).toEqual([{ text: 'file bytes' }]);

    const refused = await runAs(member.client, tenantId, reader.id, otherProject);
    expect(refused.row.status).toBe('error');
    expect(refused.row.errorMessage).toBe('Binary data not found');

    // shared into alpha, beta's workflow's runs are alpha's to read too
    await server.ctx.repos.shares.set(tenantId, 'workflow', inBeta.id, [alpha.id]);
    const shared = await runAs(member.client, tenantId, reader.id, otherProject);
    expect(shared.row.status).toBe('success');
    // the owner's run of the same workflow follows the workflow's project, not the user
    await server.ctx.repos.shares.set(tenantId, 'workflow', inBeta.id, []);
    expect((await runAs(owner.client, tenantId, reader.id, otherProject)).row.status).toBe('error');
  });

  it("a retry copies the files of its project's runs and none of another project", async () => {
    const { member, alpha, inAlpha, inBeta, tenantId } = await setup('project:editor');
    const failing = await fileWorkflow(tenantId, alpha.id, node('Fail', 'test.fail'));
    const sameProject = await storedFile(tenantId, await runOf(tenantId, inAlpha.id));
    const otherProject = await storedFile(tenantId, await runOf(tenantId, inBeta.id));

    const retried = async (id: string) => {
      const { executionId, row } = await runAs(member.client, tenantId, failing.id, id);
      expect(row.status).toBe('error');
      const retry = await member.client.data<{ executionId: string }>(
        member.client.post(`/rest/executions/${executionId}/retry`, {}),
      );
      await waitForExecution(server.ctx, tenantId, retry.executionId);
      const data = await server.ctx.repos.executions.getData(tenantId, retry.executionId);
      const pinned = (data!.runOptions as StoredRunOptions).pinData?.Start?.[0]?.binary?.data?.id;
      return { retryId: retry.executionId, pinned: pinned ?? '' };
    };

    const copied = await retried(sameProject);
    expect(copied.pinned).toBe(`fs:${tenantId}/${copied.retryId}/${sameProject.split('/').pop()}`);
    const res = await fetchFile(member.client, copied.pinned);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('file bytes');

    // not copied: the reference still names beta's run, which the member cannot read
    const kept = await retried(otherProject);
    expect(kept.pinned).toBe(otherProject);
    const name = otherProject.split('/').pop();
    expect((await fetchFile(member.client, `fs:${tenantId}/${kept.retryId}/${name}`)).statusCode).toBe(404);
    expect((await fetchFile(member.client, otherProject)).statusCode).toBe(403);
  });

  it("a webhook answers with the last node's file of its project only", async () => {
    const { owner, alpha, inAlpha, inBeta, tenantId } = await setup();
    const sameProject = await storedFile(tenantId, await runOf(tenantId, inAlpha.id));
    const otherProject = await storedFile(tenantId, await runOf(tenantId, inBeta.id));
    const answer = async (webhookPath: string, fileId: string) => {
      const wf = await owner.client.data<{ id: string }>(
        owner.client.post('/rest/workflows', {
          name: `Answers ${webhookPath}`,
          projectId: alpha.id,
          nodes: [
            node(
              'Webhook',
              'core.webhook',
              {
                httpMethod: 'POST',
                path: webhookPath,
                responseMode: 'lastNode',
                responseData: 'firstEntryBinary',
              },
              [0, 0],
              { webhookId: webhookPath },
            ),
            node('Emit', 'p6.emitFile', { fileId }, [200, 0]),
          ],
          connections: chain('Webhook', 'Emit'),
        }),
      );
      await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
      return server.app.inject({ method: 'POST', url: `/webhook/${owner.tenant.slug}/${webhookPath}` });
    };

    const ok = await answer('p6-own-file', sameProject);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('file bytes');
    // a saved run of alpha whose last node names beta's file never answers with it
    const refused = await answer('p6-foreign-file', otherProject);
    expect(refused.statusCode).not.toBe(200);
    expect(refused.body).not.toContain('file bytes');
  });
});
