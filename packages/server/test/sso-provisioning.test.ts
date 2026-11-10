/**
 * P6-11 (L9): role provisioning from the identity provider. Claim mode and rule mode, the default condition
 * (a role or block), the owner who never changes, a bad expression that is false, the order of the rules and
 * their move, the tenant bound of the rules, the locks while a scope is managed, the role that a rule gives
 * cannot be deleted, a project from another workspace refused, a claim that lowers a role calls
 * `onRoleChange` and `afterAccessChange` (spies: L5 and L14 fill them), and the whole path through the
 * OIDC and the SAML identity provider fakes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/http/errors';
import { ruleExpressionProblem, ruleMatches } from '../src/services/sso/role-rules';
import { type FakeOidcIdp, startFakeOidcIdp } from './fakes/oidc-idp';
import { FakeSamlIdp } from './fakes/saml-idp';
import {
  BASE_URL,
  signup as baseSignup,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  sessionFor,
  ssoOn,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { startMain: false, allowInsecureIdp: true },
  );
}, 120_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  vi.restoreAllMocks();
});

let ip = 1;
/** signup allows 20 calls an hour per IP: each call comes from its own address */
const signup = () =>
  baseSignup(server.app, {
    remoteAddress: `127.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    projects: 'real',
  });

type Owner = Awaited<ReturnType<typeof signup>>;

const suffix = () => randomUUID().slice(0, 8);

/** the claim-mode config of a workspace, saved through the route */
async function configure(owner: Owner, body: Record<string, unknown>) {
  return owner.client.data(owner.client.patch('/rest/sso/provisioning/config', body));
}

/** turns OIDC on for the workspace and saves the provisioning config in the same step (no config route) */
async function oidcOn(owner: Owner, provisioning: Record<string, unknown> = {}) {
  return ssoOn(server, owner.tenant.id, 'oidc', { provisioning });
}

async function signIn(owner: Owner, email: string, claims: Record<string, unknown> = {}) {
  const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id))!;
  return server.ctx.ssoLogin.signIn(
    tenant,
    {
      providerType: 'oidc',
      providerId: `sub-${email}`,
      email,
      emailVerified: true,
      claims: claims as never,
    },
    { ip: '10.9.9.9' },
    { authMethod: 'oidc' },
  );
}

const roleOf = async (owner: Owner, userId: string) =>
  (await server.ctx.repos.memberships.get(owner.tenant.id, userId))?.role;

const newEmail = (tag: string) => `${tag}-${suffix()}@example.com`;

async function customGlobalRole(owner: Owner, displayName = `Provisioned ${suffix()}`) {
  return owner.client.data<{ slug: string }>(
    owner.client.post('/rest/roles', { displayName, roleType: 'global', scopes: ['variable:list'] }),
  );
}

async function expectRefused(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describe('the expression language', () => {
  it('matches only true or "true"; an error is false; the dry run finds a syntax error', () => {
    expect(ruleMatches("{{ $claims.groups.includes('admins') }}", { groups: ['admins'] })).toBe(true);
    expect(ruleMatches("{{ $claims.groups.includes('admins') }}", { groups: ['users'] })).toBe(false);
    expect(ruleMatches('{{ $claims.missing.deep.value }}', {})).toBe(false);
    expect(ruleMatches('{{ $claims.name }}', { name: 'true' })).toBe(true);
    expect(ruleMatches('{{ 1 }}', {})).toBe(false);
    expect(ruleMatches('{{ ( }}', {})).toBe(false);
    expect(ruleMatches('x'.repeat(2001), {})).toBe(false);
    expect(ruleExpressionProblem('{{ ( }}')).toMatch(/syntax/i);
    expect(ruleExpressionProblem('x'.repeat(2001))).toMatch(/2000/);
    expect(ruleExpressionProblem("{{ $claims.groups.includes('a') }}")).toBeUndefined();
  });
});

describe('the config', () => {
  it('answers our defaults, saves, audits and refuses a member', async () => {
    const owner = await signup();
    const first = await owner.client.data(owner.client.get('/rest/sso/provisioning/config'));
    expect(first).toEqual({
      scopesProvisionInstanceRole: false,
      scopesProvisionProjectRoles: false,
      scopesUseExpressionMapping: false,
      scopesName: 'workflow',
      scopesInstanceRoleClaimName: 'instance_role',
      scopesProjectsRolesClaimName: 'projects',
      defaultInstanceRole: null,
    });
    const saved = await configure(owner, {
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: true,
      scopesInstanceRoleClaimName: 'wf_role',
      defaultInstanceRole: 'block',
    });
    expect(saved).toMatchObject({
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: true,
      scopesInstanceRoleClaimName: 'wf_role',
      defaultInstanceRole: 'block',
    });
    expect(await owner.client.data(owner.client.get('/rest/sso/provisioning/config'))).toEqual(saved);
    const audits = (await server.ctx.repos.audit.list(owner.tenant.id, 50)).filter(
      (row) => row.action === 'provisioning.updated',
    );
    expect(audits.length).toBe(1);

    const member = await realMember(owner);
    expect((await member.client.get('/rest/sso/provisioning/config')).statusCode).toBe(403);
    expect((await member.client.patch('/rest/sso/provisioning/config', {})).statusCode).toBe(403);
    expect((await member.client.get('/rest/sso/role-mapping-rules')).statusCode).toBe(403);
  });

  it('refuses project roles without workspace roles, an owner default and a bad claim name', async () => {
    const owner = await signup();
    const noInstance = await owner.client.patch('/rest/sso/provisioning/config', {
      scopesProvisionProjectRoles: true,
    });
    expect(noInstance.statusCode).toBe(400);
    const ownerDefault = await owner.client.patch('/rest/sso/provisioning/config', {
      scopesProvisionInstanceRole: true,
      defaultInstanceRole: 'owner',
    });
    expect(ownerDefault.statusCode).toBe(400);
    const unknown = await owner.client.patch('/rest/sso/provisioning/config', {
      defaultInstanceRole: 'global:nope',
    });
    expect(unknown.statusCode).toBe(400);
    const blank = await owner.client.patch('/rest/sso/provisioning/config', {
      scopesInstanceRoleClaimName: '  ',
    });
    expect(blank.statusCode).toBe(400);
    // nothing was saved
    expect(await owner.client.data(owner.client.get('/rest/sso/provisioning/config'))).toMatchObject({
      scopesProvisionInstanceRole: false,
      defaultInstanceRole: null,
    });
  });

  it('turning workspace roles off turns project roles off too, and turning project roles off deletes the project rules', async () => {
    const owner = await signup();
    const project = await projectIn(server, owner.tenant.id, `P ${suffix()}`);
    await configure(owner, {
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: true,
      scopesUseExpressionMapping: true,
    });
    await owner.client.data(
      owner.client.post('/rest/sso/role-mapping-rules', {
        type: 'project',
        expression: '{{ true }}',
        role: 'project:editor',
        projectIds: [project.id],
      }),
    );
    await owner.client.data(
      owner.client.post('/rest/sso/role-mapping-rules', {
        type: 'instance',
        expression: '{{ true }}',
        role: 'admin',
      }),
    );
    const off = await configure(owner, { scopesProvisionInstanceRole: false });
    expect(off).toMatchObject({ scopesProvisionInstanceRole: false, scopesProvisionProjectRoles: false });
    const rules = await owner.client.data<Array<{ type: string }>>(
      owner.client.get('/rest/sso/role-mapping-rules'),
    );
    expect(rules.map((rule) => rule.type)).toEqual(['instance']);
    const audit = (await server.ctx.repos.audit.list(owner.tenant.id, 50)).find(
      (row) => row.action === 'provisioning.updated' && (row.metadata as any)?.projectRulesDeleted,
    );
    expect(audit).toBeTruthy();
  });
});

describe('claim mode, workspace roles', () => {
  it('a claim sets the role of a new person and of a member, audited as provisioning', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    await oidcOn(owner, { scopesProvisionInstanceRole: true });

    const fresh = newEmail('new');
    const created = await signIn(owner, fresh, { instance_role: 'admin' });
    expect(await roleOf(owner, created.user.id)).toBe('admin');
    const changed = (await server.ctx.repos.audit.list(owner.tenant.id, 100)).find(
      (row) => row.action === 'member.role_changed' && row.resourceId === created.user.id,
    );
    expect((changed?.metadata as any)?.source).toBe('provisioning');

    await signIn(owner, member.email, { instance_role: 'admin' });
    expect(await roleOf(owner, member.user.id)).toBe('admin');
  });

  it("a custom global role works; the claim names are the workspace's own", async () => {
    const owner = await signup();
    const role = await customGlobalRole(owner);
    const member = await realMember(owner);
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesInstanceRoleClaimName: 'wf_role' });
    await signIn(owner, member.email, { instance_role: 'admin' });
    expect(await roleOf(owner, member.user.id)).toBe('member');
    await signIn(owner, member.email, { wf_role: role.slug });
    expect(await roleOf(owner, member.user.id)).toBe(role.slug);
  });

  it('a claim that lowers a role calls onRoleChange and afterAccessChange', async () => {
    const owner = await signup();
    const admin = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, admin.user.id, 'admin');
    await oidcOn(owner, { scopesProvisionInstanceRole: true });
    const onRoleChange = vi.spyOn(server.ctx.apiKeys, 'onRoleChange');
    const afterAccessChange = vi.spyOn(server.ctx.privateCredentials, 'afterAccessChange');
    await signIn(owner, admin.email, { instance_role: 'member' });
    expect(await roleOf(owner, admin.user.id)).toBe('member');
    expect(onRoleChange).toHaveBeenCalledWith(owner.tenant.id, admin.user.id, 'member');
    expect(afterAccessChange).toHaveBeenCalledWith(owner.tenant.id, { userId: admin.user.id });
  });

  it('an unknown role goes to the default condition: a role, nothing, or block', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, 'admin');
    await oidcOn(owner, { scopesProvisionInstanceRole: true });
    // no default: the role stays
    await signIn(owner, member.email, { instance_role: 'wizard' });
    expect(await roleOf(owner, member.user.id)).toBe('admin');
    // default role
    await configure(owner, { defaultInstanceRole: 'member' });
    await signIn(owner, member.email, { instance_role: 'wizard' });
    expect(await roleOf(owner, member.user.id)).toBe('member');
    // an owner claim does not pass a block
    await configure(owner, { defaultInstanceRole: 'block' });
    await expectRefused(signIn(owner, member.email, { instance_role: 'owner' }), 'sso_access_blocked');
    expect(await roleOf(owner, member.user.id)).toBe('member');
  });

  it('a blocked person cannot sign in and no account is made', async () => {
    const owner = await signup();
    await oidcOn(owner, { scopesProvisionInstanceRole: true, defaultInstanceRole: 'block' });
    const email = newEmail('blocked');
    await expectRefused(signIn(owner, email, {}), 'sso_access_blocked');
    const { rows } = await server.ctx.database.pool.query(
      'select count(*)::int as n from users where email = $1',
      [email],
    );
    expect(rows[0].n).toBe(0);
    const failed = (await server.ctx.repos.audit.list(owner.tenant.id, 50)).find(
      (row) => row.action === 'auth.sso_login_failed',
    );
    expect((failed?.metadata as any)?.reason).toBe('sso_access_blocked');
    // a person the claim names is not blocked
    const ok = await signIn(owner, email, { instance_role: 'member' });
    expect(await roleOf(owner, ok.user.id)).toBe('member');
  });

  it('the owner is never changed or blocked, and a claim never makes an owner', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    await oidcOn(owner, { scopesProvisionInstanceRole: true, defaultInstanceRole: 'block' });
    await signIn(owner, owner.user.email, { instance_role: 'member' });
    expect(await roleOf(owner, owner.user.id)).toBe('owner');
    await signIn(owner, owner.user.email, {});
    expect(await roleOf(owner, owner.user.id)).toBe('owner');
    await expectRefused(signIn(owner, member.email, { instance_role: 'owner' }), 'sso_access_blocked');
    expect(await roleOf(owner, member.user.id)).toBe('member');
  });

  it('the last owner stays an owner when the decision would change it', async () => {
    const owner = await signup();
    await oidcOn(owner, { scopesProvisionInstanceRole: true });
    const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id))!;
    await server.ctx.provisioning.apply(tenant.id, owner.user.id, { blocked: false, instanceRole: 'member' });
    expect(await roleOf(owner, owner.user.id)).toBe('owner');
  });
});

describe('claim mode, project roles', () => {
  it('replaces the project roles with the claim; the last entry of a project wins; other workspaces are skipped', async () => {
    const owner = await signup();
    const other = await signup();
    const member = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, `A ${suffix()}`);
    const b = await projectIn(server, owner.tenant.id, `B ${suffix()}`);
    const foreign = await projectIn(server, other.tenant.id, `F ${suffix()}`);
    await server.ctx.repos.projects.relations.add(owner.tenant.id, a.id, member.user.id, 'project:viewer');
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
    const afterAccessChange = vi.spyOn(server.ctx.privateCredentials, 'afterAccessChange');

    await signIn(owner, member.email, {
      instance_role: 'member',
      projects: [
        `${b.id}:project:viewer`,
        `${b.id}:project:editor`,
        `${foreign.id}:project:admin`,
        'not-a-project:project:admin',
        `${a.id}:superhero`,
      ],
    });
    const relations = await server.ctx.repos.projects.relations.listForUser(owner.tenant.id, member.user.id);
    const team = relations.filter((relation) => relation.role !== 'project:personalOwner');
    expect(team.map((relation) => [relation.projectId, relation.role])).toEqual([[b.id, 'project:editor']]);
    expect(
      await server.ctx.repos.projects.relations.get(other.tenant.id, foreign.id, member.user.id),
    ).toBeUndefined();
    expect(afterAccessChange).toHaveBeenCalledWith(owner.tenant.id, {
      userId: member.user.id,
      projectId: a.id,
    });
    expect(afterAccessChange).toHaveBeenCalledWith(owner.tenant.id, {
      userId: member.user.id,
      projectId: b.id,
    });
    // the personal project stays
    expect(relations.some((relation) => relation.role === 'project:personalOwner')).toBe(true);
  });

  it('an empty claim takes the project roles away; a bare role name and a comma list are read', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, `A ${suffix()}`);
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
    await signIn(owner, member.email, { instance_role: 'member', projects: `${a.id}:editor` });
    expect((await server.ctx.repos.projects.relations.get(owner.tenant.id, a.id, member.user.id))?.role).toBe(
      'project:editor',
    );
    await signIn(owner, member.email, { instance_role: 'member' });
    expect(
      await server.ctx.repos.projects.relations.get(owner.tenant.id, a.id, member.user.id),
    ).toBeUndefined();
  });
});

describe('rule mode', () => {
  const rule = (owner: Owner, body: Record<string, unknown>) =>
    owner.client.post('/rest/sso/role-mapping-rules', body);

  it('the first match wins; a missing claim and a bad expression are false; the default condition follows', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    const role = await customGlobalRole(owner);
    await oidcOn(owner, {
      scopesProvisionInstanceRole: true,
      scopesUseExpressionMapping: true,
      defaultInstanceRole: 'block',
    });
    await owner.client.data(
      rule(owner, {
        type: 'instance',
        expression: "{{ $claims.groups.includes('wf-admins') }}",
        role: 'admin',
      }),
    );
    await owner.client.data(
      rule(owner, {
        type: 'instance',
        expression: "{{ $claims.groups.includes('wf-staff') }}",
        role: role.slug,
      }),
    );
    await owner.client.data(
      rule(owner, {
        type: 'instance',
        expression: "{{ $claims.groups.includes('wf-staff') }}",
        role: 'admin',
      }),
    );

    await signIn(owner, member.email, { groups: ['wf-staff', 'wf-admins'] });
    expect(await roleOf(owner, member.user.id)).toBe('admin');
    await signIn(owner, member.email, { groups: ['wf-staff'] });
    expect(await roleOf(owner, member.user.id)).toBe(role.slug);
    // no claim at all: the expression throws, which is false, so the default (block) decides
    await expectRefused(signIn(owner, member.email, {}), 'sso_access_blocked');
    await expectRefused(signIn(owner, member.email, { groups: ['other'] }), 'sso_access_blocked');
    expect(await roleOf(owner, member.user.id)).toBe(role.slug);
  });

  it('refuses a syntax error, a long expression, an owner rule and an unknown role at save', async () => {
    const owner = await signup();
    const syntax = await rule(owner, { type: 'instance', expression: '{{ ( }}', role: 'admin' });
    expect(syntax.statusCode).toBe(400);
    const long = await rule(owner, { type: 'instance', expression: 'x'.repeat(2001), role: 'admin' });
    expect(long.statusCode).toBe(400);
    const ownerRule = await rule(owner, { type: 'instance', expression: '{{ true }}', role: 'owner' });
    expect(ownerRule.statusCode).toBe(400);
    const unknown = await rule(owner, { type: 'instance', expression: '{{ true }}', role: 'global:nope' });
    expect(unknown.statusCode).toBe(400);
    const projectRole = await rule(owner, {
      type: 'instance',
      expression: '{{ true }}',
      role: 'project:editor',
    });
    expect(projectRole.statusCode).toBe(400);
    const instanceWithProjects = await rule(owner, {
      type: 'instance',
      expression: '{{ true }}',
      role: 'admin',
      projectIds: [randomUUID()],
    });
    expect(instanceWithProjects.statusCode).toBe(400);
    const noProjects = await rule(owner, {
      type: 'project',
      expression: '{{ true }}',
      role: 'project:editor',
    });
    expect(noProjects.statusCode).toBe(400);
    expect((await server.ctx.repos.roleMapping.list(owner.tenant.id)).length).toBe(0);
  });

  it('orders are unique per type, appended, clamped, moved and renumbered', async () => {
    const owner = await signup();
    const project = await projectIn(server, owner.tenant.id, `P ${suffix()}`);
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const made = await owner.client.data(
        rule(owner, { type: 'instance', expression: `{{ $claims.n === ${n} }}`, role: 'member' }),
      );
      expect(made.order).toBe(n - 1);
      ids.push(made.id);
    }
    const projectRule = await owner.client.data(
      rule(owner, {
        type: 'project',
        expression: '{{ true }}',
        role: 'project:viewer',
        projectIds: [project.id],
      }),
    );
    // its own list starts at 0
    expect(projectRule.order).toBe(0);
    expect(projectRule.projectIds).toEqual([project.id]);

    const moved = await owner.client.data<Array<{ id: string; order: number }>>(
      owner.client.post(`/rest/sso/role-mapping-rules/${ids[3]}/move`, { position: 0 }),
    );
    expect(moved.map((r) => r.id)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    expect(moved.map((r) => r.order)).toEqual([0, 1, 2, 3]);
    // a position past the end is the end
    const last = await owner.client.data<Array<{ id: string }>>(
      owner.client.post(`/rest/sso/role-mapping-rules/${ids[3]}/move`, { position: 99 }),
    );
    expect(last.map((r) => r.id)).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    // deleting leaves a gap; a new rule goes after the last one
    await owner.client.data(owner.client.delete(`/rest/sso/role-mapping-rules/${ids[1]}`));
    const appended = await owner.client.data(
      rule(owner, { type: 'instance', expression: '{{ true }}', role: 'member' }),
    );
    expect(appended.order).toBeGreaterThan(2);
    const list = await owner.client.data<Array<{ id: string; type: string }>>(
      owner.client.get('/rest/sso/role-mapping-rules'),
    );
    expect(list.map((r) => r.type)).toEqual(['instance', 'instance', 'instance', 'instance', 'project']);
    expect(list.at(-2)?.id).toBe(appended.id);
  });

  it('a rule patch changes the expression, role and projects, never the type', async () => {
    const owner = await signup();
    const a = await projectIn(server, owner.tenant.id, `A ${suffix()}`);
    const b = await projectIn(server, owner.tenant.id, `B ${suffix()}`);
    const made = await owner.client.data(
      rule(owner, { type: 'project', expression: '{{ true }}', role: 'project:viewer', projectIds: [a.id] }),
    );
    const patched = await owner.client.data(
      owner.client.patch(`/rest/sso/role-mapping-rules/${made.id}`, {
        expression: "{{ $claims.team === 'x' }}",
        role: 'project:editor',
        projectIds: [a.id, b.id],
      }),
    );
    expect(patched).toMatchObject({ role: 'project:editor', order: 0 });
    expect([...patched.projectIds].sort()).toEqual([a.id, b.id].sort());
    expect(
      (await owner.client.patch(`/rest/sso/role-mapping-rules/${made.id}`, { type: 'instance' })).statusCode,
    ).toBe(400);
    expect(
      (await owner.client.patch(`/rest/sso/role-mapping-rules/${made.id}`, { role: 'admin' })).statusCode,
    ).toBe(400);
    expect(
      (await owner.client.patch(`/rest/sso/role-mapping-rules/${made.id}`, { projectIds: [] })).statusCode,
    ).toBe(400);
  });

  it('project rules give the first matching role per project and replace the project roles', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, `A ${suffix()}`);
    const b = await projectIn(server, owner.tenant.id, `B ${suffix()}`);
    await oidcOn(owner, {
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: true,
      scopesUseExpressionMapping: true,
    });
    await owner.client.data(rule(owner, { type: 'instance', expression: '{{ true }}', role: 'member' }));
    await owner.client.data(
      rule(owner, {
        type: 'project',
        expression: "{{ $claims.teams.includes('red') }}",
        role: 'project:admin',
        projectIds: [a.id],
      }),
    );
    await owner.client.data(
      rule(owner, {
        type: 'project',
        expression: "{{ $claims.teams.includes('red') || $claims.teams.includes('blue') }}",
        role: 'project:viewer',
        projectIds: [a.id, b.id],
      }),
    );
    await signIn(owner, member.email, { teams: ['red'] });
    const get = (projectId: string) =>
      server.ctx.repos.projects.relations.get(owner.tenant.id, projectId, member.user.id);
    expect((await get(a.id))?.role).toBe('project:admin');
    expect((await get(b.id))?.role).toBe('project:viewer');
    await signIn(owner, member.email, { teams: ['blue'] });
    expect((await get(a.id))?.role).toBe('project:viewer');
    await signIn(owner, member.email, { teams: [] });
    expect(await get(a.id)).toBeUndefined();
    expect(await get(b.id)).toBeUndefined();
  });

  it('admins reach every team project, so no project relation is written for them', async () => {
    const owner = await signup();
    const person = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, `A ${suffix()}`);
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
    await signIn(owner, person.email, { instance_role: 'admin', projects: [`${a.id}:project:editor`] });
    expect(await roleOf(owner, person.user.id)).toBe('admin');
    expect(
      await server.ctx.repos.projects.relations.get(owner.tenant.id, a.id, person.user.id),
    ).toBeUndefined();
  });
});

describe('tenants', () => {
  it('a rule of workspace A is unseen in B, and B cannot read, change, move or delete it', async () => {
    const a = await signup();
    const b = await signup();
    const made = await a.client.data(
      a.client.post('/rest/sso/role-mapping-rules', {
        type: 'instance',
        expression: '{{ true }}',
        role: 'admin',
      }),
    );
    expect(await b.client.data(b.client.get('/rest/sso/role-mapping-rules'))).toEqual([]);
    expect(
      (await b.client.patch(`/rest/sso/role-mapping-rules/${made.id}`, { role: 'member' })).statusCode,
    ).toBe(404);
    expect(
      (await b.client.post(`/rest/sso/role-mapping-rules/${made.id}/move`, { position: 0 })).statusCode,
    ).toBe(404);
    expect((await b.client.delete(`/rest/sso/role-mapping-rules/${made.id}`)).statusCode).toBe(404);
    expect(await server.ctx.repos.roleMapping.get(b.tenant.id, made.id)).toBeUndefined();
    expect(await server.ctx.repos.roleMapping.get(a.tenant.id, made.id)).toBeTruthy();
    // and B's sign-in never reads A's rules
    await oidcOn(b, {
      scopesProvisionInstanceRole: true,
      scopesUseExpressionMapping: true,
      defaultInstanceRole: 'block',
    });
    await expectRefused(signIn(b, newEmail('b'), {}), 'sso_access_blocked');
  });

  it('a project of another workspace is refused by the route (404) and by the foreign key', async () => {
    const a = await signup();
    const b = await signup();
    const foreign = await projectIn(server, b.tenant.id, `F ${suffix()}`);
    const res = await a.client.post('/rest/sso/role-mapping-rules', {
      type: 'project',
      expression: '{{ true }}',
      role: 'project:editor',
      projectIds: [foreign.id],
    });
    expect(res.statusCode).toBe(404);
    await expect(
      server.ctx.repos.roleMapping.create(a.tenant.id, {
        type: 'project',
        expression: '{{ true }}',
        role: 'project:editor',
        projectIds: [foreign.id],
      }),
    ).rejects.toThrow();
    expect(await server.ctx.repos.roleMapping.list(a.tenant.id)).toEqual([]);
    // a personal project is no team project either
    const personal = (await server.ctx.repos.projects.relations.listForUser(a.tenant.id, a.user.id)).find(
      (relation) => relation.role === 'project:personalOwner',
    )!;
    const personalRule = await a.client.post('/rest/sso/role-mapping-rules', {
      type: 'project',
      expression: '{{ true }}',
      role: 'project:editor',
      projectIds: [personal.projectId],
    });
    expect(personalRule.statusCode).toBe(404);
  });
});

describe('managed roles', () => {
  it('manual role edits are refused while a scope is managed by a provider, and free otherwise', async () => {
    const owner = await signup();
    const member = await realMember(owner);
    // email sign-in: nothing is managed even with the flags on
    await configure(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
    await expect(
      server.ctx.provisioning.assertInstanceRolesEditable(owner.tenant.id),
    ).resolves.toBeUndefined();
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: false });
    await expectRefused(
      server.ctx.provisioning.assertInstanceRolesEditable(owner.tenant.id),
      'roles_managed_by_sso',
    );
    await expect(
      server.ctx.provisioning.assertProjectRolesEditable(owner.tenant.id),
    ).resolves.toBeUndefined();
    const refused = await owner.client.patch(`/rest/members/${member.user.id}`, { role: 'admin' });
    expect(refused.statusCode).toBe(400);
    expect(await roleOf(owner, member.user.id)).toBe('member');
    await oidcOn(owner, { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
    await expectRefused(
      server.ctx.provisioning.assertProjectRolesEditable(owner.tenant.id),
      'roles_managed_by_sso',
    );
    const project = await projectIn(server, owner.tenant.id, `P ${suffix()}`);
    const add = await owner.client.post(`/rest/projects/${project.id}/users`, {
      relations: [{ userId: member.user.id, role: 'project:editor' }],
    });
    expect(add.statusCode).toBe(400);
  });
});

describe('deleting a role and moving its holders', () => {
  it('is refused while workspace roles are provisioned, and free of the lock otherwise', async () => {
    const owner = await signup();
    const role = await owner.client.data<{ slug: string }>(
      owner.client.post('/rest/roles', {
        displayName: `Ops ${suffix()}`,
        roleType: 'global',
        scopes: ['user:list'],
      }),
    );
    const holder = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, holder.user.id, role.slug);
    await oidcOn(owner, { scopesProvisionInstanceRole: true });
    const refused = await owner.client.delete(
      `/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=member`,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('roles_managed_by_sso');
    expect(await roleOf(owner, holder.user.id)).toBe(role.slug);
    expect(await server.ctx.repos.roles.get(owner.tenant.id, role.slug)).toBeDefined();
  });

  it('strips the key scopes, cleans private credentials and audits each member moved', async () => {
    const owner = await signup();
    const role = await owner.client.data<{ slug: string }>(
      owner.client.post('/rest/roles', {
        displayName: `Ops ${suffix()}`,
        roleType: 'global',
        scopes: ['user:list', 'user:changeRole'],
      }),
    );
    const holder = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, holder.user.id, role.slug);
    const key = await server.ctx.repos.apiKeys.create({
      tenantId: owner.tenant.id,
      userId: holder.user.id,
      name: `key-${suffix()}`,
      prefix: 'abcd1234',
      keyHash: randomUUID(),
      scopes: ['user:list', 'user:changeRole'],
      audience: 'public-api',
    });
    const afterAccessChange = vi.spyOn(server.ctx.privateCredentials, 'afterAccessChange');
    const ok = await owner.client.delete(
      `/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=member`,
    );
    expect(ok.statusCode).toBe(200);
    expect(await roleOf(owner, holder.user.id)).toBe('member');
    const keys = await server.ctx.repos.apiKeys.list(owner.tenant.id, holder.user.id);
    expect(keys.find((row) => row.id === key.id)?.scopes).toEqual(['user:list']);
    expect(afterAccessChange).toHaveBeenCalledWith(owner.tenant.id, { userId: holder.user.id });
    const changed = (await server.ctx.repos.audit.list(owner.tenant.id, 100)).find(
      (row) => row.action === 'member.role_changed' && row.resourceId === holder.user.id,
    );
    expect(changed?.metadata).toMatchObject({ from: role.slug, to: 'member' });
  });
});

describe('deleting a role that a rule gives', () => {
  it('is a 409 that names the rules and the default condition, until they are gone', async () => {
    const owner = await signup();
    const role = await customGlobalRole(owner);
    const made = await owner.client.data(
      owner.client.post('/rest/sso/role-mapping-rules', {
        type: 'instance',
        expression: '{{ true }}',
        role: role.slug,
      }),
    );
    const blocked = await owner.client.delete(`/rest/roles/${role.slug}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain(made.id);
    expect(await server.ctx.repos.roles.get(owner.tenant.id, role.slug)).toBeTruthy();

    await owner.client.data(owner.client.delete(`/rest/sso/role-mapping-rules/${made.id}`));
    await configure(owner, { defaultInstanceRole: role.slug });
    const byDefault = await owner.client.delete(`/rest/roles/${role.slug}`);
    expect(byDefault.statusCode).toBe(409);
    expect(byDefault.json().error.message).toContain('default condition');
    expect(await server.ctx.provisioning.ruleBlockers(owner.tenant.id, role.slug)).toEqual([
      { id: 'default', type: 'instance', expression: 'default condition' },
    ]);

    await configure(owner, { defaultInstanceRole: null });
    expect((await owner.client.delete(`/rest/roles/${role.slug}`)).statusCode).toBe(200);
    // the service call with an actor behaves the same
    const session = await sessionFor(server, owner.tenant.id, owner.user.id);
    const other = await customGlobalRole(owner);
    await owner.client.data(
      owner.client.post('/rest/sso/role-mapping-rules', {
        type: 'instance',
        expression: '{{ true }}',
        role: other.slug,
      }),
    );
    await expectRefused(
      server.ctx.roles.delete(owner.tenant.id, other.slug, { actor: session.auth }),
      'conflict',
    );
  });
});

