/**
 * P6-74 (L3): `localSnapshot` and `computeStatus`. Status compares the workspace with the work folder by the id map's
 * versions: after the sync state is recorded it shows nothing, a local edit is `modified` here, a remote change is
 * `modified` there, a change on both sides is a conflict, a remote delete of a synced resource is a conflict on pull,
 * `preferLocalVersion` keeps the local side and `scope` filters to a project set.
 */
import { randomUUID } from 'node:crypto';
import { pathFor, type SourceControlledFile } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncIdMap } from '../src/services/source-control/id-map';
import { type ParsedFile, parseFile } from '../src/services/source-control/import-schemas';
import { exportFiles } from '../src/services/source-control/serialize';
import {
  computeStatus,
  fileVersionId,
  type LocalSnapshot,
  localSnapshot,
} from '../src/services/source-control/status';
import { createTestServer, folderIn, node, signup, type TestServer, workflowIn } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.close();
});

async function seed() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const { ctx } = server;
  const teamId = owner.client.defaultProjectId as string;
  const personal = await ctx.repos.projects.ensurePersonal(tenantId, { id: owner.user.id, name: 'Owner' });
  const credential = await ctx.credentials.create(
    tenantId,
    { name: 'API', type: 'testApi', projectId: teamId, data: { apiKey: 'first-secret' } },
    owner.user.id,
  );
  const table = await ctx.repos.dataTables.create(tenantId, teamId, 'orders');
  await ctx.repos.dataTables.addColumn(tenantId, table.id, { name: 'sku', type: 'string', position: 0 });
  const folder = await folderIn(server, tenantId, teamId, 'Sales');
  const flow = await workflowIn(server, tenantId, teamId, {
    name: 'Flow',
    nodes: [node('Start', 'core.noOp')],
    folderId: folder.id,
  });
  const mine = await workflowIn(server, tenantId, personal.id, { name: 'Mine' });
  await ctx.repos.variables.create(tenantId, { key: 'REGION', value: 'eu' });
  const tag = await ctx.repos.tags.create(tenantId, 'ops');
  await ctx.repos.workflows.setTags(tenantId, flow.id, [tag.id]);
  return { owner, tenantId, teamId, personal, credential, table, folder, flow, mine, tag };
}

type Seed = Awaited<ReturnType<typeof seed>>;

const deps = () => server.ctx.serviceDeps;

async function remoteOf(s: Seed, map: SyncIdMap): Promise<Map<string, ParsedFile>> {
  const files = await exportFiles(deps(), s.tenantId, 'all', map);
  return new Map([...files].map(([path, bytes]) => [path, parseFile(path, bytes)]));
}

/** what a finished push or pull records: both versions of every resource that has a file of its own */
function recordSync(snapshot: LocalSnapshot, remote: Map<string, ParsedFile>, map: SyncIdMap): void {
  const kinds = {
    workflow: 'workflow',
    credential: 'credential',
    datatable: 'datatable',
    project: 'project',
  } as const;
  for (const resource of snapshot.resources) {
    const type = kinds[resource.type as keyof typeof kinds];
    if (!type) continue;
    const gitId = map.gitIdFor(type, resource.id);
    const file = remote.get(pathFor(resource.type, gitId));
    if (!file) continue;
    map.record(type, gitId, resource.id, { git: fileVersionId(file), local: resource.versionId });
  }
}

async function synced(s: Seed) {
  const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
  const remote = await remoteOf(s, map);
  const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
  recordSync(snapshot, remote, map);
  return { map, remote, snapshot };
}

const rowOf = (rows: SourceControlledFile[], type: string, id: string) =>
  rows.find((row) => row.type === type && row.id === id);

/** a copy of a remote file with a change in its data */
function changed(remote: Map<string, ParsedFile>, path: string, change: (data: any) => void): void {
  const file = remote.get(path) as ParsedFile;
  const data = JSON.parse(JSON.stringify(file.data));
  change(data);
  remote.set(path, { ...file, data } as ParsedFile);
}

