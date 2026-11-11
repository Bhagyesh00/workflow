/**
 * P6-07 (S4 L4): Git sync between two workspaces through one repository.
 *
 * Workspace A makes a workflow, a sub-workflow, a credential with a seeded secret, a variable, a tag, a folder, a
 * data table and a team project, and pushes; workspace B connects to the same repository and pulls: the same
 * definitions after the id rewrite, a second status shows nothing, B's credential has empty secrets, references
 * line up and B's sub-workflow call runs B's copy. Then: a filled secret stays, conflicts and `force`, the three
 * `autoPublish` modes with a real publish and a publishing error, a remote delete, the seeded secret in no blob,
 * answer or log line, and two pulls at once. Over HTTP (the guarded client sending https://127.0.0.1 as http to the
 * plain fake, so a token is allowed) and over SSH. Every remote is a fake on 127.0.0.1 in a temp folder.
 * The publish of a pull runs after its writes, outside the pull's lock bypass: a trigger it starts meets the
 * protected lock like any production run. A Git error naming the stored token or a line of the stored key reaches
 * no answer and no log line.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient, REDACTED } from '@workflow/core';
import {
  type HttpRequestOptions,
  type NodePackage,
  pathFor,
  type SourceControlledFile,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inPullWrite } from '../src/services/protected';
import {
  type BareRepo,
  createBareRepo,
  requireGit,
  startGitHttpServer,
  startGitSshServer,
} from './fakes/git-server';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  protectWorkspace,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
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
const SECRET = `sk_live_${randomBytes(16).toString('hex')}`;
const VAR_SECRET = `var_${randomBytes(16).toString('hex')}`;
let server: TestServer;
let ip = 1;
const cleanups: Array<() => Promise<void>> = [];
const logs: string[] = [];

/**
 * sync-1: a trigger whose timer does what a production run's data table node does (a table create through the
 * node proxy) and records the answer: 'passed' or the status code
 */
const probes: Array<number | 'passed'> = [];
/** whether each activation of the probe ran inside the pull's lock bypass */
const activations: boolean[] = [];
let probeTarget: { tenantId: string; projectId: string } | undefined;
const probePackage: NodePackage = {
  name: 'git-sync-probe',
  nodes: [
    {
      description: {
        name: 'test.pullProbe',
        displayName: 'Pull probe',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Probe' },
        inputs: [],
        outputs: ['main'],
        properties: [],
      },
      async trigger() {
        activations.push(inPullWrite());
        const timer = setInterval(() => {
          const target = probeTarget;
          if (!target) return;
          server.ctx.dataTables
            .forProject(target.tenantId, target.projectId, { workflowId: 'probe' })
            .createTable({
              name: `probe_${randomUUID().slice(0, 8)}`,
              columns: [{ name: 'a', type: 'string' }],
            })
            .then(
              () => probes.push('passed'),
              (error: { statusCode?: number }) => probes.push(error.statusCode ?? 500),
            );
        }, 30);
        return { closeFunction: async () => clearInterval(timer) };
      },
    },
  ],
  credentials: [],
};

beforeAll(async () => {
  await requireGit();
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    {
      http: new TlsTerminatingClient({
        ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] },
      }),
      nodePackages: [probePackage],
    },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  logs.length = 0;
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(server.ctx.logger, level).mockImplementation(((...args: unknown[]) => {
      const first = args[0] as Record<string, unknown> | undefined;
      if (first && typeof first === 'object' && ('req' in first || 'res' in first)) return;
      logs.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v)));
    }) as never);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});

const world = () => signup(server.app, { remoteAddress: `127.9.4.${(ip++ % 250) + 1}` });
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

