/**
 * P6-03 C0 access contract (C0c1): AccessService scopes, masks, implicit members, 404 against 403,
 * the per-request cache, list filters and the repository narrowing, custom roles, the personal space
 * policy, the legacy role map and the credential checks. Rows are set up through the repositories.
 */
import { randomUUID } from 'node:crypto';
import {
  GLOBAL_ROLE_SCOPES,
  MANDATORY_INSTANCE_SCOPES,
  maskScopes,
  PROJECT_ROLE_SCOPES,
  personalOwnerScopes,
  RESOURCE_ROLE_SCOPES,
  type Scope,
} from '@workflow/workflow';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '../src/db/schema';
import { type AuthContext, requireScope } from '../src/http/auth';
import { AccessService, LEGACY_ROLE_SCOPES, MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  assertCredentialsUsable,
  InaccessibleCredentialError,
  InvalidCredentialError,
} from '../src/services/credential-usable';
import { createTestServer, resetDatabase, type TestServer } from './helpers';

let server: TestServer;
let access: AccessService;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
  access = new AccessService(server.ctx.repos);
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;
const union = (...sets: Iterable<Scope>[]) => new Set<Scope>(sets.flatMap((s) => [...s]));
const sorted = (scopes: Iterable<Scope>) => [...scopes].sort();

async function workspace(name = 'Acme') {
  const tenant = await repos().tenants.create({
    name,
    slug: `ws-${randomUUID().slice(0, 8)}`,
    plan: 'unlimited',
  });
  const owner = await user(tenant.id, 'owner');
  return { tenant, owner };
}

async function user(tenantId: string, role: Role) {
  const row = await repos().users.create({
    email: `u-${randomUUID().slice(0, 8)}@example.com`,
    name: `User ${role}`,
    passwordHash: 'x',
  });
  await repos().memberships.add(tenantId, row.id, role);
  return row;
}

async function team(tenantId: string, name: string) {
  return repos().projects.create(tenantId, { name, type: 'team' });
}

async function workflowIn(tenantId: string, projectId: string, name = 'Flow') {
  return repos().workflows.create(tenantId, {
    versionId: randomUUID(),
    name,
    nodes: [],
    connections: {},
    settings: {},
    pinData: {},
    stickyNotes: [],
    projectId,
  });
}

async function credentialIn(tenantId: string, projectId: string, name = 'Key', isGlobal = false) {
  return repos().credentials.create(tenantId, {
    id: randomUUID(),
    name,
    type: 'testApi',
    dataEnc: 'not-used',
    projectId,
    isGlobal,
  });
}

function authOf(tenant: { id: string }, row: { id: string }, role: Role): AuthContext {
  return { tenant, user: row, role } as unknown as AuthContext;
}

function requestOf(auth: AuthContext | null): FastifyRequest {
  return { auth, server: { access } } as unknown as FastifyRequest;
}

