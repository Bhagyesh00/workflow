/**
 * P6-08 (S4 L7): environments. Two workspaces on two branches of one repository: A is on `dev`, B is on `main`
 * and protected. A pushes a change to workflow W; the Git host merges `dev` into `main` (the test does it in the
 * bare repo with `git merge-tree --write-tree`, `git commit-tree` and `git update-ref`: a bare repo has no work
 * tree for `git merge`); B pulls. W changed in B, and B's credential still decrypts to B's own secret. On protected
 * B: a variable create is 403, a value update is 200, a pull creates a credential stub, disconnect clears the
 * switch, and a production run's table structure change and table rename are refused while its row write passes.
 * Every remote is a fake on 127.0.0.1 in a temp folder; no internet.
 */
import { randomBytes } from 'node:crypto';
import { HttpClient, REDACTED } from '@workflow/core';
import type { HttpRequestOptions } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_TEXT } from '../src/services/protected';
import { type BareRepo, createBareRepo, requireGit, runGit, startGitHttpServer } from './fakes/git-server';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
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
const SECRET_A = `sk_a_${randomBytes(12).toString('hex')}`;
const SECRET_B = `sk_b_${randomBytes(12).toString('hex')}`;
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

const world = () => signup(server.app, { remoteAddress: `127.9.6.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof world>>;

async function remote(): Promise<{ repo: BareRepo; url: string }> {
  const repo = await createBareRepo();
  const http = await startGitHttpServer(repo, { auth: { username: 'deploy', token: TOKEN } });
  cleanups.push(
    () => repo.cleanup(),
    () => http.close(),
  );
  return { repo, url: `https://127.0.0.1:${http.port}${repo.urlPath}` };
}

async function connect(w: World, url: string, branchName: string, extra: Record<string, unknown> = {}) {
  const res = await w.client.post('/rest/source-control/preferences', {
    repositoryUrl: url,
    connectionType: 'https',
    httpsUsername: 'deploy',
    httpsPassword: TOKEN,
    branchName,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** the Git host's merge of `dev` into `main`: a merge commit with both parents, made with plumbing only */
async function mergeDevIntoMain(repo: BareRepo): Promise<void> {
  const base = ['--git-dir', repo.dir];
  const tree = (await runGit([...base, 'merge-tree', '--write-tree', 'main', 'dev'])).toString('utf8').trim();
  const main = (await runGit([...base, 'rev-parse', 'refs/heads/main'])).toString('utf8').trim();
  const dev = (await runGit([...base, 'rev-parse', 'refs/heads/dev'])).toString('utf8').trim();
  const commit = (
    await runGit([...base, 'commit-tree', tree, '-p', main, '-p', dev, '-m', 'Merge dev into main'])
  )
    .toString('utf8')
    .trim();
  await runGit([...base, 'update-ref', 'refs/heads/main', commit]);
}

async function pushAll(w: World): Promise<void> {
  const rows = await w.client.data<Array<{ id: string; type: string }>>(
    w.client.get('/rest/source-control/get-status?direction=push'),
  );
  const res = await w.client.post('/rest/source-control/push-workfolder', {
    fileNames: rows.map((r) => ({ id: r.id, type: r.type })),
    commitMessage: 'Change from dev',
  });
  expect(res.statusCode, res.body).toBe(200);
}

const pull = (w: World) => w.client.post('/rest/source-control/pull-workfolder', {});
const rowsOf = async (table: string, tenantId: string) =>
  (await server.ctx.database.pool.query(`select * from ${table} where tenant_id = $1`, [tenantId]))
    .rows as Array<Record<string, any>>;

/** A on dev, B on main, one repository; the branches start at the same commit */
async function twoBranches() {
  const { repo, url } = await remote();
  const a = await world();
  await connect(a, url, 'dev', { initRepo: true });
  const dev = await repo.head('dev');
  await runGit(['--git-dir', repo.dir, 'update-ref', 'refs/heads/main', String(dev)]);
  const b = await world();
  await connect(b, url, 'main');
  return { repo, url, a, b };
}

describe('environments: dev and main of one repository', () => {
  it('a change pushed on dev reaches main after the host merge and B’s pull; B keeps its own secret', async () => {
    const { repo, a, b } = await twoBranches();
    const credential = await a.client.data<{ id: string; name: string }>(
      a.client.post('/rest/credentials', { name: 'Shared API', type: 'testApi', data: { apiKey: SECRET_A } }),
    );
    const w = await createWorkflow(a.client, {
      name: 'W',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Use', 'test.useCredential', {}, [200, 0], {
          credentials: { testApi: { id: credential.id, name: credential.name } },
        }),
      ],
      connections: chain('Start', 'Use'),
    });
    await pushAll(a);
    await mergeDevIntoMain(repo);
    expect((await pull(b)).statusCode).toBe(200);
    const bWorkflow = (await rowsOf('workflows', b.tenant.id)).find((x) => x.name === 'W');
    expect(bWorkflow).toBeTruthy();
    expect(bWorkflow?.nodes).toHaveLength(2);

    // B fills its own secret for the credential the pull stubbed
    const bCred = (await rowsOf('credentials', b.tenant.id))[0];
    expect(bCred).toBeTruthy();
    expect(
      server.ctx.credentials.decrypt((await server.ctx.repos.credentials.get(b.tenant.id, bCred.id))!)
        .apiKey ?? '',
    ).not.toBe(SECRET_A);
    await b.client.data(
      b.client.patch(`/rest/credentials/${bCred.id}`, {
        data: { apiKey: SECRET_B, region: REDACTED, baseUrl: REDACTED },
      }),
    );

    // A changes W on dev and pushes; the host merges again; B pulls
    const current = await a.client.data<{ versionId: string }>(a.client.get(`/rest/workflows/${w.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${w.id}`, {
        versionId: current.versionId,
        name: 'W changed on dev',
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Use', 'test.useCredential', {}, [200, 0], {
            credentials: { testApi: { id: credential.id, name: credential.name } },
          }),
          setNode('Extra', 'added', '1'),
        ],
        connections: chain('Start', 'Use', 'Extra'),
      }),
    );
    await pushAll(a);
    await mergeDevIntoMain(repo);
    expect((await repo.files('main')).size).toBeGreaterThan(0);
    const second = await pull(b);
    expect(second.statusCode, second.body).toBe(200);
    const changed = (await rowsOf('workflows', b.tenant.id)).find((x) => x.name === 'W changed on dev');
    expect(changed, 'W changed in B').toBeTruthy();
    expect(changed?.nodes).toHaveLength(3);
    const row = await server.ctx.repos.credentials.get(b.tenant.id, bCred.id);
    expect(server.ctx.credentials.decrypt(row!).apiKey).toBe(SECRET_B);
    // the secret of dev is in no file on main
    for (const [, text] of await repo.files('main')) {
      expect(text).not.toContain(SECRET_A);
      expect(text).not.toContain(SECRET_B);
    }
  });

  it('on protected B: a variable create is 403, a value update is 200, and a pull creates a credential stub', async () => {
    const { repo, a, b } = await twoBranches();
    const variable = await b.client.data<{ id: string }>(
      b.client.post('/rest/variables', { key: 'ENV_NAME', value: 'main' }),
    );
    const patched = await b.client.patch('/rest/source-control/preferences', { branchReadOnly: true });
    expect(patched.statusCode, patched.body).toBe(200);

    const denied = await b.client.post('/rest/variables', { key: 'OTHER', value: '1' });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain(PROTECTED_TEXT.variableCreate);
    const value = await b.client.patch(`/rest/variables/${variable.id}`, { value: 'main2' });
    expect(value.statusCode, value.body).toBe(200);
    expect(value.json().data.value).toBe('main2');

    // A makes a credential and a workflow on dev; the host merges; the protected B pulls both
    const credential = await a.client.data<{ id: string; name: string }>(
      a.client.post('/rest/credentials', { name: 'Stubbed', type: 'testApi', data: { apiKey: SECRET_A } }),
    );
    await createWorkflow(a.client, {
      name: 'Pulled W',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Use', 'test.useCredential', {}, [200, 0], {
          credentials: { testApi: { id: credential.id, name: credential.name } },
        }),
      ],
      connections: chain('Start', 'Use'),
    });
    await pushAll(a);
    await mergeDevIntoMain(repo);
    const pulled = await pull(b);
    expect(pulled.statusCode, pulled.body).toBe(200);
    const creds = await rowsOf('credentials', b.tenant.id);
    expect(creds.map((c) => c.name)).toContain('Stubbed');
    const stub = creds.find((c) => c.name === 'Stubbed');
    expect(
      JSON.stringify(
        server.ctx.credentials.decrypt((await server.ctx.repos.credentials.get(b.tenant.id, stub?.id))!),
      ),
    ).not.toContain(SECRET_A);
    expect((await rowsOf('workflows', b.tenant.id)).map((x) => x.name)).toContain('Pulled W');
    // the lock is back on after the pull
    const after = await b.client.post('/rest/variables', { key: 'AFTER', value: '1' });
    expect(after.statusCode).toBe(403);
    // and a push from B is refused with n8n's text
    const push = await b.client.post('/rest/source-control/push-workfolder', {
      fileNames: [{ id: stub?.id, type: 'credential' }],
    });
    expect(push.statusCode, push.body).toBe(400);
    expect(push.body).toContain(PROTECTED_TEXT.push);
  });

  it('disconnect clears the switch', async () => {
    const { b } = await twoBranches();
    await b.client.patch('/rest/source-control/preferences', { branchReadOnly: true });
    expect((await b.client.post('/rest/folders', { name: 'F' })).statusCode).toBe(403);
    const off = await b.client.post('/rest/source-control/disconnect', {});
    expect(off.statusCode, off.body).toBe(200);
    expect((await b.client.data(b.client.get('/rest/settings'))).sourceControl).toEqual({ readOnly: false });
    expect((await b.client.post('/rest/folders', { name: 'F' })).statusCode).toBe(200);
  });

  it('on protected B a production run’s table structure change and rename are refused, its row write passes', async () => {
    const { b } = await twoBranches();
    const table = await b.client.data<{ id: string }>(
      b.client.post('/rest/data-tables', { name: 'orders', columns: [{ name: 'title', type: 'string' }] }),
    );
    await b.client.patch('/rest/source-control/preferences', { branchReadOnly: true });
    // the node proxy of a production run, with its workflow id
    const access = server.ctx.dataTables.forProject(b.tenant.id, await teamProjectOf(server, b.tenant.id), {
      workflowId: 'prod-run',
    });
    await expect(
      access.createTable({ name: 'made', columns: [{ name: 'a', type: 'string' }] }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: PROTECTED_TEXT.dataTableCreate,
    });
    await expect(access.renameTable(table.id, 'orders2')).rejects.toMatchObject({
      statusCode: 403,
      message: PROTECTED_TEXT.dataTableStructure,
    });
    await expect(access.addColumn(table.id, { name: 'qty', type: 'number' })).rejects.toMatchObject({
      statusCode: 403,
      message: PROTECTED_TEXT.dataTableStructure,
    });
    await expect(access.deleteTable(table.id)).rejects.toMatchObject({
      statusCode: 403,
      message: PROTECTED_TEXT.dataTableStructure,
    });
    const rows = await access.insertRows(table.id, [{ title: 'row 1' }], 'count');
    expect(rows).toBeTruthy();
    expect((await access.getRows(table.id)).data.map((r) => r.title)).toEqual(['row 1']);
  });
});