describe('through the identity provider fakes', () => {
  let oidc: FakeOidcIdp | undefined;
  let saml: FakeSamlIdp | undefined;
  afterAll(async () => {
    await oidc?.close();
    await saml?.close();
  });

  it('OIDC: a claim of the id token sets the role', async () => {
    oidc = await startFakeOidcIdp();
    const owner = await signup();
    const member = await realMember(owner);
    const saved = await owner.client.post('/rest/sso/oidc/config', {
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      discoveryEndpoint: oidc.discoveryUrl,
      loginEnabled: true,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await configure(owner, { scopesProvisionInstanceRole: true, defaultInstanceRole: 'block' });

    const visit = async (extra: Record<string, unknown>) => {
      const login = await server.app.inject({ method: 'GET', url: `/sso/oidc/${owner.tenant.slug}/login` });
      expect(login.statusCode).toBe(302);
      const cookies = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const query = oidc!.authorize(String(login.headers.location), {
        person: { sub: `sub-${member.email}`, email: member.email, email_verified: true, extra },
      });
      return server.app.inject({
        method: 'GET',
        url: `/sso/oidc/${owner.tenant.slug}/callback?${new URLSearchParams(query).toString()}`,
        headers: { cookie: cookies },
      });
    };
    const ok = await visit({ instance_role: 'admin' });
    expect(ok.statusCode).toBe(302);
    expect(String(ok.headers.location)).not.toContain('ssoError');
    expect(await roleOf(owner, member.user.id)).toBe('admin');
    const refused = await visit({});
    expect(String(refused.headers.location)).toContain('ssoError=sso_access_blocked');
    expect(await roleOf(owner, member.user.id)).toBe('admin');
  });

  it('SAML: a blocked person gets no session; an attribute rule sets the role', async () => {
    saml = await FakeSamlIdp.start();
    const owner = await signup();
    const member = await realMember(owner);
    await owner.client.data(owner.client.post('/rest/sso/saml/config', { metadata: saml.metadata() }));
    await owner.client.data(owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true }));
    await configure(owner, {
      scopesProvisionInstanceRole: true,
      scopesUseExpressionMapping: true,
      defaultInstanceRole: 'block',
    });
    await owner.client.data(
      owner.client.post('/rest/sso/role-mapping-rules', {
        type: 'instance',
        expression: "{{ $claims.department === 'ops' }}",
        role: 'admin',
      }),
    );
    const sp = {
      entityId: `${BASE_URL}/sso/saml/${owner.tenant.slug}/metadata`,
      acsUrl: `${BASE_URL}/sso/saml/${owner.tenant.slug}/acs`,
    };
    const post = (department: string) =>
      server.app.inject({
        method: 'POST',
        url: `/sso/saml/${owner.tenant.slug}/acs`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(
          saml!.postResponse({
            sp,
            user: { email: member.email, firstName: 'Sam', lastName: 'Lee', attributes: { department } },
          }),
        ).toString(),
      });
    const blocked = await post('sales');
    expect(blocked.statusCode).toBe(302);
    expect(String(blocked.headers.location)).toContain('ssoError=sso_access_blocked');
    expect(blocked.cookies.find((c) => c.name === 'wf_session')?.value).toBeFalsy();
    expect(await roleOf(owner, member.user.id)).toBe('member');
    const ok = await post('ops');
    expect(ok.cookies.find((c) => c.name === 'wf_session')?.value).toBeTruthy();
    expect(await roleOf(owner, member.user.id)).toBe('admin');
  });
});
