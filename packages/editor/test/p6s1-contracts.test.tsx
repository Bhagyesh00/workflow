/**
 * Phase 6 S1 C0f2 contracts: `canWith` over a me and a row, the demo's global scopes by role (`setDemoRole`;
 * P6-39: the old test names are project roles), the redirects of the old list routes, the Security shell, and the FULL demo parts of
 * commit 0: projects of the seed, `GET /roles`, `/settings/security`, project variables, member roles and the
 * credential `isGlobal` flag. Stubs (501) are the lanes' and are not asserted here.
 */
import { screen, waitFor } from '@testing-library/react';
import { GLOBAL_ROLE_SCOPES, type Scope } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Me, Project, ProjectDetail, RolesMap, SecurityPolicy } from '../src/api/types';
import { seedDemo } from '../src/demo/install';
import { MISSING_SCOPE, MockBackend } from '../src/demo/mock-backend';
import { addDemoRole } from '../src/demo/mock-roles';
import { canWith } from '../src/lib/permissions';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await backend().handle({ method, path, body, query });
  return {
    status: res.status,
    body: res.body as { data?: unknown; error?: { code: string; message: string } },
  };
}

async function data<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await call(method, path, body, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as T;
}

const me = () => data<Me>('GET', '/auth/me');

describe('canWith', () => {
  it('passes on the global scopes or the row scopes, and denies with nothing loaded', () => {
    const user = { globalScopes: ['workflow:read'] as Scope[] };
    const row = { scopes: ['workflow:update'] as Scope[] };
    expect(canWith(user, 'workflow:read')).toBe(true);
    expect(canWith(user, 'workflow:update')).toBe(false);
    expect(canWith(user, 'workflow:update', row)).toBe(true);
    expect(canWith(user, 'workflow:delete', row)).toBe(false);
    expect(canWith(null, 'workflow:read', null)).toBe(false);
    expect(canWith(undefined, 'workflow:update', row)).toBe(true);
  });
});

describe('demo global scopes', () => {
  beforeEach(() => void signedIn());

  it('answers globalScopes on me, login and switch-tenant', async () => {
    const owner = await me();
    expect(owner.role).toBe('owner');
    expect(new Set(owner.globalScopes)).toEqual(new Set(GLOBAL_ROLE_SCOPES.owner));
    for (const scope of ['instanceAi:manage', 'securitySettings:manage', 'role:manage'] as Scope[])
      expect(owner.globalScopes).toContain(scope);
    const login = await data<Me>('POST', '/auth/login', {
      email: 'owner@example.com',
      password: 'secret-pass-1',
    });
    expect(login.globalScopes).toEqual(owner.globalScopes);
  });

  it("setDemoRole('viewer') and ('editor') make a member with that project role on the team project (P6-39)", async () => {
    const team = backend().oldestTeamProject(backend().session!.tenantId);
    const relationOf = () =>
      backend().projectRelations.find(
        (r) => r.projectId === team.id && r.userId === backend().session!.userId,
      );
    for (const name of ['viewer', 'editor'] as const) {
      backend().setDemoRole(name);
      const now = await me();
      expect(now.role).toBe('member');
      expect(new Set(now.globalScopes)).toEqual(new Set(GLOBAL_ROLE_SCOPES.member));
      expect(backend().memberships[0].role).toBe('member');
      expect(relationOf()?.role).toBe(`project:${name}`);
      for (const scope of [
        'instanceAi:manage',
        'securitySettings:manage',
        'role:manage',
        'project:create',
      ] as Scope[])
        expect(now.globalScopes).not.toContain(scope);
    }
    expect(backend().projectScopes(team)).toContain('workflow:update');
    backend().setDemoRole('viewer');
    expect(backend().projectScopes(team)).not.toContain('workflow:update');
    expect(backend().projectScopes(team)).toContain('workflow:read');
    expect(canWith(await me(), 'workflow:update')).toBe(false);
  });

  it('a member holds the global member scopes; a workspace role leaves the project relations alone', async () => {
    backend().setDemoRole('member');
    const member = await me();
    expect(member.role).toBe('member');
    expect(new Set(member.globalScopes)).toEqual(new Set(GLOBAL_ROLE_SCOPES.member));
    expect(backend().auth().role).toBe('member');
    backend().setDemoRole('editor');
    backend().setDemoRole('viewer');
    const team = backend().oldestTeamProject(backend().session!.tenantId);
    const mine = () =>
      backend().projectRelations.filter(
        (r) => r.projectId === team.id && r.userId === backend().session!.userId,
      );
    expect(mine().map((r) => r.role)).toEqual(['project:viewer']);
    backend().setDemoRole('admin');
    expect(backend().memberships[0].role).toBe('admin');
    expect(mine().map((r) => r.role)).toEqual(['project:viewer']);
    expect((await me()).role).toBe('admin');
  });

  it('requireScope answers 403 with the server message', () => {
    backend().setDemoRole('viewer');
    expect(() => backend().requireScope('workflow:update')).toThrow(MISSING_SCOPE);
    expect(backend().requireScope('workflow:update', { scopes: ['workflow:update'] }).user.email).toBe(
      'owner@example.com',
    );
  });
});