describe('scopesFor', () => {
  it('masks a sharee project role by the share role: a sharee editor has no workflow:delete', async () => {
    const { tenant } = await workspace();
    const home = await team(tenant.id, 'Home');
    const other = await team(tenant.id, 'Other');
    const workflow = await workflowIn(tenant.id, home.id);
    await repos().shares.set(tenant.id, 'workflow', workflow.id, [other.id]);
    const sharee = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, other.id, sharee.id, 'project:editor');
    const author = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, home.id, author.id, 'project:editor');

    const shared = await access.scopesFor(tenant.id, sharee.id, { workflowId: workflow.id });
    expect(sorted(shared)).toEqual(
      sorted(
        union(
          GLOBAL_ROLE_SCOPES.member,
          maskScopes(PROJECT_ROLE_SCOPES['project:editor'], RESOURCE_ROLE_SCOPES['workflow:editor']),
        ),
      ),
    );
    expect(shared.has('workflow:update')).toBe(true);
    expect(shared.has('workflow:execute')).toBe(true);
    expect(shared.has('workflow:delete')).toBe(false);

    const own = await access.scopesFor(tenant.id, author.id, { workflowId: workflow.id });
    expect(own.has('workflow:delete')).toBe(PROJECT_ROLE_SCOPES['project:editor'].has('workflow:delete'));
    expect(sorted(own)).toEqual(
      sorted(
        union(
          GLOBAL_ROLE_SCOPES.member,
          maskScopes(PROJECT_ROLE_SCOPES['project:editor'], RESOURCE_ROLE_SCOPES['workflow:owner']),
        ),
      ),
    );
  });

  it('makes owners and admins implicit admins of team projects; a member with no relation gets global scopes only', async () => {
    const { tenant, owner } = await workspace();
    const admin = await user(tenant.id, 'admin');
    const member = await user(tenant.id, 'member');
    const project = await team(tenant.id, 'Team');
    for (const who of [owner, admin]) {
      const scopes = await access.scopesFor(tenant.id, who.id, { projectId: project.id });
      for (const scope of PROJECT_ROLE_SCOPES['project:admin']) expect(scopes.has(scope)).toBe(true);
    }
    const scopes = await access.scopesFor(tenant.id, member.id, { projectId: project.id });
    expect(sorted(scopes)).toEqual(sorted(GLOBAL_ROLE_SCOPES.member));
  });

  it('answers 404 for another workspace id and a non-uuid id, with the name the service uses', async () => {
    const a = await workspace('A');
    const b = await workspace('B');
    const projectB = await team(b.tenant.id, 'B team');
    const workflowB = await workflowIn(b.tenant.id, projectB.id);
    const credentialB = await credentialIn(b.tenant.id, projectB.id);
    const tableB = await repos().dataTables.create(b.tenant.id, projectB.id, 'Orders');
    const cases: Array<[Parameters<AccessService['scopesFor']>[2], string]> = [
      [{ workflowId: workflowB.id }, 'Workflow not found'],
      [{ credentialId: credentialB.id }, 'Credential not found'],
      [{ projectId: projectB.id }, 'Project not found'],
      [{ executionId: randomUUID() }, 'Execution not found'],
      [{ folderId: 'not-a-uuid' }, 'Folder not found'],
      [{ variableId: randomUUID() }, 'Variable not found'],
      [{ secretConnectionKey: 'vault' }, 'Connection with key "vault" not found'],
    ];
    for (const [target, message] of cases) {
      await expect(access.scopesFor(a.tenant.id, a.owner.id, target)).rejects.toMatchObject({
        statusCode: 404,
        message,
      });
    }
    await expect(access.scopesFor(a.tenant.id, a.owner.id, { dataTableId: tableB.id })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
  });

  it('resolves an execution through its workflow; a run with no workflow row gets global scopes only', async () => {
    const { tenant } = await workspace();
    const project = await team(tenant.id, 'Team');
    const workflow = await workflowIn(tenant.id, project.id);
    const viewer = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, project.id, viewer.id, 'project:viewer');
    const run = await repos().executions.create(
      tenant.id,
      { id: randomUUID(), workflowId: workflow.id, mode: 'manual', status: 'success' },
      { workflowData: {}, runOptions: {} },
    );
    const orphan = await repos().executions.create(
      tenant.id,
      { id: randomUUID(), workflowId: null, mode: 'manual', status: 'success' },
      { workflowData: {}, runOptions: {} },
    );
    const scopes = await access.scopesFor(tenant.id, viewer.id, { executionId: run.id });
    expect(scopes.has('execution:read')).toBe(
      PROJECT_ROLE_SCOPES['project:viewer'].has('execution:read') &&
        RESOURCE_ROLE_SCOPES['workflow:owner'].has('execution:read'),
    );
    expect(scopes.has('execution:delete')).toBe(false);
    const none = await access.scopesFor(tenant.id, viewer.id, { executionId: orphan.id });
    expect(sorted(none)).toEqual(sorted(GLOBAL_ROLE_SCOPES.member));
  });

  it('grants exactly a custom project role scopes, and a custom global role its scopes plus the baseline', async () => {
    const { tenant } = await workspace();
    const project = await team(tenant.id, 'Team');
    await repos().roles.create(tenant.id, {
      slug: 'project:reader',
      displayName: 'Reader',
      roleType: 'project',
      scopes: ['workflow:read', 'project:read'],
    });
    await repos().roles.create(tenant.id, {
      slug: 'global:auditor',
      displayName: 'Auditor',
      roleType: 'global',
      scopes: ['auditLogs:manage'],
    });
    const member = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, project.id, member.id, 'project:reader');
    const scopes = await access.scopesFor(tenant.id, member.id, { projectId: project.id });
    expect(sorted(scopes)).toEqual(
      sorted(union(GLOBAL_ROLE_SCOPES.member, ['workflow:read', 'project:read'])),
    );

    const auditor = await user(tenant.id, 'global:auditor');
    expect(sorted(await access.globalScopes(tenant.id, 'global:auditor'))).toEqual(
      sorted(union(['auditLogs:manage'], MANDATORY_INSTANCE_SCOPES)),
    );
    // a project role slug as a workspace role, or an unknown slug, gives nothing
    expect((await access.globalScopes(tenant.id, 'project:reader')).size).toBe(0);
    expect((await access.globalScopes(tenant.id, 'nobody')).size).toBe(0);
    const onProject = await access.scopesFor(tenant.id, auditor.id, { projectId: project.id });
    expect(sorted(onProject)).toEqual(sorted(union(['auditLogs:manage'], MANDATORY_INSTANCE_SCOPES)));
  });

  it('follows the personal space policy flags for a personal project owner (both on by default)', async () => {
    const { tenant } = await workspace();
    const member = await user(tenant.id, 'member');
    const personal = await repos().projects.ensurePersonal(tenant.id, member);
    const on = await access.scopesFor(tenant.id, member.id, { projectId: personal.id });
    expect(sorted(on)).toEqual(
      sorted(
        union(
          GLOBAL_ROLE_SCOPES.member,
          personalOwnerScopes({ personalSpacePublishing: true, personalSpaceSharing: true }),
        ),
      ),
    );
    expect(on.has('workflow:publish')).toBe(true);
    expect(on.has('workflow:share')).toBe(true);
    await repos().tenants.updateSettings(tenant.id, {
      securityPolicy: { personalSpacePublishing: false, personalSpaceSharing: false },
    });
    const off = await access.scopesFor(tenant.id, member.id, { projectId: personal.id });
    expect(off.has('workflow:publish')).toBe(false);
    expect(off.has('workflow:share')).toBe(false);
    expect(off.has('credential:share')).toBe(false);
    expect(off.has('workflow:create')).toBe(true);
  });
});

