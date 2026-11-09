/**
 * P6-39 (L24), the role cutover: the old workspace words `editor` and `viewer` are gone. Migration 0024 turned
 * the stored ones into `member` plus that role on the team project, a pending invitation that still holds one
 * maps on accept, the member routes refuse them, a create with no project goes to the caller's personal project
 * (signup makes no team project), and the five rules that change on purpose (tags, annotation tags, a
 * credential and a run's annotation for a project viewer) hold.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import {
  createTestServer,
  createWorkflow,
  credentialIn,
  memberAs,
  node,
  ORIGIN,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const MIGRATION = path.resolve(__dirname, '..', 'migrations', '0024_roles_cutover.sql');

/** runs migration 0024's statements on the test database (what `db-migrate` did to the stored rows) */
async function backfill(): Promise<void> {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) await server.ctx.database.pool.query(statement);
  }
}

/** a user stored with an old word, as before the cutover, with a session client */
async function oldMember(
  tenantId: string,
  role: 'editor' | 'viewer',
): Promise<{ id: string; client: TestClient }> {
  const user = await server.ctx.repos.users.create({
    email: `old-${role}-${randomUUID().slice(0, 8)}@example.com`,
    name: `Old ${role}`,
    passwordHash: 'unused',
  });
  await server.ctx.repos.memberships.add(tenantId, user.id, role);
  await server.ctx.repos.projects.ensurePersonal(tenantId, user);
  const client = new TestClient(server.app, ORIGIN);
  client.cookie = `wf_session=${await server.ctx.auth.createSession(user.id, tenantId, { ip: '127.0.0.1' })}`;
  return { id: user.id, client };
}

const manual = () => ({ nodes: [node('Start', 'core.manualTrigger')] });

