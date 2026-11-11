/**
 * P6-75 (S4 L5): the public source control rows, GET /source-control/status, POST /source-control/push and POST
 * /source-control/pull, through `ctx.sourceControlSync` as REST does. Key scopes (`sourceControl:read`, `:push`,
 * `:pull`) are checked per row; a project admin's key (no key scopes) pushes only their project's files; not
 * connected is 400 (n8n's public controller; REST says 412); a name outside the caller's status is 403 'You are not
 * allowed to push these changes' (REST says 400); a conflict is 409 with the files. Remotes are the
 * fakes of test/fakes/git-server.ts on 127.0.0.1; no network.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import type { HttpRequestOptions, SourceControlledFile } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/http/errors';
import { type BareRepo, createBareRepo, requireGit, startGitHttpServer } from './fakes/git-server';
import {
  addToProject,
  createTestServer,
  createWorkflow,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
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
let keyCount = 0;
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

const manual = () => [node('Start', 'core.manualTrigger')];
type World = Awaited<ReturnType<typeof signup>>;
type Who = { client: World['client'] };

const world = () => signup(server.app, { remoteAddress: `127.9.8.${(ip++ % 250) + 1}` });

async function remote(): Promise<{ repo: BareRepo; connect: (w: Who) => Promise<void> }> {
  const repo = await createBareRepo();
  const http = await startGitHttpServer(repo, { auth: { username: 'deploy', token: TOKEN } });
  cleanups.push(
    () => repo.cleanup(),
    () => http.close(),
  );
  return {
    repo,
    connect: async (w) => {
      const res = await w.client.post('/rest/source-control/preferences', {
        repositoryUrl: `https://127.0.0.1:${http.port}${repo.urlPath}`,
        connectionType: 'https',
        httpsUsername: 'deploy',
        httpsPassword: TOKEN,
        initRepo: true,
      });
      expect(res.statusCode, res.body).toBe(200);
    },
  };
}

async function keyOf(w: Who, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await w.client.data(
    w.client.post('/rest/api-keys', {
      name: `git-public-${keyCount}-${randomUUID().slice(0, 6)}`,
      ...(scopes ? { scopes } : {}),
    }),
  );
  return made.key as string;
}

const api = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });
const pushVia = (key: string, ids: string[], extra: Record<string, unknown> = {}) =>
  api(key, 'POST', '/source-control/push', {
    fileNames: ids.map((id) => ({ id, type: 'workflow' })),
    ...extra,
  });
const workflowRows = (rows: SourceControlledFile[]) =>
  rows
    .filter((r) => r.type === 'workflow')
    .map((r) => [r.name, r.status])
    .sort();

describe('status', () => {
  it('lists the files that differ, like the REST status, for a key with sourceControl:read', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    await createWorkflow(a.client, { name: 'Local one', nodes: manual() });
    const key = await keyOf(a, ['sourceControl:read']);
    const res = await api(key, 'GET', '/source-control/status');
    expect(res.statusCode, res.body).toBe(200);
    const viaRest = await a.client.data<SourceControlledFile[]>(
      a.client.get('/rest/source-control/get-status?direction=push'),
    );
    expect(res.json().data).toEqual(viaRest);
    expect(workflowRows(res.json().data)).toEqual([['Local one', 'created']]);
  });

  it('needs the key scope, and the pull direction needs the user’s pull scope too', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    const wrongScope = await keyOf(a, ['sourceControl:pull']);
    expect((await api(wrongScope, 'GET', '/source-control/status')).statusCode).toBe(403);
    const reader = await keyOf(a, ['sourceControl:read']);
    expect((await api(reader, 'GET', '/source-control/status?direction=pull')).statusCode).toBe(200);
    // a member holds no global pull scope: the pull status is refused for them whatever the key says
    const member = await realMember(a);
    const memberKey = await keyOf(member);
    expect((await api(memberKey, 'GET', '/source-control/status?direction=pull')).statusCode).toBe(403);
  });
});

describe('push', () => {
  it('pushes the picked files with the trimmed message; the same answer shape as REST', async () => {
    const { repo, connect } = await remote();
    const a = await world();
    await connect(a);
    const one = await createWorkflow(a.client, { name: 'One', nodes: manual() });
    const two = await createWorkflow(a.client, { name: 'Two', nodes: manual() });
    const key = await keyOf(a, ['sourceControl:push']);
    const res = await pushVia(key, [one.id], { commitMessage: '  Public push  ' });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().data;
    expect(result.files).toEqual([expect.objectContaining({ id: one.id, type: 'workflow', pushed: true })]);
    const head = await repo.head();
    expect(result.commit).toBe(head);
    expect(await repo.message(head ?? '')).toBe('Public push');
    const files = [...(await repo.files(head ?? '')).keys()];
    expect(files.some((f) => f.includes(one.id))).toBe(true);
    expect(files.some((f) => f.includes(two.id))).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      Object.keys(
        (await a.client.data(
          a.client.post('/rest/source-control/push-workfolder', {
            fileNames: [{ id: two.id, type: 'workflow' }],
          }),
        )) as object,
      ).sort(),
    );
  });

  it('a bad body is 400 and a key with sourceControl:pull only cannot push', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    const wf = await createWorkflow(a.client, { name: 'One', nodes: manual() });
    const pushKey = await keyOf(a, ['sourceControl:push']);
    expect((await api(pushKey, 'POST', '/source-control/push', {})).statusCode).toBe(400);
    expect((await api(pushKey, 'POST', '/source-control/push', { fileNames: [] })).statusCode).toBe(400);
    expect(
      (await api(pushKey, 'POST', '/source-control/push', { fileNames: [{ id: wf.id, type: 'bogus' }] }))
        .statusCode,
    ).toBe(400);
    const pullKey = await keyOf(a, ['sourceControl:pull']);
    const refused = await pushVia(pullKey, [wf.id]);
    expect(refused.statusCode).toBe(403);
    const readKey = await keyOf(a, ['sourceControl:read']);
    expect((await pushVia(readKey, [wf.id])).statusCode).toBe(403);
    // a key with push only cannot pull either
    expect((await api(pushKey, 'POST', '/source-control/pull', {})).statusCode).toBe(403);
  });

  it('is 400 when source control is not connected (REST answers 412)', async () => {
    const a = await world();
    const wf = await createWorkflow(a.client, { name: 'One', nodes: manual() });
    const key = await keyOf(a);
    const res = await pushVia(key, [wf.id]);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toMatch(/not connected/i);
    expect((await api(key, 'GET', '/source-control/status')).statusCode).toBe(400);
    expect((await api(key, 'POST', '/source-control/pull', {})).statusCode).toBe(400);
    const viaRest = await a.client.post('/rest/source-control/push-workfolder', {
      fileNames: [{ id: wf.id, type: 'workflow' }],
    });
    expect(viaRest.statusCode).toBe(412);
  });

  it('redacts a token and a key in an error text before it reaches the client', async () => {
    const a = await world();
    const key = await keyOf(a);
    const github = `ghp_${randomBytes(16).toString('hex')}`;
    const bearer = `Bearer ${randomBytes(18).toString('hex')}`;
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----
${randomBytes(24).toString('base64')}
-----END OPENSSH PRIVATE KEY-----`;
    const leak = `remote said ${github} ${bearer} ${pem}`;
    const sync = server.ctx.sourceControlSync;
    // the not connected error is mapped to 400, any other error keeps its status; both pass redactSecrets
    const spies = [
      vi.spyOn(sync, 'push').mockRejectedValue(new ApiError(412, 'source_control_not_connected', leak)),
      vi.spyOn(sync, 'status').mockRejectedValue(ApiError.badRequest(leak)),
      vi.spyOn(sync, 'pull').mockRejectedValue(new ApiError(409, 'conflict', leak)),
    ];
    try {
      for (const [res, status] of [
        [await pushVia(key, ['x']), 400],
        [await api(key, 'GET', '/source-control/status'), 400],
        [await api(key, 'POST', '/source-control/pull', {}), 409],
      ] as const) {
        expect(res.statusCode, res.body).toBe(status);
        expect(res.body).not.toContain(github);
        expect(res.body).not.toContain(bearer.slice(7));
        expect(res.body).not.toContain('PRIVATE KEY');
        expect(res.json().error.message).toContain('remote said');
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('answers a conflict with 409 and the files; force pushes', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    const wf = await createWorkflow(a.client, { name: 'Shared', nodes: manual() });
    const keyA = await keyOf(a);
    expect((await pushVia(keyA, [wf.id])).statusCode).toBe(200);
    const b = await world();
    await connect(b);
    expect((await b.client.post('/rest/source-control/pull-workfolder', {})).statusCode).toBe(200);
    const row = (
      await server.ctx.database.pool.query('select id, version_id from workflows where tenant_id = $1', [
        b.tenant.id,
      ])
    ).rows[0];
    await b.client.data(
      b.client.patch(`/rest/workflows/${row.id}`, { versionId: row.version_id, name: 'From B' }),
    );
    expect((await pushVia(await keyOf(b), [wf.id])).statusCode).toBe(200);
    const current = await a.client.data(a.client.get(`/rest/workflows/${wf.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${wf.id}`, { versionId: current.versionId, name: 'From A' }),
    );
    const refused = await pushVia(keyA, [wf.id]);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.details.files).toEqual([
      expect.objectContaining({ id: wf.id, type: 'workflow', conflict: true }),
    ]);
    expect((await pushVia(keyA, [wf.id], { force: true })).statusCode).toBe(200);
  });

  it('a project admin’s key pushes their project’s file and is refused on another project’s', async () => {
    const { repo, connect } = await remote();
    const a = await world();
    await connect(a);
    const y = await projectIn(server, a.tenant.id, `Other ${randomUUID().slice(0, 6)}`);
    const inX = await createWorkflow(a.client, { name: 'In X', nodes: manual() });
    const inY = await workflowIn(server, a.tenant.id, y.id, { name: 'In Y', nodes: manual() });
    const admin = await realMember(a);
    await addToProject(
      server,
      a.tenant.id,
      a.client.defaultProjectId as string,
      admin.user.id,
      'project:admin',
    );
    const key = await keyOf(admin);
    const head = await repo.head();
    const refused = await pushVia(key, [inY.id]);
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    expect(await repo.head()).toBe(head);
    const ok = await pushVia(key, [inX.id]);
    expect(ok.statusCode, ok.body).toBe(200);
    const files = [...(await repo.files((await repo.head()) ?? '')).keys()];
    expect(files.some((f) => f.includes(inX.id))).toBe(true);
    expect(files.some((f) => f.includes(inY.id))).toBe(false);
  });
  it('answers 403 You are not allowed to push these changes to a name outside the caller’s status; REST stays 400', async () => {
    const { repo, connect } = await remote();
    const a = await world();
    await connect(a);
    const text = 'You are not allowed to push these changes';
    const head = await repo.head();
    const unknown = await pushVia(await keyOf(a, ['sourceControl:push']), [randomUUID()]);
    expect(unknown.statusCode, unknown.body).toBe(403);
    expect(unknown.json().error.message).toBe(text);
    // a true member, project admin of a's default project, names a workflow of another team project
    const other = await projectIn(server, a.tenant.id, `Other ${randomUUID().slice(0, 6)}`);
    const inOther = await workflowIn(server, a.tenant.id, other.id, { name: 'In other', nodes: manual() });
    const admin = await realMember(a);
    await addToProject(
      server,
      a.tenant.id,
      a.client.defaultProjectId as string,
      admin.user.id,
      'project:admin',
    );
    const foreign = await pushVia(await keyOf(admin), [inOther.id]);
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(foreign.json().error.message).toBe(text);
    // a true member with no pushable project names a's workflow
    const wf = await createWorkflow(a.client, { name: 'One', nodes: manual() });
    const member = await realMember(a);
    const none = await pushVia(await keyOf(member), [wf.id]);
    expect(none.statusCode, none.body).toBe(403);
    expect(none.json().error.message).toBe(text);
    expect(await repo.head()).toBe(head);
    const viaRest = await a.client.post('/rest/source-control/push-workfolder', {
      fileNames: [{ id: randomUUID(), type: 'workflow' }],
    });
    expect(viaRest.statusCode).toBe(400);
    expect(viaRest.json().error.message).toBe('A picked file is not part of the changes.');
  });
});

describe('pull', () => {
  it('the public pull equals the REST pull', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    await createWorkflow(a.client, { name: 'First', nodes: manual() });
    await createWorkflow(a.client, { name: 'Second', nodes: manual() });
    const rows = await a.client.data<SourceControlledFile[]>(
      a.client.get('/rest/source-control/get-status?direction=push'),
    );
    expect(
      (
        await a.client.post('/rest/source-control/push-workfolder', {
          fileNames: rows.map((r) => ({ id: r.id, type: r.type })),
        })
      ).statusCode,
    ).toBe(200);

    const viaRest = await world();
    await connect(viaRest);
    const restRes = await viaRest.client.post('/rest/source-control/pull-workfolder', {});
    expect(restRes.statusCode, restRes.body).toBe(200);
    const viaApi = await world();
    await connect(viaApi);
    const publicRes = await api(
      await keyOf(viaApi, ['sourceControl:pull']),
      'POST',
      '/source-control/pull',
      {},
    );
    expect(publicRes.statusCode, publicRes.body).toBe(200);

    const shape = (body: { data: { files: SourceControlledFile[] } }) =>
      body.data.files.map((f) => [f.type, f.name, f.status]).sort();
    expect(shape(publicRes.json())).toEqual(shape(restRes.json()));
    expect(shape(publicRes.json()).filter((f) => f[0] === 'workflow')).toEqual([
      ['workflow', 'First', 'created'],
      ['workflow', 'Second', 'created'],
    ]);
    const names = async (w: World) =>
      (
        await server.ctx.database.pool.query(
          'select name from workflows where tenant_id = $1 order by name',
          [w.tenant.id],
        )
      ).rows.map((r) => r.name);
    expect(await names(viaApi)).toEqual(await names(viaRest));
  });

  it('pull needs the key scope and the user’s pull scope', async () => {
    const { connect } = await remote();
    const a = await world();
    await connect(a);
    expect(
      (await api(await keyOf(a, ['sourceControl:read']), 'POST', '/source-control/pull', {})).statusCode,
    ).toBe(403);
    const member = await realMember(a);
    expect((await api(await keyOf(member), 'POST', '/source-control/pull', {})).statusCode).toBe(403);
  });
});