describe('legacy roles', () => {
  it('give editor and viewer today rights, workspace wide', async () => {
    const { tenant } = await workspace();
    const viewer = LEGACY_ROLE_SCOPES.viewer;
    const editor = LEGACY_ROLE_SCOPES.editor;
    for (const scope of ['credential:read', 'annotationTag:create', 'tag:create', 'tag:update'] as Scope[]) {
      expect(viewer.has(scope)).toBe(false);
      expect(editor.has(scope)).toBe(true);
    }
    expect(editor.has('tag:delete')).toBe(true);
    for (const scope of viewer) expect(editor.has(scope)).toBe(true);
    for (const scope of ['project:list', 'project:read', 'workflow:read', 'credential:list'] as Scope[]) {
      expect(viewer.has(scope)).toBe(true);
    }
    const never: Scope[] = [
      'project:create',
      'role:manage',
      'workflow:share',
      'workflow:move',
      'credential:share',
      'credential:move',
    ];
    for (const scope of never) {
      expect(viewer.has(scope)).toBe(false);
      expect(editor.has(scope)).toBe(false);
    }
    expect(await access.globalScopes(tenant.id, 'editor')).toBe(editor);
    expect(await access.globalScopes(tenant.id, 'viewer')).toBe(viewer);
    expect(await access.globalScopes(tenant.id, 'member')).toBe(GLOBAL_ROLE_SCOPES.member);

    // workspace wide: an old editor updates a workflow of a project it has no relation on
    const project = await team(tenant.id, 'Team');
    const workflow = await workflowIn(tenant.id, project.id);
    const old = await user(tenant.id, 'editor');
    const scopes = await access.scopesFor(tenant.id, old.id, { workflowId: workflow.id });
    expect(scopes.has('workflow:update')).toBe(true);
    expect(scopes.has('workflow:share')).toBe(false);
  });
});

