/**
 * P6-27 (L7): form and chat sign-in. `canExecute` (the form trigger's "execute access", the MCP Trigger and
 * the Chat Trigger user access) is `workflow:execute` for that user on the workflow, through their
 * projects; `issueCode` stays plain workspace membership.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  const inAlpha = await workflowIn(server, tenantId, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, tenantId, beta.id, { name: 'In beta' });
  return { owner, member, tenantId, alpha, beta, inAlpha, inBeta };
}

describe('canExecute', () => {
  it('is workflow:execute through the projects of the user', async () => {
    const { member, tenantId, alpha, inAlpha, inBeta } = await setup();
    const { formAuth } = server.ctx;
    // a member of no project holds nothing
    expect(await formAuth.canExecute(member.user.id, inAlpha.id)).toBe(false);
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
    expect(await formAuth.canExecute(member.user.id, inAlpha.id)).toBe(true);
    expect(await formAuth.canExecute(member.user.id, inBeta.id)).toBe(false);
  });

  it('is false for a project viewer and true again when the role is widened (next call)', async () => {
    const { member, tenantId, alpha, inAlpha } = await setup();
    const { formAuth } = server.ctx;
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:viewer');
    expect(await formAuth.canExecute(member.user.id, inAlpha.id)).toBe(false);
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:admin');
    expect(await formAuth.canExecute(member.user.id, inAlpha.id)).toBe(true);
  });

  it('is true for the workspace owner, false for a user of another workspace and for an id that is no uuid', async () => {
    const { owner, inAlpha } = await setup();
    const other = await signup(server.app);
    const { formAuth } = server.ctx;
    expect(await formAuth.canExecute(owner.user.id, inAlpha.id)).toBe(true);
    expect(await formAuth.canExecute(other.user.id, inAlpha.id)).toBe(false);
    expect(await formAuth.canExecute(owner.user.id, 'not-a-uuid')).toBe(false);
  });

  it('goes by the workspace of the workflow for a user in two workspaces', async () => {
    const first = await setup();
    const second = await setup();
    const { formAuth } = server.ctx;
    await addToProject(server, first.tenantId, first.alpha.id, first.member.user.id, 'project:editor');
    await server.ctx.repos.memberships.add(second.tenantId, first.member.user.id, 'member');
    expect(await formAuth.canExecute(first.member.user.id, first.inAlpha.id)).toBe(true);
    expect(await formAuth.canExecute(first.member.user.id, second.inAlpha.id)).toBe(false);
    await addToProject(server, second.tenantId, second.alpha.id, first.member.user.id, 'project:viewer');
    expect(await formAuth.canExecute(first.member.user.id, second.inAlpha.id)).toBe(false);
  });

  it('is false once the membership is gone', async () => {
    const { member, tenantId, alpha, inAlpha } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
    await server.ctx.repos.memberships.remove(tenantId, member.user.id);
    expect(await server.ctx.formAuth.canExecute(member.user.id, inAlpha.id)).toBe(false);
  });
});

describe('POST /rest/form-auth/code', () => {
  it('stays membership: a member of no project gets a code for a form of the workspace', async () => {
    const { owner, member } = await setup();
    const res = await member.client.post('/rest/form-auth/code', {
      returnTo: `/form/${owner.tenant.slug}/who`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.code).toMatch(/^[\w-]{43}$/);
  });

  it('still refuses a user who is not in the workspace', async () => {
    const { owner } = await setup();
    const other = await signup(server.app);
    const res = await other.client.post('/rest/form-auth/code', {
      returnTo: `/form/${owner.tenant.slug}/who`,
    });
    expect(res.statusCode).toBe(403);
  });
});
