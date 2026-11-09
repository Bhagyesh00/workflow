/**
 * P6-33 security settings (L12): GET and POST /settings/security under `securitySettings:manage`; the
 * personal space publishing and sharing flags (default on) with the counts of what exists; turning a
 * flag off removes the scope from `project:personalOwner` and undoes nothing.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  addToProject,
  createTestServer,
  credentialIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

type Owner = Awaited<ReturnType<typeof signup>>;

const hook = () =>
  node('Webhook', 'core.webhook', { httpMethod: 'POST', path: `p-${randomUUID().slice(0, 8)}` }, [0, 0], {
    webhookId: randomUUID(),
  });

/** a workflow with a trigger saved through the route (it has a version to publish) */
async function savedWorkflow(client: Owner['client'], projectId: string) {
  return client.data<{ id: string }>(
    client.post('/rest/workflows', {
      name: `Flow ${randomUUID().slice(0, 6)}`,
      nodes: [hook()],
      connections: {},
      settings: {},
      projectId,
    }),
  );
}

const teamName = () => `Team ${randomUUID().slice(0, 6)}`;

/** a workspace, a real member and the member's personal project */
async function scene() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const personal = (await server.ctx.repos.projects.getPersonal(owner.tenant.id, member.user.id))!;
  return { owner, member, personal };
}

const scopesOf = (owner: Owner, userId: string, projectId: string) =>
  server.ctx.access.scopesFor(owner.tenant.id, userId, { projectId });

const setPolicy = (owner: Owner, body: Record<string, unknown>) =>
  owner.client.data<Record<string, unknown>>(owner.client.post('/rest/settings/security', body));