describe('requireScope', () => {
  it('refuses a hidden row in the workspace with 403 and another workspace id with 404', async () => {
    const a = await workspace('A');
    const b = await workspace('B');
    const project = await team(a.tenant.id, 'Team');
    const workflow = await workflowIn(a.tenant.id, project.id);
    const foreign = await workflowIn(b.tenant.id, (await team(b.tenant.id, 'B')).id);
    const member = await user(a.tenant.id, 'member');
    const request = requestOf(authOf(a.tenant, member, 'member'));
    await expect(requireScope(request, 'workflow:read', { workflowId: workflow.id })).rejects.toMatchObject({
      statusCode: 403,
      message: MISSING_SCOPE_MESSAGE,
    });
    await expect(requireScope(request, 'workflow:read', { workflowId: foreign.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(requireScope(request, 'workflow:read', { workflowId: 'nope' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(requireScope(requestOf(null), 'workflow:read')).rejects.toMatchObject({ statusCode: 401 });

    await repos().projects.relations.add(a.tenant.id, project.id, member.id, 'project:viewer');
    const fresh = requestOf(authOf(a.tenant, member, 'member'));
    await expect(requireScope(fresh, 'workflow:read', { workflowId: workflow.id })).resolves.toMatchObject({
      user: { id: member.id },
    });
  });

  it('caches the scopes of a target on the request: one lookup per request', async () => {
    const { tenant, owner } = await workspace();
    const project = await team(tenant.id, 'Team');
    const workflow = await workflowIn(tenant.id, project.id);
    const spy = vi.spyOn(server.ctx.repos.workflows, 'get');
    try {
      const request = requestOf(authOf(tenant, owner, 'owner'));
      await requireScope(request, 'workflow:read', { workflowId: workflow.id });
      const once = spy.mock.calls.length;
      expect(once).toBeGreaterThan(0);
      await requireScope(request, 'workflow:update', { workflowId: workflow.id });
      expect(spy).toHaveBeenCalledTimes(once);
      // the cache lives on the request: a new request looks the target up again
      await requireScope(requestOf(authOf(tenant, owner, 'owner')), 'workflow:read', {
        workflowId: workflow.id,
      });
      expect(spy).toHaveBeenCalledTimes(once * 2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('listFilter and the repositories', () => {
  it('is all for a global scope and narrows a member to its projects and shares', async () => {
    const { tenant, owner } = await workspace();
    const mine = await team(tenant.id, 'Mine');
    const sharee = await team(tenant.id, 'Sharee');
    const hidden = await team(tenant.id, 'Hidden');
    const own = await workflowIn(tenant.id, mine.id, 'Own');
    const shared = await workflowIn(tenant.id, hidden.id, 'Shared');
    await workflowIn(tenant.id, hidden.id, 'Hidden');
    await repos().shares.set(tenant.id, 'workflow', shared.id, [sharee.id]);
    const member = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, mine.id, member.id, 'project:viewer');
    await repos().projects.relations.add(tenant.id, sharee.id, member.id, 'project:editor');
    const lonely = await user(tenant.id, 'member');
    const old = await user(tenant.id, 'viewer');

    expect(await access.listFilter(authOf(tenant, owner, 'owner'), 'workflow:list')).toEqual({ all: true });
    expect(await access.listFilter(authOf(tenant, old, 'viewer'), 'workflow:list')).toEqual({ all: true });
    expect(await access.listFilter(authOf(tenant, lonely, 'member'), 'workflow:list')).toEqual({
      all: false,
      projectIds: [],
      workflowIds: [],
      credentialIds: [],
    });

    const filter = await access.listFilter(authOf(tenant, member, 'member'), 'workflow:read');
    expect(filter).toMatchObject({ all: false, workflowIds: [shared.id], credentialIds: [] });
    if (filter.all) throw new Error('expected a narrowed filter');
    expect([...filter.projectIds].sort()).toEqual([mine.id, sharee.id].sort());

    const listed = await repos().workflows.list(tenant.id, { filter, limit: 50 });
    expect(listed.map((w) => w.name).sort()).toEqual(['Own', 'Shared']);
    const inMine = await repos().workflows.list(tenant.id, { filter, projectId: mine.id, limit: 50 });
    expect(inMine.map((w) => w.id)).toEqual([own.id]);
    const onlyShared = await repos().workflows.list(tenant.id, {
      filter,
      projectId: sharee.id,
      onlySharedWithMe: true,
      limit: 50,
    });
    expect(onlyShared.map((w) => w.id)).toEqual([shared.id]);
    expect(await repos().workflows.list(tenant.id, { filter: { all: true }, limit: 50 })).toHaveLength(3);
    const none = await access.listFilter(authOf(tenant, lonely, 'member'), 'workflow:read');
    expect(await repos().workflows.list(tenant.id, { filter: none, limit: 50 })).toEqual([]);

    const run = await repos().executions.create(
      tenant.id,
      { id: randomUUID(), workflowId: own.id, mode: 'manual', status: 'success' },
      { workflowData: {}, runOptions: {} },
    );
    await repos().executions.create(
      tenant.id,
      { id: randomUUID(), workflowId: null, mode: 'manual', status: 'success' },
      { workflowData: {}, runOptions: {} },
    );
    const runFilter = await access.listFilter(authOf(tenant, member, 'member'), 'execution:list');
    const runs = await repos().executions.list(tenant.id, { filter: runFilter, limit: 50 });
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    expect(await repos().executions.list(tenant.id, { filter: { all: true }, limit: 50 })).toHaveLength(2);
  });

  it('lists owned, shared and global credentials, and narrows folders and data tables to projects', async () => {
    const { tenant } = await workspace();
    const mine = await team(tenant.id, 'Mine');
    const other = await team(tenant.id, 'Other');
    const owned = await credentialIn(tenant.id, mine.id, 'Owned');
    const shared = await credentialIn(tenant.id, other.id, 'Shared');
    const global = await credentialIn(tenant.id, other.id, 'Global', true);
    await credentialIn(tenant.id, other.id, 'Hidden');
    await repos().shares.set(tenant.id, 'credential', shared.id, [mine.id]);
    const member = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, mine.id, member.id, 'project:editor');

    const filter = await access.listFilter(authOf(tenant, member, 'member'), 'credential:list');
    if (filter.all) throw new Error('expected a narrowed filter');
    expect(filter.projectIds).toEqual([mine.id]);
    expect([...filter.credentialIds].sort()).toEqual([shared.id, global.id].sort());
    const listed = await repos().credentials.list(tenant.id, { filter });
    expect(listed.map((c) => c.name).sort()).toEqual(['Global', 'Owned', 'Shared']);
    expect(listed.find((c) => c.id === owned.id)).toMatchObject({ projectId: mine.id, isGlobal: false });
    expect(await repos().credentials.list(tenant.id, 'testApi')).toHaveLength(4);

    await repos().folders.create(tenant.id, { name: 'A', parentFolderId: null, projectId: mine.id });
    await repos().folders.create(tenant.id, { name: 'B', parentFolderId: null, projectId: other.id });
    await repos().dataTables.create(tenant.id, mine.id, 'Orders');
    await repos().dataTables.create(tenant.id, other.id, 'Orders');
    const folderFilter = await access.listFilter(authOf(tenant, member, 'member'), 'folder:read');
    const folders = await repos().folders.list(tenant.id, { filter: folderFilter, limit: 50 });
    expect(folders.map((f) => f.name)).toEqual(['A']);
    const tableFilter = await access.listFilter(authOf(tenant, member, 'member'), 'dataTable:read');
    const tables = await repos().dataTables.list(tenant.id, { filter: tableFilter, take: 50, skip: 0 });
    expect(tables.count).toBe(1);
    expect(tables.rows[0].projectId).toBe(mine.id);
  });

  it('lists the accessible projects for a scope', async () => {
    const { tenant, owner } = await workspace();
    const a = await team(tenant.id, 'A');
    const b = await team(tenant.id, 'B');
    const member = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, a.id, member.id, 'project:editor');
    await repos().projects.relations.add(tenant.id, b.id, member.id, 'project:viewer');
    expect(await access.accessibleProjectIds(authOf(tenant, member, 'member'), 'workflow:create')).toEqual([
      a.id,
    ]);
    expect(
      (await access.accessibleProjectIds(authOf(tenant, member, 'member'), 'workflow:read')).sort(),
    ).toEqual([a.id, b.id].sort());
    const all = await access.accessibleProjectIds(authOf(tenant, owner, 'owner'), 'workflow:create');
    expect(all.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('credentials', () => {
  it('credentialUsable: owned, shared, global and allow pass; another project is refused', async () => {
    const { tenant } = await workspace();
    const mine = await team(tenant.id, 'Mine');
    const other = await team(tenant.id, 'Other');
    const owned = await credentialIn(tenant.id, mine.id);
    const shared = await credentialIn(tenant.id, other.id);
    const global = await credentialIn(tenant.id, other.id, 'Global', true);
    const foreign = await credentialIn(tenant.id, other.id);
    await repos().shares.set(tenant.id, 'credential', shared.id, [mine.id]);
    expect(await access.credentialUsable(tenant.id, mine.id, owned)).toBe(true);
    expect(await access.credentialUsable(tenant.id, mine.id, shared)).toBe(true);
    expect(await access.credentialUsable(tenant.id, mine.id, global)).toBe(true);
    expect(await access.credentialUsable(tenant.id, mine.id, foreign, [foreign.id])).toBe(true);
    expect(await access.credentialUsable(tenant.id, mine.id, foreign)).toBe(false);
    expect(await access.credentialUsable(randomUUID(), mine.id, owned)).toBe(false);
  });

  it('credentialUsableBy counts only the member own project relations with credential:read', async () => {
    const { tenant, owner } = await workspace();
    const mine = await team(tenant.id, 'Mine');
    const other = await team(tenant.id, 'Other');
    const owned = await credentialIn(tenant.id, mine.id);
    const shared = await credentialIn(tenant.id, other.id);
    const global = await credentialIn(tenant.id, other.id, 'Global', true);
    const foreign = await credentialIn(tenant.id, other.id);
    await repos().shares.set(tenant.id, 'credential', shared.id, [mine.id]);
    const member = await user(tenant.id, 'member');
    await repos().projects.relations.add(tenant.id, mine.id, member.id, 'project:editor');
    const ids = [owned.id, shared.id, global.id, foreign.id];
    const usable = await access.credentialUsableBy(tenant.id, member.id, ids);
    expect([...usable].sort()).toEqual([owned.id, shared.id].sort());
    // the owner's global scopes do not count
    expect((await access.credentialUsableBy(tenant.id, owner.id, ids)).size).toBe(0);
  });

  it('finds a credential by name only among what the project can use', async () => {
    const { tenant } = await workspace();
    const mine = await team(tenant.id, 'Mine');
    const other = await team(tenant.id, 'Other');
    const foreign = await credentialIn(tenant.id, other.id, 'Same');
    expect(await repos().credentials.findByName(tenant.id, mine.id, 'Same', ['testApi'])).toBeUndefined();
    expect((await repos().credentials.findByName(tenant.id, null, 'Same', ['testApi']))?.id).toBe(foreign.id);
    const own = await credentialIn(tenant.id, mine.id, 'Same');
    expect((await repos().credentials.findByName(tenant.id, mine.id, 'Same', ['testApi']))?.id).toBe(own.id);
  });

  it('the usable check stub passes everything and the errors carry n8n texts', async () => {
    const { tenant } = await workspace();
    const project = await team(tenant.id, 'Team');
    await expect(
      assertCredentialsUsable(server.ctx, tenant.id, project.id, {
        nodes: [],
        connections: {},
      } as never),
    ).resolves.toBeUndefined();
    expect(new InvalidCredentialError('HTTP').message).toBe('Node "HTTP" uses invalid credential');
    expect(new InaccessibleCredentialError('HTTP', { type: 'team', name: 'Ops' }).message).toBe(
      'Node "HTTP" does not have access to the credential',
    );
  });
});

describe('projects, variables and the target project', () => {
  it('targetProject takes the given id, else the oldest team project, which is made when missing', async () => {
    const { tenant, owner } = await workspace('Fresh');
    const auth = authOf(tenant, owner, 'owner');
    const made = await access.targetProject(auth);
    expect(await repos().projects.get(tenant.id, made)).toMatchObject({ type: 'team', name: 'Fresh' });
    expect(await access.targetProject(auth)).toBe(made);
    const second = await team(tenant.id, 'Second');
    expect(await access.targetProject(auth, second.id)).toBe(second.id);
    expect(await access.targetProject(auth)).toBe(made);
    await expect(access.targetProject(auth, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(access.targetProject(auth, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('ensurePersonal makes one personal project with the owner relation', async () => {
    const { tenant } = await workspace();
    const member = await user(tenant.id, 'member');
    const first = await repos().projects.ensurePersonal(tenant.id, member);
    const again = await repos().projects.ensurePersonal(tenant.id, member);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ type: 'personal', ownerUserId: member.id });
    expect(await repos().projects.relations.get(tenant.id, first.id, member.id)).toMatchObject({
      role: 'project:personalOwner',
    });
    expect((await repos().projects.listForUser(tenant.id, member.id)).map((p) => p.id)).toEqual([first.id]);
  });

  it('moveResources moves the work and drops the target own shares', async () => {
    const { tenant } = await workspace();
    const from = await team(tenant.id, 'From');
    const to = await team(tenant.id, 'To');
    const workflow = await workflowIn(tenant.id, from.id);
    const credential = await credentialIn(tenant.id, from.id);
    await repos().shares.set(tenant.id, 'workflow', workflow.id, [to.id]);
    await repos().folders.create(tenant.id, { name: 'F', parentFolderId: null, projectId: from.id });
    await repos().dataTables.create(tenant.id, from.id, 'T');
    const moved = await repos().projects.moveResources(tenant.id, from.id, to.id);
    expect(moved).toEqual({ workflows: 1, credentials: 1, folders: 1, dataTables: 1 });
    expect((await repos().workflows.get(tenant.id, workflow.id))?.projectId).toBe(to.id);
    expect((await repos().credentials.get(tenant.id, credential.id))?.projectId).toBe(to.id);
    expect(await repos().shares.listForWorkflow(tenant.id, workflow.id)).toEqual([]);
    expect(await repos().projects.delete(tenant.id, from.id)).toBe(true);
  });

  it('variables: the project value wins in the run map; global only without a project', async () => {
    const { tenant } = await workspace();
    const project = await team(tenant.id, 'Team');
    await repos().variables.create(tenant.id, { key: 'region', value: 'eu' });
    await repos().variables.create(tenant.id, { key: 'only', value: 'global' });
    await repos().variables.create(tenant.id, { key: 'region', value: 'us', projectId: project.id });
    expect(await repos().variables.map(tenant.id, project.id)).toEqual({ region: 'us', only: 'global' });
    expect(await repos().variables.map(tenant.id)).toEqual({ region: 'eu', only: 'global' });
    expect(await repos().variables.list(tenant.id)).toHaveLength(3);
    expect(await repos().variables.list(tenant.id, { projectId: null })).toHaveLength(2);
    expect(await repos().variables.list(tenant.id, { projectId: project.id })).toHaveLength(1);
  });
});
