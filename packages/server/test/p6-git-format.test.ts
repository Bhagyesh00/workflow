/**
 * P6-74 (L3): the work folder file format. `exportFiles` writes n8n's layout (pretty JSON, 2 spaces) with ids as git
 * ids; `sanitizeCredentialData` leaves no secret; `parseFile` reads one file with one schema per kind; `SyncIdMap`
 * rewrites every known UUID in one pass both ways and keeps its rows in `sync_id_map` for one workspace only.
 */
import { randomUUID } from 'node:crypto';
import { pathFor } from '@workflow/workflow';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentials as credentialsTable } from '../src/db/schema';
import { SyncIdMap } from '../src/services/source-control/id-map';
import { parseFile, SourceControlFormatError } from '../src/services/source-control/import-schemas';
import {
  contentVersion,
  exportFiles,
  sanitizeCredentialData,
  stableStringify,
} from '../src/services/source-control/serialize';
import { createTestServer, node, signup, type TestServer, workflowIn } from './helpers';

const SECRET = 'SEEDED-SECRET-VALUE-8c1f';
const TOKEN = 'SEEDED-OAUTH-TOKEN-3d2a';
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (bytes: Uint8Array) => JSON.parse(text(bytes));

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.close();
});

/** a workspace with a team project, a personal project, and one of each resource kind */
async function seed() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const { ctx } = server;
  const teamId = owner.client.defaultProjectId as string;
  const personal = await ctx.repos.projects.ensurePersonal(tenantId, {
    id: owner.user.id,
    name: 'Owner',
  });
  const secret = await ctx.credentials.create(
    tenantId,
    {
      name: 'Seeded API',
      type: 'testApi',
      projectId: teamId,
      data: {
        apiKey: SECRET,
        baseUrl: '=https://{{ $json.host }}',
        retries: 3,
        verbose: true,
        nothing: null,
        oauthTokenData: { access_token: TOKEN },
      },
    },
    owner.user.id,
  );
  const privateCredential = await ctx.credentials.create(
    tenantId,
    {
      name: 'Private OAuth',
      type: 'testApi',
      projectId: teamId,
      data: { apiKey: SECRET },
      isResolvable: true,
    },
    owner.user.id,
  );
  const table = await ctx.repos.dataTables.create(tenantId, teamId, 'orders');
  await ctx.repos.dataTables.addColumn(tenantId, table.id, { name: 'sku', type: 'string', position: 0 });
  await ctx.repos.dataTables.addColumn(tenantId, table.id, { name: 'qty', type: 'number', position: 1 });
  const folder = await ctx.repos.folders.create(tenantId, {
    name: 'Sales',
    parentFolderId: null,
    projectId: teamId,
  });
  const sub = await workflowIn(server, tenantId, teamId, {
    name: 'Sub flow',
    nodes: [node('Start', 'core.noOp')],
    folderId: folder.id,
  });
  const main = await workflowIn(server, tenantId, teamId, {
    name: 'Main flow',
    nodes: [
      node('Call', 'core.executeWorkflow', { workflowId: sub.id, note: `={{ "${sub.id}" }}` }, [0, 0], {
        credentials: { testApi: { id: secret.id, name: secret.name } },
      }),
      node('Table', 'core.dataTable', { dataTableId: table.id }),
    ],
    settings: { errorWorkflow: sub.id, executionOrder: 'v1' },
  });
  // pin data and static data are in the rows and must stay out of the files
  await ctx.repos.workflows.update(tenantId, main.id, undefined, {
    versionId: main.versionId,
    pinData: { Call: [{ json: { leaked: SECRET } }] },
  });
  await ctx.repos.workflows.setStaticData(tenantId, main.id, { leaked: SECRET });
  const mine = await workflowIn(server, tenantId, personal.id, { name: 'Personal flow' });
  const variable = await ctx.repos.variables.create(tenantId, { key: 'REGION', value: SECRET });
  const projectVariable = await ctx.repos.variables.create(tenantId, {
    key: 'TEAM_ONLY',
    value: SECRET,
    projectId: teamId,
  });
  const tag = await ctx.repos.tags.create(tenantId, 'finance');
  await ctx.repos.workflows.setTags(tenantId, main.id, [tag.id]);
  return {
    owner,
    tenantId,
    teamId,
    personal,
    secret,
    privateCredential,
    table,
    folder,
    sub,
    main,
    mine,
    variable,
    projectVariable,
    tag,
  };
}

