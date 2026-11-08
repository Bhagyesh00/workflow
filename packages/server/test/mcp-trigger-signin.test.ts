/**
 * P5-14 (with P5-03): the MCP Server Trigger's "Workspace sign-in" option (`n8nOAuth2`) against the real
 * app with the sdk client: a token of the workspace's OAuth server for the trigger's URL is required,
 * "Require Workflow Execute Permission" lets only editors and above in, and "Include User in Output" puts
 * the signed-in user on the trigger's item (or leaves it off).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as SdkStreamable } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAuthHelper } from '../src/services/mcp/oauth/tokens';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import {
  createWorkflow,
  executionsOf,
  node,
  outputOf,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

const TRIGGER = 'MCP Server Trigger';
let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' }, { nodePackages: [nodesAiPackage] });
});
afterAll(async () => {
  await server?.close();
});

const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

async function signup(name = 'Signin User') {
  const client = new TestClient(server.app, server.url, ip());
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-signin-${id}@example.com`,
    password: 'Passw0rd!',
    name: `${name} ${id}`,
    workspaceName: `Signin ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as {
    user: { id: string; email: string };
    tenant: { id: string; slug: string };
  };
  return { client, ...data, name: `${name} ${id}` };
}
type User = Awaited<ReturnType<typeof signup>>;

async function signedInTrigger(owner: User, parameters: DataObject = {}) {
  const path = `signin-${randomUUID().slice(0, 8)}`;
  const wf = await createWorkflow(owner.client, {
    name: `Trigger ${path}`,
    nodes: [
      node(TRIGGER, 'ai.mcpTrigger', { path, authentication: 'n8nOAuth2', ...parameters }, [0, 0], {
        webhookId: randomUUID(),
      }),
      node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
    ],
    connections: { Calculator: { ai_tool: [[{ node: TRIGGER, type: 'ai_tool', index: 0 }]] } },
  });
  await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
  return { ...wf, url: `${server.url}/mcp/${owner.tenant.slug}/${path}` };
}

/** register, authorize for `resource`, consent as `user`, swap the code: an access token */
async function tokenFor(owner: User, user: User, resource: string): Promise<string> {
  const slug = owner.tenant.slug;
  const redirectUri = 'http://127.0.0.1:7788/cb';
  const reg = await fetch(`${server.url}/mcp-oauth/${slug}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Signin client',
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
  expect(authorize.status).toBe(302);
  const flow = new URL(authorize.headers.get('location') ?? '').searchParams.get('flow') ?? '';
  const { redirectUrl } = await user.client.data(
    user.client.post('/rest/consent/approve', { flow, approved: true }),
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
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
};

const initialize = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(INIT),
  });

async function callCalculator(url: string, accessToken: string) {
  const mcp = new SdkClient({ name: 'signin-test', version: '1.0.0' });
  await mcp.connect(
    new SdkStreamable(new URL(url), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }),
  );
  try {
    const result = await mcp.callTool({ name: 'Calculator', arguments: { input: '2 + 3' } });
    return (result.content as Array<{ text?: string }>)[0]?.text;
  } finally {
    await mcp.close();
  }
}

/** the trigger's item of the workflow's newest run */
async function triggerItem(owner: User, workflowId: string): Promise<DataObject> {
  const [run] = await executionsOf(server.ctx, owner.tenant.id, workflowId);
  await waitForExecution(server.ctx, owner.tenant.id, run.id, ['success']);
  const execution = await owner.client.data(owner.client.get(`/rest/executions/${run.id}`));
  return outputOf(execution.state, TRIGGER)[0];
}

describe('MCP Server Trigger workspace sign-in', () => {
  it('asks for a workspace token: none, a wrong one, an MCP key or a server token get 401 with the challenge', async () => {
    const owner = await signup();
    const trigger = await signedInTrigger(owner);
    const metadataUrl = `${server.url}/.well-known/oauth-protected-resource${new URL(trigger.url).pathname}`;

    const none = await initialize(trigger.url);
    expect(none.status).toBe(401);
    const challenge = none.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${metadataUrl}"`);
    // the client can read the challenge (CORS exposes it)
    expect(none.headers.get('access-control-expose-headers')).toContain('www-authenticate');
    const meta = await (await fetch(metadataUrl)).json();
    expect(meta).toMatchObject({
      resource: trigger.url,
      authorization_servers: [`${server.url}/mcp-oauth/${owner.tenant.slug}`],
    });

    const wrong = await initialize(trigger.url, { authorization: 'Bearer wfo_at_not-a-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('error="invalid_token"');
    const key = (
      await server.ctx.auth.createApiKey(owner.tenant.id, owner.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
    ).key;
    expect((await initialize(trigger.url, { authorization: `Bearer ${key}` })).status).toBe(401);
    const serverToken = await tokenFor(owner, owner, `${server.url}/mcp-server/${owner.tenant.slug}/http`);
    expect((await initialize(trigger.url, { authorization: `Bearer ${serverToken}` })).status).toBe(401);
    // no run was started by any refused request
    expect(await executionsOf(server.ctx, owner.tenant.id, trigger.id)).toHaveLength(0);

    const accessToken = await tokenFor(owner, owner, trigger.url);
    expect(await callCalculator(trigger.url, accessToken)).toBe('5');
  });

  it('requires the execute permission by default: a viewer is refused, an editor runs it', async () => {
    const owner = await signup();
    const viewer = await signup('Viewer');
    const editor = await signup('Editor');
    await server.ctx.repos.memberships.add(owner.tenant.id, viewer.user.id, 'viewer');
    await server.ctx.repos.memberships.add(owner.tenant.id, editor.user.id, 'editor');
    const strict = await signedInTrigger(owner);
    const open = await signedInTrigger(owner, { requireExecuteAccess: false });

    const viewerStrict = await tokenFor(owner, viewer, strict.url);
    const refused = await initialize(strict.url, { authorization: `Bearer ${viewerStrict}` });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });

    // without the option a viewer of the workspace may call it
    const viewerOpen = await tokenFor(owner, viewer, open.url);
    expect(await callCalculator(open.url, viewerOpen)).toBe('5');

    const editorStrict = await tokenFor(owner, editor, strict.url);
    expect(await callCalculator(strict.url, editorStrict)).toBe('5');

    // the helper's rule: editor or above in the workflow's workspace
    const helper = createMcpAuthHelper(server.ctx);
    expect(await helper.canExecute(editor.user.id, strict.id)).toBe(true);
    expect(await helper.canExecute(viewer.user.id, strict.id)).toBe(false);
    const stranger = await signup('Stranger');
    expect(await helper.canExecute(stranger.user.id, strict.id)).toBe(false);

    // removed from the workspace: the token stops working at once
    await server.ctx.repos.memberships.remove(owner.tenant.id, editor.user.id);
    expect((await initialize(strict.url, { authorization: `Bearer ${editorStrict}` })).status).toBe(401);
  });

  it('puts the signed-in user on the item with Include User in Output, and leaves it off without', async () => {
    const owner = await signup('Ada Lovelace');
    const withUser = await signedInTrigger(owner);
    const withoutUser = await signedInTrigger(owner, { includeUserInOutput: false });

    expect(await callCalculator(withUser.url, await tokenFor(owner, owner, withUser.url))).toBe('5');
    const item = await triggerItem(owner, withUser.id);
    const [firstName, ...rest] = owner.name.split(' ');
    expect(item.user).toEqual({
      id: owner.user.id,
      email: owner.user.email,
      firstName,
      lastName: rest.join(' '),
    });
    // the Bearer token never reaches the run
    expect(JSON.stringify(item)).not.toContain('wfo_at_');

    expect(await callCalculator(withoutUser.url, await tokenFor(owner, owner, withoutUser.url))).toBe('5');
    const plain = await triggerItem(owner, withoutUser.id);
    expect(plain).not.toHaveProperty('user');
    expect(plain.mcpToolCall).toMatchObject({ toolName: 'Calculator' });
  });

  it('checks the token for the trigger URL rebuilt on the MCP base URL (proxy scheme or prefix)', async () => {
    const owner = await signup();
    const trigger = await signedInTrigger(owner);
    const accessToken = await tokenFor(owner, owner, trigger.url);
    const helper = createMcpAuthHelper(() => server.ctx);
    const path = new URL(trigger.url).pathname;
    expect((await helper.verifyAccessToken(accessToken, trigger.url))?.user.id).toBe(owner.user.id);
    expect(
      (await helper.verifyAccessToken(accessToken, `https://127.0.0.1:${server.port}/prefix${path}`))?.role,
    ).toBe('owner');
    // another trigger path, the test endpoint, the server URL or an MCP key: no user
    expect(
      await helper.verifyAccessToken(
        accessToken,
        `${server.url}/mcp-test/${owner.tenant.slug}/${path.split('/').pop()}`,
      ),
    ).toBeNull();
    expect(
      await helper.verifyAccessToken(accessToken, `${server.url}/mcp/${owner.tenant.slug}/other`),
    ).toBeNull();
    expect(
      await helper.verifyAccessToken(accessToken, `${server.url}/mcp-server/${owner.tenant.slug}/http`),
    ).toBeNull();
    expect(await helper.verifyAccessToken('wfk_x_y', trigger.url)).toBeNull();
    expect(helper.challenge(trigger.url)).toBe(
      `Bearer realm="MCP Server", resource_metadata="${server.url}/.well-known/oauth-protected-resource${path}"`,
    );
  });
});