describe('localSnapshot', () => {
  it('lists every resource of the scope with its version, owner and folder path', async () => {
    const s = await seed();
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    expect(snapshot.tenantId).toBe(s.tenantId);
    const flow = snapshot.resources.find((r) => r.id === s.flow.id);
    expect(flow).toMatchObject({
      type: 'workflow',
      name: 'Flow',
      versionId: s.flow.versionId,
      projectId: s.teamId,
      parentFolderId: s.folder.id,
      projectType: 'team',
      folderPath: ['Sales'],
      isPublished: false,
    });
    expect(snapshot.resources.find((r) => r.id === s.mine.id)).toMatchObject({
      projectType: 'personal',
      ownerEmail: s.owner.user.email.toLowerCase(),
    });
    expect(snapshot.resources.map((r) => r.type).sort()).toEqual(
      ['credential', 'datatable', 'folders', 'project', 'tags', 'variables', 'workflow', 'workflow'].sort(),
    );
  });

  it('keeps to the projects of a set and carries no single file', async () => {
    const s = await seed();
    const snapshot = await localSnapshot(deps(), s.tenantId, new Set([s.personal.id]));
    expect(snapshot.resources.map((r) => r.id)).toEqual([s.mine.id]);
  });

  it('never reads another workspace', async () => {
    const a = await seed();
    const b = await seed();
    const snapshot = await localSnapshot(deps(), a.tenantId, 'all');
    expect(snapshot.resources.some((r) => r.id === b.flow.id || r.id === b.credential.id)).toBe(false);
  });
});

