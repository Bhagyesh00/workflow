/**
 * P6-38 (L17): Chat Trigger "Require Workflow Execute Permission" is `workflow:execute` on the chat's
 * workflow through the user's projects (`canExecute`, the door of hosted chat and the canvas chat).
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  createWorkflow,
  flushRedis,
  node,
  realMember,
  resetDatabase,
  signup,
  TEST_REDIS,
  type TestServer,
  teamProjectOf,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ REDIS_URL: TEST_REDIS }, { nodePackages: [nodesAiPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  await flushRedis();
});

const get = (url: string) => server.app.inject({ method: 'GET', url });

describe('hosted chat by project', () => {
  it('opens for a project editor, refuses a project viewer and a member of no project (403, no cookie)', async () => {
    const owner = await signup(server.app, { remoteAddress: '10.9.0.1' });
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node(
          'Chat',
          'ai.chatTrigger',
          { public: true, authentication: 'n8nUserAuth', requireExecuteAccess: true },
          [0, 0],
          { webhookId: 'chat-id' },
        ),
      ],
      connections: {},
    });
    expect((await owner.client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(200);
    const url = `/webhook/${owner.tenant.slug}/chat-id/chat`;
    const project = await teamProjectOf(server, owner.tenant.id);
    const member = await realMember(owner);

    const attempt = async () => {
      const issued = await member.client.data<{ code: string }>(
        member.client.post('/rest/form-auth/code', { returnTo: url }),
      );
      return get(`${url}?code=${issued.code}`);
    };
    const none = await attempt();
    expect(none.statusCode).toBe(403);
    expect(none.headers['set-cookie']).toBeUndefined();

    await addToProject(server, owner.tenant.id, project, member.user.id, 'project:viewer');
    expect((await attempt()).statusCode).toBe(403);

    await addToProject(server, owner.tenant.id, project, member.user.id, 'project:editor');
    const ok = await attempt();
    expect(ok.statusCode).toBe(302);
    expect(String(ok.headers['set-cookie'])).toContain('=');
  });
});
