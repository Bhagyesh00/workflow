/**
 * P6-07 (S4 L4): the push and the remote content.
 *
 * Push: the paths come from the server's own status for the caller (GHSA-hvrx-jc5j-pg3w: a name outside it is
 * refused); one commit on the fetched head with only the picked files changed and the message trimmed (default
 * "Updated Workfolder"); a conflict without `force` is 409 with the list, `force` pushes. Remote content: workflows
 * only, by git id; the global admin 200, a project viewer 403, an id with no local mapping 403 for a non-admin, an
 * id the repository does not hold 404. Not connected 412, a bad body 400, a held lease 409. Before L5 the project
 * admin's pushable set is empty (fail closed), so only the global admin and a project viewer are tested here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { type HttpRequestOptions, pathFor, type SourceControlledFile } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease } from '../src/services/source-control/lock';
import { type BareRepo, createBareRepo, requireGit, startGitHttpServer } from './fakes/git-server';
import {
  addToProject,
  createTestServer,
  createWorkflow,
  node,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

class TlsTerminatingClient extends HttpClient {
  override request<T = unknown>(options: HttpRequestOptions, signal?: AbortSignal) {
    return super.request<T>(
      { ...options, url: options.url.replace(/^https:\/\/127\.0\.0\.1:/, 'http://127.0.0.1:') },
      signal,
    );
  }
}

const TOKEN = `tok_${randomBytes(12).toString('hex')}`;
let server: TestServer;
let ip = 1;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await requireGit();
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    {
      http: new TlsTerminatingClient({
        ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] },
      }),
    },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const world = () => signup(server.app, { remoteAddress: `127.9.5.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof world>>;

async function httpRemote(): Promise<{ repo: BareRepo; url: string }> {
  const repo = await createBareRepo();
  const http = await startGitHttpServer(repo, { auth: { username: 'deploy', token: TOKEN } });
  cleanups.push(
    () => repo.cleanup(),
    () => http.close(),
  );
  return { repo, url: `https://127.0.0.1:${http.port}${repo.urlPath}` };
}

async function connected(): Promise<{ repo: BareRepo; url: string; a: World }> {
  const { repo, url } = await httpRemote();
  const a = await world();
  const res = await a.client.post('/rest/source-control/preferences', {
    repositoryUrl: url,
    connectionType: 'https',
    httpsUsername: 'deploy',
    httpsPassword: TOKEN,
    initRepo: true,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { repo, url, a };
}

const status = async (w: { client: World['client'] }, direction: 'push' | 'pull' = 'push') =>
  w.client.data<SourceControlledFile[]>(
    w.client.get(`/rest/source-control/get-status?direction=${direction}`),
  );
const push = (w: { client: World['client'] }, body: Record<string, unknown>) =>
  w.client.post('/rest/source-control/push-workfolder', body);
const manual = () => [node('Start', 'core.manualTrigger')];

describe('push', () => {
  it('commits only the picked files on the fetched head, with the trimmed message', async () => {
    const { repo, a } = await connected();
    const one = await createWorkflow(a.client, { name: 'One', nodes: manual() });
    const two = await createWorkflow(a.client, { name: 'Two', nodes: manual() });
    const rows = await status(a);
    expect(rows.filter((r) => r.type === 'workflow').map((r) => [r.name, r.status, r.location])).toEqual([
      ['One', 'created', 'local'],
      ['Two', 'created', 'local'],
    ]);
    const before = await repo.head();

    const first = await push(a, {
      fileNames: [{ id: one.id, type: 'workflow' }],
      commitMessage: '  Add one  ',
    });
    expect(first.statusCode, first.body).toBe(200);
    const result = first.json().data;
    expect(result.files).toEqual([expect.objectContaining({ id: one.id, type: 'workflow', pushed: true })]);
    const head = await repo.head();
    expect(result.commit).toBe(head);
    expect(await repo.parents(head ?? '')).toEqual(before ? [before] : []);
    expect(await repo.message(head ?? '')).toBe('Add one');
    const files = await repo.files(head ?? '');
    expect(files.has(pathFor('workflow', one.id))).toBe(true);
    expect(files.has(pathFor('workflow', two.id))).toBe(false);
    expect(JSON.parse(files.get(pathFor('workflow', one.id)) ?? '{}')).toMatchObject({
      id: one.id,
      name: 'One',
      versionId: one.versionId,
    });

    // the next push keeps the first file as it is and takes the default message
    const second = await push(a, { fileNames: [{ id: two.id, type: 'workflow' }] });
    expect(second.statusCode, second.body).toBe(200);
    const next = await repo.head();
    expect(await repo.parents(next ?? '')).toEqual([head]);
    expect(await repo.message(next ?? '')).toBe('Updated Workfolder');
    const after = await repo.files(next ?? '');
    expect(after.get(pathFor('workflow', one.id))).toBe(files.get(pathFor('workflow', one.id)));
    expect(after.has(pathFor('workflow', two.id))).toBe(true);
    expect((await status(a)).filter((r) => r.type === 'workflow')).toEqual([]);
    const audit = (
      await server.ctx.database.pool.query(
        "select metadata from audit_log where action = 'source_control.pushed'",
      )
    ).rows;
    expect(audit).toHaveLength(2);
  });

  it('refuses a name outside the caller’s own status (GHSA-hvrx-jc5j-pg3w)', async () => {
    const { repo, a } = await connected();
    const wf = await createWorkflow(a.client, { name: 'Admin work', nodes: manual() });
    // an id the status does not hold
    const unknown = await push(a, { fileNames: [{ id: randomUUID(), type: 'workflow' }] });
    expect(unknown.statusCode).toBe(400);
    // a file of the right id but another type
    const wrongType = await push(a, { fileNames: [{ id: wf.id, type: 'credential' }] });
    expect(wrongType.statusCode).toBe(400);
    // a member whose status holds nothing names the admin's workflow
    const member = await realMember(a);
    await addToProject(server, a.tenant.id, a.client.defaultProjectId!, member.user.id, 'project:editor');
    expect(await status(member)).toEqual([]);
    const head = await repo.head();
    const refused = await push(member, { fileNames: [{ id: wf.id, type: 'workflow' }] });
    expect(refused.statusCode).toBe(400);
    expect(await repo.head()).toBe(head);
    // a client path is never read: only id and type
    const path = await push(a, {
      fileNames: [{ id: wf.id, type: 'workflow', file: '../../etc/passwd' }],
    });
    expect(path.statusCode).toBe(200);
    expect([...(await repo.files((await repo.head()) ?? '')).keys()]).not.toContain('../../etc/passwd');
  });

  it('answers a conflict with 409 and the list; force pushes', async () => {
    const { url, a } = await connected();
    const wf = await createWorkflow(a.client, { name: 'Shared', nodes: manual() });
    expect((await push(a, { fileNames: [{ id: wf.id, type: 'workflow' }] })).statusCode).toBe(200);
    // B takes it, changes it and pushes
    const b = await world();
    expect(
      (
        await b.client.post('/rest/source-control/preferences', {
          repositoryUrl: url,
          connectionType: 'https',
          httpsUsername: 'deploy',
          httpsPassword: TOKEN,
          initRepo: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await b.client.post('/rest/source-control/pull-workfolder', {})).statusCode).toBe(200);
    const bRow = (
      await server.ctx.database.pool.query('select id, version_id from workflows where tenant_id = $1', [
        b.tenant.id,
      ])
    ).rows[0];
    await b.client.data(
      b.client.patch(`/rest/workflows/${bRow.id}`, { versionId: bRow.version_id, name: 'From B' }),
    );
    const bRows = await status(b);
    const bWorkflow = bRows.find((r) => r.type === 'workflow');
    expect(bWorkflow).toMatchObject({ id: wf.id, status: 'modified', conflict: false });
    expect((await push(b, { fileNames: [{ id: wf.id, type: 'workflow' }] })).statusCode).toBe(200);

    // A changed it too: a conflict
    const aRow = await a.client.data(a.client.get(`/rest/workflows/${wf.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${wf.id}`, { versionId: aRow.versionId, name: 'From A' }),
    );
    const refused = await push(a, { fileNames: [{ id: wf.id, type: 'workflow' }] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.files).toEqual([
      expect.objectContaining({ id: wf.id, type: 'workflow', conflict: true }),
    ]);
    const forced = await push(a, { fileNames: [{ id: wf.id, type: 'workflow' }], force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    const remote = await a.client.data(a.client.get(`/rest/source-control/remote-content/workflow/${wf.id}`));
    expect(remote.name).toBe('From A');
  });

  it('answers 400 to a bad body, 412 when not connected and 409 while the lease is held', async () => {
    const a = await world();
    expect((await push(a, {})).statusCode).toBe(400);
    expect((await push(a, { fileNames: [], commitMessage: 'x' })).statusCode).toBe(400);
    const notConnected = await push(a, { fileNames: [{ id: randomUUID(), type: 'workflow' }] });
    expect(notConnected.statusCode).toBe(412);
    expect(notConnected.json().error.code).toBe('source_control_not_connected');
    expect((await a.client.get('/rest/source-control/get-status')).statusCode).toBe(412);

    const { a: b } = await connected();
    const wf = await createWorkflow(b.client, { name: 'Busy', nodes: manual() });
    const lease = await acquireLease(server.ctx.serviceDeps, b.tenant.id);
    try {
      const busy = await push(b, { fileNames: [{ id: wf.id, type: 'workflow' }] });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.code).toBe('source_control_busy');
    } finally {
      await lease.release();
    }
    expect((await push(b, { fileNames: [{ id: wf.id, type: 'workflow' }] })).statusCode).toBe(200);
  });
});

describe('remote content', () => {
  it('gives the global admin the remote workflow in local ids; a viewer 403; an unknown id 403 or 404', async () => {
    const { a } = await connected();
    const child = await createWorkflow(a.client, {
      name: 'Child',
      nodes: [node('Called', 'core.executeWorkflowTrigger')],
    });
    const wf = await createWorkflow(a.client, {
      name: 'Remote one',
      nodes: [...manual(), node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0])],
    });
    expect(
      (
        await push(a, {
          fileNames: [
            { id: wf.id, type: 'workflow' },
            { id: child.id, type: 'workflow' },
          ],
        })
      ).statusCode,
    ).toBe(200);
    // changed locally after the push: the answer is the remote copy
    const row = await a.client.data(a.client.get(`/rest/workflows/${wf.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${wf.id}`, { versionId: row.versionId, name: 'Local name' }),
    );

    const ok = await a.client.get(`/rest/source-control/remote-content/workflow/${wf.id}`);
    expect(ok.statusCode, ok.body).toBe(200);
    const data = ok.json().data;
    expect(data).toMatchObject({ id: wf.id, name: 'Remote one' });
    expect(data.nodes.find((n: { name: string }) => n.name === 'Call').parameters.workflowId).toBe(child.id);
    expect(data.pinData).toBeUndefined();

    // a project viewer of the workflow's project
    const viewer = await realMember(a);
    await addToProject(server, a.tenant.id, a.client.defaultProjectId!, viewer.user.id, 'project:viewer');
    const denied = await viewer.client.get(`/rest/source-control/remote-content/workflow/${wf.id}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('User is missing a scope required to perform this action');
    // an id with no local workflow and no mapping: 403 for a non-admin, 404 for the admin
    const stranger = randomUUID();
    expect(
      (await viewer.client.get(`/rest/source-control/remote-content/workflow/${stranger}`)).statusCode,
    ).toBe(403);
    expect((await a.client.get(`/rest/source-control/remote-content/workflow/${stranger}`)).statusCode).toBe(
      404,
    );
    // another workspace's workflow id (not in this repository): not found
    const other = await world();
    const foreign = await createWorkflow(other.client, { name: 'Foreign', nodes: manual() });
    expect(
      (await a.client.get(`/rest/source-control/remote-content/workflow/${foreign.id}`)).statusCode,
    ).toBe(404);
    // only workflows, by uuid
    expect((await a.client.get(`/rest/source-control/remote-content/credential/${wf.id}`)).statusCode).toBe(
      400,
    );
    expect((await a.client.get('/rest/source-control/remote-content/workflow/not-a-uuid')).statusCode).toBe(
      400,
    );
  });
});

describe('error text', () => {
  it('passes redactSecrets on status, push, pull and remote content (a remote path can hold a token)', async () => {
    const { repo, a } = await connected();
    // a file the work folder does not use: L1 names its path in the refusal
    const secret = `ghp_${randomBytes(18).toString('hex')}`;
    await repo.commit([{ path: `notes/${secret}.txt`, data: 'x' }], { message: 'stray file' });
    const answers = [
      await a.client.get('/rest/source-control/get-status'),
      await push(a, { fileNames: [{ id: randomUUID(), type: 'workflow' }] }),
      await a.client.post('/rest/source-control/pull-workfolder', {}),
      await a.client.get(`/rest/source-control/remote-content/workflow/${randomUUID()}`),
    ];
    for (const res of answers) {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, res.body).toBeLessThan(500);
      expect(res.body).not.toContain(secret);
      expect(res.json().error.message).toContain('[redacted]');
    }
  });
});
