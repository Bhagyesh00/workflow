/**
 * P6-15 private credentials (n8n's end-user credentials): one OAuth app on the credential, each user connects
 * their own account (an entry per credential and user, under RLS), and a run uses the entry of the user it
 * acts for. Covers the per user connect (OAuth2 and OAuth1) with the session check on the callback, two users
 * running one workflow, the refresh write-back, the publish refusal, runs with no identity or no connection,
 * the create and switch rules, the list and run flags, and that no token reaches run data or an answer.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataObject, NodePackage } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import { OTHER_USER_CALLBACK_MESSAGE } from '../src/services/oauth2';
import { PRIVATE_PERSONAL_ERROR, PRIVATE_TYPE_ERROR } from '../src/services/private-credentials';
import {
  addToProject,
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let provider: Server;
let providerUrl: string;
/** the provider's token calls, by grant */
const tokenCalls: Array<Record<string, string>> = [];
/** bearer token -> whose account it is */
const accounts = new Map<string, string>();
/** the oauth_callback of the last OAuth1 request-token call (its state), as the provider received it */
let lastCallbackUrl = '';

const privatePackage: NodePackage = {
  name: 'private-credential-tests',
  nodes: [
    {
      description: {
        name: 'test.whoAmI',
        displayName: 'Who am I',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Who' },
        inputs: ['main'],
        outputs: ['main'],
        credentials: [{ name: 'oAuth2Api', required: true }],
        properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
      },
      async execute(ctx) {
        const url = String(ctx.getNodeParameter('url', 0));
        const answer = (await ctx.helpers.httpRequestWithAuthentication('oAuth2Api', { url })) as DataObject;
        return [[{ json: { who: answer.who } }]];
      },
    },
    {
      // a poll trigger whose manual sample calls the provider with the private credential
      description: {
        name: 'test.whoPoll',
        displayName: 'Who polls',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Who polls' },
        inputs: [],
        outputs: ['main'],
        polling: true,
        credentials: [{ name: 'oAuth2Api', required: true }],
        properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
      },
      async poll(ctx) {
        const url = String(ctx.getNodeParameter('url', 0));
        const answer = (await ctx.helpers.httpRequestWithAuthentication('oAuth2Api', { url })) as DataObject;
        return [[{ json: { who: answer.who } }]];
      },
    },
  ],
  credentials: [],
};
/** when true the provider's /me fails (a run to retry) */
let meFails = false;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [privatePackage] });
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        tokenCalls.push(form);
        if (form.grant_type === 'authorization_code') {
          // the code names the account the user signed in with at the provider
          const access = `access-${form.code}-${randomUUID().slice(0, 6)}`;
          accounts.set(access, form.code);
          return json(200, { access_token: access, refresh_token: `refresh-${form.code}`, expires_in: 3600 });
        }
        if (form.grant_type === 'refresh_token') {
          const who = form.refresh_token.replace(/^refresh-/, '');
          const access = `renewed-${who}-${randomUUID().slice(0, 6)}`;
          accounts.set(access, who);
          return json(200, { access_token: access, expires_in: 3600 });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (req.url === '/me') {
        if (meFails) return json(500, { error: 'down' });
        const who = accounts.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
        return who ? json(200, { who }) : json(401, { error: 'invalid_token' });
      }
      if (req.url === '/request_token') {
        // the state rides in the callback URL the request-token call signs
        const callback = /oauth_callback="([^"]*)"/.exec(String(req.headers.authorization ?? ''))?.[1];
        if (callback) lastCallbackUrl = decodeURIComponent(callback);
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
        return void res.end('oauth_token=rt-1&oauth_token_secret=rs-1&oauth_callback_confirmed=true');
      }
      if (req.url === '/access_token') {
        const verifier = /oauth_verifier="([^"]*)"/.exec(String(req.headers.authorization ?? ''))?.[1];
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
        return void res.end(`oauth_token=at-${verifier}&oauth_token_secret=as-1`);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => provider.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  tokenCalls.length = 0;
  accounts.clear();
  meFails = false;
});

const repos = () => server.ctx.repos;

/** an owner with a team project and a member who edits there */
async function setup() {
  const owner = await signup(server.app);
  const team = owner.client.defaultProjectId!;
  const member = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, member.user.id, 'project:editor');
  member.client.defaultProjectId = team;
  return { owner, member, team, tenantId: owner.tenant.id };
}

