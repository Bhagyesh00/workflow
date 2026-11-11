/**
 * P6-07 (S4 L4): what a pull refuses or skips, per file, with the rest of the pull applied.
 *
 * - The `contentImport` policy (P6-04, from S3): a workflow using a blocked node type is skipped and lands in
 *   `contentImportPolicy`; a deprecated node (P6-52) is refused by the save the same way; an unknown node type is
 *   blocked.
 * - The caller's projects: a caller holding `sourceControl:pull` through a custom global role (the scope added to
 *   the stored role, the roles route keeps it off custom roles), admin of project P only,
 *   pulls P's files; the files and deletes of project Q are skipped and listed, Q's rows unchanged (verify). The
 *   mapped row decides, never the owner a file names: Q's credential, table and folder stay when their files name P.
 *   Such a caller makes no project; a caller with every project makes a missing team project through the project
 *   service (its admin relation, the audit row and the team project limit).
 * - A refusal skips the file and the pull goes on: a table name taken in its project (409), the team project limit
 *   (403). A workflow archived on both sides takes the remote change and stays archived. A lease lost during the
 *   writes stops the pull with 409.
 *
 * The remote content is written straight into the fake bare repository (`BareRepo.commit`), in n8n's layout.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { type HttpRequestOptions, pathFor, type WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncIdMap } from '../src/services/source-control/id-map';
import {
  type BareRepo,
  createBareRepo,
  requireGit,
  startGitHttpServer,
  type TreeFile,
} from './fakes/git-server';
import {
  addToProject,
  createTestServer,
  node,
  policyDeny,
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

const world = () => signup(server.app, { remoteAddress: `127.9.6.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof world>>;

async function remoteWith(files: TreeFile[]): Promise<{ repo: BareRepo; url: string }> {
  const repo = await createBareRepo();
  await repo.commit(files);
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

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function projectFile(id: string, name: string): TreeFile {
  return {
    path: pathFor('project', id),
    data: json({
      id,
      name,
      type: 'team',
      icon: null,
      description: null,
      owner: { type: 'team', teamId: id, teamName: name },
    }),
  };
}

function workflowFile(
  id: string,
  name: string,
  nodes: WorkflowNode[],
  owner: { teamId: string; teamName: string },
  versionId = randomUUID(),
  extra: { parentFolderId?: string; isArchived?: boolean } = {},
): TreeFile {
  return {
    path: pathFor('workflow', id),
    data: json({
      id,
      name,
      description: null,
      nodes,
      connections: {},
      settings: {},
      triggerCount: 0,
      versionId,
      owner: { type: 'team', ...owner },
      parentFolderId: null,
      isArchived: false,
      ...extra,
    }),
  };
}

function credentialFile(id: string, name: string, owner: { teamId: string; teamName: string }): TreeFile {
  return {
    path: pathFor('credential', id),
    data: json({ id, name, type: 'testApi', owner: { type: 'team', ...owner }, data: { region: 'eu' } }),
  };
}

function tableFile(
  id: string,
  name: string,
  projectId: string,
  columns: Array<{ name: string; type: string }>,
): TreeFile {
  return {
    path: pathFor('datatable', id),
    data: json({
      id,
      name,
      projectId,
      columns: columns.map((c, index) => ({ id: randomUUID(), ...c, index })),
    }),
  };
}

function foldersFile(folders: Array<{ id: string; name: string; homeProjectId: string }>): TreeFile {
  const at = new Date(0).toISOString();
  return {
    path: 'folders.json',
    data: json({
      folders: folders.map((f) => ({ ...f, parentFolderId: null, createdAt: at, updatedAt: at })),
    }),
  };
}

/** a true member holding `sourceControl:pull` through a custom global role, admin of `projectId` only */
async function projectPuller(owner: World, projectId: string) {
  const role = await owner.client.data<{ slug: string; scopes: string[] }>(
    owner.client.post('/rest/roles', {
      displayName: `Puller ${randomUUID().slice(0, 6)}`,
      roleType: 'global',
      scopes: [],
    }),
  );
  await server.ctx.repos.roles.update(owner.tenant.id, role.slug, {
    scopes: [...role.scopes, 'sourceControl:pull'] as never,
  });
  const member = await realMember(owner);
  await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, role.slug);
  await addToProject(server, owner.tenant.id, projectId, member.user.id, 'project:admin');
  return member;
}