async function connect(w: World, url: string): Promise<void> {
  const res = await w.client.post('/rest/source-control/preferences', {
    repositoryUrl: url,
    connectionType: 'https',
    httpsUsername: 'deploy',
    httpsPassword: TOKEN,
    initRepo: true,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const status = async (w: World, direction: 'push' | 'pull') =>
  w.client.data<SourceControlledFile[]>(
    w.client.get(`/rest/source-control/get-status?direction=${direction}`),
  );

/** pushes every row of the caller's push status */
async function pushAll(w: World, commitMessage?: string) {
  const rows = await status(w, 'push');
  const res = await w.client.post('/rest/source-control/push-workfolder', {
    fileNames: rows.map((r) => ({ id: r.id, type: r.type })),
    ...(commitMessage ? { commitMessage } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

const pull = (w: World, body: Record<string, unknown> = {}) =>
  w.client.post('/rest/source-control/pull-workfolder', body);

const workflowsOf = async (tenantId: string) =>
  (await server.ctx.database.pool.query('select * from workflows where tenant_id = $1', [tenantId]))
    .rows as Array<Record<string, any>>;
const byName = async (tenantId: string, name: string) => {
  const row = (await workflowsOf(tenantId)).find((w) => w.name === name);
  if (!row) throw new Error(`no workflow ${name}`);
  return row;
};

/** what A makes before its first push */
async function seedA(a: World) {
  const credential = await a.client.data<{ id: string; name: string }>(
    a.client.post('/rest/credentials', {
      name: 'Shared API',
      type: 'testApi',
      data: { apiKey: SECRET, region: 'eu', baseUrl: 'https://api.example.test' },
    }),
  );
  const folder = await a.client.data<{ id: string }>(a.client.post('/rest/folders', { name: 'Ops' }));
  const table = await a.client.data<{ id: string }>(
    a.client.post('/rest/data-tables', {
      name: 'orders',
      columns: [
        { name: 'title', type: 'string' },
        { name: 'qty', type: 'number' },
      ],
    }),
  );
  await a.client.data(a.client.post('/rest/variables', { key: 'API_REGION', value: VAR_SECRET }));
  const tag = await a.client.data<{ id: string }>(a.client.post('/rest/tags', { name: 'nightly' }));
  const child = await createWorkflow(a.client, {
    name: 'Child',
    nodes: [
      node('Manual', 'core.manualTrigger', {}, [0, -200]),
      node('Called', 'core.executeWorkflowTrigger', {}, [0, 0]),
      setNode('Double', 'doubled', '={{ $json.n * 2 }}'),
    ],
    connections: chain('Called', 'Double'),
  });
  const parent = await a.client.data<{ id: string; versionId: string }>(
    a.client.post('/rest/workflows', {
      name: 'Parent',
      folderId: folder.id,
      tagIds: [tag.id],
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
        node('Rows', 'test.callWorkflow', { workflowId: `={{ "${table.id}" }}` }, [400, 200], {
          disabled: true,
        }),
      ],
      connections: chain('Start', 'Call'),
      settings: {},
    }),
  );
  const user = await createWorkflow(a.client, {
    name: 'Uses credential',
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Use', 'test.useCredential', {}, [200, 0], {
        credentials: { testApi: { id: credential.id, name: credential.name } },
      }),
    ],
    connections: chain('Start', 'Use'),
  });
  return { credential, folder, table, tag, child, parent, user };
}

describe('a pull on a second workspace gives the same workflows (HTTP)', () => {
  it('pushes everything from A; B pulls the same definitions with its own ids, empty secrets and its own sub-workflow', async () => {
    const { repo, url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    const seeded = await seedA(a);
    const pushRes = await pushAll(a, 'First export');
    const head = await repo.head();
    expect(await repo.message(head ?? '')).toBe('First export');

    const b = await world();
    await connect(b, url);
    const pullRes = await pull(b);
    expect(pullRes.statusCode, pullRes.body).toBe(200);
    const result = pullRes.json().data;
    expect(result.publishingErrors).toEqual([]);
    expect(result.contentImportPolicy).toEqual([]);
    expect(result.files.map((f: SourceControlledFile) => f.name)).toEqual(
      expect.arrayContaining(['Parent', 'Child', 'Uses credential', 'Shared API', 'orders']),
    );

    // the same definitions, B's own ids
    const bParent = await byName(b.tenant.id, 'Parent');
    const bChild = await byName(b.tenant.id, 'Child');
    const bUser = await byName(b.tenant.id, 'Uses credential');
    expect(bParent.id).not.toBe(seeded.parent.id);
    expect(bChild.id).not.toBe(seeded.child.id);
    const aParent = await byName(a.tenant.id, 'Parent');
    expect(bParent.nodes.map((n: any) => [n.name, n.type])).toEqual(
      aParent.nodes.map((n: any) => [n.name, n.type]),
    );
    expect(bParent.connections).toEqual(aParent.connections);
    expect(bParent.pin_data ?? {}).toEqual({});
    const call = bParent.nodes.find((n: any) => n.name === 'Call');
    expect(call.parameters.workflowId).toBe(bChild.id);

    // the credential: B's own row, empty secret, the reference points at it
    const bCreds = (
      await server.ctx.database.pool.query('select * from credentials where tenant_id = $1', [b.tenant.id])
    ).rows;
    expect(bCreds).toHaveLength(1);
    expect(bCreds[0].id).not.toBe(seeded.credential.id);
    const bCredRow = await server.ctx.repos.credentials.get(b.tenant.id, bCreds[0].id);
    const bData = server.ctx.credentials.decrypt(bCredRow!);
    expect(bData.apiKey ?? '').toBe('');
    expect(bUser.nodes.find((n: any) => n.name === 'Use').credentials.testApi.id).toBe(bCreds[0].id);

    // project, folder, tag, variable, data table
    const bProject = (
      await server.ctx.database.pool.query('select * from projects where tenant_id = $1 and id = $2', [
        b.tenant.id,
        bParent.project_id,
      ])
    ).rows[0];
    expect(bProject.type).toBe('team');
    expect(bProject.name).toBe(
      (await server.ctx.repos.projects.get(a.tenant.id, a.client.defaultProjectId!))?.name,
    );
    expect(bParent.folder_id).toBeTruthy();
    expect((await server.ctx.repos.folders.get(b.tenant.id, bParent.folder_id))?.name).toBe('Ops');
    const bTags = await server.ctx.repos.workflows.tagsFor(b.tenant.id, [bParent.id]);
    expect(bTags.get(bParent.id)?.map((t) => t.name)).toEqual(['nightly']);
    const bVars = await server.ctx.repos.variables.list(b.tenant.id);
    expect(bVars.map((v) => [v.key, v.value])).toEqual([['API_REGION', '']]);
    const bTables = (
      await server.ctx.database.pool.query('select * from data_tables where tenant_id = $1', [b.tenant.id])
    ).rows;
    expect(bTables.map((t) => t.name)).toEqual(['orders']);
    expect(bTables[0].id).not.toBe(seeded.table.id);
    const rowsNode = bParent.nodes.find((n: any) => n.name === 'Rows');
    expect(rowsNode.parameters.workflowId).toBe(`={{ "${bTables[0].id}" }}`);
    const bColumns = await server.ctx.repos.dataTables.listColumns(b.tenant.id, bTables[0].id);
    expect(bColumns.map((c) => [c.name, c.type])).toEqual([
      ['title', 'string'],
      ['qty', 'number'],
    ]);

    // a second status shows nothing
    expect(await status(b, 'pull')).toEqual([]);

    // B's parent calls B's child
    const { executionId } = await b.client.data(
      b.client.post(`/rest/workflows/${bParent.id}/run`, { triggerItems: [{ json: { n: 3 } }] }),
    );
    await waitForExecution(server.ctx, b.tenant.id, executionId, ['success']);
    const children = await server.ctx.repos.executions.list(b.tenant.id, {
      workflowId: bChild.id,
      limit: 10,
    });
    expect(children).toHaveLength(1);
    expect(
      await server.ctx.repos.executions.list(a.tenant.id, { workflowId: seeded.child.id, limit: 10 }),
    ).toEqual([]);

    // the seeded secret (and the variable value) is in no blob, no answer and no log line
    const files = await repo.files(head ?? '');
    expect([...files.keys()].sort()).toEqual(
      expect.arrayContaining([
        'variable_stubs.json',
        'tags.json',
        'folders.json',
        `credential_stubs/${seeded.credential.id}.json`,
        `datatables/${seeded.table.id}.json`,
        `workflows/${seeded.parent.id}.json`,
      ]),
    );
    const blobs = [...files.values()].join('\n');
    for (const secret of [SECRET, VAR_SECRET, TOKEN]) {
      expect(blobs).not.toContain(secret);
      expect(pushRes.body).not.toContain(secret);
      expect(pullRes.body).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect(blobs).not.toContain('pinData');
    expect(blobs).not.toContain('staticData');
    const audit = (
      await server.ctx.database.pool.query(
        "select action, metadata from audit_log where action in ('source_control.pushed', 'source_control.pulled')",
      )
    ).rows;
    expect(audit.map((r) => r.action).sort()).toEqual(['source_control.pulled', 'source_control.pushed']);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('keeps B’s filled secret when A changes the workflow and the credential; remote expressions come in', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    const seeded = await seedA(a);
    await pushAll(a);
    const b = await world();
    await connect(b, url);
    expect((await pull(b)).statusCode).toBe(200);
    const bCredId = (
      await server.ctx.database.pool.query('select id from credentials where tenant_id = $1', [b.tenant.id])
    ).rows[0].id as string;
    // B fills the secret in its own workspace
    await b.client.data(
      b.client.patch(`/rest/credentials/${bCredId}`, {
        data: { apiKey: 'b-own-secret', region: REDACTED, baseUrl: REDACTED },
      }),
    );

    // A renames the workflow and turns the base URL into an expression
    const parent = await a.client.data(a.client.get(`/rest/workflows/${seeded.parent.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${seeded.parent.id}`, {
        versionId: parent.versionId,
        name: 'Parent v2',
      }),
    );
    await a.client.data(
      a.client.patch(`/rest/credentials/${seeded.credential.id}`, {
        data: { apiKey: REDACTED, region: REDACTED, baseUrl: '={{ "https://" + "api.example.test" }}' },
      }),
    );
    await pushAll(a);
    const pulled = await pull(b);
    expect(pulled.statusCode, pulled.body).toBe(200);
    expect((await workflowsOf(b.tenant.id)).map((w) => w.name)).toContain('Parent v2');
    const row = await server.ctx.repos.credentials.get(b.tenant.id, bCredId);
    const data = server.ctx.credentials.decrypt(row!);
    expect(data.apiKey).toBe('b-own-secret');
    expect(data.baseUrl).toBe('={{ "https://" + "api.example.test" }}');
    expect(await status(b, 'pull')).toEqual([]);
  });

  it('answers a conflict with 409 and the list; force takes the remote version', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    const wf = await createWorkflow(a.client, {
      name: 'Shared',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    await pushAll(a);
    const b = await world();
    await connect(b, url);
    expect((await pull(b)).statusCode).toBe(200);
    const bWf = await byName(b.tenant.id, 'Shared');
    // both sides change it
    await b.client.data(
      b.client.patch(`/rest/workflows/${bWf.id}`, { versionId: bWf.version_id, name: 'Local' }),
    );
    const aRow = await a.client.data(a.client.get(`/rest/workflows/${wf.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${wf.id}`, { versionId: aRow.versionId, name: 'Remote' }),
    );
    await pushAll(a);

    const refused = await pull(b);
    expect(refused.statusCode).toBe(409);
    const files = refused.json().error.details.files as SourceControlledFile[];
    expect(files).toEqual([
      expect.objectContaining({ type: 'workflow', conflict: true, status: 'modified' }),
    ]);
    expect((await server.ctx.repos.workflows.get(b.tenant.id, bWf.id))?.name).toBe('Local');

    const forced = await pull(b, { force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect((await server.ctx.repos.workflows.get(b.tenant.id, bWf.id))?.name).toBe('Remote');
    expect(await status(b, 'pull')).toEqual([]);
  });

  it('publishes by autoPublish only: none, all, published; a failed publish lands in publishingErrors', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    const hook = (path: string) =>
      node('Hook', 'core.webhook', { path, httpMethod: 'GET' }, [0, 0], { webhookId: randomUUID() });
    const live = await createWorkflow(a.client, {
      name: 'Live',
      nodes: [hook(`p6-sync-${randomUUID().slice(0, 8)}`)],
    });
    await createWorkflow(a.client, { name: 'Manual only', nodes: [node('Start', 'core.manualTrigger')] });
    await pushAll(a);

    // none (default): nothing is published
    const b = await world();
    await connect(b, url);
    expect((await pull(b)).statusCode).toBe(200);
    expect((await workflowsOf(b.tenant.id)).every((w) => !w.active)).toBe(true);

    // all: the trigger workflow is published, the manual one fails into publishingErrors
    const c = await world();
    await connect(c, url);
    const all = await pull(c, { autoPublish: 'all' });
    expect(all.statusCode, all.body).toBe(200);
    expect((await byName(c.tenant.id, 'Live')).active).toBe(true);
    expect((await byName(c.tenant.id, 'Manual only')).active).toBe(false);
    const errors = all.json().data.publishingErrors;
    expect(errors).toEqual([
      expect.objectContaining({ name: 'Manual only', id: (await byName(c.tenant.id, 'Manual only')).id }),
    ]);
    expect(errors[0].message.length).toBeGreaterThan(0);

    // published: only what was published before the pull is published again, with the pulled version
    const aLive = await a.client.data(a.client.get(`/rest/workflows/${live.id}`));
    await a.client.data(
      a.client.patch(`/rest/workflows/${live.id}`, { versionId: aLive.versionId, name: 'Live v2' }),
    );
    await pushAll(a);
    const cLive = await byName(c.tenant.id, 'Live');
    const republished = await pull(c, { autoPublish: 'published' });
    expect(republished.statusCode, republished.body).toBe(200);
    const after = await server.ctx.repos.workflows.get(c.tenant.id, cLive.id);
    expect(after?.name).toBe('Live v2');
    expect(after?.active).toBe(true);
    expect(after?.publishedVersionId).toBe(after?.versionId);
    // B (none) keeps everything unpublished after the same change
    expect((await pull(b)).statusCode).toBe(200);
    expect((await byName(b.tenant.id, 'Live v2')).active).toBe(false);
  });

  it('applies a remote delete (with force) and lists it', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    const gone = await createWorkflow(a.client, {
      name: 'Gone',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    await createWorkflow(a.client, { name: 'Stays', nodes: [node('Start', 'core.manualTrigger')] });
    await pushAll(a);
    const b = await world();
    await connect(b, url);
    expect((await pull(b)).statusCode).toBe(200);
    const bGone = await byName(b.tenant.id, 'Gone');

    // A deletes it and pushes the deletion
    await a.client.data(a.client.post(`/rest/workflows/${gone.id}/archive`, {}));
    await a.client.data(a.client.delete(`/rest/workflows/${gone.id}`));
    const rows = await status(a, 'push');
    expect(rows).toEqual([expect.objectContaining({ id: gone.id, status: 'deleted', location: 'local' })]);
    await pushAll(a);

    const refused = await pull(b);
    expect(refused.statusCode).toBe(409);
    const forced = await pull(b, { force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().data.files).toEqual([
      expect.objectContaining({ id: gone.id, type: 'workflow', status: 'deleted', name: 'Gone' }),
    ]);
    expect(await server.ctx.repos.workflows.get(b.tenant.id, bGone.id)).toBeUndefined();
    expect((await workflowsOf(b.tenant.id)).map((w) => w.name)).toEqual(['Stays']);
    expect(await status(b, 'pull')).toEqual([]);
  });

  it('runs one operation at a time: of two pulls at once one answers 409', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    await createWorkflow(a.client, { name: 'One', nodes: [node('Start', 'core.manualTrigger')] });
    await pushAll(a);
    const b = await world();
    await connect(b, url);
    const [first, second] = await Promise.all([pull(b), pull(b)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const busy = first.statusCode === 409 ? first : second;
    expect(busy.json().error.code).toBe('source_control_busy');
    // the lease is free again
    expect((await pull(b)).statusCode).toBe(200);
    expect((await workflowsOf(b.tenant.id)).map((w) => w.name)).toEqual(['One']);
  });
});

describe('a pull on a second workspace gives the same workflows (SSH)', () => {
  it('pushes and pulls over SSH with the ids rewritten', async () => {
    const repo = await createBareRepo();
    const ssh = await startGitSshServer(repo);
    cleanups.push(
      () => repo.cleanup(),
      () => ssh.close(),
    );
    const useKey = async (w: World) =>
      server.ctx.repos.sourceControl.upsert(w.tenant.id, {
        keyType: 'ed25519',
        publicKey: ssh.clientKey.publicKey,
        privateKeyEnc: server.ctx.cipher.encrypt(ssh.clientKey.privateKey, {
          tenantId: w.tenant.id,
          credentialId: `sourceControl:${w.tenant.id}`,
        }),
      });
    const a = await world();
    await useKey(a);
    expect(
      (await a.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url, initRepo: true }))
        .statusCode,
    ).toBe(200);
    const child = await createWorkflow(a.client, {
      name: 'Child',
      nodes: [node('Called', 'core.executeWorkflowTrigger')],
    });
    await createWorkflow(a.client, {
      name: 'Parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }),
      ],
      connections: chain('Start', 'Call'),
    });
    await pushAll(a);
    expect(ssh.commands.some((c) => c.startsWith('git-receive-pack'))).toBe(true);

    const b = await world();
    await useKey(b);
    expect(
      (await b.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url, initRepo: true }))
        .statusCode,
    ).toBe(200);
    const res = await pull(b);
    expect(res.statusCode, res.body).toBe(200);
    const bChild = await byName(b.tenant.id, 'Child');
    const bParent = await byName(b.tenant.id, 'Parent');
    expect(bChild.id).not.toBe(child.id);
    expect(bParent.nodes.find((n: any) => n.name === 'Call').parameters.workflowId).toBe(bChild.id);
    expect(await status(b, 'pull')).toEqual([]);
  });
});

describe('the publish of a pull runs after the pull’s lock bypass', () => {
  it('a workflow pulled and published with a trigger, then the workspace protected: its later run’s table create is refused', async () => {
    const { url } = await httpRemote();
    const a = await world();
    await connect(a, url);
    await createWorkflow(a.client, { name: 'Probe', nodes: [node('Probe', 'test.pullProbe')] });
    await pushAll(a);
    const b = await world();
    await connect(b, url);
    activations.length = 0;
    const res = await pull(b, { autoPublish: 'all' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.publishingErrors).toEqual([]);
    // the trigger started after the pull's writes, outside the bypass
    expect(activations).toEqual([false]);
    const probe = await byName(b.tenant.id, 'Probe');
    expect(probe.active).toBe(true);
    await protectWorkspace(server, b.tenant.id, true);
    probes.length = 0;
    probeTarget = { tenantId: b.tenant.id, projectId: probe.project_id };
    try {
      await waitFor(async () => probes.length >= 3, { message: 'three trigger ticks' });
      expect(new Set(probes)).toEqual(new Set([403]));
    } finally {
      probeTarget = undefined;
      await server.ctx.workflows.setActive(b.tenant.id, probe.id, false, { userId: b.user.id });
    }
  });
});

describe('the stored token and key in no answer or log line', () => {
  /** status, push, pull and remote content of `w`; each a 4xx whose text was redacted */
  async function answersOf(w: World, id: string) {
    return [
      await w.client.get('/rest/source-control/get-status'),
      await w.client.post('/rest/source-control/push-workfolder', {
        fileNames: [{ id: randomUUID(), type: 'workflow' }],
      }),
      await pull(w),
      await w.client.get(`/rest/source-control/remote-content/workflow/${id}`),
    ];
  }

  /** a work folder file whose refusal names `key` (a key the remote chose) */
  const badFile = (id: string, key: string) => ({
    path: pathFor('workflow', id),
    data: JSON.stringify({ id, name: 'Bad', nodes: [], connections: { [key]: 5 }, versionId: 'v1' }),
  });

  it('HTTPS: a Git error naming the token', async () => {
    const { repo, url } = await httpRemote();
    const id = randomUUID();
    const pattern = `ghp_${randomBytes(18).toString('hex')}`;
    await repo.commit([badFile(id, `${TOKEN}+${pattern}`)], { message: 'bad file' });
    const a = await world();
    await connect(a, url);
    for (const res of await answersOf(a, id)) {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, res.body).toBeLessThan(500);
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toContain(pattern);
      expect(res.json().error.message).toContain('[redacted]');
    }
    const lines = logs.join('\n');
    expect(lines).not.toContain(TOKEN);
    expect(lines).not.toContain(pattern);
  });

  it('SSH: a Git error naming a line of the stored key', async () => {
    const repo = await createBareRepo();
    const ssh = await startGitSshServer(repo);
    cleanups.push(
      () => repo.cleanup(),
      () => ssh.close(),
    );
    const keyLine = ssh.clientKey.privateKey
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('-----'))
      .sort((x, y) => y.length - x.length)[0];
    expect(keyLine.length).toBeGreaterThan(16);
    const id = randomUUID();
    await repo.commit([badFile(id, keyLine)], { message: 'bad file' });
    const a = await world();
    await server.ctx.repos.sourceControl.upsert(a.tenant.id, {
      keyType: 'ed25519',
      publicKey: ssh.clientKey.publicKey,
      privateKeyEnc: server.ctx.cipher.encrypt(ssh.clientKey.privateKey, {
        tenantId: a.tenant.id,
        credentialId: `sourceControl:${a.tenant.id}`,
      }),
    });
    const connected = await a.client.post('/rest/source-control/preferences', {
      repositoryUrl: ssh.url,
      initRepo: true,
    });
    expect(connected.statusCode, connected.body).toBe(200);
    for (const res of await answersOf(a, id)) {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, res.body).toBeLessThan(500);
      expect(res.body).not.toContain(keyLine);
      expect(res.json().error.message).toContain('[redacted]');
    }
    expect(logs.join('\n')).not.toContain(keyLine);
  });
});
