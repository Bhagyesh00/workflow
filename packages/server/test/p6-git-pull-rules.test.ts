/**
 * P6-07 (S4 L4): what a pull refuses or skips, per file, with the rest of the pull applied.
 *
 * - The `contentImport` policy (P6-04, from S3): a workflow using a blocked node type is skipped and lands in
 *   `contentImportPolicy`; a deprecated node (P6-52) is refused by the save the same way; an unknown node type is
 *   blocked.
 * - The caller's projects: a caller holding `sourceControl:pull` through a custom global role (the scope added to
 *   the stored role, the roles route keeps it off custom roles), admin of project P only,
 *   pulls P's files; the files and deletes of project Q are skipped and listed, Q's rows unchanged (verify).
 *
 * The remote content is written straight into the fake bare repository (`BareRepo.commit`), in n8n's layout.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { type HttpRequestOptions, pathFor, type WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    }),
  };
}

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
