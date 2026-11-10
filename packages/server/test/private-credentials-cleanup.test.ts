/**
 * P6-15 private credentials: the cleanup paths and the move rules. As n8n's connection status service, a
 * user's own connection goes when that user can no longer reach the credential: a workspace role change, a
 * removal from the workspace or a project, a project role change, an unshare, a move and a team project
 * delete. A switch back to fixed and a change of a shared field delete every connection. A private
 * credential never moves to a personal project (a move or a project delete), and a move needs
 * `credential:createEndUser`.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import { changeMemberRole } from '../src/services/member-disable';
import { removeMember } from '../src/services/member-removal';
import { PRIVATE_MOVE_PERSONAL_ERROR } from '../src/services/private-credentials';
import {
  addToProject,
  createTestServer,
  memberAs,
  projectIn,
  realMember,
  resetDatabase,
  sessionFor,
  signup,
  type TestServer,
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

const repos = () => server.ctx.repos;
const suffix = () => randomUUID().slice(0, 8);

const oauth2Data: DataObject = {
  authUrl: 'https://auth.example.com/authorize',
  accessTokenUrl: 'https://auth.example.com/token',
  clientId: 'shared-client',
  clientSecret: 'shared-secret',
  scope: 'read',
};

/** a private credential owned by `projectId`, made as the owner would (service create with the flag) */
async function privateIn(tenantId: string, projectId: string, name = `Private ${suffix()}`) {
  return server.ctx.credentials.create(tenantId, {
    name,
    type: 'oAuth2Api',
    data: oauth2Data,
    projectId,
    isResolvable: true,
  });
}

/** a user's own connection, as the OAuth callback writes it */
async function connected(tenantId: string, credentialId: string, userId: string, who = userId) {
  await server.ctx.privateCredentials.saveEntry(tenantId, credentialId, userId, {
    oauthTokenData: { access_token: `token-${who}`, refresh_token: `refresh-${who}` },
  });
}

const hasEntry = async (tenantId: string, credentialId: string, userId: string) =>
  (await repos().credentialEntries.get(tenantId, credentialId, userId)) !== undefined;

/** an owner, its team project and a member who edits there, each connected to one private credential */
async function setup() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const team = owner.client.defaultProjectId!;
  const member = await realMember(owner);
  await addToProject(server, tenantId, team, member.user.id, 'project:editor');
  const credential = await privateIn(tenantId, team);
  await connected(tenantId, credential.id, owner.user.id);
  await connected(tenantId, credential.id, member.user.id);
  return { owner, member, tenantId, team, credential };
}