const manual = () => [node('Start', 'core.manualTrigger')];
const count = async (sql: string, tenantId: string) =>
  (await server.ctx.database.pool.query(sql, [tenantId])).rows[0].n as number;
type Skipped = { id: string; name: string; violations: string[] };

const pull = (w: { client: World['client'] }, body: Record<string, unknown> = {}) =>
  w.client.post('/rest/source-control/pull-workfolder', body);
const names = async (tenantId: string) =>
  (
    await server.ctx.database.pool.query('select name from workflows where tenant_id = $1 order by name', [
      tenantId,
    ])
  ).rows.map((r) => r.name as string);

describe('the content policy on pull', () => {
  it('skips a workflow with a blocked node type into contentImportPolicy and applies the rest', async () => {
    const team = { teamId: randomUUID(), teamName: 'Imports' };
    const blockedId = randomUUID();
    const { url } = await remoteWith([
      projectFile(team.teamId, team.teamName),
      workflowFile(
        blockedId,
        'Uses set',
        [node('Start', 'core.manualTrigger'), node('Set', 'core.set')],
        team,
      ),
      workflowFile(randomUUID(), 'Plain', [node('Start', 'core.manualTrigger')], team),
    ]);
    const b = await world();
    await connect(b, url);
    await policyDeny(server, b.tenant.id, 'node', 'core.set');
    const res = await pull(b);
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().data;
    expect(result.contentImportPolicy).toEqual([
      {
        id: blockedId,
        name: 'Uses set',
        violations: ['Node type "core.set" is blocked by a workspace policy'],
      },
    ]);
    expect(result.files.map((f: { name: string }) => f.name)).not.toContain('Uses set');
    expect(await names(b.tenant.id)).toEqual(['Plain']);
  });

  it('refuses a deprecated node per file and blocks an unknown node type', async () => {
    const team = { teamId: randomUUID(), teamName: 'Imports' };
    const deprecatedId = randomUUID();
    const unknownId = randomUUID();
    const { url } = await remoteWith([
      projectFile(team.teamId, team.teamName),
      workflowFile(
        deprecatedId,
        'Old node',
        [node('Start', 'core.manualTrigger'), node('Wait', 'core.noOp')],
        team,
      ),
      workflowFile(
        unknownId,
        'Unknown node',
        [node('Start', 'core.manualTrigger'), node('X', 'acme.notInstalled')],
        team,
      ),
      workflowFile(randomUUID(), 'Fine', [node('Start', 'core.manualTrigger')], team),
    ]);
    const b = await world();
    await connect(b, url);
    const noOp = server.ctx.registries.nodeTypes.get('core.noOp');
    if (!noOp) throw new Error('core.noOp missing');
    noOp.description.deprecated = true;
    try {
      const res = await pull(b);
      expect(res.statusCode, res.body).toBe(200);
      const skipped = res.json().data.contentImportPolicy as Array<{
        id: string;
        name: string;
        violations: string[];
      }>;
      expect(skipped.map((s) => s.id).sort()).toEqual([deprecatedId, unknownId].sort());
      expect(skipped.find((s) => s.id === unknownId)?.violations).toEqual([
        'Node type "acme.notInstalled" is not installed in this workspace',
      ]);
      expect(skipped.find((s) => s.id === deprecatedId)?.violations.join(' ')).toMatch(/deprecated/i);
      expect(await names(b.tenant.id)).toEqual(['Fine']);
    } finally {
      noOp.description.deprecated = false;
    }
  });
});

