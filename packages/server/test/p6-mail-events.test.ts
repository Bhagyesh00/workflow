/**
 * P6-17 (L1) the mail events: each sends once. The share notices (workflow, credential, project) reach the
 * people of the sharee projects and skip the actor; the first production failure mail goes out once even
 * when two failures race, and not at all while an error workflow exists or mail is not set up; the MCP
 * client revoked mail reaches the owner of the grant only when someone else revoked it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/context';
import { maybeSendFirstFailure } from '../src/services/first-failure-mail';
import { startSmtpServer } from './fakes/smtp';
import {
  addToProject,
  createTestServer,
  credentialIn,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let smtp: Awaited<ReturnType<typeof startSmtpServer>>;
let server: TestServer;
let plain: TestServer;

const depsOf = (s: TestServer): ServiceDeps => ({
  config: s.ctx.config,
  database: s.ctx.database,
  repos: s.ctx.repos,
  logger: s.ctx.logger,
  context: () => s.ctx,
});

beforeAll(async () => {
  smtp = await startSmtpServer();
  server = await createTestServer({
    EMAIL_MODE: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SSL: 'false',
    SMTP_STARTTLS: 'false',
    MCP_ACCESS_ENABLED: 'true',
  });
  // the same app with mail off, on the same database (no reset: the first server's tables stay empty of its rows)
  plain = await createTestServer({ SMTP_HOST: '' }, { reset: false });
});
afterAll(async () => {
  await plain.close();
  await server.close();
  await smtp.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  smtp.messages.length = 0;
});

const suffix = () => randomUUID().slice(0, 8);
const mailsTo = (email: string) => smtp.messages.filter((m) => m.to.join(' ').includes(email));
/** the mails come after the write returns; the fake has them once the route answered */
const text = (raw: string) =>
  raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

