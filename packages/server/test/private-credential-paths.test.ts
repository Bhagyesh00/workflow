/**
 * P6-15 and P6-16 (S2 fix round): the private credential rules on every path, not only the REST route.
 * A private credential's delete needs `credential:createEndUser` on the public API and the assistant tool too;
 * a per user Connect of an MCP credential with automatic registration keeps the shared row's client; the
 * credential test of the REST route and of the assistant tool opens a JWE token answer. Run with
 * TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/workflow_test_p6_s2_private and
 * TEST_REDIS_URL=redis://127.0.0.1:6379/14. Every endpoint is a local fake on 127.0.0.1.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject } from '@workflow/workflow';
import { CompactEncrypt, importJWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import { credentialsTools } from '../src/services/assistant/tools/credentials';
import { MCP_CLIENT_FIRST_MESSAGE } from '../src/services/oauth2';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
let remote: Server;
let remoteUrl: string;
/** every request the fake saw, by path */
const seen: string[] = [];
/** what the fake token endpoint answers next */
let tokenAnswer: Record<string, unknown> = {};
/** the bearer the fake resource endpoint saw last */
let seenBearer = '';

beforeAll(async () => {
  remote = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(String(req.url));
      if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(tokenAnswer));
      }
      if (req.url === '/me') {
        seenBearer = String(req.headers.authorization ?? '');
        res.writeHead(seenBearer === 'Bearer plain-access' ? 200 : 401, {
          'content-type': 'application/json',
        });
        return void res.end('{}');
      }
      // the MCP discovery finds nothing here
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  server = await createTestServer(
    {},
    {
      nodePackages: [
        nodesAiPackage,
        {
          name: 'private-credential-path-tests',
          nodes: [],
          credentials: [
            {
              name: 'jweTestOAuth2Api',
              displayName: 'JWE test OAuth2',
              extends: ['oAuth2Api'],
              properties: [],
              test: { request: { url: `${remoteUrl}/me` } },
            },
          ],
        },
      ],
    },
  );
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => remote.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  seen.length = 0;
  tokenAnswer = {};
  seenBearer = '';
});

const repos = () => server.ctx.repos;

/** an owner with a team project and a true member who edits there */
async function setup() {
  const owner = await signup(server.app);
  const team = owner.client.defaultProjectId!;
  const member = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, member.user.id, 'project:editor');
  member.client.defaultProjectId = team;
  return { owner, member, team, tenantId: owner.tenant.id };
}

const oauth2Data = (): DataObject => ({
  authUrl: 'https://auth.example.com/authorize',
  accessTokenUrl: `${remoteUrl}/token`,
  clientId: 'shared-client',
  clientSecret: 'shared-client-secret',
});

async function credential(client: TestClient, body: Record<string, unknown>) {
  return client.data<{ id: string; name: string }>(client.post('/rest/credentials', body));
}

async function keyOf(client: TestClient): Promise<string> {
  const made = await client.data<{ key: string }>(
    client.post('/rest/api-keys', { name: `k-${randomUUID()}` }),
  );
  return made.key;
}

const publicDelete = (key: string, id: string) =>
  server.app.inject({ method: 'DELETE', url: `/api/v1/credentials/${id}`, headers: { 'x-api-key': key } });

/** a tool's handler, called as the assistant calls it for `userId` after the card was approved */
function tool(name: string) {
  const found = credentialsTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return (tenantId: string, userId: string, input: Record<string, unknown>) =>
    found.handler(
      server.ctx,
      { tenant: { id: tenantId }, user: { id: userId }, actor: { userId, ip: '127.0.0.1' } } as never,
      input as never,
    );
}