describe('the caller’s projects on pull', () => {
  it('pulls only project P for an admin of P with a custom pull role; Q’s files and deletes are skipped and listed', async () => {
    const p = { teamId: randomUUID(), teamName: 'Project P' };
    const q = { teamId: randomUUID(), teamName: 'Project Q' };
    const wP = randomUUID();
    const wQ = randomUUID();
    const { repo, url } = await remoteWith([
      projectFile(p.teamId, p.teamName),
      projectFile(q.teamId, q.teamName),
      workflowFile(wP, 'P one', [node('Start', 'core.manualTrigger')], p),
      workflowFile(wQ, 'Q one', [node('Start', 'core.manualTrigger')], q),
    ]);
    const owner = await world();
    await connect(owner, url);
    expect((await pull(owner)).statusCode).toBe(200);
    expect(await names(owner.tenant.id)).toEqual(['P one', 'Q one']);
    const localOf = async (name: string) =>
      (
        await server.ctx.database.pool.query('select * from workflows where tenant_id = $1 and name = $2', [
          owner.tenant.id,
          name,
        ])
      ).rows[0];
    const pProject = (await localOf('P one')).project_id as string;
    const qRow = await localOf('Q one');

    // the member: a custom global role holding sourceControl:pull, admin of P only. The roles route keeps
    // sourceControl:* off custom global roles (as n8n), so the scope is added to the stored role directly.
    const role = await owner.client.data<{ slug: string; scopes: string[] }>(
      owner.client.post('/rest/roles', {
        displayName: `Puller ${randomUUID().slice(0, 6)}`,
        roleType: 'global',
        scopes: [],
      }),
    );
    await server.ctx.repos.roles.update(owner.tenant.id, role.slug, {
      scopes: [...role.scopes, 'sourceControl:pull'] as never,
    });
    const member = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, role.slug);
    await addToProject(server, owner.tenant.id, pProject, member.user.id, 'project:admin');

    // the remote changes P one, adds P two and Q two, and deletes Q one
    const head = await repo.head();
    const changed = await repo.files(head ?? '');
    const files: TreeFile[] = [...changed.entries()]
      .filter(([path]) => path !== pathFor('workflow', wQ) && path !== pathFor('workflow', wP))
      .map(([path, data]) => ({ path, data }));
    await repo.commit([
      ...files,
      workflowFile(wP, 'P one v2', [node('Start', 'core.manualTrigger')], p),
      workflowFile(randomUUID(), 'P two', [node('Start', 'core.manualTrigger')], p),
      workflowFile(randomUUID(), 'Q two', [node('Start', 'core.manualTrigger')], q),
    ]);

    const res = await pull(member, { force: true });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().data;
    // a modified row carries the workspace's name of the workflow, a created one the file's
    expect(result.files.map((f: { name: string }) => f.name).sort()).toEqual(['P one', 'P two']);
    const skipped = result.contentImportPolicy as Array<{ id: string; name: string; violations: string[] }>;
    expect(skipped.map((s) => s.name).sort()).toEqual(['Q one', 'Q two']);
    for (const s of skipped) expect(s.violations[0]).toMatch(/outside the projects/);
    expect(await names(owner.tenant.id)).toEqual(['P one v2', 'P two', 'Q one']);
    const qAfter = await localOf('Q one');
    expect(qAfter.version_id).toBe(qRow.version_id);
    // the owner (all projects) gets the rest
    const rest = await pull(owner, { force: true });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(await names(owner.tenant.id)).toEqual(['P one v2', 'P two', 'Q two']);
  });

  it('refuses a pull to a member without sourceControl:pull', async () => {
    const team = { teamId: randomUUID(), teamName: 'T' };
    const { url } = await remoteWith([projectFile(team.teamId, team.teamName)]);
    const owner = await world();
    await connect(owner, url);
    const member = await realMember(owner);
    const res = await pull(member);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('User is missing a scope required to perform this action');
    expect((await member.client.get('/rest/source-control/get-status?direction=pull')).statusCode).toBe(403);
  });
});

