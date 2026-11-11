/**
 * P6-75 (S4 L5): `pushableProjects` and what rests on it. A project admin (a real member holding
 * `project:admin` in one team project) may push, read the remote content of and see the status of that project's
 * workflows only; another project's workflows, and anything in a personal project, are out of reach (the GHSA
 * test of n8n's source control scope). Remotes are the fakes of test/fakes/git-server.ts on 127.0.0.1.
 * A push of a file outside the caller's own status is refused 400 by L4's push ("not part of the changes").
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import type { HttpRequestOptions, SourceControlledFile } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function connected(): Promise<{ repo: BareRepo; a: World }> {
  const repo = await createBareRepo();
  const http = await startGitHttpServer(repo, { auth: { username: 'deploy', token: TOKEN } });
  cleanups.push(
    () => repo.cleanup(),
    () => http.close(),
  );
  const a = await signup(server.app, { remoteAddress: `127.9.7.${(ip++ % 250) + 1}` });
  const res = await a.client.post('/rest/source-control/preferences', {
    repositoryUrl: `https://127.0.0.1:${http.port}${repo.urlPath}`,
    connectionType: 'https',
    httpsUsername: 'deploy',
    httpsPassword: TOKEN,
    initRepo: true,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { repo, a };
}

const status = (w: Who) =>
  w.client.data<SourceControlledFile[]>(w.client.get('/rest/source-control/get-status?direction=push'));
const push = (w: Who, ids: string[]) =>
  w.client.post('/rest/source-control/push-workfolder', {
    fileNames: ids.map((id) => ({ id, type: 'workflow' })),
  });
const workflowNames = (rows: SourceControlledFile[]) =>
  rows
    .filter((r) => r.type === 'workflow')
    .map((r) => r.name)
    .sort();

/** the workspace of `a`, its default team project X (with a project admin member), a second team project Y */
async function scene() {
  const { repo, a } = await connected();
  const x = a.client.defaultProjectId as string;
  const y = await projectIn(server, a.tenant.id, `Other ${randomUUID().slice(0, 6)}`);
  const inX = await createWorkflow(a.client, { name: 'In X', nodes: manual() });
  const inY = await workflowIn(server, a.tenant.id, y.id, { name: 'In Y', nodes: manual() });
  const admin = await realMember(a);
  await addToProject(server, a.tenant.id, x, admin.user.id, 'project:admin');
  return { repo, a, x, y, inX, inY, admin };
}

describe('pushableProjects', () => {
  it('is every project for the global scope, the admin’s team projects only, nothing for a viewer', async () => {
    const { a, x, admin } = await scene();
    const viewer = await realMember(a);
    await addToProject(server, a.tenant.id, x, viewer.user.id, 'project:viewer');
    expect(workflowNames(await status(a))).toEqual(['In X', 'In Y']);
    expect(workflowNames(await status(admin))).toEqual(['In X']);
    expect(await status(viewer)).toEqual([]);
  });
});

describe('project admin', () => {
  it('pushes their project’s file and is refused on another project’s (GHSA-hvrx-jc5j-pg3w)', async () => {
    const { repo, a, inX, inY, admin } = await scene();
    const head = await repo.head();
    const refused = await push(admin, [inY.id]);
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    expect(await repo.head()).toBe(head);

    const mixed = await push(admin, [inX.id, inY.id]);
    expect(mixed.statusCode, mixed.body).toBeGreaterThanOrEqual(400);
    expect(await repo.head()).toBe(head);

    const ok = await push(admin, [inX.id]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.files).toEqual([expect.objectContaining({ id: inX.id, pushed: true })]);
    const files = [...(await repo.files((await repo.head()) ?? '')).keys()];
    expect(files.some((f) => f.includes(inX.id))).toBe(true);
    expect(files.some((f) => f.includes(inY.id))).toBe(false);
    // the global admin still pushes the other project's file
    expect((await push(a, [inY.id])).statusCode).toBe(200);
  });

  it('reads the remote content of their project’s workflow (200) and gets 403 on another project’s', async () => {
    const { a, inX, inY, admin } = await scene();
    expect((await push(a, [inX.id, inY.id])).statusCode).toBe(200);
    const own = await admin.client.get(`/rest/source-control/remote-content/workflow/${inX.id}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data).toMatchObject({ id: inX.id, name: 'In X' });
    const other = await admin.client.get(`/rest/source-control/remote-content/workflow/${inY.id}`);
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error.message).toBe('User is missing a scope required to perform this action');
  });

  it('sees in the status only their projects', async () => {
    const { a, inX, inY, admin } = await scene();
    const rows = await status(admin);
    expect(workflowNames(rows)).toEqual(['In X']);
    expect(rows.some((r) => r.id === inY.id)).toBe(false);
    expect((await push(a, [inX.id, inY.id])).statusCode).toBe(200);
    expect(workflowNames(await status(admin))).toEqual([]);
  });

  it('never reaches a personal project, their own included', async () => {
    const { repo, admin } = await scene();
    // the member has no default team project, so this is made in their personal project
    const mine = await createWorkflow(admin.client, { name: 'Personal one', nodes: manual() });
    expect(workflowNames(await status(admin))).not.toContain('Personal one');
    const head = await repo.head();
    const refused = await push(admin, [mine.id]);
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(await repo.head()).toBe(head);
  });

  it('a project editor holds no push scope: nothing in the status, every push refused', async () => {
    const { a, x, inX } = await scene();
    const editor = await realMember(a);
    await addToProject(server, a.tenant.id, x, editor.user.id, 'project:editor');
    expect(await status(editor)).toEqual([]);
    expect((await push(editor, [inX.id])).statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (await editor.client.get(`/rest/source-control/remote-content/workflow/${inX.id}`)).statusCode,
    ).toBe(403);
  });

  it('a narrowed project role takes effect on the next call', async () => {
    const { x, a, inX, admin } = await scene();
    expect(workflowNames(await status(admin))).toEqual(['In X']);
    await addToProject(server, a.tenant.id, x, admin.user.id, 'project:viewer');
    expect(await status(admin)).toEqual([]);
    expect((await push(admin, [inX.id])).statusCode).toBeGreaterThanOrEqual(400);
  });
});