describe('GET and POST /settings/security', () => {
  it('answers both flags on and zero counts by default', async () => {
    const owner = await signup(server.app);
    const policy = await owner.client.data(owner.client.get('/rest/settings/security'));
    expect(policy).toEqual({
      personalSpacePublishing: true,
      personalSpaceSharing: true,
      publishedPersonalWorkflowsCount: 0,
      sharedPersonalWorkflowsCount: 0,
      sharedPersonalCredentialsCount: 0,
    });
  });

  it('needs securitySettings:manage: a member is 403 with n8n text', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    for (const res of [
      await member.client.get('/rest/settings/security'),
      await member.client.post('/rest/settings/security', {
        personalSpaceSharing: false,
      }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain(MISSING_SCOPE_MESSAGE);
    }
    const anonymous = await server.app.inject({
      method: 'GET',
      url: '/rest/settings/security',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('a custom global role holding the scope may use it', async () => {
    const owner = await signup(server.app);
    const role = await owner.client.data<{ slug: string }>(
      owner.client.post('/rest/roles', {
        displayName: `Sec ${randomUUID().slice(0, 6)}`,
        roleType: 'global',
        scopes: ['securitySettings:manage'],
      }),
    );
    const member = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, role.slug);
    const res = await member.client.post('/rest/settings/security', {
      personalSpacePublishing: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.personalSpacePublishing).toBe(false);
  });

  it('saves one flag and keeps the other, and an empty body changes nothing', async () => {
    const { owner } = await scene();
    expect(await setPolicy(owner, { personalSpacePublishing: false })).toMatchObject({
      personalSpacePublishing: false,
      personalSpaceSharing: true,
    });
    expect(await setPolicy(owner, { personalSpaceSharing: false })).toMatchObject({
      personalSpacePublishing: false,
      personalSpaceSharing: false,
    });
    expect(await setPolicy(owner, {})).toMatchObject({
      personalSpacePublishing: false,
      personalSpaceSharing: false,
    });
    expect(await setPolicy(owner, { personalSpacePublishing: true })).toMatchObject({
      personalSpacePublishing: true,
      personalSpaceSharing: false,
    });
  });

  it('refuses a value that is not a boolean and keeps the other settings', async () => {
    const owner = await signup(server.app);
    await owner.client.data(owner.client.patch('/rest/settings', { timezone: 'Europe/Berlin' }));
    const bad = await owner.client.post('/rest/settings/security', {
      personalSpaceSharing: 'no',
    });
    expect(bad.statusCode).toBe(400);
    await setPolicy(owner, { personalSpaceSharing: false });
    const settings = await owner.client.data<{
      timezone: string;
      securityPolicy: unknown;
    }>(owner.client.get('/rest/settings'));
    expect(settings.timezone).toBe('Europe/Berlin');
    expect(settings.securityPolicy).toEqual({
      personalSpacePublishing: true,
      personalSpaceSharing: false,
    });
  });

  it('writes an audit entry with the new flags', async () => {
    const { owner } = await scene();
    await setPolicy(owner, { personalSpaceSharing: false });
    const rows = await server.ctx.database.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, owner.tenant.id), eq(auditLog.action, 'tenant.security_policy_updated')),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.user.id);
    expect(rows[0].metadata).toMatchObject({
      personalSpaceSharing: false,
      personalSpacePublishing: true,
    });
  });

  it('does not touch another workspace', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    await setPolicy(a, { personalSpacePublishing: false });
    const other = await b.client.data<{ personalSpacePublishing: boolean }>(
      b.client.get('/rest/settings/security'),
    );
    expect(other.personalSpacePublishing).toBe(true);
  });
});

describe('publishing', () => {
  it('with publishing off a personal project cannot publish; on it can', async () => {
    const { owner, member, personal } = await scene();
    const wf = await savedWorkflow(member.client, personal.id);
    expect((await scopesOf(owner, member.user.id, personal.id)).has('workflow:publish')).toBe(true);

    await setPolicy(owner, { personalSpacePublishing: false });
    expect((await scopesOf(owner, member.user.id, personal.id)).has('workflow:publish')).toBe(false);
    const refused = await member.client.post(`/rest/workflows/${wf.id}/activate`, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(MISSING_SCOPE_MESSAGE);

    await setPolicy(owner, { personalSpacePublishing: true });
    const ok = await member.client.post(`/rest/workflows/${wf.id}/activate`, {});
    expect(ok.statusCode).toBe(200);
  });

  it('a team project is not affected by the personal space flags', async () => {
    const { owner, member } = await scene();
    const team = await projectIn(server, owner.tenant.id, teamName());
    await addToProject(server, owner.tenant.id, team.id, member.user.id, 'project:admin');
    await setPolicy(owner, {
      personalSpacePublishing: false,
      personalSpaceSharing: false,
    });
    const scopes = await scopesOf(owner, member.user.id, team.id);
    expect(scopes.has('workflow:publish')).toBe(true);
    expect(scopes.has('workflow:update')).toBe(true);
  });

  it('turning publishing off does not unpublish what is live', async () => {
    const { owner, member, personal } = await scene();
    const wf = await savedWorkflow(member.client, personal.id);
    expect((await member.client.post(`/rest/workflows/${wf.id}/activate`, {})).statusCode).toBe(200);
    const off = await setPolicy(owner, { personalSpacePublishing: false });
    expect(off.publishedPersonalWorkflowsCount).toBe(1);
    const row = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(row?.active).toBe(true);
    expect(row?.publishedVersionId).not.toBeNull();
  });
});

describe('sharing', () => {
  it('with sharing off a personal project owner holds no share scope; on it does', async () => {
    const { owner, member, personal } = await scene();
    const has = async () => {
      const scopes = await scopesOf(owner, member.user.id, personal.id);
      return [scopes.has('workflow:share'), scopes.has('credential:share')];
    };
    expect(await has()).toEqual([true, true]);
    await setPolicy(owner, { personalSpaceSharing: false });
    expect(await has()).toEqual([false, false]);
    await setPolicy(owner, { personalSpaceSharing: true });
    expect(await has()).toEqual([true, true]);
  });

  it('turning sharing off keeps the existing shares', async () => {
    const { owner, personal } = await scene();
    const team = await projectIn(server, owner.tenant.id, teamName());
    const wf = await workflowIn(server, owner.tenant.id, personal.id);
    await server.ctx.repos.shares.set(owner.tenant.id, 'workflow', wf.id, [team.id]);
    const off = await setPolicy(owner, { personalSpaceSharing: false });
    expect(off.sharedPersonalWorkflowsCount).toBe(1);
    expect(await server.ctx.repos.shares.listForWorkflow(owner.tenant.id, wf.id)).toHaveLength(1);
  });
});

describe('counts', () => {
  it('count published and shared work of personal projects only, each resource once', async () => {
    const { owner, member, personal } = await scene();
    const other = await realMember(owner);
    const otherPersonal = (await server.ctx.repos.projects.getPersonal(owner.tenant.id, other.user.id))!;
    const team = await projectIn(server, owner.tenant.id, teamName());
    const team2 = await projectIn(server, owner.tenant.id, teamName());
    const { repos } = server.ctx;
    const tenantId = owner.tenant.id;

    const published = await savedWorkflow(member.client, personal.id);
    await workflowIn(server, tenantId, personal.id);
    const sharedTwice = await workflowIn(server, tenantId, otherPersonal.id);
    const sharedIntoPersonal = await workflowIn(server, tenantId, team.id);
    const teamPublished = await savedWorkflow(owner.client, team.id);
    await member.client.data(member.client.post(`/rest/workflows/${published.id}/activate`, {}));
    await owner.client.data(owner.client.post(`/rest/workflows/${teamPublished.id}/activate`, {}));
    await repos.shares.set(tenantId, 'workflow', sharedTwice.id, [team.id, team2.id]);
    await repos.shares.set(tenantId, 'workflow', sharedIntoPersonal.id, [personal.id]);

    const sharedCredential = await credentialIn(server, tenantId, personal.id);
    await credentialIn(server, tenantId, personal.id);
    const teamCredential = await credentialIn(server, tenantId, team.id);
    await repos.shares.set(tenantId, 'credential', sharedCredential.id, [team.id, team2.id]);
    await repos.shares.set(tenantId, 'credential', teamCredential.id, [personal.id]);

    const expected = {
      publishedPersonalWorkflowsCount: 1,
      sharedPersonalWorkflowsCount: 1,
      sharedPersonalCredentialsCount: 1,
    };
    const policy = await owner.client.data(owner.client.get('/rest/settings/security'));
    expect(policy).toMatchObject(expected);
    await expect(server.ctx.securitySettings.counts(tenantId)).resolves.toEqual(expected);
  });

  it('count only the callers workspace', async () => {
    const a = await scene();
    const b = await scene();
    const team = await projectIn(server, a.owner.tenant.id, teamName());
    const wf = await workflowIn(server, a.owner.tenant.id, a.personal.id);
    await server.ctx.repos.shares.set(a.owner.tenant.id, 'workflow', wf.id, [team.id]);
    const mine = await a.owner.client.data<{
      sharedPersonalWorkflowsCount: number;
    }>(a.owner.client.get('/rest/settings/security'));
    const theirs = await b.owner.client.data<{
      sharedPersonalWorkflowsCount: number;
    }>(b.owner.client.get('/rest/settings/security'));
    expect(mine.sharedPersonalWorkflowsCount).toBe(1);
    expect(theirs.sharedPersonalWorkflowsCount).toBe(0);
  });
});