describe('the mapped row decides on pull, never the owner a file names', () => {
  it('leaves a credential, a table and a folder of project Q alone when their remote files name P', async () => {
    const p = { teamId: randomUUID(), teamName: 'Project P' };
    const q = { teamId: randomUUID(), teamName: 'Project Q' };
    const credId = randomUUID();
    const tableId = randomUUID();
    const folderId = randomUUID();
    const base = [projectFile(p.teamId, p.teamName), projectFile(q.teamId, q.teamName)];
    const { repo, url } = await remoteWith([
      ...base,
      credentialFile(credId, 'Q cred', q),
      tableFile(tableId, 'q_table', q.teamId, [{ name: 'title', type: 'string' }]),
      foldersFile([{ id: folderId, name: 'Q folder', homeProjectId: q.teamId }]),
    ]);
    const owner = await world();
    await connect(owner, url);
    const first = await pull(owner);
    expect(first.statusCode, first.body).toBe(200);
    const tenantId = owner.tenant.id;
    const { repos } = server.ctx;
    const map = await SyncIdMap.load(repos, tenantId);
    const pLocal = map.localIdFor('project', p.teamId) as string;
    const qLocal = map.localIdFor('project', q.teamId) as string;
    const credLocal = map.localIdFor('credential', credId) as string;
    const tableLocal = map.localIdFor('datatable', tableId) as string;
    const folderLocal = map.localIdFor('folder', folderId) as string;
    expect((await repos.credentials.get(tenantId, credLocal))?.projectId).toBe(qLocal);
    expect((await repos.folders.get(tenantId, folderLocal))?.projectId).toBe(qLocal);

    const member = await projectPuller(owner, pLocal);
    await repo.commit([
      ...base,
      credentialFile(credId, 'Renamed by P', p),
      tableFile(tableId, 'renamed_by_p', p.teamId, [{ name: 'other', type: 'number' }]),
      foldersFile([{ id: folderId, name: 'Moved to P', homeProjectId: p.teamId }]),
    ]);
    const res = await pull(member, { force: true });
    expect(res.statusCode, res.body).toBe(200);
    const skipped = res.json().data.contentImportPolicy as Skipped[];
    for (const id of [credId, tableId]) {
      expect(skipped.find((s) => s.id === id)?.violations[0], id).toMatch(/outside the projects/);
    }
    expect(await repos.credentials.get(tenantId, credLocal)).toMatchObject({
      name: 'Q cred',
      projectId: qLocal,
    });
    expect(await repos.dataTables.get(tenantId, tableLocal)).toMatchObject({
      name: 'q_table',
      projectId: qLocal,
    });
    expect((await repos.dataTables.listColumns(tenantId, tableLocal)).map((c) => c.name)).toEqual(['title']);
    expect(await repos.folders.get(tenantId, folderLocal)).toMatchObject({
      name: 'Q folder',
      projectId: qLocal,
    });
    expect(await count('select count(*)::int as n from folders where tenant_id = $1', tenantId)).toBe(1);
  });
});