function oauth2Data(extra: DataObject = {}): DataObject {
  return {
    authUrl: 'https://auth.example.com/authorize',
    accessTokenUrl: `${providerUrl}/token`,
    clientId: 'shared-client',
    clientSecret: 'shared-client-secret',
    scope: 'read',
    ...extra,
  };
}

async function privateCredential(client: TestClient, name = 'Mail') {
  return client.data<{ id: string; name: string }>(
    client.post('/rest/credentials', { name, type: 'oAuth2Api', isResolvable: true, data: oauth2Data() }),
  );
}

/** the per user flow: authorize as `client`, then the provider sends that browser back with `code` */
async function connect(client: TestClient, credentialId: string, code: string, callbackClient = client) {
  const { url } = await client.data<{ url: string }>(client.post(`/rest/credentials/${credentialId}/authorize`));
  const state = new URL(url).searchParams.get('state')!;
  return callbackClient.get(`/rest/oauth2/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

async function whoWorkflow(client: TestClient, credential: { id: string; name: string }) {
  return createWorkflow(client, {
    name: 'Who runs',
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Who', 'test.whoAmI', { url: `${providerUrl}/me` }, [200, 0], {
        credentials: { oAuth2Api: { id: credential.id, name: credential.name } },
      }),
    ],
    connections: chain('Start', 'Who'),
  });
}

async function runAs(client: TestClient, tenantId: string, workflowId: string) {
  const { executionId } = await client.data<{ executionId: string }>(
    client.post(`/rest/workflows/${workflowId}/run`, {}),
  );
  const row = await waitForExecution(server.ctx, tenantId, executionId);
  const data = await repos().executions.getData(tenantId, executionId);
  return { row, data };
}

const entryOf = (tenantId: string, credentialId: string, userId: string) =>
  server.ctx.credentials.readEntry(tenantId, credentialId, userId);

describe('private credentials: connect', () => {
  it('a member connects their own account; the entry is theirs and the shared row keeps no token', async () => {
    const { owner, member, tenantId } = await setup();
    const credential = await privateCredential(owner.client);
    const callback = await connect(member.client, credential.id, 'bea');
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('"status":"success"');

    const entry = await entryOf(tenantId, credential.id, member.user.id);
    expect(entry?.oauthTokenData).toMatchObject({ refresh_token: 'refresh-bea' });
    expect(await entryOf(tenantId, credential.id, owner.user.id)).toBeUndefined();
    const shared = server.ctx.credentials.decrypt((await repos().credentials.get(tenantId, credential.id))!);
    expect(shared.oauthTokenData).toBeUndefined();
    expect(shared.clientSecret).toBe('shared-client-secret');
    // the entry is encrypted with its own binding: the shared binding cannot read it
    const raw = await repos().credentialEntries.get(tenantId, credential.id, member.user.id);
    expect(raw?.dataEnc).not.toContain('refresh-bea');
    expect(() =>
      server.ctx.cipher.decrypt(raw!.dataEnc, { tenantId, credentialId: credential.id }),
    ).toThrow();

    // the answers carry the state, never a token
    const mine = await member.client.data(member.client.get(`/rest/credentials/${credential.id}`));
    expect(mine).toMatchObject({ isResolvable: true, connectedByMe: true, connectedCount: 1 });
    const theirs = await owner.client.data(owner.client.get(`/rest/credentials/${credential.id}`));
    expect(theirs).toMatchObject({ isResolvable: true, connectedByMe: false, connectedCount: 1 });
    const list = await owner.client.data<any[]>(owner.client.get('/rest/credentials'));
    expect(list.find((row) => row.id === credential.id)).toMatchObject({
      isResolvable: true,
      connectedByMe: false,
      connectedCount: 1,
    });
    for (const body of [JSON.stringify(mine), JSON.stringify(theirs), JSON.stringify(list)]) {
      expect(body).not.toContain('access-bea');
      expect(body).not.toContain('refresh-bea');
      expect(body).not.toContain('shared-client-secret');
    }
    const audit = await repos().audit.list(tenantId, 50);
    expect(audit.some((row: { action: string }) => row.action === 'credential.user_connected')).toBe(true);
  });

  it("refuses another user's callback, and one with no session, before any token call", async () => {
    const { owner, member, tenantId } = await setup();
    const credential = await privateCredential(owner.client);
    // the member starts a flow and sends the link to the owner, whose browser comes back with the owner's code
    const sent = await connect(member.client, credential.id, 'owner-account', owner.client);
    expect(sent.statusCode).toBe(400);
    expect(sent.body).toContain(OTHER_USER_CALLBACK_MESSAGE);
    const { url } = await member.client.data<{ url: string }>(
      member.client.post(`/rest/credentials/${credential.id}/authorize`),
    );
    const state = new URL(url).searchParams.get('state')!;
    const anonymous = await server.app.inject({
      url: `/rest/oauth2/callback?code=x&state=${encodeURIComponent(state)}`,
    });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.body).toContain(OTHER_USER_CALLBACK_MESSAGE);
    expect(tokenCalls).toHaveLength(0);
    expect(await entryOf(tenantId, credential.id, member.user.id)).toBeUndefined();
    expect(await entryOf(tenantId, credential.id, owner.user.id)).toBeUndefined();
  });

  it('authorize needs credential:connect; the shared connect refuses a private credential and back', async () => {
    const { owner, member, tenantId, team } = await setup();
    const credential = await privateCredential(owner.client);
    await addToProject(server, tenantId, team, member.user.id, 'project:viewer');
    const denied = await member.client.post(`/rest/credentials/${credential.id}/authorize`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    const shared = await owner.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`);
    expect(shared.statusCode).toBe(400);
    expect(shared.body).toContain('This credential is private');
    const fixed = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', { name: 'Fixed', type: 'oAuth2Api', data: oauth2Data() }),
    );
    const perUser = await owner.client.post(`/rest/credentials/${fixed.id}/authorize`);
    expect(perUser.statusCode).toBe(400);
    expect(perUser.body).toContain('This credential is not private');
  });

  it('DELETE my-connection clears only the caller entry, also after the caller lost access', async () => {
    const { owner, member, tenantId, team } = await setup();
    const credential = await privateCredential(owner.client);
    await connect(member.client, credential.id, 'bea');
    await connect(owner.client, credential.id, 'olga');
    // the entry stays until a cleanup runs: drop the relation by hand (no hook), the member clears their own
    await repos().projects.relations.remove(tenantId, team, member.user.id);
    const cleared = await member.client.delete(`/rest/credentials/${credential.id}/my-connection`);
    expect(cleared.statusCode).toBe(200);
    expect(await entryOf(tenantId, credential.id, member.user.id)).toBeUndefined();
    expect(await entryOf(tenantId, credential.id, owner.user.id)).toBeDefined();
    const missing = await owner.client.delete(`/rest/credentials/${randomUUID()}/my-connection`);
    expect(missing.statusCode).toBe(404);
  });

  it('OAuth1: the per user callback writes the entry; the shared callback still writes the row', async () => {
    const { owner, member, tenantId } = await setup();
    const data = {
      requestTokenUrl: `${providerUrl}/request_token`,
      authUrl: 'https://auth.example.com/authorize',
      accessTokenUrl: `${providerUrl}/access_token`,
      consumerKey: 'consumer-1',
      consumerSecret: 'consumer-secret',
    };
    const privateOne = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', { name: 'Tw', type: 'oAuth1Api', isResolvable: true, data }),
    );
    const stateOf = (callbackUrl: string) => new URL(callbackUrl).searchParams.get('state')!;
    const signedState = await lastOAuth1State(member.client, privateOne.id);
    const other = await owner.client.get(
      `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(signedState)}`,
    );
    expect(other.statusCode).toBe(400);
    expect(other.body).toContain(OTHER_USER_CALLBACK_MESSAGE);
    const own = await member.client.get(
      `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v2&state=${encodeURIComponent(signedState)}`,
    );
    expect(own.statusCode).toBe(200);
    expect((await entryOf(tenantId, privateOne.id, member.user.id))?.oauthTokenData).toMatchObject({
      oauth_token: 'at-v2',
    });
    expect(
      server.ctx.credentials.decrypt((await repos().credentials.get(tenantId, privateOne.id))!).oauthTokenData,
    ).toBeUndefined();

    const fixed = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', { name: 'Tw fixed', type: 'oAuth1Api', data }),
    );
    const shared = await owner.client.data<{ url: string }>(
      owner.client.get(`/rest/oauth1/authorize?credentialId=${fixed.id}`),
    );
    expect(shared.url).toContain('oauth_token=rt-1');
    const fixedState = stateOf(lastCallbackUrl);
    const done = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v3&state=${encodeURIComponent(fixedState)}`,
    });
    expect(done.statusCode).toBe(200);
    expect(
      server.ctx.credentials.decrypt((await repos().credentials.get(tenantId, fixed.id))!).oauthTokenData,
    ).toMatchObject({ oauth_token: 'at-v3' });
  });
});

/** starts the OAuth1 per user flow as `client` and reads the signed state back from the provider */
async function lastOAuth1State(client: TestClient, credentialId: string): Promise<string> {
  const { url } = await client.data<{ url: string }>(client.post(`/rest/credentials/${credentialId}/authorize`));
  expect(url).toContain('oauth_token=rt-1');
  return new URL(lastCallbackUrl).searchParams.get('state')!;
}

describe('private credentials: runs', () => {
  it("two users run one workflow and each run uses that user's own token", async () => {
    const { owner, member, tenantId } = await setup();
    const credential = await privateCredential(owner.client);
    await connect(owner.client, credential.id, 'olga');
    await connect(member.client, credential.id, 'bea');
    const workflow = await whoWorkflow(owner.client, credential);

    const ownerRun = await runAs(owner.client, tenantId, workflow.id);
    const memberRun = await runAs(member.client, tenantId, workflow.id);
    expect(ownerRun.row.status).toBe('success');
    expect(memberRun.row.status).toBe('success');
    expect(outputOf(ownerRun.data?.state, 'Who')).toEqual([{ who: 'olga' }]);
    expect(outputOf(memberRun.data?.state, 'Who')).toEqual([{ who: 'bea' }]);

    // no token in run data, and the run carries the flag
    for (const run of [ownerRun, memberRun]) {
      const text = JSON.stringify(run.data);
      expect(text).not.toMatch(/access-(olga|bea)/);
      expect(text).not.toMatch(/refresh-(olga|bea)/);
      expect(text).not.toContain('shared-client-secret');
      expect(run.row.usedPrivateCredentials).toBe(true);
    }
    const executions = await owner.client.data<any[]>(
      owner.client.get(`/rest/executions?workflowId=${workflow.id}`),
    );
    expect(executions.map((row) => row.usedPrivateCredentials)).toEqual([true, true]);
    const page = await owner.client.request('GET', '/rest/executions');
    expect(page.body).not.toMatch(/access-(olga|bea)/);
    const workflows = await owner.client.data<any[]>(owner.client.get('/rest/workflows'));
    expect(workflows.find((row) => row.id === workflow.id)?.usesPrivateCredentials).toBe(true);
  });

  it("a refresh writes only that user's entry, never the shared row or another user's entry", async () => {
    const { owner, member, tenantId } = await setup();
    const credential = await privateCredential(owner.client);
    await connect(owner.client, credential.id, 'olga');
    await connect(member.client, credential.id, 'bea');
    const ownerBefore = await entryOf(tenantId, credential.id, owner.user.id);
    // the member's token has expired: the run refreshes it
    const expired = await entryOf(tenantId, credential.id, member.user.id);
    await server.ctx.credentials.saveEntry(tenantId, credential.id, member.user.id, {
      ...expired,
      oauthTokenData: { ...(expired?.oauthTokenData as DataObject), expires_at: Date.now() - 60_000 },
    });
    const sharedBefore = (await repos().credentials.get(tenantId, credential.id))!.dataEnc;

    const workflow = await whoWorkflow(owner.client, credential);
    const run = await runAs(member.client, tenantId, workflow.id);
    expect(outputOf(run.data?.state, 'Who')).toEqual([{ who: 'bea' }]);
    expect(tokenCalls.filter((call) => call.grant_type === 'refresh_token')).toEqual([
      expect.objectContaining({ refresh_token: 'refresh-bea' }),
    ]);
    const after = await entryOf(tenantId, credential.id, member.user.id);
    expect(String((after?.oauthTokenData as DataObject).access_token)).toMatch(/^renewed-bea-/);
    expect((after?.oauthTokenData as DataObject).refresh_token).toBe('refresh-bea');
    expect(await entryOf(tenantId, credential.id, owner.user.id)).toEqual(ownerBefore);
    expect((await repos().credentials.get(tenantId, credential.id))!.dataEnc).toBe(sharedBefore);
  });

  it('a run with no identity fails, and so does a user with no connection (no fallback)', async () => {
    const { owner, member, tenantId, team } = await setup();
    const credential = await privateCredential(owner.client);
    await connect(owner.client, credential.id, 'olga');
    const ref = { id: credential.id, name: credential.name };
    await expect(server.ctx.credentials.provider(tenantId, team).get(ref, 'oAuth2Api')).rejects.toThrow(
      /is private: each user connects their own account, and this run was not started by a signed-in user/,
    );
    await expect(
      server.ctx.credentials.provider(tenantId, team, { endUserId: member.user.id }).get(ref, 'oAuth2Api'),
    ).rejects.toThrow(/is not connected for this user/);

    const workflow = await whoWorkflow(owner.client, credential);
    const run = await runAs(member.client, tenantId, workflow.id);
    expect(run.row.status).toBe('error');
    expect(run.row.errorMessage).toMatch(/is not connected for this user/);
    expect(run.row.usedPrivateCredentials).toBe(false);
    // the owner's connection is never used for the member
    expect(tokenCalls.filter((call) => call.grant_type !== 'authorization_code')).toHaveLength(0);
  });

  it("a retry by another member runs as that member, never with the original user's connection", async () => {
    const { owner, member, tenantId, team } = await setup();
    const other = await realMember(owner);
    await addToProject(server, tenantId, team, other.user.id, 'project:editor');
    other.client.defaultProjectId = team;
    const credential = await privateCredential(owner.client);
    await connect(member.client, credential.id, 'bea');
    await connect(other.client, credential.id, 'otto');
    const workflow = await whoWorkflow(owner.client, credential);
    meFails = true;
    const failed = await runAs(member.client, tenantId, workflow.id);
    expect(failed.row.status).toBe('error');
    meFails = false;

    const { executionId } = await other.client.data<{ executionId: string }>(
      other.client.post(`/rest/executions/${failed.row.id}/retry`, {}),
    );
    await waitForExecution(server.ctx, tenantId, executionId);
    const retried = await repos().executions.getData(tenantId, executionId);
    expect(outputOf(retried?.state, 'Who')).toEqual([{ who: 'otto' }]);
    expect(retried?.runOptions).toMatchObject({ endUserId: other.user.id });
    // the original user retries their own run with their own connection
    const own = await member.client.data<{ executionId: string }>(
      member.client.post(`/rest/executions/${failed.row.id}/retry`, {}),
    );
    await waitForExecution(server.ctx, tenantId, own.executionId);
    const ownData = await repos().executions.getData(tenantId, own.executionId);
    expect(outputOf(ownData?.state, 'Who')).toEqual([{ who: 'bea' }]);
  });

  it("a manual run's trigger sample uses the private credential of the user who runs it", async () => {
    const { owner, member, tenantId } = await setup();
    const credential = await privateCredential(owner.client);
    await connect(member.client, credential.id, 'bea');
    const workflow = await createWorkflow(owner.client, {
      name: 'Who polls',
      nodes: [
        node('Poll', 'test.whoPoll', { url: `${providerUrl}/me` }, [0, 0], {
          credentials: { oAuth2Api: { id: credential.id, name: credential.name } },
        }),
      ],
      connections: {},
    });
    const run = await runAs(member.client, tenantId, workflow.id);
    expect(run.row.status).toBe('success');
    expect(outputOf(run.data?.state, 'Poll')).toEqual([{ who: 'bea' }]);
    // the owner has no connection: the sample fails for them, the member's is never used
    const refused = await owner.client.post(`/rest/workflows/${workflow.id}/run`, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/is not connected for this user/);
  });

  it('a private credential publishes only when every enabled trigger gives a user identity', async () => {
    const { owner } = await setup();
    const credential = await privateCredential(owner.client);
    const who = node('Who', 'test.whoAmI', { url: `${providerUrl}/me` }, [200, 0], {
      credentials: { oAuth2Api: { id: credential.id, name: credential.name } },
    });
    const scheduled = await createWorkflow(owner.client, {
      name: 'Nightly',
      nodes: [node('Every', 'core.scheduleTrigger'), who],
      connections: chain('Every', 'Who'),
    });
    const refused = await owner.client.post(`/rest/workflows/${scheduled.id}/activate`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(
      /^Cannot publish workflow: end-user credentials \(Mail\) are only supported with Manual Trigger/,
    );
    // the private credential named by name only counts too
    const byName = await createWorkflow(owner.client, {
      name: 'By name',
      nodes: [
        node('Every', 'core.scheduleTrigger'),
        { ...who, credentials: { oAuth2Api: { id: null, name: credential.name } } } as never,
      ],
      connections: chain('Every', 'Who'),
    });
    const byNameRefused = await owner.client.post(`/rest/workflows/${byName.id}/activate`);
    expect(byNameRefused.statusCode).toBe(400);
    expect(byNameRefused.body).toContain('end-user credentials (Mail)');

    // a Webhook with workspace sign-in gives an identity, and a disabled schedule beside it does not count
    const signedIn = await createWorkflow(owner.client, {
      name: 'Signed in',
      nodes: [
        node('Webhook', 'core.webhook', {
          httpMethod: 'POST',
          path: `who-${randomUUID().slice(0, 8)}`,
          authentication: 'n8nOAuth2',
        }),
        { ...node('Every', 'core.scheduleTrigger', {}, [0, 200]), disabled: true },
        who,
      ],
      connections: chain('Webhook', 'Who'),
    });
    const published = await owner.client.post(`/rest/workflows/${signedIn.id}/activate`);
    expect(published.statusCode).toBe(200);
    // the same schedule enabled refuses it again
    const enabled = await createWorkflow(owner.client, {
      name: 'Signed in and nightly',
      nodes: [
        node('Webhook', 'core.webhook', {
          httpMethod: 'POST',
          path: `who-${randomUUID().slice(0, 8)}`,
          authentication: 'n8nOAuth2',
        }),
        node('Every', 'core.scheduleTrigger', {}, [0, 200]),
        who,
      ],
      connections: chain('Webhook', 'Who'),
    });
    expect((await owner.client.post(`/rest/workflows/${enabled.id}/activate`)).statusCode).toBe(400);
  });
});

describe('private credentials: create and switch', () => {
  it('only OAuth types, never in a personal project, and only with credential:createEndUser', async () => {
    const { owner, member, team, tenantId } = await setup();
    const notOAuth = await owner.client.post('/rest/credentials', {
      name: 'Key',
      type: 'testApi',
      isResolvable: true,
      data: { apiKey: 'k' },
    });
    expect(notOAuth.statusCode).toBe(400);
    expect(notOAuth.json().error.message).toBe(PRIVATE_TYPE_ERROR);

    const personal = await repos().projects.getPersonal(tenantId, owner.user.id);
    const inPersonal = await owner.client.post('/rest/credentials', {
      name: 'Mine',
      type: 'oAuth2Api',
      isResolvable: true,
      projectId: personal!.id,
      data: oauth2Data(),
    });
    expect(inPersonal.statusCode).toBe(400);
    expect(inPersonal.json().error.message).toBe(PRIVATE_PERSONAL_ERROR);

    // a project editor creates credentials but holds no credential:createEndUser
    const byEditor = await member.client.post('/rest/credentials', {
      name: 'Ed',
      type: 'oAuth2Api',
      isResolvable: true,
      projectId: team,
      data: oauth2Data(),
    });
    expect(byEditor.statusCode).toBe(403);
    const fixed = await member.client.data<{ id: string }>(
      member.client.post('/rest/credentials', { name: 'Ed fixed', type: 'oAuth2Api', data: oauth2Data() }),
    );
    const toggle = await member.client.patch(`/rest/credentials/${fixed.id}`, { isResolvable: true });
    expect(toggle.statusCode).toBe(403);
    const toggled = await owner.client.data(owner.client.patch(`/rest/credentials/${fixed.id}`, { isResolvable: true }));
    expect(toggled).toMatchObject({ isResolvable: true, connectedCount: 0, connectedByMe: false });
    // deleting a private one needs credential:createEndUser too
    expect((await member.client.delete(`/rest/credentials/${fixed.id}`)).statusCode).toBe(403);
    expect((await owner.client.delete(`/rest/credentials/${fixed.id}`)).statusCode).toBe(200);
  });

  it('the entry table is under RLS: a role other than the owner sees only the rows of its tenant', async () => {
    const a = await setup();
    const b = await setup();
    const ca = await privateCredential(a.owner.client);
    const cb = await privateCredential(b.owner.client);
    await connect(a.owner.client, ca.id, 'a1');
    await connect(b.owner.client, cb.id, 'b1');
    const client = await server.ctx.database.pool.connect();
    const role = `wf_rls_l14_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT SELECT ON credential_user_entries TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      const none = await client.query('SELECT count(*)::int AS n FROM credential_user_entries');
      expect(none.rows[0].n).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      const { rows } = await client.query('SELECT tenant_id, credential_id FROM credential_user_entries');
      expect(rows).toEqual([{ tenant_id: a.tenantId, credential_id: ca.id }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // the repository filters the tenant too: B's id under A's tenant finds nothing
    expect(await repos().credentialEntries.get(a.tenantId, cb.id, b.owner.user.id)).toBeUndefined();
  });
});
