/**
 * P6-74 (L3): `resolveOwner`, the project a pulled file lands in. A personal owner maps by email to that member's
 * personal project in this workspace; an email of no member (or of a member of another workspace) falls back to the
 * puller's personal project; a team owner maps through the id map, the project made through the project service when
 * missing (the service mints the id).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projects } from '../src/db/schema';
import { SyncIdMap } from '../src/services/source-control/id-map';
import { resolveOwner } from '../src/services/source-control/owners';
import { createTestServer, realMember, signup, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.close();
});

const deps = () => server.ctx.serviceDeps;

async function workspace() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const map = await SyncIdMap.load(server.ctx.repos, tenantId);
  return { owner, member, tenantId, map };
}

describe('resolveOwner', () => {
  it('maps a personal owner who is a member to that member`s personal project', async () => {
    const { owner, member, tenantId, map } = await workspace();
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'personal', personalEmail: member.user.email },
      { userId: owner.user.id },
      map,
    );
    const expected = await server.ctx.repos.projects.getPersonal(tenantId, member.user.id);
    expect(expected).toBeDefined();
    expect(projectId).toBe(expected?.id);
    const ownerProject = await server.ctx.repos.projects.getPersonal(tenantId, owner.user.id);
    expect(projectId).not.toBe(ownerProject?.id);
  });

  it('matches the email in any letter case', async () => {
    const { owner, member, tenantId, map } = await workspace();
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'personal', personalEmail: member.user.email.toUpperCase() },
      { userId: owner.user.id },
      map,
    );
    expect(projectId).toBe((await server.ctx.repos.projects.getPersonal(tenantId, member.user.id))?.id);
  });

  it('falls back to the puller`s personal project for an email of no member', async () => {
    const { owner, tenantId, map } = await workspace();
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'personal', personalEmail: `nobody-${randomUUID()}@example.com` },
      { userId: owner.user.id },
      map,
    );
    const mine = await server.ctx.repos.projects.getPersonal(tenantId, owner.user.id);
    expect(projectId).toBe(mine?.id);
  });

  it('never maps to a member of another workspace', async () => {
    const { owner, tenantId, map } = await workspace();
    const stranger = await signup(server.app);
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'personal', personalEmail: stranger.user.email },
      { userId: owner.user.id },
      map,
    );
    const mine = await server.ctx.repos.projects.getPersonal(tenantId, owner.user.id);
    expect(projectId).toBe(mine?.id);
    const strangerProject = await server.ctx.repos.projects.getPersonal(stranger.tenant.id, stranger.user.id);
    expect(projectId).not.toBe(strangerProject?.id);
    const row = await server.ctx.repos.projects.get(tenantId, projectId);
    expect(row?.tenantId).toBe(tenantId);
  });

  it('makes a team project for an unknown team id, names it, and maps it', async () => {
    const { owner, tenantId, map } = await workspace();
    const teamId = randomUUID();
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'team', teamId, teamName: 'Finance team' },
      { userId: owner.user.id },
      map,
    );
    const row = await server.ctx.repos.projects.get(tenantId, projectId);
    expect(row).toMatchObject({ type: 'team', name: 'Finance team', tenantId });
    expect(row?.id).not.toBe(teamId);
    expect(map.localIdFor('project', teamId)).toBe(projectId);
    // the same team again: the same project, no second one
    const again = await resolveOwner(
      deps(),
      tenantId,
      { type: 'team', teamId, teamName: 'Finance team' },
      { userId: owner.user.id },
      map,
    );
    expect(again).toBe(projectId);
    await map.save(server.ctx.repos);
    const reloaded = await SyncIdMap.load(server.ctx.repos, tenantId);
    expect(
      await resolveOwner(
        deps(),
        tenantId,
        { type: 'team', teamId, teamName: 'Renamed' },
        { userId: owner.user.id },
        reloaded,
      ),
    ).toBe(projectId);
  });

  it('makes a missing project of an allocated team id through the project service and maps the team to it', async () => {
    const { owner, tenantId, map } = await workspace();
    const teamId = randomUUID();
    const allocated = map.allocate('project', teamId);
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'team', teamId, teamName: 'Ops' },
      { userId: owner.user.id },
      map,
    );
    expect(projectId).not.toBe(allocated);
    expect(map.localIdFor('project', teamId)).toBe(projectId);
    expect(await server.ctx.repos.projects.get(tenantId, projectId)).toMatchObject({
      type: 'team',
      name: 'Ops',
    });
    expect(await server.ctx.repos.projects.get(tenantId, allocated)).toBeUndefined();
  });

  it('takes a team project of this workspace that carries the git id (the first pusher)', async () => {
    const { owner, tenantId, map } = await workspace();
    const team = owner.client.defaultProjectId as string;
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'team', teamId: team, teamName: 'Whatever' },
      { userId: owner.user.id },
      map,
    );
    expect(projectId).toBe(team);
    expect(map.localIdFor('project', team)).toBe(team);
    expect(await server.ctx.database.db.select().from(projects).where(eq(projects.id, team))).toHaveLength(1);
  });

  it('never takes a team project of another workspace for a git id', async () => {
    const { owner, tenantId, map } = await workspace();
    const stranger = await signup(server.app);
    const foreign = stranger.client.defaultProjectId as string;
    const projectId = await resolveOwner(
      deps(),
      tenantId,
      { type: 'team', teamId: foreign, teamName: 'Foreign' },
      { userId: owner.user.id },
      map,
    );
    expect(projectId).not.toBe(foreign);
    expect((await server.ctx.repos.projects.get(tenantId, projectId))?.tenantId).toBe(tenantId);
    expect(await server.ctx.repos.projects.get(stranger.tenant.id, projectId)).toBeUndefined();
  });
});