describe('sanitizeCredentialData', () => {
  it('empties strings unless an expression, drops oauthTokenData and nulls, keeps numbers and booleans', () => {
    const out = sanitizeCredentialData({
      apiKey: SECRET,
      expr: '={{ $secrets.vault.key }}',
      count: 4,
      on: false,
      nothing: null,
      oauthTokenData: { access_token: TOKEN },
      nested: { password: SECRET, keep: 7, expr: '={{ 1 }}', gone: null },
      list: [SECRET, 3, null],
    });
    expect(out).toEqual({
      apiKey: '',
      expr: '={{ $secrets.vault.key }}',
      count: 4,
      on: false,
      nested: { password: '', keep: 7, expr: '={{ 1 }}' },
      list: ['', 3],
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('keeps a __proto__ key as a key and never sets a prototype', () => {
    const out = sanitizeCredentialData(JSON.parse('{"__proto__":{"polluted":"yes"},"a":1}'));
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('exportFiles', () => {
  it('writes n8n layout with 2-space JSON and no secret, pin data or static data', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const files = await exportFiles(server.ctx.serviceDeps, s.tenantId, 'all', map);
    const paths = [...files.keys()].sort();
    expect(paths).toEqual(
      [
        pathFor('workflow', s.main.id),
        pathFor('workflow', s.sub.id),
        pathFor('workflow', s.mine.id),
        pathFor('credential', s.secret.id),
        pathFor('credential', s.privateCredential.id),
        pathFor('datatable', s.table.id),
        pathFor('project', s.teamId),
        'folders.json',
        'tags.json',
        'variable_stubs.json',
      ].sort(),
    );
    const all = [...files.values()].map(text).join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('pinData');
    expect(all).not.toContain('staticData');
    expect(all).not.toContain('leaked');
    // pretty JSON, 2 spaces, final newline
    const raw = text(files.get(pathFor('workflow', s.main.id)) as Uint8Array);
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
    expect(raw).not.toContain('\r');
    const workflow = json(files.get(pathFor('workflow', s.main.id)) as Uint8Array);
    expect(Object.keys(workflow)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'description',
        'nodes',
        'connections',
        'settings',
        'triggerCount',
        'versionId',
        'owner',
        'parentFolderId',
        'isArchived',
        'nodeGroups',
        'stickyNotes',
      ]),
    );
    expect(workflow.owner).toEqual({ type: 'team', teamId: s.teamId, teamName: expect.any(String) });
    const subFile = json(files.get(pathFor('workflow', s.sub.id)) as Uint8Array);
    expect(subFile.parentFolderId).toBe(s.folder.id);
    const personal = json(files.get(pathFor('workflow', s.mine.id)) as Uint8Array);
    expect(personal.owner).toEqual({ type: 'personal', personalEmail: s.owner.user.email.toLowerCase() });
  });

  it('a string that starts with = but holds no {{ }} is a literal: emptied, never written (format-1)', async () => {
    expect(
      sanitizeCredentialData({
        password: '=hunter2',
        open: '={{ unclosed',
        ok: '={{ $json.a }}',
        list: ['=x'],
      }),
    ).toEqual({ password: '', open: '', ok: '={{ $json.a }}', list: [''] });
    const s = await seed();
    const literal = await server.ctx.credentials.create(
      s.tenantId,
      { name: 'Literal', type: 'testApi', projectId: s.teamId, data: { apiKey: '=hunter2-LITERAL' } },
      s.owner.user.id,
    );
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    const stub = json(files.get(pathFor('credential', literal.id)) as Uint8Array);
    expect(stub.data).toEqual({ apiKey: '' });
    for (const bytes of files.values()) expect(text(bytes)).not.toContain('hunter2-LITERAL');
    // a remote stub that carries it is emptied on parse as well
    const remoteStub = text(files.get(pathFor('credential', literal.id)) as Uint8Array).replace(
      '"apiKey": ""',
      '"apiKey": "=hunter2-LITERAL"',
    );
    const parsed = parseFile(pathFor('credential', literal.id), new TextEncoder().encode(remoteStub));
    expect(JSON.stringify(parsed)).not.toContain('hunter2-LITERAL');
  });

  it('writes credential stubs: sanitized data, isGlobal and isResolvable, owner', async () => {
    const s = await seed();
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    const stub = json(files.get(pathFor('credential', s.secret.id)) as Uint8Array);
    expect(stub).toMatchObject({
      id: s.secret.id,
      name: 'Seeded API',
      type: 'testApi',
      isGlobal: false,
      isResolvable: false,
      owner: { type: 'team', teamId: s.teamId },
      data: { apiKey: '', baseUrl: '=https://{{ $json.host }}', retries: 3, verbose: true },
    });
    expect(stub.data).not.toHaveProperty('nothing');
    expect(stub.data).not.toHaveProperty('oauthTokenData');
    const priv = json(files.get(pathFor('credential', s.privateCredential.id)) as Uint8Array);
    expect(priv.isResolvable).toBe(true);
  });

  it('writes variable stubs with empty values, project variables inside the project file, tables as schema only', async () => {
    const s = await seed();
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    const variables = json(files.get('variable_stubs.json') as Uint8Array);
    expect(variables).toEqual([
      { id: s.variable.id, key: 'REGION', type: 'string', value: '', projectId: null },
    ]);
    const project = json(files.get(pathFor('project', s.teamId)) as Uint8Array);
    expect(project.type).toBe('team');
    expect(project.variableStubs).toEqual([
      { id: s.projectVariable.id, key: 'TEAM_ONLY', type: 'string', value: '', projectId: s.teamId },
    ]);
    const table = json(files.get(pathFor('datatable', s.table.id)) as Uint8Array);
    expect(table).toMatchObject({ id: s.table.id, name: 'orders', projectId: s.teamId });
    expect(
      table.columns.map((c: { name: string; type: string; index: number }) => [c.name, c.type, c.index]),
    ).toEqual([
      ['sku', 'string', 0],
      ['qty', 'number', 1],
    ]);
    expect(table).not.toHaveProperty('rows');
    const tags = json(files.get('tags.json') as Uint8Array);
    expect(tags).toEqual({
      tags: [{ id: s.tag.id, name: 'finance' }],
      mappings: [{ workflowId: s.main.id, tagId: s.tag.id }],
    });
    const folders = json(files.get('folders.json') as Uint8Array);
    expect(folders.folders).toEqual([
      expect.objectContaining({
        id: s.folder.id,
        name: 'Sales',
        parentFolderId: null,
        homeProjectId: s.teamId,
      }),
    ]);
    expect(JSON.stringify([variables, project, table])).not.toContain(SECRET);
  });

  it('exports only the projects of a scope set and no single file', async () => {
    const s = await seed();
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      new Set([s.teamId]),
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    const paths = [...files.keys()];
    expect(paths).toContain(pathFor('workflow', s.main.id));
    expect(paths).not.toContain(pathFor('workflow', s.mine.id));
    expect(paths).toContain(pathFor('project', s.teamId));
    expect(paths).not.toContain('tags.json');
    expect(paths).not.toContain('folders.json');
    expect(paths).not.toContain('variable_stubs.json');
  });

  it('never reads another workspace', async () => {
    const a = await seed();
    const b = await seed();
    const files = await exportFiles(
      server.ctx.serviceDeps,
      a.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, a.tenantId),
    );
    expect(files.has(pathFor('workflow', b.main.id))).toBe(false);
    expect(files.has(pathFor('credential', b.secret.id))).toBe(false);
    expect([...files.values()].map(text).join('')).not.toContain(b.teamId);
  });

  it('writes git ids for a mapped resource and keeps a private credential private through parse', async () => {
    const s = await seed();
    const gitId = randomUUID();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    map.record('credential', gitId, s.privateCredential.id, {});
    map.record('workflow', randomUUID(), s.sub.id, {});
    const files = await exportFiles(server.ctx.serviceDeps, s.tenantId, 'all', map);
    expect(files.has(pathFor('credential', s.privateCredential.id))).toBe(false);
    const path = pathFor('credential', gitId);
    const parsed = parseFile(path, files.get(path) as Uint8Array);
    expect(parsed.type).toBe('credential');
    if (parsed.type !== 'credential') return;
    expect(parsed.id).toBe(gitId);
    expect(parsed.data.isResolvable).toBe(true);
    expect(parsed.data.data).toEqual({ apiKey: '' });
    // the call node of the main workflow names the sub-workflow by its git id
    const gitSub = map.gitIdFor('workflow', s.sub.id);
    expect(gitSub).not.toBe(s.sub.id);
    const main = text(files.get(pathFor('workflow', s.main.id)) as Uint8Array);
    expect(main).toContain(gitSub);
    expect(main).not.toContain(s.sub.id);
  });

  it('keeps isGlobal of a global credential', async () => {
    const s = await seed();
    await server.ctx.database.db
      .update(credentialsTable)
      .set({ isGlobal: true })
      .where(eq(credentialsTable.id, s.secret.id));
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    expect(json(files.get(pathFor('credential', s.secret.id)) as Uint8Array).isGlobal).toBe(true);
  });
});

describe('parseFile', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('round-trips every exported file through its schema', async () => {
    const s = await seed();
    const files = await exportFiles(
      server.ctx.serviceDeps,
      s.tenantId,
      'all',
      await SyncIdMap.load(server.ctx.repos, s.tenantId),
    );
    const kinds = new Set<string>();
    for (const [path, bytes] of files) {
      const parsed = parseFile(path, bytes);
      expect(parsed.path).toBe(path);
      kinds.add(parsed.type);
    }
    expect([...kinds].sort()).toEqual(
      ['credential', 'datatable', 'folders', 'project', 'tags', 'variables', 'workflow'].sort(),
    );
    const workflow = parseFile(
      pathFor('workflow', s.main.id),
      files.get(pathFor('workflow', s.main.id)) as Uint8Array,
    );
    if (workflow.type !== 'workflow') throw new Error('kind');
    expect(workflow.data.name).toBe('Main flow');
    expect(workflow.data.nodes).toHaveLength(2);
    expect(workflow.data.settings).toMatchObject({ executionOrder: 'v1' });
  });

  it('refuses a wrong shape, naming the file and the field, not the value', () => {
    const id = randomUUID();
    const path = pathFor('workflow', id);
    expect(() => parseFile(path, encode({ id, name: 'x', nodes: 'not a list', versionId: 'v' }))).toThrow(
      SourceControlFormatError,
    );
    try {
      parseFile(path, encode({ id, name: 'x', nodes: 'not a list', versionId: 'v' }));
    } catch (error) {
      expect((error as Error).message).toContain(path);
      expect((error as Error).message).toContain('nodes');
      expect((error as Error).message).not.toContain('not a list');
    }
    expect(() =>
      parseFile(pathFor('datatable', id), encode({ id, name: 'x', projectId: 'nope', columns: [] })),
    ).toThrow(SourceControlFormatError);
    expect(() => parseFile('tags.json', encode({ tags: [{ id: 'not-a-uuid', name: 'a' }] }))).toThrow(
      SourceControlFormatError,
    );
  });

  it('refuses a file whose id differs from its name, bad JSON, a path outside the layout and a big file', () => {
    const id = randomUUID();
    const other = randomUUID();
    const base = { name: 'x', nodes: [], connections: {}, versionId: 'v' };
    expect(() => parseFile(pathFor('workflow', id), encode({ id: other, ...base }))).toThrow(
      /another id than its name/,
    );
    expect(() => parseFile(pathFor('workflow', id), new TextEncoder().encode('{nope'))).toThrow(
      /not valid JSON/,
    );
    expect(() => parseFile(`../workflows/${id}.json`, encode({ id, ...base }))).toThrow(
      /not a work folder file/,
    );
    expect(() => parseFile(`workflows/${id}.txt`, encode({ id, ...base }))).toThrow(/not a work folder file/);
    expect(() => parseFile('workflows/x/y.json', encode({}))).toThrow(SourceControlFormatError);
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(32);
    expect(() => parseFile(pathFor('workflow', id), big)).toThrow(/size limit/);
  });

  it('drops unknown keys and never keeps pin data, static data or a variable value', () => {
    const id = randomUUID();
    const parsed = parseFile(
      pathFor('workflow', id),
      encode({
        id,
        name: 'w',
        nodes: [],
        connections: {},
        versionId: 'v1',
        pinData: { a: [] },
        staticData: { b: 1 },
        extra: 'x',
      }),
    );
    expect(parsed.type).toBe('workflow');
    expect(parsed.data).not.toHaveProperty('pinData');
    expect(parsed.data).not.toHaveProperty('staticData');
    expect(parsed.data).not.toHaveProperty('extra');
    const vars = parseFile('variable_stubs.json', encode([{ id, key: 'K', type: 'string', value: SECRET }]));
    if (vars.type !== 'variables') throw new Error('kind');
    expect(vars.data[0].value).toBe('');
  });

  it('sanitizes a credential stub a remote filled with a real secret', () => {
    const id = randomUUID();
    const parsed = parseFile(
      pathFor('credential', id),
      encode({
        id,
        name: 'c',
        type: 'testApi',
        data: { apiKey: SECRET, n: 2, oauthTokenData: { access_token: TOKEN } },
      }),
    );
    if (parsed.type !== 'credential') throw new Error('kind');
    expect(parsed.data.data).toEqual({ apiKey: '', n: 2 });
    expect(parsed.data.isResolvable).toBe(false);
  });
});

describe('SyncIdMap', () => {
  it('rewrites every known UUID in one pass both ways: refs, sub-workflow call, data table, expression', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    const gitCred = randomUUID();
    const gitSub = randomUUID();
    const gitTable = randomUUID();
    map.record('credential', gitCred, s.secret.id, {});
    map.record('workflow', gitSub, s.sub.id, {});
    map.record('datatable', gitTable, s.table.id, {});
    const stranger = randomUUID();
    const definition = {
      nodes: [
        {
          credentials: { testApi: { id: s.secret.id, name: 'x' } },
          parameters: {
            workflowId: s.sub.id,
            dataTableId: s.table.id,
            expr: `={{ $("${s.sub.id}") + "${s.table.id.toUpperCase()}" }}`,
            unknown: stranger,
          },
        },
      ],
      settings: { errorWorkflow: s.sub.id },
    };
    const toGit = map.rewriteDefinition(definition, 'toGit');
    expect(toGit.nodes[0].credentials.testApi.id).toBe(gitCred);
    expect(toGit.nodes[0].parameters.workflowId).toBe(gitSub);
    expect(toGit.nodes[0].parameters.dataTableId).toBe(gitTable);
    expect(toGit.nodes[0].parameters.expr).toBe(`={{ $("${gitSub}") + "${gitTable}" }}`);
    expect(toGit.nodes[0].parameters.unknown).toBe(stranger);
    expect(toGit.settings.errorWorkflow).toBe(gitSub);
    expect(definition.settings.errorWorkflow).toBe(s.sub.id);
    expect(map.rewriteDefinition(toGit, 'toLocal')).toEqual({
      ...definition,
      nodes: [
        {
          ...definition.nodes[0],
          parameters: {
            ...definition.nodes[0].parameters,
            expr: definition.nodes[0].parameters.expr.toLowerCase(),
          },
        },
      ],
    });
  });

  it('swaps two ids in one pass, a replaced id is not read again', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    // git id of A is the local id of B and the other way round
    map.record('workflow', s.sub.id, s.main.id, {});
    map.record('workflow', s.main.id, s.sub.id, {});
    const out = map.rewriteDefinition({ a: s.sub.id, b: s.main.id }, 'toLocal');
    expect(out).toEqual({ a: s.main.id, b: s.sub.id });
  });

  it('answers git and local ids, gives an incoming git id a new local id once, and never a taken one', async () => {
    const s = await seed();
    const map = await SyncIdMap.load(server.ctx.repos, s.tenantId);
    expect(map.gitIdFor('workflow', s.main.id)).toBe(s.main.id);
    const gitId = randomUUID();
    expect(map.localIdFor('workflow', gitId)).toBeUndefined();
    const local = map.allocate('workflow', gitId);
    expect(local).not.toBe(gitId);
    expect(map.allocate('workflow', gitId)).toBe(local);
    expect(map.localIdFor('workflow', gitId)).toBe(local);
    expect(map.gitIdFor('workflow', local)).toBe(gitId);
    expect(map.rewriteDefinition({ id: gitId }, 'toLocal')).toEqual({ id: local });
  });

  it('saves what changed and loads it back for this workspace only, with the versions of each side', async () => {
    const a = await seed();
    const b = await seed();
    const { repos } = server.ctx;
    const map = await SyncIdMap.load(repos, a.tenantId);
    const gitId = randomUUID();
    map.record('workflow', gitId, a.main.id, { git: 'git-v1', local: 'local-v1' });
    const incoming = randomUUID();
    const incomingLocal = map.allocate('workflow', incoming);
    await map.save(repos);
    const loaded = await SyncIdMap.load(repos, a.tenantId);
    expect(loaded.entryForGit('workflow', gitId)).toMatchObject({
      localId: a.main.id,
      gitVersionId: 'git-v1',
      localVersionId: 'local-v1',
    });
    expect(loaded.localIdFor('workflow', incoming)).toBe(incomingLocal);
    expect((await SyncIdMap.load(repos, b.tenantId)).localIdFor('workflow', gitId)).toBeUndefined();
    // a new version replaces the old, a side left out keeps its version
    loaded.record('workflow', gitId, a.main.id, { local: 'local-v2' });
    await loaded.save(repos);
    expect((await SyncIdMap.load(repos, a.tenantId)).entryForGit('workflow', gitId)).toMatchObject({
      gitVersionId: 'git-v1',
      localVersionId: 'local-v2',
    });
    // drop removes the row
    loaded.drop('workflow', gitId);
    await loaded.save(repos);
    expect((await SyncIdMap.load(repos, a.tenantId)).localIdFor('workflow', gitId)).toBeUndefined();
    expect((await SyncIdMap.load(repos, a.tenantId)).localIdFor('workflow', incoming)).toBe(incomingLocal);
  });

  it('moves a local id to a new git id without tripping the unique key', async () => {
    const s = await seed();
    const { repos } = server.ctx;
    const map = await SyncIdMap.load(repos, s.tenantId);
    const first = randomUUID();
    const second = randomUUID();
    map.record('workflow', first, s.main.id, {});
    await map.save(repos);
    const again = await SyncIdMap.load(repos, s.tenantId);
    again.record('workflow', second, s.main.id, {});
    await again.save(repos);
    const rows = await repos.syncIdMap.list(s.tenantId);
    expect(rows.filter((r) => r.resourceType === 'workflow').map((r) => r.gitId)).toEqual([second]);
  });

  it('repository: upsert, list and remove by tenant', async () => {
    const a = await seed();
    const b = await seed();
    const { repos } = server.ctx;
    const gitId = randomUUID();
    await repos.syncIdMap.upsert(a.tenantId, [
      { resourceType: 'tag', gitId, localId: a.tag.id, gitVersionId: null, localVersionId: null },
    ]);
    await repos.syncIdMap.upsert(a.tenantId, [
      { resourceType: 'tag', gitId, localId: a.tag.id, gitVersionId: 'g', localVersionId: 'l' },
    ]);
    expect(await repos.syncIdMap.list(a.tenantId)).toEqual([
      expect.objectContaining({ resourceType: 'tag', gitId, gitVersionId: 'g', localVersionId: 'l' }),
    ]);
    expect(await repos.syncIdMap.list(b.tenantId)).toEqual([]);
    // another workspace cannot remove it
    await repos.syncIdMap.remove(b.tenantId, [{ resourceType: 'tag', gitId }]);
    expect(await repos.syncIdMap.list(a.tenantId)).toHaveLength(1);
    await repos.syncIdMap.remove(a.tenantId, [{ resourceType: 'tag', gitId }]);
    expect(await repos.syncIdMap.list(a.tenantId)).toEqual([]);
    await repos.syncIdMap.remove(a.tenantId, []);
  });
});

describe('contentVersion', () => {
  it('is the same for the same content in any key order and differs when the content differs', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
    const a = { tags: [{ id: 'x', name: 'one' }], mappings: [] };
    expect(contentVersion('tags', a)).toBe(contentVersion('tags', JSON.parse(JSON.stringify(a))));
    expect(contentVersion('tags', a)).not.toBe(contentVersion('tags', { ...a, tags: [] }));
  });
});