describe('computeStatus', () => {
  it('shows nothing after the sync state is recorded, in both directions', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    expect(computeStatus({ local: snapshot, remote, map, direction: 'push' })).toEqual([]);
    expect(computeStatus({ local: snapshot, remote, map, direction: 'pull' })).toEqual([]);
  });

  it('shows nothing for identical content even with no recorded state', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const remote = await remoteOf(s, map);
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    expect(computeStatus({ local: snapshot, remote, map, direction: 'push' })).toEqual([]);
    expect(computeStatus({ local: snapshot, remote, map, direction: 'pull' })).toEqual([]);
  });

  it('shows nothing for a secret filled in locally (the stub holds no secret)', async () => {
    const s = await seed();
    const { map, remote } = await synced(s);
    await server.ctx.credentials.update(s.tenantId, s.credential.id, { data: { apiKey: 'second-secret' } });
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    expect(computeStatus({ local: snapshot, remote, map, direction: 'push' })).toEqual([]);
  });

  it('an empty remote: everything is created on push, nothing on pull', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    const pushRows = computeStatus({ local: snapshot, remote: new Map(), map, direction: 'push' });
    expect(
      pushRows.every((row) => row.status === 'created' && row.location === 'local' && !row.conflict),
    ).toBe(true);
    expect(pushRows.map((row) => row.type).sort()).toEqual(
      ['credential', 'datatable', 'folders', 'project', 'tags', 'variables', 'workflow', 'workflow'].sort(),
    );
    const flow = rowOf(pushRows, 'workflow', s.flow.id) as SourceControlledFile;
    expect(flow).toMatchObject({
      file: pathFor('workflow', s.flow.id),
      name: 'Flow',
      isLocalPublished: false,
      folderPath: ['Sales'],
      owner: { type: 'team', projectId: s.teamId },
    });
    expect(rowOf(pushRows, 'variables', 'variables')?.file).toBe('variable_stubs.json');
    expect(computeStatus({ local: snapshot, remote: new Map(), map, direction: 'pull' })).toEqual([]);
  });

  it('a local edit is modified here (push, no conflict) and a conflict on pull', async () => {
    const s = await seed();
    const { map, remote } = await synced(s);
    await server.ctx.repos.workflows.update(s.tenantId, s.flow.id, undefined, {
      versionId: randomUUID(),
      name: 'Flow edited',
    });
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    const push = computeStatus({ local: snapshot, remote, map, direction: 'push' });
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({
      type: 'workflow',
      id: s.flow.id,
      name: 'Flow edited',
      status: 'modified',
      location: 'local',
      conflict: false,
    });
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull).toHaveLength(1);
    expect(pull[0]).toMatchObject({ status: 'modified', location: 'local', conflict: true });
    // preferLocalVersion keeps the local side: nothing to pull over it
    expect(
      computeStatus({ local: snapshot, remote, map, direction: 'pull', preferLocalVersion: true }),
    ).toEqual([]);
  });

  it('a remote change is modified there (pull, no conflict) and a conflict on push', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    changed(remote, pathFor('workflow', s.flow.id), (data) => {
      data.versionId = randomUUID();
      data.name = 'Flow remote';
    });
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull).toHaveLength(1);
    expect(pull[0]).toMatchObject({
      id: s.flow.id,
      status: 'modified',
      location: 'remote',
      conflict: false,
    });
    const push = computeStatus({ local: snapshot, remote, map, direction: 'push' });
    expect(push[0]).toMatchObject({ status: 'modified', location: 'local', conflict: true });
    expect(
      computeStatus({ local: snapshot, remote, map, direction: 'push', preferLocalVersion: true })[0]
        .conflict,
    ).toBe(false);
  });

  it('a change on both sides is a conflict on pull, and preferLocalVersion clears it', async () => {
    const s = await seed();
    const { map, remote } = await synced(s);
    await server.ctx.repos.workflows.update(s.tenantId, s.flow.id, undefined, { versionId: randomUUID() });
    changed(remote, pathFor('workflow', s.flow.id), (data) => {
      data.versionId = randomUUID();
    });
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull[0]).toMatchObject({ status: 'modified', location: 'remote', conflict: true });
    expect(
      computeStatus({ local: snapshot, remote, map, direction: 'pull', preferLocalVersion: true })[0]
        .conflict,
    ).toBe(false);
  });

  it('a different parent folder, description or owner is a change', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    const path = pathFor('workflow', s.flow.id);
    for (const change of [
      (data: any) => {
        data.parentFolderId = null;
      },
      (data: any) => {
        data.description = 'a new description';
      },
      (data: any) => {
        data.owner = { type: 'personal', personalEmail: 'somebody@example.com' };
      },
    ]) {
      const copy = new Map(remote);
      changed(copy, path, change);
      const rows = computeStatus({ local: snapshot, remote: copy, map, direction: 'pull' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: s.flow.id,
        status: 'modified',
        location: 'remote',
        conflict: false,
      });
      const push = computeStatus({ local: snapshot, remote: copy, map, direction: 'push' });
      expect(push[0]).toMatchObject({ id: s.flow.id, status: 'modified', location: 'local' });
    }
  });

  it('a remote delete of a synced resource is a conflict on pull and created again on push', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    remote.delete(pathFor('workflow', s.flow.id));
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull).toHaveLength(1);
    expect(pull[0]).toMatchObject({
      type: 'workflow',
      id: s.flow.id,
      status: 'deleted',
      location: 'remote',
      conflict: true,
    });
    const push = computeStatus({ local: snapshot, remote, map, direction: 'push' });
    expect(push[0]).toMatchObject({ id: s.flow.id, status: 'created', location: 'local', conflict: false });
    expect(
      computeStatus({ local: snapshot, remote, map, direction: 'pull', preferLocalVersion: true }),
    ).toEqual([]);
  });

  it('a local delete of a synced resource is deleted on push and created again on pull', async () => {
    const s = await seed();
    const { map, remote } = await synced(s);
    await server.ctx.repos.workflows.delete(s.tenantId, s.mine.id);
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    const push = computeStatus({ local: snapshot, remote, map, direction: 'push' });
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({
      type: 'workflow',
      id: s.mine.id,
      name: 'Mine',
      status: 'deleted',
      location: 'local',
      conflict: false,
      file: pathFor('workflow', s.mine.id),
    });
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull[0]).toMatchObject({ id: s.mine.id, status: 'created', location: 'remote', conflict: false });
  });

  it('a file only in the remote is created on pull and absent from push (another workspace made it)', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    const id = randomUUID();
    const path = pathFor('workflow', id);
    remote.set(
      path,
      parseFile(
        path,
        new TextEncoder().encode(
          JSON.stringify({
            id,
            name: 'From elsewhere',
            nodes: [],
            connections: {},
            versionId: randomUUID(),
            owner: { type: 'team', teamId: s.teamId, teamName: 'x' },
          }),
        ),
      ),
    );
    const pull = computeStatus({ local: snapshot, remote, map, direction: 'pull' });
    expect(pull).toHaveLength(1);
    expect(pull[0]).toMatchObject({
      file: path,
      id,
      name: 'From elsewhere',
      type: 'workflow',
      status: 'created',
      location: 'remote',
      conflict: false,
      owner: { type: 'team', projectId: s.teamId },
    });
    expect(computeStatus({ local: snapshot, remote, map, direction: 'push' })).toEqual([]);
  });

  it('compares through the map: a resource pulled under a new local id matches its file', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const gitId = randomUUID();
    map.record('workflow', gitId, s.flow.id, {});
    const remote = await remoteOf(s, map);
    expect(remote.has(pathFor('workflow', gitId))).toBe(true);
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    recordSync(snapshot, remote, map);
    expect(computeStatus({ local: snapshot, remote, map, direction: 'push' })).toEqual([]);
    expect(computeStatus({ local: snapshot, remote, map, direction: 'pull' })).toEqual([]);
    const rows = computeStatus({ local: snapshot, remote: new Map(), map, direction: 'push' });
    expect(rowOf(rows, 'workflow', gitId)?.file).toBe(pathFor('workflow', gitId));
  });

  it('the single files: a changed tag file is modified, a removed one is created again', async () => {
    const s = await seed();
    const { map, remote, snapshot } = await synced(s);
    const copy = new Map(remote);
    changed(copy, 'tags.json', (data) => {
      data.tags.push({ id: randomUUID(), name: 'extra' });
    });
    expect(computeStatus({ local: snapshot, remote: copy, map, direction: 'push' })).toEqual([
      expect.objectContaining({
        type: 'tags',
        id: 'tags',
        file: 'tags.json',
        status: 'modified',
        location: 'local',
      }),
    ]);
    expect(computeStatus({ local: snapshot, remote: copy, map, direction: 'pull' })).toEqual([
      expect.objectContaining({ type: 'tags', status: 'modified', location: 'remote', conflict: false }),
    ]);
    copy.delete('variable_stubs.json');
    const rows = computeStatus({ local: snapshot, remote: copy, map, direction: 'push' });
    expect(rowOf(rows, 'variables', 'variables')).toMatchObject({ status: 'created', location: 'local' });
  });

  it('scope keeps to a project set: the personal project and its files drop out', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const all = await localSnapshot(deps(), s.tenantId, 'all');
    const team = await localSnapshot(deps(), s.tenantId, new Set([s.teamId]));
    const remote = new Map<string, ParsedFile>();
    const everything = computeStatus({ local: all, remote, map, direction: 'push' });
    const scoped = computeStatus({ local: team, remote, map, direction: 'push' });
    expect(rowOf(everything, 'workflow', s.mine.id)).toBeDefined();
    expect(rowOf(scoped, 'workflow', s.mine.id)).toBeUndefined();
    expect(rowOf(scoped, 'workflow', s.flow.id)).toBeDefined();
    expect(scoped.some((row) => ['tags', 'variables', 'folders'].includes(row.type))).toBe(false);
    // a file of a project outside the set is not listed either
    const full = await remoteOf(s, map);
    const foreignId = randomUUID();
    const foreignPath = pathFor('workflow', foreignId);
    full.set(
      foreignPath,
      parseFile(
        foreignPath,
        new TextEncoder().encode(
          JSON.stringify({
            id: foreignId,
            name: 'Elsewhere',
            nodes: [],
            connections: {},
            versionId: 'v',
            owner: { type: 'team', teamId: randomUUID(), teamName: 'Other team' },
          }),
        ),
      ),
    );
    expect(
      computeStatus({ local: team, remote: full, map, direction: 'pull' }).map((row) => row.id),
    ).not.toContain(foreignId);
    expect(
      computeStatus({ local: all, remote: full, map, direction: 'pull' }).map((row) => row.id),
    ).toContain(foreignId);
  });

  it('rows come in the order projects, folders, credentials, tables, workflows, tags, variables', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const snapshot = await localSnapshot(deps(), s.tenantId, 'all');
    const rows = computeStatus({ local: snapshot, remote: new Map(), map, direction: 'push' });
    const types = rows.map((row) => row.type);
    expect([...new Set(types)]).toEqual([
      'project',
      'folders',
      'credential',
      'datatable',
      'workflow',
      'tags',
      'variables',
    ]);
  });
});
