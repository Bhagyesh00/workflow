/**
 * P6-38 (L17): the MCP Server Trigger's "Require Workflow Execute Permission" is `workflow:execute` on the
 * trigger's workflow through the user's projects: a member with no access to that project is refused.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAuthHelper } from '../src/services/mcp/oauth/tokens';
import {
  addToProject,
  createWorkflow,
  node,
  realMember,
  startMcpTestServer,
  TestClient,
  type TestMember,
  type TestServer,
  teamProjectOf,
} from './helpers';

const TRIGGER = 'MCP Server Trigger';
let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer(
    {
      MCP_ACCESS_ENABLED: 'true',
      OAUTH_SERVER_REGISTER_RATE_LIMIT: '1000',
      OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: '1000',
    },
    { nodePackages: [nodesAiPackage] },
  );
});
afterAll(async () => {
  await server?.close();
});

/** register, authorize for `resource`, consent as `member`, swap the code: an access token */
async function tokenFor(slug: string, member: TestMember, resource: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:7788/cb';
  const reg = await fetch(`${server.url}/mcp-oauth/${slug}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Scope client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = await fetch(
    `${server.url}/mcp-oauth/${slug}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource,
    })}`,
    { redirect: 'manual' },
  );
  const flow = new URL(authorize.headers.get('location') ?? '').searchParams.get('flow') ?? '';
  const { redirectUrl } = await member.client.data<{ redirectUrl: string }>(
    member.client.post('/rest/consent/approve', { flow, approved: true }),
  );
  const code = new URL(redirectUrl).searchParams.get('code') ?? '';
  const res = await fetch(`${server.url}/mcp-oauth/${slug}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
      resource,
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function signup() {
  const client = new TestClient(server.app, server.url, '10.9.1.1');
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-scope-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Scope ${id}`,
    workspaceName: `Scope ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { tenant: { id: string; slug: string } };
  // P6-39: signup makes no team project; the old default (where these tests' work lives) is made here
  const team = await client.data<{ id: string }>(client.post('/rest/projects', { name: `Scope ${id}` }));
  client.defaultProjectId = team.id;
  return { client, ...data };
}

const initialize = (url: string, token: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    }),
  });

describe('MCP Server Trigger by project', () => {
  it('refuses a member with no access to the trigger project and a viewer; a project editor gets in', async () => {
    const owner = await signup();
    const path = `scope-${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node(TRIGGER, 'ai.mcpTrigger', { path, authentication: 'n8nOAuth2' }, [0, 0], {
          webhookId: randomUUID(),
        }),
        node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
      ],
      connections: { Calculator: { ai_tool: [[{ node: TRIGGER, type: 'ai_tool', index: 0 }]] } },
    });
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    const url = `${server.url}/mcp/${owner.tenant.slug}/${path}`;
    const project = await teamProjectOf(server, owner.tenant.id);
    const member = await realMember(owner, { origin: server.url });
    const helper = createMcpAuthHelper(server.ctx);

    expect(await helper.canExecute(member.user.id, wf.id)).toBe(false);
    const token = await tokenFor(owner.tenant.slug, member, url);
    const refused = await initialize(url, token);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });

    await addToProject(server, owner.tenant.id, project, member.user.id, 'project:viewer');
    expect(await helper.canExecute(member.user.id, wf.id)).toBe(false);
    expect((await initialize(url, token)).status).toBe(403);

    await addToProject(server, owner.tenant.id, project, member.user.id, 'project:editor');
    expect(await helper.canExecute(member.user.id, wf.id)).toBe(true);
    expect((await initialize(url, token)).status).toBe(200);
  });
});