describe('private credential delete on every path', () => {
  it('a project editor deletes a fixed credential but not a private one, by the public API or the assistant', async () => {
    const { owner, member, tenantId } = await setup();
    const shared = await credential(owner.client, {
      name: 'Private',
      type: 'oAuth2Api',
      isResolvable: true,
      data: oauth2Data(),
    });
    const fixed = await credential(member.client, { name: 'Fixed', type: 'oAuth2Api', data: oauth2Data() });
    const key = await keyOf(member.client);

    const refused = await publicDelete(key, shared.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(MISSING_SCOPE_MESSAGE);
    await expect(
      tool('delete_credential')(tenantId, member.user.id, { credentialId: shared.id }),
    ).rejects.toThrow(MISSING_SCOPE_MESSAGE);
    expect(await repos().credentials.get(tenantId, shared.id)).toBeDefined();
    expect((await member.client.delete(`/rest/credentials/${shared.id}`)).statusCode).toBe(403);

    // the member's own fixed credential still goes by the public API
    expect((await publicDelete(key, fixed.id)).statusCode).toBe(200);
    expect(await repos().credentials.get(tenantId, fixed.id)).toBeUndefined();
    // and someone with credential:createEndUser deletes the private one through the assistant
    await tool('delete_credential')(tenantId, owner.user.id, { credentialId: shared.id });
    expect(await repos().credentials.get(tenantId, shared.id)).toBeUndefined();
  });
});

describe('per user Connect of an MCP credential with automatic registration', () => {
  it("keeps the shared row's client; only a caller who may update it registers the first one", async () => {
    const { owner, member, tenantId, team } = await setup();
    const mcp = await credential(owner.client, {
      name: 'MCP',
      type: 'mcpOAuth2Api',
      isResolvable: true,
      projectId: team,
      data: { useDynamicClientRegistration: true, resourceUrl: `${remoteUrl}/mcp/tools` },
    });
    // a sharee holds credential:connect on it, not credential:update
    const away = await projectIn(server, tenantId, 'Away');
    const sharee = await realMember(owner);
    await addToProject(server, tenantId, away.id, sharee.user.id, 'project:editor');
    await owner.client.data(
      owner.client.put(`/rest/credentials/${mcp.id}/share`, { shareWithIds: [away.id] }),
    );
    const before = (await repos().credentials.get(tenantId, mcp.id))!.dataEnc;

    const first = await sharee.client.post(`/rest/credentials/${mcp.id}/authorize`);
    expect(first.statusCode).toBe(400);
    expect(first.json().error.message).toBe(MCP_CLIENT_FIRST_MESSAGE);
    expect(seen).toEqual([]);
    expect((await repos().credentials.get(tenantId, mcp.id))!.dataEnc).toBe(before);

    // the project editor may update it: the first per user Connect looks for the authorization server
    const editor = await member.client.post(`/rest/credentials/${mcp.id}/authorize`);
    expect(editor.statusCode).toBe(400);
    expect(seen.length).toBeGreaterThan(0);

    // once a client is stored, every per user Connect uses it and never writes the shared row
    await owner.client.data(
      owner.client.patch(`/rest/credentials/${mcp.id}`, {
        data: {
          useDynamicClientRegistration: true,
          resourceUrl: `${remoteUrl}/mcp/tools`,
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/token`,
          clientId: 'registered-client',
        },
      }),
    );
    const stored = (await repos().credentials.get(tenantId, mcp.id))!.dataEnc;
    seen.length = 0;
    for (const client of [sharee.client, member.client]) {
      const { url } = await client.data<{ url: string }>(
        client.post(`/rest/credentials/${mcp.id}/authorize`),
      );
      expect(new URL(url).searchParams.get('client_id')).toBe('registered-client');
    }
    expect(seen).toEqual([]);
    expect((await repos().credentials.get(tenantId, mcp.id))!.dataEnc).toBe(stored);
  });
});

/** a compact JWE of `plain` for the workspace's first public key */
async function jwe(slug: string, plain: string): Promise<string> {
  const res = await server.app.inject({ url: `/.well-known/jwks/${slug}.json` });
  const jwk = (res.json() as { keys: Array<Record<string, unknown>> }).keys[0];
  const key = await importJWK(jwk, 'RSA-OAEP-256');
  return new CompactEncrypt(new TextEncoder().encode(plain))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: jwk.kid as string })
    .encrypt(key);
}

const jweData = (): DataObject => ({
  grantType: 'clientCredentials',
  accessTokenUrl: `${remoteUrl}/token`,
  clientId: 'client-1',
  clientSecret: 'client-secret',
  authentication: 'body',
  jweEnabled: true,
});

describe('the credential test of a JWE credential', () => {
  it('decrypts the token answer in the REST route and in the assistant tool', async () => {
    const { member, tenantId, team } = await setup();
    tokenAnswer = { access_token: await jwe(member.tenant.slug, 'plain-access'), expires_in: 60 };
    const tested = await member.client.data<{ status: string }>(
      member.client.post('/rest/credentials/test', {
        type: 'jweTestOAuth2Api',
        data: jweData(),
        projectId: team,
      }),
    );
    expect(tested.status).toBe('OK');
    expect(seenBearer).toBe('Bearer plain-access');

    seenBearer = '';
    const stored = await credential(member.client, {
      name: 'JWE',
      type: 'jweTestOAuth2Api',
      data: jweData(),
    });
    // the assistant tests the stored data (not an empty merge) and opens the JWE answer too
    const result = await tool('test_credential')(tenantId, member.user.id, { credentialId: stored.id });
    expect(result).toMatchObject({ status: 'OK' });
    expect(seenBearer).toBe('Bearer plain-access');
  });
});