describe('projects a pull makes', () => {
  it('makes no project for a puller limited to some projects (a folder or a workflow of an unknown team)', async () => {
    const p = { teamId: randomUUID(), teamName: 'Project P' };
    const stranger = { teamId: randomUUID(), teamName: 'Unknown team' };
    const strayFolder = randomUUID();
    const { repo, url } = await remoteWith([projectFile(p.teamId, p.teamName)]);
    const owner = await world();
    await connect(owner, url);
    expect((await pull(owner)).statusCode).toBe(200);
    const tenantId = owner.tenant.id;
    const map = await SyncIdMap.load(server.ctx.repos, tenantId);
    const member = await projectPuller(owner, map.localIdFor('project', p.teamId) as string);
    await repo.commit([
      projectFile(p.teamId, p.teamName),
      foldersFile([{ id: strayFolder, name: 'Stray', homeProjectId: randomUUID() }]),
      workflowFile(randomUUID(), 'Stray work', manual(), stranger, undefined, {
        parentFolderId: strayFolder,
      }),
    ]);
    const projectsBefore = await count(
      'select count(*)::int as n from projects where tenant_id = $1',
      tenantId,
    );
    const res = await pull(member);
    expect(res.statusCode, res.body).toBe(200);
    expect(await count('select count(*)::int as n from projects where tenant_id = $1', tenantId)).toBe(
      projectsBefore,
    );
    expect(await count('select count(*)::int as n from folders where tenant_id = $1', tenantId)).toBe(0);
    expect(await names(tenantId)).toEqual([]);
  });

  it('makes a missing team project through the project service: its admin, the audit row and the limit', async () => {
    const team = { teamId: randomUUID(), teamName: 'New team' };
    const other = { teamId: randomUUID(), teamName: 'Over the limit' };
    const workId = randomUUID();
    const { repo, url } = await remoteWith([workflowFile(workId, 'Team work', manual(), team)]);
    const owner = await world();
    await connect(owner, url);
    const first = await pull(owner);
    expect(first.statusCode, first.body).toBe(200);
    const tenantId = owner.tenant.id;
    const { pool } = server.ctx.database;
    const made = (await SyncIdMap.load(server.ctx.repos, tenantId)).localIdFor(
      'project',
      team.teamId,
    ) as string;
    expect(await server.ctx.repos.projects.get(tenantId, made)).toMatchObject({
      type: 'team',
      name: 'New team',
    });
    const relation = await pool.query(
      'select role from project_relations where project_id = $1 and user_id = $2',
      [made, owner.user.id],
    );
    expect(relation.rows.map((r) => r.role)).toEqual(['project:admin']);
    const audit = await pool.query(
      "select 1 from audit_log where action = 'project.created' and resource_id = $1",
      [made],
    );
    expect(audit.rowCount).toBe(1);

    // the limit: no other team project fits; that file is listed, the rest still comes
    const teams = await count(
      "select count(*)::int as n from projects where tenant_id = $1 and type = 'team'",
      tenantId,
    );
    await server.ctx.repos.tenants.mergeSettings(tenantId, { limits: { maxTeamProjects: teams } } as never);
    const overId = randomUUID();
    await repo.commit([
      projectFile(team.teamId, team.teamName),
      workflowFile(workId, 'Team work', manual(), team),
      workflowFile(overId, 'Over', manual(), other),
      workflowFile(randomUUID(), 'Still arrives', manual(), team),
    ]);
    const res = await pull(owner, { force: true });
    expect(res.statusCode, res.body).toBe(200);
    const skipped = res.json().data.contentImportPolicy as Skipped[];
    expect(skipped.map((s) => s.id)).toEqual([overId]);
    expect(skipped[0].violations[0]).toMatch(/maximum of/);
    expect(await names(tenantId)).toEqual(['Still arrives', 'Team work']);
    expect(
      await count("select count(*)::int as n from projects where tenant_id = $1 and type = 'team'", tenantId),
    ).toBe(teams);
  });

  it('keeps a team project the pull made while the remote has no project file for it, even on a forced pull', async () => {
    const team = { teamId: randomUUID(), teamName: 'No file' };
    const workId = randomUUID();
    const { repo, url } = await remoteWith([workflowFile(workId, 'Team work', manual(), team)]);
    const owner = await world();
    await connect(owner, url);
    const first = await pull(owner);
    expect(first.statusCode, first.body).toBe(200);
    const tenantId = owner.tenant.id;
    const made = (await SyncIdMap.load(server.ctx.repos, tenantId)).localIdFor(
      'project',
      team.teamId,
    ) as string;
    expect(await names(tenantId)).toEqual(['Team work']);

    // the remote still names the project as the owner of a workflow: it is not deleted there
    const status = await owner.client.get('/rest/source-control/get-status?direction=pull');
    expect(status.statusCode, status.body).toBe(200);
    expect(
      (status.json().data as Array<{ type: string; status: string }>).filter(
        (row) => row.type === 'project' && row.status === 'deleted',
      ),
    ).toEqual([]);
    const forced = await pull(owner, { force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(await server.ctx.repos.projects.get(tenantId, made)).toMatchObject({ type: 'team' });
    expect(await names(tenantId)).toEqual(['Team work']);

    // once no remote file names it (the workflow is gone too), the project is deleted on the remote as before
    await repo.commit([
      workflowFile(randomUUID(), 'Other', manual(), { teamId: randomUUID(), teamName: 'x' }),
    ]);
    const gone = await owner.client.get('/rest/source-control/get-status?direction=pull');
    expect(
      (gone.json().data as Array<{ type: string; id: string; status: string }>).filter(
        (row) => row.type === 'project' && row.status === 'deleted',
      ),
    ).toMatchObject([{ id: team.teamId }]);
  });
});

describe('a refusal skips one file and the pull goes on', () => {
  it('lists a data table whose name its project already holds and pulls the rest', async () => {
    const team = { teamId: randomUUID(), teamName: 'Tables' };
    const { repo, url } = await remoteWith([projectFile(team.teamId, team.teamName)]);
    const owner = await world();
    await connect(owner, url);
    expect((await pull(owner)).statusCode).toBe(200);
    const tenantId = owner.tenant.id;
    const local = (await SyncIdMap.load(server.ctx.repos, tenantId)).localIdFor(
      'project',
      team.teamId,
    ) as string;
    await server.ctx.dataTables.create(
      tenantId,
      { name: 'orders', columns: [{ name: 'title', type: 'string' }], projectId: local },
      { userId: owner.user.id },
    );
    const tableId = randomUUID();
    await repo.commit([
      projectFile(team.teamId, team.teamName),
      tableFile(tableId, 'orders', team.teamId, [{ name: 'qty', type: 'number' }]),
      workflowFile(randomUUID(), 'After the table', manual(), team),
    ]);
    const res = await pull(owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.contentImportPolicy).toEqual([
      expect.objectContaining({ id: tableId, name: 'orders' }),
    ]);
    expect(await names(tenantId)).toEqual(['After the table']);
  });

  it('takes a remote change to a workflow archived on both sides and keeps it archived', async () => {
    const team = { teamId: randomUUID(), teamName: 'Archive' };
    const id = randomUUID();
    const { repo, url } = await remoteWith([
      projectFile(team.teamId, team.teamName),
      workflowFile(id, 'Old name', manual(), team, undefined, { isArchived: true }),
    ]);
    const owner = await world();
    await connect(owner, url);
    expect((await pull(owner)).statusCode).toBe(200);
    const tenantId = owner.tenant.id;
    const localId = (await SyncIdMap.load(server.ctx.repos, tenantId)).localIdFor('workflow', id) as string;
    expect((await server.ctx.repos.workflows.get(tenantId, localId))?.isArchived).toBe(true);
    await repo.commit([
      projectFile(team.teamId, team.teamName),
      workflowFile(id, 'New name', manual(), team, undefined, { isArchived: true }),
    ]);
    const res = await pull(owner, { force: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.contentImportPolicy).toEqual([]);
    expect(await server.ctx.repos.workflows.get(tenantId, localId)).toMatchObject({
      name: 'New name',
      isArchived: true,
    });
    const after = await owner.client.get('/rest/source-control/get-status?direction=pull');
    expect(after.json().data).toEqual([]);
  });
});

describe('the lease during the writes', () => {
  it('stops with 409 when another operation took the lease, before the next write', async () => {
    const team = { teamId: randomUUID(), teamName: 'Lease' };
    const { url } = await remoteWith([
      projectFile(team.teamId, team.teamName),
      workflowFile(randomUUID(), 'First', manual(), team),
      workflowFile(randomUUID(), 'Second', manual(), team),
    ]);
    const owner = await world();
    await connect(owner, url);
    const tenantId = owner.tenant.id;
    const workflows = server.ctx.workflows;
    const create = workflows.create.bind(workflows);
    // the first write: another caller takes the lease (as after an expiry)
    const spy = vi.spyOn(workflows, 'create').mockImplementationOnce(async (...args) => {
      await server.ctx.database.pool.query(
        "update source_control_settings set locked_until = now() + interval '10 minutes' where tenant_id = $1",
        [tenantId],
      );
      return create(...args);
    });
    try {
      const res = await pull(owner);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('source_control_lease_lost');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await names(tenantId)).toEqual(['First']);
    } finally {
      spy.mockRestore();
    }
  });
});
