/**
 * P6-16 (L15): OAuth2 token responses encrypted as JWE. Run with
 * TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/workflow_test_p6_s2_jwe and
 * TEST_REDIS_URL=redis://127.0.0.1:6379/15. The token endpoint is a local fake on 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialTypes, type OAuth2Data, requestOAuth2Token } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import { CompactEncrypt, importJWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCredential } from '../src/services/credential-test';
import { CredentialService } from '../src/services/credentials';
import { createTestServer, resetDatabase, signup, type TestServer } from './helpers';

let server: TestServer;
let remote: Server;
let remoteUrl: string;
/** what the fake token endpoint answers next */
let tokenAnswer: Record<string, unknown> = {};
let tokenCalls = 0;
/** the bearer the fake resource endpoint saw last */
let seenBearer = '';

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/token') {
        tokenCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(tokenAnswer));
        return;
      }
      if (req.url === '/me') {
        seenBearer = String(req.headers.authorization ?? '');
        res.writeHead(seenBearer === 'Bearer plain-access' ? 200 : 401, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => remote.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  tokenAnswer = {};
  tokenCalls = 0;
  seenBearer = '';
});

type Jwk = Record<string, unknown>;

async function jwksOf(slug: string): Promise<{ keys: Jwk[] }> {
  const res = await server.app.inject({ url: `/.well-known/jwks/${slug}.json` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** a compact JWE of `plain` for the workspace's first public key */
async function jwe(slug: string, plain: string, header: Record<string, unknown> = {}): Promise<string> {
  const jwk = (await jwksOf(slug)).keys[0];
  const key = await importJWK(jwk, 'RSA-OAEP-256');
  return new CompactEncrypt(new TextEncoder().encode(plain))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: jwk.kid as string, ...header })
    .encrypt(key);
}

function oauthData(extra: Partial<OAuth2Data> = {}): OAuth2Data {
  return {
    grantType: 'clientCredentials' as const,
    accessTokenUrl: `${remoteUrl}/token`,
    clientId: 'client-1',
    clientSecret: 'client-secret',
    authentication: 'body' as const,
    jweEnabled: true,
    ...extra,
  };
}

/** the hook as the server wires it for a run: the workspace's `decryptResponse` */
function hookFor(tenantId: string) {
  return (token: Record<string, unknown>, data: Record<string, unknown>) =>
    server.ctx.oauthJwe.decryptResponse(tenantId, token, data);
}

describe('JWKS route', () => {
  it('serves the public keys only, cached one hour, and 404 for an unknown workspace', async () => {
    const { tenant } = await signup(server.app);
    const res = await server.app.inject({ url: `/.well-known/jwks/${tenant.slug}.json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const body = res.json() as { keys: Jwk[] };
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0];
    expect(key).toMatchObject({ kty: 'RSA', use: 'enc', alg: 'RSA-OAEP-256' });
    expect(typeof key.kid).toBe('string');
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(key).not.toHaveProperty(secret);
    expect(res.body).not.toMatch(/PRIVATE|"d":/);
    // the same key on the next call: made once
    expect((await jwksOf(tenant.slug)).keys).toEqual(body.keys);

    const unknown = await server.app.inject({ url: `/.well-known/jwks/no-such-${Date.now()}.json` });
    expect(unknown.statusCode).toBe(404);
  });

  it('stores the private part encrypted with the tenant and jwe:<kid> binding', async () => {
    const { tenant } = await signup(server.app);
    const kid = (await jwksOf(tenant.slug)).keys[0].kid as string;
    const row = await server.ctx.repos.jweKeys.get(tenant.id, kid);
    expect(row!.privateEnc).toMatch(/^v1\.test\./);
    expect(row!.privateEnc).not.toContain('PRIVATE');
    const pem = server.ctx.cipher.decrypt<string>(row!.privateEnc, {
      tenantId: tenant.id,
      credentialId: `jwe:${kid}`,
    });
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(() =>
      server.ctx.cipher.decrypt(row!.privateEnc, { tenantId: tenant.id, credentialId: 'jwe:other' }),
    ).toThrow();
    expect(await server.ctx.repos.jweKeys.get(tenant.id, 'missing')).toBeUndefined();
    expect(await server.ctx.repos.jweKeys.list(tenant.id)).toHaveLength(1);
    expect(await server.ctx.repos.jweKeys.delete(tenant.id, kid)).toBe(true);
    expect(await server.ctx.repos.jweKeys.delete(tenant.id, kid)).toBe(false);
  });
});

describe('decryptResponse', () => {
  it('leaves a response unchanged when the flag is off', async () => {
    const { tenant } = await signup(server.app);
    const token = { access_token: 'plain-access', token_type: 'Bearer' };
    expect(await server.ctx.oauthJwe.decryptResponse(tenant.id, token, { jweEnabled: false })).toEqual(token);
    expect(await server.ctx.oauthJwe.decryptResponse(tenant.id, token, {})).toEqual(token);
  });

  it('opens the encrypted tokens and keeps the other fields', async () => {
    const { tenant } = await signup(server.app);
    const out = await server.ctx.oauthJwe.decryptResponse(
      tenant.id,
      {
        access_token: await jwe(tenant.slug, 'plain-access'),
        refresh_token: await jwe(tenant.slug, 'plain-refresh', { enc: 'A128CBC-HS256' }),
        token_type: 'Bearer',
        expires_in: 3600,
      },
      { jweEnabled: true },
    );
    expect(out).toEqual({
      access_token: 'plain-access',
      refresh_token: 'plain-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('refuses a plain response while it is on', async () => {
    const { tenant } = await signup(server.app);
    await expect(
      server.ctx.oauthJwe.decryptResponse(
        tenant.id,
        { access_token: 'plain-access', refresh_token: 'plain-refresh' },
        { jweEnabled: true },
      ),
    ).rejects.toThrow(/no encrypted token/);
  });

  it("refuses another workspace's key: tenant B cannot open a token made for tenant A", async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    // both workspaces have a key
    await jwksOf(b.tenant.slug);
    const forA = await jwe(a.tenant.slug, 'plain-access');
    await expect(
      server.ctx.oauthJwe.decryptResponse(b.tenant.id, { access_token: forA }, { jweEnabled: true }),
    ).rejects.toThrow(/Couldn't decrypt/);
    // and A's own key opens it
    const out = await server.ctx.oauthJwe.decryptResponse(a.tenant.id, { access_token: forA }, { jweEnabled: true });
    expect(out.access_token).toBe('plain-access');
    // a workspace with no key at all cannot open it either
    await server.ctx.repos.jweKeys.delete(
      b.tenant.id,
      (await server.ctx.repos.jweKeys.list(b.tenant.id))[0].kid,
    );
    await expect(
      server.ctx.oauthJwe.decryptResponse(b.tenant.id, { access_token: forA }, { jweEnabled: true }),
    ).rejects.toThrow(/Couldn't decrypt/);
  });

  it('refuses alg none and a wrong key management algorithm', async () => {
    const { tenant } = await signup(server.app);
    const kid = (await jwksOf(tenant.slug)).keys[0].kid as string;
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${part({ alg: 'none', enc: 'A256GCM', kid })}..${part('iv')}.${part('ct')}.${part('tag')}`;
    await expect(
      server.ctx.oauthJwe.decryptResponse(tenant.id, { access_token: none }, { jweEnabled: true }),
    ).rejects.toThrow(/Couldn't decrypt/);

    // RSA-OAEP (SHA-1) made for the same key: a valid JWE, but not the algorithm we accept
    const jwk = (await jwksOf(tenant.slug)).keys[0];
    const sha1 = await new CompactEncrypt(new TextEncoder().encode('plain-access'))
      .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM', kid })
      .encrypt(await importJWK({ ...jwk, alg: 'RSA-OAEP' }, 'RSA-OAEP'));
    await expect(
      server.ctx.oauthJwe.decryptResponse(tenant.id, { access_token: sha1 }, { jweEnabled: true }),
    ).rejects.toThrow(/Couldn't decrypt/);
    // a token that only looks like a JWE (five parts, no real header) counts as plain
    await expect(
      server.ctx.oauthJwe.decryptResponse(tenant.id, { access_token: 'a.b.c.d.e' }, { jweEnabled: true }),
    ).rejects.toThrow(/no encrypted token/);
  });
});

describe('credential type', () => {
  it('offers jweEnabled on oAuth2Api only, a child type has no field', () => {
    const types = server.ctx.registries.credentialTypes;
    expect(types.getResolved('oAuth2Api')!.properties.map((p) => p.name)).toContain('jweEnabled');
    const jwe = types.getResolved('oAuth2Api')!.properties.find((p) => p.name === 'jweEnabled');
    expect(jwe).toMatchObject({ type: 'boolean', default: false, doNotInherit: true });
    for (const child of ['googleOAuth2Api', 'gmailOAuth2', 'testPkceOAuth2Api']) {
      expect(types.getResolved(child)!.properties.map((p) => p.name)).not.toContain('jweEnabled');
    }
  });
});

describe('the three token paths', () => {
  it('callback: a JWE response is decrypted and stored; a plain one is refused', async () => {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Encrypted provider',
        type: 'oAuth2Api',
        data: oauthData({ grantType: 'authorizationCode', authUrl: 'https://auth.example.com/authorize' }),
      }),
    );
    const connect = async () => {
      const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
      const state = new URL(url).searchParams.get('state')!;
      return server.app.inject({ url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}` });
    };

    tokenAnswer = { access_token: 'plain-access', refresh_token: 'plain-refresh', expires_in: 3600 };
    const plain = await connect();
    expect(plain.statusCode).toBe(400);
    expect(plain.body).toContain('"status":"error"');
    let row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).oauthTokenData).toBeUndefined();

    tokenAnswer = {
      access_token: await jwe(tenant.slug, 'plain-access'),
      refresh_token: await jwe(tenant.slug, 'plain-refresh'),
      expires_in: 3600,
    };
    const ok = await connect();
    expect(ok.statusCode).toBe(200);
    row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).oauthTokenData).toMatchObject({
      access_token: 'plain-access',
      refresh_token: 'plain-refresh',
    });
  });

  it('refresh: a JWE response is decrypted; a plain one is refused', async () => {
    const { tenant } = await signup(server.app);
    const data = oauthData({ grantType: 'authorizationCode' });
    const grant = { type: 'refresh_token', refreshToken: 'old-refresh' } as const;

    tokenAnswer = { access_token: await jwe(tenant.slug, 'plain-access'), expires_in: 60 };
    const fresh = await requestOAuth2Token(server.ctx.http, data, grant, undefined, hookFor(tenant.id));
    expect(fresh.access_token).toBe('plain-access');
    // no new refresh token came: the old one stays
    expect(fresh.refresh_token).toBe('old-refresh');

    tokenAnswer = { access_token: 'plain-access' };
    await expect(
      requestOAuth2Token(server.ctx.http, data, grant, undefined, hookFor(tenant.id)),
    ).rejects.toThrow(/no encrypted token/);
  });

  it('client credentials: a JWE response is decrypted; a plain one is refused', async () => {
    const { tenant } = await signup(server.app);
    const data = oauthData();
    const grant = { type: 'client_credentials' } as const;

    tokenAnswer = { access_token: await jwe(tenant.slug, 'plain-access'), expires_in: 60 };
    const fresh = await requestOAuth2Token(server.ctx.http, data, grant, undefined, hookFor(tenant.id));
    expect(fresh.access_token).toBe('plain-access');

    tokenAnswer = { access_token: 'plain-access' };
    await expect(
      requestOAuth2Token(server.ctx.http, data, grant, undefined, hookFor(tenant.id)),
    ).rejects.toThrow(/no encrypted token/);

    // with the flag off the same plain answer works and the hook changes nothing
    const off = await requestOAuth2Token(
      server.ctx.http,
      oauthData({ jweEnabled: false }),
      grant,
      undefined,
      hookFor(tenant.id),
    );
    expect(off.access_token).toBe('plain-access');
  });

  it("a JWE credential's test call decrypts", async () => {
    const { tenant } = await signup(server.app);
    const oauth2 = nodesBasePackage.credentials.find((c) => c.name === 'oAuth2Api')!;
    const credentials = new CredentialService(
      server.ctx.repos,
      server.ctx.cipher,
      new CredentialTypes([
        oauth2,
        {
          name: 'jweTestOAuth2Api',
          displayName: 'JWE test OAuth2',
          extends: ['oAuth2Api'],
          properties: [],
          test: { request: { url: `${remoteUrl}/me` } },
        },
      ]),
    );
    const opts = {
      nodeTypes: server.ctx.registries.nodeTypes,
      tenantId: tenant.id,
      logger: console as never,
      oauthTokenDecrypt: hookFor(tenant.id),
    };

    tokenAnswer = { access_token: await jwe(tenant.slug, 'plain-access'), expires_in: 60 };
    const ok = await testCredential(credentials, server.ctx.http, 'jweTestOAuth2Api', oauthData(), opts);
    expect(ok).toEqual({ status: 'OK', message: 'Connection tested successfully' });
    // the resource saw the decrypted token, not the JWE
    expect(seenBearer).toBe('Bearer plain-access');

    // a plain answer is refused on the test call too
    tokenAnswer = { access_token: 'plain-access' };
    const refused = await testCredential(credentials, server.ctx.http, 'jweTestOAuth2Api', oauthData(), opts);
    expect(refused.status).toBe('Error');
    expect(refused.message).toMatch(/no encrypted token/);
    expect(tokenCalls).toBe(2);
  });
});