describe('share mails', () => {
  async function setup() {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const home = await projectIn(server, tenantId, `Home ${suffix()}`);
    const away = await projectIn(server, tenantId, `Away ${suffix()}`);
    const member = await realMember(owner);
    const other = await realMember(owner);
    await addToProject(server, tenantId, away.id, member.user.id, 'project:editor');
    await addToProject(server, tenantId, away.id, other.user.id, 'project:viewer');
    // the actor is in the sharee project too, and gets no mail
    await addToProject(server, tenantId, away.id, owner.user.id, 'project:admin');
    return { owner, tenantId, home, away, member, other };
  }

  it('a workflow shared with a project mails each of its people once, never the actor', async () => {
    const { owner, tenantId, home, away, member, other } = await setup();
    const workflow = await workflowIn(server, tenantId, home.id, { name: 'Billing sync' });
    const res = await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [away.id] });
    expect(res.statusCode).toBe(200);
    expect(mailsTo(member.email)).toHaveLength(1);
    expect(mailsTo(other.email)).toHaveLength(1);
    expect(mailsTo(owner.user.email)).toHaveLength(0);
    const mail = text(mailsTo(member.email)[0]?.data ?? '');
    expect(mail).toContain('Billing sync');
    expect(mail).toContain(`/workflow/${workflow.id}`);
    // the same list again adds nothing, so nothing is sent
    smtp.messages.length = 0;
    await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [away.id] });
    expect(smtp.messages).toHaveLength(0);
  });

  it('a credential shared with a project mails its people once', async () => {
    const { owner, tenantId, home, away, member, other } = await setup();
    const credential = await credentialIn(server, tenantId, home.id, { name: 'Stripe key' });
    const res = await owner.client.put(`/rest/credentials/${credential.id}/share`, {
      shareWithIds: [away.id],
    });
    expect(res.statusCode).toBe(200);
    expect(mailsTo(member.email)).toHaveLength(1);
    expect(mailsTo(other.email)).toHaveLength(1);
    expect(mailsTo(owner.user.email)).toHaveLength(0);
    const mail = text(mailsTo(member.email)[0]?.data ?? '');
    expect(mail).toContain('Stripe key');
    // the mail names the credential, never its data
    expect(mail).not.toContain('secret');
  });

  it('adding people to a project mails the added people once and not the actor', async () => {
    const { owner, tenantId, home } = await setup();
    const added = await realMember(owner);
    const res = await owner.client.post(`/rest/projects/${home.id}/users`, {
      relations: [
        { userId: added.user.id, role: 'project:editor' },
        { userId: owner.user.id, role: 'project:admin' },
      ],
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(mailsTo(added.email)).toHaveLength(1);
    expect(mailsTo(owner.user.email)).toHaveLength(0);
    const mail = text(mailsTo(added.email)[0]?.data ?? '');
    expect(mail).toContain(home.name);
    expect(mail).toContain('editor');
    expect(tenantId).toBeTruthy();
  });

  it('a mail that fails does not undo the share', async () => {
    // mail is on but nothing listens on the port
    const broken = await createTestServer(
      {
        EMAIL_MODE: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1',
        SMTP_SSL: 'false',
        SMTP_STARTTLS: 'false',
      },
      { reset: false },
    );
    try {
      const owner = await signup(broken.app);
      const home = await projectIn(broken, owner.tenant.id, `Home ${suffix()}`);
      const away = await projectIn(broken, owner.tenant.id, `Away ${suffix()}`);
      const member = await realMember(owner);
      await addToProject(broken, owner.tenant.id, away.id, member.user.id, 'project:editor');
      const workflow = await workflowIn(broken, owner.tenant.id, home.id);
      const res = await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [away.id] });
      expect(res.statusCode).toBe(200);
      const shared = await broken.ctx.repos.shares.listForWorkflow(owner.tenant.id, workflow.id);
      expect(shared.map((s) => s.projectId)).toContain(away.id);
    } finally {
      await broken.close();
    }
  });

  it('nothing is sent while mail is off', async () => {
    const owner = await signup(plain.app);
    const home = await projectIn(plain, owner.tenant.id, `Home ${suffix()}`);
    const away = await projectIn(plain, owner.tenant.id, `Away ${suffix()}`);
    const member = await realMember(owner);
    await addToProject(plain, owner.tenant.id, away.id, member.user.id, 'project:editor');
    const workflow = await workflowIn(plain, owner.tenant.id, home.id);
    const res = await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [away.id] });
    expect(res.statusCode).toBe(200);
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('first production failure mail', () => {
  it('goes to the owner of the personal project of the workflow, once, even when two failures race', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const personal = await server.ctx.repos.projects.ensurePersonal(owner.tenant.id, {
      id: member.user.id,
      name: member.user.name,
    });
    const workflow = await workflowIn(server, owner.tenant.id, personal.id, { name: 'Nightly import' });
    await Promise.all([
      maybeSendFirstFailure(depsOf(server), owner.tenant.id, workflow.id),
      maybeSendFirstFailure(depsOf(server), owner.tenant.id, workflow.id),
    ]);
    expect(smtp.messages).toHaveLength(1);
    expect(mailsTo(member.email)).toHaveLength(1);
    expect(text(smtp.messages[0]?.data ?? '')).toContain('Nightly import');
    // later failures send nothing: the workspace was told
    await maybeSendFirstFailure(depsOf(server), owner.tenant.id, workflow.id);
    expect(smtp.messages).toHaveLength(1);
  });

  it('goes to the workspace owner when the workflow lives in a team project', async () => {
    const owner = await signup(server.app);
    const team = await projectIn(server, owner.tenant.id, `Team ${suffix()}`);
    const workflow = await workflowIn(server, owner.tenant.id, team.id);
    await maybeSendFirstFailure(depsOf(server), owner.tenant.id, workflow.id);
    expect(mailsTo(owner.user.email)).toHaveLength(1);
  });

  it('is skipped when any workflow of the workspace has an error workflow, and does not use up the mail', async () => {
    const owner = await signup(server.app);
    const team = await projectIn(server, owner.tenant.id, `Team ${suffix()}`);
    const handler = await workflowIn(server, owner.tenant.id, team.id);
    const guarded = await workflowIn(server, owner.tenant.id, team.id, {
      settings: { errorWorkflow: handler.id },
    });
    const failing = await workflowIn(server, owner.tenant.id, team.id);
    await maybeSendFirstFailure(depsOf(server), owner.tenant.id, failing.id);
    expect(smtp.messages).toHaveLength(0);
    // the error workflow goes: the next first failure is told
    await server.ctx.repos.workflows.delete(owner.tenant.id, guarded.id);
    await maybeSendFirstFailure(depsOf(server), owner.tenant.id, failing.id);
    expect(smtp.messages).toHaveLength(1);
  });

  it('is skipped while mail is not set up', async () => {
    const owner = await signup(plain.app);
    const team = await projectIn(plain, owner.tenant.id, `Team ${suffix()}`);
    const workflow = await workflowIn(plain, owner.tenant.id, team.id);
    await maybeSendFirstFailure(depsOf(plain), owner.tenant.id, workflow.id);
    expect(smtp.messages).toHaveLength(0);
    expect((await plain.ctx.repos.tenants.get(owner.tenant.id))?.settings).not.toHaveProperty(
      'firstProductionFailure',
    );
  });

  it('never throws', async () => {
    const owner = await signup(server.app);
    await expect(
      maybeSendFirstFailure(depsOf(server), owner.tenant.id, randomUUID()),
    ).resolves.toBeUndefined();
    await expect(maybeSendFirstFailure(depsOf(server), randomUUID(), randomUUID())).resolves.toBeUndefined();
  });
});

describe('MCP client revoked mail', () => {
  async function grant(tenantId: string, userId: string, name: string) {
    const clientId = `client-${randomUUID()}`;
    await server.ctx.repos.mcpOAuth.createClient({
      id: clientId,
      tenantId,
      name,
      redirectUris: ['http://localhost:4444/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
    });
    await server.ctx.repos.mcpOAuth.saveConsent({ tenantId, userId, clientId, scope: ['workflow:read'] });
    return clientId;
  }

  it('an admin revoking a member grant mails the member once with the client name', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const clientId = await grant(owner.tenant.id, member.user.id, 'Desk assistant');
    const res = await owner.client.delete(`/rest/mcp/oauth-clients/${clientId}?userId=${member.user.id}`);
    expect(res.statusCode).toBe(200);
    expect(mailsTo(member.email)).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
    const mail = text(smtp.messages[0]?.data ?? '');
    expect(mail).toContain('Desk assistant');
    expect(mail).toContain('revoked by');
  });

  it('a user revoking their own client gets no mail', async () => {
    const owner = await signup(server.app);
    const clientId = await grant(owner.tenant.id, owner.user.id, 'My client');
    const res = await owner.client.delete(`/rest/mcp/oauth-clients/${clientId}`);
    expect(res.statusCode).toBe(200);
    expect(smtp.messages).toHaveLength(0);
  });

  it('a refused revoke (unknown client) sends nothing', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const res = await owner.client.delete(
      `/rest/mcp/oauth-clients/client-${randomUUID()}?userId=${member.user.id}`,
    );
    expect(res.statusCode).toBe(404);
    expect(smtp.messages).toHaveLength(0);
  });
});