describe('private credentials: cleanup on an access change', () => {
  it('a project role change that drops credential:connect removes that user entry only', async () => {
    const { owner, member, tenantId, team, credential } = await setup();
    const res = await owner.client.patch(`/rest/projects/${team}/users/${member.user.id}`, {
      role: 'project:viewer',
    });
    expect(res.statusCode).toBe(200);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('a project editor who is removed from the project loses the entry', async () => {
    const { owner, member, tenantId, team, credential } = await setup();
    const res = await owner.client.delete(`/rest/projects/${team}/users/${member.user.id}`);
    expect(res.statusCode).toBe(200);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('a removed member: the entry is gone', async () => {
    const { owner, member, tenantId, credential } = await setup();
    const auth = (await sessionFor(server, tenantId, owner.user.id)).auth;
    await removeMember(server.ctx, auth, member.user.id, { deleteData: true });
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('a workspace role change from admin to member removes an entry reached only as admin', async () => {
    const { owner, tenantId, credential } = await setup();
    const admin = await memberAs(owner, 'admin');
    await connected(tenantId, credential.id, admin.user.id);
    await changeMemberRole(server.ctx, tenantId, admin.user.id, 'admin');
    expect(await hasEntry(tenantId, credential.id, admin.user.id)).toBe(true);
    await changeMemberRole(server.ctx, tenantId, admin.user.id, 'member');
    expect(await hasEntry(tenantId, credential.id, admin.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('an unshare removes the entries of users who reached the credential only through the share', async () => {
    const { owner, member, tenantId, team, credential } = await setup();
    const other = await projectIn(server, tenantId, `Other ${suffix()}`);
    const guest = await realMember(owner);
    await addToProject(server, tenantId, other.id, guest.user.id, 'project:editor');
    const shared = await owner.client.put(`/rest/credentials/${credential.id}/share`, {
      shareWithIds: [other.id],
    });
    expect(shared.statusCode).toBe(200);
    await connected(tenantId, credential.id, guest.user.id);
    const unshared = await owner.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [] });
    expect(unshared.statusCode).toBe(200);
    expect(await hasEntry(tenantId, credential.id, guest.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(true);
    expect(team).toBeTruthy();
  });

  it('a move to another team project removes the entries of users who stay behind', async () => {
    const { owner, member, tenantId, credential } = await setup();
    const target = await projectIn(server, tenantId, `Target ${suffix()}`);
    const moved = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: target.id,
    });
    expect(moved.statusCode).toBe(200);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
    // the owner reaches every team project (implicit project admin)
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('a team project delete with transfer removes the entries of the deleted project members', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const leaving = await projectIn(server, tenantId, `Leaving ${suffix()}`);
    const target = await projectIn(server, tenantId, `Target ${suffix()}`);
    const member = await realMember(owner);
    await addToProject(server, tenantId, leaving.id, member.user.id, 'project:editor');
    const credential = await privateIn(tenantId, leaving.id);
    await connected(tenantId, credential.id, member.user.id);
    await connected(tenantId, credential.id, owner.user.id);
    const deleted = await owner.client.delete(`/rest/projects/${leaving.id}?transferId=${target.id}`);
    expect(deleted.statusCode).toBe(200);
    expect((await repos().credentials.get(tenantId, credential.id))?.projectId).toBe(target.id);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, owner.user.id)).toBe(true);
  });

  it('a team project delete removes the entries that reached a credential through a share into it', async () => {
    const { owner, member, tenantId, credential } = await setup();
    const doomed = await projectIn(server, tenantId, `Doomed ${suffix()}`);
    const guest = await realMember(owner);
    await addToProject(server, tenantId, doomed.id, guest.user.id, 'project:editor');
    await owner.client.data(
      owner.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [doomed.id] }),
    );
    await connected(tenantId, credential.id, guest.user.id);
    const deleted = await owner.client.delete(`/rest/projects/${doomed.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(await hasEntry(tenantId, credential.id, guest.user.id)).toBe(false);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(true);
  });
});

describe('private credentials: switch and shared fields', () => {
  it('a switch to fixed deletes every connection', async () => {
    const { owner, member, tenantId, credential } = await setup();
    const res = await owner.client.patch(`/rest/credentials/${credential.id}`, { isResolvable: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isResolvable).toBe(false);
    expect(await repos().credentialEntries.list(tenantId, { credentialId: credential.id })).toEqual([]);
    expect(await hasEntry(tenantId, credential.id, member.user.id)).toBe(false);
  });

  it('changing a shared field deletes every connection; a rename or a redacted save keeps them', async () => {
    const { owner, tenantId, credential } = await setup();
    const detail = await owner.client.data<{ data: DataObject }>(
      owner.client.get(`/rest/credentials/${credential.id}`),
    );
    const kept = await owner.client.patch(`/rest/credentials/${credential.id}`, {
      name: 'Renamed',
      data: detail.data,
    });
    expect(kept.statusCode).toBe(200);
    expect(await repos().credentialEntries.list(tenantId, { credentialId: credential.id })).toHaveLength(2);
    const changed = await owner.client.patch(`/rest/credentials/${credential.id}`, {
      data: { ...detail.data, clientId: 'another-client' },
    });
    expect(changed.statusCode).toBe(200);
    expect(await repos().credentialEntries.list(tenantId, { credentialId: credential.id })).toEqual([]);
  });
});

describe('private credentials: move rules', () => {
  it('a private credential is never moved to a personal project', async () => {
    const { owner, tenantId, credential } = await setup();
    const personal = await repos().projects.getPersonal(tenantId, owner.user.id);
    const res = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: personal!.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(PRIVATE_MOVE_PERSONAL_ERROR);
    expect((await repos().credentials.get(tenantId, credential.id))?.projectId).not.toBe(personal!.id);
  });

  it('a project delete that would migrate a private credential to a personal project is refused', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const leaving = await projectIn(server, tenantId, `Leaving ${suffix()}`);
    const credential = await privateIn(tenantId, leaving.id, 'Team mail');
    const personal = await repos().projects.getPersonal(tenantId, owner.user.id);
    const res = await owner.client.delete(`/rest/projects/${leaving.id}?transferId=${personal!.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(
      "Can't delete project. Private credentials can't be moved to a personal project: Team mail",
    );
    expect(await repos().projects.get(tenantId, leaving.id)).toBeDefined();
    expect((await repos().credentials.get(tenantId, credential.id))?.projectId).toBe(leaving.id);
    // a fixed credential still moves to a personal project as before
    await server.ctx.credentials.update(tenantId, credential.id, { isResolvable: false });
    const moved = await owner.client.delete(`/rest/projects/${leaving.id}?transferId=${personal!.id}`);
    expect(moved.statusCode).toBe(200);
  });

  it('a move needs credential:createEndUser on the private credential', async () => {
    const { tenantId, member, credential } = await setup();
    const target = await projectIn(server, tenantId, `Target ${suffix()}`);
    const auth = (await sessionFor(server, tenantId, member.user.id)).auth;
    // a project editor holds credential:connect but not credential:createEndUser
    await expect(
      server.ctx.privateCredentials.assertMovable(auth, credential.id, target.id),
    ).rejects.toMatchObject({ statusCode: 403, message: MISSING_SCOPE_MESSAGE });
    const res = await member.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: target.id,
    });
    expect(res.statusCode).toBe(403);
    // a fixed credential is not held to the private rule
    const fixed = await server.ctx.credentials.create(tenantId, {
      name: 'Fixed',
      type: 'oAuth2Api',
      data: oauth2Data,
      projectId: credential.projectId,
    });
    await expect(
      server.ctx.privateCredentials.assertMovable(auth, fixed.id, target.id),
    ).resolves.toBeUndefined();
  });
});