describe('routes', () => {
  it('redirects the old list routes to /home, keeping the query', async () => {
    signedIn();
    const { router } = renderApp('/workflows?search=abc');
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'));
    expect(router.state.location.search).toBe('?search=abc');
    await router.navigate('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'));
  });

  it('the Security shell renders the workflow reviews section', async () => {
    signedIn();
    renderApp('/settings/security');
    expect(await screen.findByRole('heading', { name: 'Security' })).toBeTruthy();
    const toggle = await screen.findByRole('switch', { name: 'Workflow reviews' });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });

  it('the reviews switch is off for an old editor', async () => {
    signedIn().setDemoRole('editor');
    renderApp('/settings/security');
    expect(await screen.findByText('Only admins can change this setting.')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Workflow reviews' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('demo projects', () => {
  beforeEach(() => void signedIn());

  it('a workspace has one team project and the owner a personal one; seeded rows go to the team project, a create with no project to the personal one', async () => {
    const { tenant, user } = backend().auth();
    const team = backend().projects.filter((p) => p.tenantId === tenant.id && p.type === 'team');
    expect(team.map((p) => p.name)).toEqual(['Test Space']);
    const personal = await data<ProjectDetail>('GET', '/projects/personal');
    expect(personal).toMatchObject({ type: 'personal', name: 'Olive Owner' });
    expect(personal.relations).toEqual([
      { id: user.id, email: 'owner@example.com', name: 'Olive Owner', role: 'project:personalOwner' },
    ]);
    expect(personal.scopes).toContain('workflow:create');

    const seeded = backend().seedWorkflow({ name: 'Seeded' });
    expect(seeded.projectId).toBe(team[0].id);
    expect(seeded.homeProject).toEqual({ id: team[0].id, name: 'Test Space', type: 'team', icon: null });
    const created = await data<{ projectId: string }>('POST', '/workflows', {
      name: 'Mine',
      projectId: personal.id,
    });
    expect(created.projectId).toBe(personal.id);
    expect((await call('POST', '/workflows', { name: 'X', projectId: 'nope' })).status).toBe(404);
    const list = await data<Array<{ name: string; homeProject: { type: string } }>>('GET', '/workflows');
    expect(Object.fromEntries(list.map((w) => [w.name, w.homeProject.type]))).toEqual({
      Seeded: 'team',
      Mine: 'personal',
    });

    // P6-39: a create with no project goes to the caller's personal project
    const cred = await data<{ id: string }>('POST', '/credentials', { name: 'C', type: 'crmApi', data: {} });
    const creds = await data<Array<{ id: string; projectId: string }>>('GET', '/credentials', undefined, {
      projectId: personal.id,
    });
    expect(creds.map((c) => c.id)).toEqual([cred.id]);
  });

  it('lists projects for the shell', async () => {
    const mine = await data<Project[]>('GET', '/projects/my-projects');
    expect(mine.map((p) => p.type)).toEqual(['personal', 'team']);
    const page = await data<{ count: number; data: Project[] }>('GET', '/projects', undefined, { take: '1' });
    expect(page.count).toBe(2);
    expect(page.data).toHaveLength(1);
    expect(await data('GET', '/projects/count')).toEqual({ personal: 1, team: 1 });
    const team = mine.find((p) => p.type === 'team')!;
    const detail = await data<ProjectDetail>('GET', `/projects/${team.id}`);
    expect(detail.implicitMembers.map((m) => m.globalRole.slug)).toEqual(['owner']);
  });

  it('the install seed puts its rows in the team project and makes personal projects', () => {
    const demo = new MockBackend();
    seedDemo(demo);
    const tenantId = demo.session!.tenantId;
    const team = demo.oldestTeamProject(tenantId);
    expect(team.name).toBe('Acme Operations');
    expect(demo.workflows.filter((w) => w.tenantId === tenantId).every((w) => w.projectId === team.id)).toBe(
      true,
    );
    expect(demo.credentials.find((c) => c.id === 'cred-crm')?.projectId).toBe(team.id);
    expect(demo.projects.filter((p) => p.tenantId === tenantId && p.type === 'personal')).toHaveLength(2);
  });
});

describe('demo roles, security, variables, members, credentials', () => {
  beforeEach(() => void signedIn());

  it('GET /roles answers the system roles and one custom project role', async () => {
    const roles = await data<RolesMap>('GET', '/roles', undefined, { withUsageCount: 'true' });
    expect(roles.global.map((r) => r.slug)).toEqual(['owner', 'admin', 'member']);
    expect(roles.project.map((r) => [r.slug, r.systemRole])).toEqual([
      ['project:admin', true],
      ['project:editor', true],
      ['project:viewer', true],
      ['project:reviewer', false],
    ]);
    expect(roles.global[0].usedByUsers).toBe(1);
    expect(roles.credential.map((r) => r.slug)).toEqual(['credential:owner', 'credential:user']);
    backend().setDemoRole('viewer');
    expect((await call('GET', '/roles')).status).toBe(200);
  });

  it('/settings/security reads and writes the policy with its counts', async () => {
    expect(await data<SecurityPolicy>('GET', '/settings/security')).toEqual({
      personalSpacePublishing: true,
      personalSpaceSharing: true,
      publishedPersonalWorkflowsCount: 0,
      sharedPersonalWorkflowsCount: 0,
      sharedPersonalCredentialsCount: 0,
      // P6-53 (S3 C0): the workspace's redaction floor, off by default
      redaction: { floor: 'off' },
    });
    const personal = await data<{ id: string }>('GET', '/projects/personal');
    backend().seedWorkflow({ name: 'Live', active: true, projectId: personal.id });
    const next = await data<SecurityPolicy>('POST', '/settings/security', { personalSpaceSharing: false });
    expect(next).toMatchObject({ personalSpaceSharing: false, personalSpacePublishing: true });
    expect(next.publishedPersonalWorkflowsCount).toBe(1);
    expect((await call('POST', '/settings/security', { personalSpaceSharing: 'no' })).status).toBe(400);

    backend().setDemoRole('editor');
    const refused = await call('GET', '/settings/security');
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe(MISSING_SCOPE);
  });

  it('variables honour projectId', async () => {
    const team = backend().oldestTeamProject(backend().auth().tenant.id);
    await data('POST', '/variables', { key: 'global', value: 'g' });
    const pv = await data<{ id: string; projectId: string }>('POST', '/variables', {
      key: 'local',
      value: 'p',
      projectId: team.id,
    });
    expect(pv.projectId).toBe(team.id);
    expect((await data<Array<{ key: string }>>('GET', '/variables')).map((v) => v.key)).toEqual([
      'global',
      'local',
    ]);
    const scoped = await data<Array<{ key: string }>>('GET', '/variables', undefined, { projectId: team.id });
    expect(scoped.map((v) => v.key)).toEqual(['local']);
    expect((await call('POST', '/variables', { key: 'x', value: 'y', projectId: 'nope' })).status).toBe(404);

    // P6-39: a project editor may not make a global variable, and manages the variables of its project
    backend().setDemoRole('editor');
    expect((await call('POST', '/variables', { key: 'e', value: 'e' })).status).toBe(403);
    expect((await call('DELETE', `/variables/${pv.id}`)).status).toBe(200);
  });

  it('member routes take member and a custom global role slug', async () => {
    const { tenant } = backend().auth();
    const other = backend().createAccount({
      email: 'mia@example.com',
      password: 'secret-pass-1',
      name: 'Mia',
      workspaceName: 'Other',
    });
    backend().memberships.push({ tenantId: tenant.id, userId: other.user.id, role: 'admin' });
    expect(
      (await data<{ role: string }>('PATCH', `/members/${other.user.id}`, { role: 'member' })).role,
    ).toBe('member');
    addDemoRole(backend(), {
      tenantId: tenant.id,
      slug: 'global:auditor',
      displayName: 'Auditor',
      description: null,
      systemRole: false,
      roleType: 'global',
      scopes: ['workflow:list'],
    });
    expect(
      (await data<{ role: string }>('PATCH', `/members/${other.user.id}`, { role: 'global:auditor' })).role,
    ).toBe('global:auditor');
    expect((await call('PATCH', `/members/${other.user.id}`, { role: 'global:unknown' })).status).toBe(400);
    const invite = await call('POST', '/members/invite', { email: 'new@example.com', role: 'member' });
    expect(invite.status).toBe(200);

    backend().session = { userId: other.user.id, tenantId: tenant.id };
    const auditor = await me();
    expect(auditor.role).toBe('global:auditor');
    expect(auditor.globalScopes).toEqual(
      expect.arrayContaining(['workflow:list', 'user:list', 'dataTable:list']),
    );
    expect((await call('PATCH', `/members/${other.user.id}`, { role: 'admin' })).status).toBe(403);
  });

  it('the credential PATCH stores isGlobal with credential:shareGlobally', async () => {
    const cred = await data<{ id: string }>('POST', '/credentials', { name: 'C', type: 'crmApi', data: {} });
    await data('PATCH', `/credentials/${cred.id}`, { isGlobal: true });
    const listed = await data<Array<{ id: string; isGlobal?: boolean }>>('GET', '/credentials');
    expect(listed.find((c) => c.id === cred.id)?.isGlobal).toBe(true);
    backend().setDemoRole('editor');
    const refused = await call('PATCH', `/credentials/${cred.id}`, { isGlobal: false });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe(MISSING_SCOPE);
  });
});