describe('stored old roles after migration 0024', () => {
  it('keep their rights on the team project as member plus project:editor or project:viewer', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const team = await teamProjectOf(server, tenantId);
    const wf = await createWorkflow(owner.client, { name: 'Team flow', ...manual() });
    const editor = await oldMember(tenantId, 'editor');
    const viewer = await oldMember(tenantId, 'viewer');

    await backfill();

    for (const [id, role] of [
      [editor.id, 'project:editor'],
      [viewer.id, 'project:viewer'],
    ]) {
      expect((await server.ctx.repos.memberships.get(tenantId, id))?.role).toBe('member');
      expect((await server.ctx.repos.projects.relations.get(tenantId, team, id))?.role).toBe(role);
    }
    const rename = (client: TestClient, name: string) =>
      client.patch(`/rest/workflows/${wf.id}`, { versionId: wf.versionId, name });
    expect((await viewer.client.get(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
    expect((await rename(viewer.client, 'Viewer edit')).statusCode).toBe(403);
    expect((await rename(editor.client, 'Editor edit')).statusCode).toBe(200);
    const members = await owner.client.data<Array<{ role: string }>>(owner.client.get('/rest/members'));
    expect(members.map((m) => m.role).sort()).toEqual(['member', 'member', 'owner']);
  });

  it('an old viewer gets a personal space where its new work goes (Q7)', async () => {
    const owner = await signup(server.app);
    const viewer = await oldMember(owner.tenant.id, 'viewer');
    await backfill();
    const personal = (await server.ctx.repos.projects.getPersonal(owner.tenant.id, viewer.id))!;
    const made = await viewer.client.data<{ id: string }>(
      viewer.client.post('/rest/workflows', { name: 'Mine', ...manual() }),
    );
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, made.id))?.projectId).toBe(personal.id);
    // the team project stays read only for it
    const team = await teamProjectOf(server, owner.tenant.id);
    const refused = await viewer.client.post('/rest/workflows', {
      name: 'Team',
      ...manual(),
      projectId: team,
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('invitations and member roles', () => {
  it('a pending invitation with an old word becomes member plus the project role on the oldest team project', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const team = await teamProjectOf(server, tenantId);
    // a second, newer team project gets nothing
    const newer = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/projects', { name: 'Newer' }),
    );
    for (const role of ['viewer', 'editor'] as const) {
      const token = `old-${role}-${randomUUID()}`;
      await server.ctx.repos.invitations.create({
        tenantId,
        email: `pending-${role}@example.com`,
        role,
        tokenHash: sha256(token),
        invitedBy: owner.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const client = new TestClient(server.app);
      const joined = await client.data<{ role: string; user: { id: string } }>(
        client.post(`/rest/invitations/${token}/accept`, { name: role, password: 'Passw0rd!' }),
      );
      expect(joined.role).toBe('member');
      expect((await server.ctx.repos.memberships.get(tenantId, joined.user.id))?.role).toBe('member');
      expect((await server.ctx.repos.projects.relations.get(tenantId, team, joined.user.id))?.role).toBe(
        `project:${role}`,
      );
      expect(
        await server.ctx.repos.projects.relations.get(tenantId, newer.id, joined.user.id),
      ).toBeUndefined();
      expect(await server.ctx.repos.projects.getPersonal(tenantId, joined.user.id)).toBeDefined();
    }
  });

  it('the invite and role routes refuse the old words', async () => {
    const owner = await signup(server.app);
    const member = await memberAs(owner, 'member');
    for (const role of ['editor', 'viewer']) {
      const invite = await owner.client.post('/rest/members/invite', {
        email: `x-${role}@example.com`,
        role,
      });
      expect(invite.statusCode).toBe(400);
      expect(invite.json().error.message).toBe(`Unknown role "${role}"`);
      const change = await owner.client.patch(`/rest/members/${member.user.id}`, { role });
      expect(change.statusCode).toBe(400);
    }
    expect(
      (await owner.client.post('/rest/members/invite', { email: 'm@example.com', role: 'member' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('creates with no project', () => {
  it("signup makes no team project, and new rows go to the caller's personal project", async () => {
    const owner = await signup(server.app, { projects: 'real' });
    const tenantId = owner.tenant.id;
    expect(await server.ctx.repos.projects.countByType(tenantId)).toEqual({ personal: 1, team: 0 });
    const personal = (await server.ctx.repos.projects.getPersonal(tenantId, owner.user.id))!.id;
    const wf = await createWorkflow(owner.client, manual());
    expect((await server.ctx.repos.workflows.get(tenantId, wf.id))?.projectId).toBe(personal);
    const credential = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', { name: 'Key', type: 'testApi', data: { apiKey: 'k' } }),
    );
    expect((await server.ctx.repos.credentials.get(tenantId, credential.id))?.projectId).toBe(personal);
    const folder = await owner.client.data<{ id: string }>(owner.client.post('/rest/folders', { name: 'F' }));
    expect((await server.ctx.repos.folders.get(tenantId, folder.id))?.projectId).toBe(personal);
    const table = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/data-tables', { name: 'cutover', columns: [] }),
    );
    expect((await server.ctx.repos.dataTables.get(tenantId, table.id))?.projectId).toBe(personal);
  });
});

describe('the five rules that change on purpose', () => {
  async function setup() {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const team = await teamProjectOf(server, tenantId);
    const viewer = await memberAs(owner, 'viewer');
    const editor = await memberAs(owner, 'editor');
    return { owner, tenantId, team, viewer, editor };
  }

  it('a project viewer writes tags and annotation tags (every member holds them); a project editor may not delete a tag', async () => {
    const { owner, viewer, editor } = await setup();
    const tag = await viewer.client.data<{ id: string }>(
      viewer.client.post('/rest/tags', { name: 'by-viewer' }),
    );
    expect((await viewer.client.patch(`/rest/tags/${tag.id}`, { name: 'renamed' })).statusCode).toBe(200);
    const deleted = await editor.client.delete(`/rest/tags/${tag.id}`);
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json().error.message).toBe('User is missing a scope required to perform this action');
    expect((await owner.client.delete(`/rest/tags/${tag.id}`)).statusCode).toBe(200);

    const annotation = await viewer.client.data<{ id: string }>(
      viewer.client.post('/rest/annotation-tags', { name: 'by-viewer' }),
    );
    expect(
      (await viewer.client.patch(`/rest/annotation-tags/${annotation.id}`, { name: 'renamed' })).statusCode,
    ).toBe(200);
    expect((await viewer.client.delete(`/rest/annotation-tags/${annotation.id}`)).statusCode).toBe(200);
  });

  it("a project viewer reads a credential of its project, with the secret blanked, and annotates the project's run", async () => {
    const { owner, tenantId, team, viewer } = await setup();
    const credential = await credentialIn(server, tenantId, team, { data: { apiKey: 'very-secret' } });
    const read = await viewer.client.get(`/rest/credentials/${credential.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain('very-secret');

    const workflow = await workflowIn(server, tenantId, team, { createdBy: owner.user.id });
    const now = new Date();
    const run = await server.ctx.repos.executions.create(
      tenantId,
      {
        id: randomUUID(),
        workflowId: workflow.id,
        workflowName: workflow.name,
        mode: 'manual',
        status: 'success',
        startedAt: now,
        stoppedAt: now,
      },
      { workflowData: {}, runOptions: { projectId: team } },
    );
    expect((await viewer.client.patch(`/rest/executions/${run.id}`, { vote: 'up' })).statusCode).toBe(200);
    // a member with no relation to the project is refused
    const outsider = await memberAs(owner, 'member');
    expect((await outsider.client.patch(`/rest/executions/${run.id}`, { vote: 'down' })).statusCode).toBe(
      403,
    );
  });
});
