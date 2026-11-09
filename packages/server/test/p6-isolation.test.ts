/**
 * P6-40 (L25), the route families and live paths. Two true members, ann in project A and ben in project B,
 * and one resource of each kind in each project. Every family of the route matrix is called by one member
 * against the other's project: a hidden row in the workspace is 403 with n8n's text, a list never holds it, a
 * create in the other project is refused, and the project's own call passes. Also the paths that are not a
 * plain route: binary data, live events (SSE), node options, the credential test, vault routes, OAuth
 * callback, MCP (key, trigger session, OAuth grants), the builder, the public API, reviews, publish check,
 * evaluations (route gate and dataset read), form and chat sign-in, and the Assistant (threads, confirmations,
 * drafts, MCP connections, tools). The two-project writes are covered too: project verbs and members, the three
 * transfers (destination), shares, favorites, test webhooks, the MCP access toggle and the public per-id routes.
 * Nothing crosses. Another workspace's id is 404 on the route families, the transfer destination and the public API.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { nodesAiPackage } from '@workflow/nodes-ai';
import {
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type NodePackage,
  type NodeType,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAuthHelper } from '../src/services/mcp/oauth/tokens';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import type { SecretProvider, SecretProviderSettings, SecretProviderType } from '../src/services/secrets/types';
import {
  type AssistantHarness,
  createAssistantHarness,
  type HarnessUser,
} from './fakes/assistant-harness';
import {
  addToProject,
  chain,
  credentialIn,
  dataTableIn,
  folderIn,
  node,
  projectIn,
  realMember,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestMember,
  type TestServer,
  waitFor,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';
const NO_ACCESS = 'does not have access to the credential';

let address = 0;
const nextAddress = () => `10.95.${(++address >> 8) & 255}.${address & 255}`;

// ---------------------------------------------------------------------------------------------
// fakes: a vault, a node with an options method, a local HTTP "remote service"

const vaults = new Map<string, Record<string, unknown>>();

class MemoryProvider implements SecretProvider {
  private secrets: Record<string, unknown> = {};
  constructor(private readonly settings: SecretProviderSettings) {}
  private read() {
    const secrets = vaults.get(String(this.settings.token));
    if (!secrets) throw new Error('no such vault');
    return { ...secrets };
  }
  async init() {}
  async connect() {
    this.read();
  }
  async update() {
    this.secrets = this.read();
  }
  async test() {
    return { success: true };
  }
  getSecret(name: string) {
    return this.secrets[name];
  }
  hasSecret(name: string) {
    return Object.hasOwn(this.secrets, name);
  }
  getSecretNames() {
    return Object.keys(this.secrets);
  }
  async disconnect() {}
}

const memoryType: SecretProviderType = {
  name: 'memoryVault',
  displayName: 'Memory vault',
  properties: [{ displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } }],
  create: (settings) => new MemoryProvider(settings),
};

const optionsNode: NodeType = {
  description: {
    name: 'test.p6IsolationOptions',
    displayName: 'Options',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Options' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'testApi', required: false }],
    properties: [],
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
  methods: {
    loadOptions: {
      async keyLength(ctx) {
        const credentials = await ctx.getCredentials<{ apiKey?: string }>('testApi');
        return [{ name: String(credentials.apiKey?.length ?? 0), value: 'length' }];
      },
    },
  },
};
const optionsPackage: NodePackage = { name: 'p6-isolation-options', nodes: [optionsNode], credentials: [] };

let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];

async function startRemote() {
  remote = createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'p6-token', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------------------------------------
// the editor API server (also an MCP server and a listener, for SSE, OAuth and the MCP routes)

describe('route families, two members, two projects', () => {
  let server: TestServer & { url: string; port: number };

  beforeAll(async () => {
    await startRemote();
    server = await startMcpTestServer(
      {
        LOGIN_RATE_LIMIT_MAX: '1000',
        AI_ENABLED: 'true',
        MCP_ACCESS_ENABLED: 'true',
        MCP_SERVER_RATE_LIMIT: '100000',
        OAUTH_SERVER_REGISTER_RATE_LIMIT: '1000',
        OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: '1000',
      },
      { nodePackages: [nodesAiPackage, optionsPackage], secretProviderTypes: [memoryType] },
    );
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await new Promise((r) => remote?.close(r));
  });

  const repos = () => server.ctx.repos;

  /** a workspace whose owner is signed in on the server's own origin (the CSRF check) */
  async function signup() {
    const client = new TestClient(server.app, server.url, nextAddress());
    const id = randomUUID().slice(0, 8);
    const res = await client.post('/rest/auth/signup', {
      email: `iso-${id}@example.com`,
      password: 'Passw0rd!',
      name: `Iso ${id}`,
      workspaceName: `Iso ${id}`,
    });
    if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
    const data = res.json().data as { user: { id: string; email: string }; tenant: { id: string; slug: string } };
    return { client, ...data };
  }
  type Owner = Awaited<ReturnType<typeof signup>>;
  type Who = { client: TestClient };

  const member = (owner: Owner, name: string) =>
    realMember(owner, { name, remoteAddress: nextAddress(), origin: server.url });

  /** an owner, projects A and B, ann (project:editor in A), ben (project:editor in B), and one of each resource per project */
  async function world() {
    const owner = await signup();
    const tenantId = owner.tenant.id;
    const a = await projectIn(server, tenantId, 'A');
    const b = await projectIn(server, tenantId, 'B');
    const ann = await member(owner, 'Ann');
    const ben = await member(owner, 'Ben');
    await addToProject(server, tenantId, a.id, ann.user.id, 'project:editor');
    await addToProject(server, tenantId, b.id, ben.user.id, 'project:editor');
    const flow = (name: string) => ({ name, nodes: [node('Start', 'core.manualTrigger')] });
    return {
      owner,
      tenantId,
      a,
      b,
      ann,
      ben,
      wfA: await workflowIn(server, tenantId, a.id, flow('Alpha flow')),
      wfB: await workflowIn(server, tenantId, b.id, flow('Beta flow')),
      credA: await credentialIn(server, tenantId, a.id, { name: 'Alpha key', data: { apiKey: 'a-secret-1' } }),
      credB: await credentialIn(server, tenantId, b.id, { name: 'Beta key', data: { apiKey: 'b-secret-22' } }),
      tableA: await dataTableIn(server, tenantId, a.id, 'alpha_table'),
      tableB: await dataTableIn(server, tenantId, b.id, 'beta_table'),
      folderA: await folderIn(server, tenantId, a.id, 'Alpha folder'),
      folderB: await folderIn(server, tenantId, b.id, 'Beta folder'),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const idsOf = (body: any): string[] => {
    const rows = Array.isArray(body.data) ? body.data : (body.data?.data ?? body.data?.rows ?? []);
    return rows.map((r: { id: string }) => r.id);
  };

  /** every response is the hidden-row 403 with n8n's text */
  function expectHidden(responses: Array<{ statusCode: number; body: string; json(): any }>, label = '') {
    responses.forEach((res, i) => {
      expect(res.statusCode, `${label} #${i}: ${res.body.slice(0, 120)}`).toBe(403);
      expect(res.json().error.message, `${label} #${i}`).toBe(FORBIDDEN);
    });
  }

  // -------------------------------------------------------------------------------------------
  describe('workflows, runs, tables, credentials, folders, variables', () => {
    it('workflows: B is hidden from ann on every verb; its project filter lists nothing; ann creates only in A; A passes', async () => {
      const w = await world();
      const { client } = w.ann;
      expectHidden(
        [
          await client.get(`/rest/workflows/${w.wfB.id}`),
          await client.patch(`/rest/workflows/${w.wfB.id}`, { name: 'x', versionId: w.wfB.versionId }),
          await client.delete(`/rest/workflows/${w.wfB.id}`),
          await client.post(`/rest/workflows/${w.wfB.id}/run`, {}),
          await client.post(`/rest/workflows/${w.wfB.id}/activate`, {}),
          await client.post(`/rest/workflows/${w.wfB.id}/archive`, {}),
          await client.post('/rest/workflows', {
            name: 'Into B',
            projectId: w.b.id,
            nodes: [],
            connections: {},
          }),
        ],
        'workflows',
      );
      // the list has no scope on the route (as n8n): a project filter the caller holds nothing in is 200 and empty
      const foreign = await client.get(`/rest/workflows?projectId=${w.b.id}`);
      expect(foreign.statusCode).toBe(200);
      expect(idsOf(foreign.json())).toEqual([]);
      expect(foreign.body).not.toContain(w.wfB.id);
      expect(idsOf((await client.get(`/rest/workflows?projectId=${w.a.id}`)).json())).toEqual([w.wfA.id]);
      expect(idsOf((await client.get('/rest/workflows')).json())).toEqual([w.wfA.id]);
      expect((await client.get(`/rest/workflows/${w.wfA.id}`)).statusCode).toBe(200);
      const made = await client.post('/rest/workflows', { name: 'Into A', projectId: w.a.id, nodes: [], connections: {} });
      expect(made.statusCode).toBe(200);
      // the same holds the other way round
      expect((await w.ben.client.get(`/rest/workflows/${w.wfA.id}`)).statusCode).toBe(403);
      expect((await repos().workflows.get(w.tenantId, w.wfB.id))?.isArchived).toBe(false);
    });

    it("executions: ann reads, deletes, retries and lists only A's runs", async () => {
      const w = await world();
      const runOf = async (workflowId: string) => {
        const id = randomUUID();
        await repos().executions.create(
          w.tenantId,
          { id, workflowId, workflowName: 'Run', mode: 'manual', status: 'error', startedAt: new Date(), stoppedAt: new Date() },
          { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
        );
        return id;
      };
      const inA = await runOf(w.wfA.id);
      const inB = await runOf(w.wfB.id);
      const orphan = await runOf(null as never);
      expectHidden(
        [
          await w.ann.client.get(`/rest/executions/${inB}`),
          await w.ann.client.delete(`/rest/executions/${inB}`),
          await w.ann.client.post(`/rest/executions/${inB}/retry`, {}),
          await w.ann.client.post(`/rest/executions/${inB}/stop`, {}),
          await w.ann.client.get(`/rest/executions/${orphan}`),
        ],
        'executions',
      );
      expect(idsOf((await w.ann.client.get('/rest/executions')).json())).toEqual([inA]);
      expect((await w.ann.client.get(`/rest/executions/${inA}`)).statusCode).toBe(200);
      expect(await repos().executions.get(w.tenantId, inB)).toBeDefined();
    });

    it('credentials: B is hidden on every verb, absent from the list, and no create or test reaches it', async () => {
      const w = await world();
      const { client } = w.ann;
      expectHidden(
        [
          await client.get(`/rest/credentials/${w.credB.id}`),
          await client.patch(`/rest/credentials/${w.credB.id}`, { name: 'x' }),
          await client.delete(`/rest/credentials/${w.credB.id}`),
          await client.post('/rest/credentials', { name: 'Into B', type: 'testApi', data: {}, projectId: w.b.id }),
          await client.post('/rest/credentials/test', { id: w.credB.id, type: 'testApi', data: {} }),
          await client.post('/rest/credentials/test', { type: 'testApi', data: {}, projectId: w.b.id }),
        ],
        'credentials',
      );
      // the list always passes the access filter, so a project the caller cannot read lists nothing
      const filtered = await client.get(`/rest/credentials?projectId=${w.b.id}`);
      expect(idsOf(filtered.json())).toEqual([]);
      const list = await client.get('/rest/credentials');
      expect(idsOf(list.json())).toEqual([w.credA.id]);
      expect(list.body).not.toContain('b-secret-22');
      const own = await client.get(`/rest/credentials/${w.credA.id}`);
      expect(own.statusCode).toBe(200);
      expect(own.body).not.toContain('a-secret-1');
    });

    it('credential test: a vault value and a project variable resolve under the credential project only', async () => {
      const w = await world();
      const token = `token-${randomUUID()}`;
      vaults.set(token, { key: 'vault-of-b' });
      await w.owner.client.data(
        w.owner.client.post(`/rest/secret-providers/projects/${w.b.id}/connections`, {
          providerKey: 'vaultB',
          type: 'memoryVault',
          settings: { token },
          isEnabled: true,
        }),
      );
      await repos().variables.create(w.tenantId, { key: 'p6iso', value: 'a-value', projectId: w.a.id });
      await repos().variables.create(w.tenantId, { key: 'p6iso', value: 'b-value', projectId: w.b.id });
      const data = (apiKey: string) => ({ baseUrl: remoteUrl, apiKey });

      // control: the project that owns the connection resolves it (a connection that never loads would fail here)
      received.length = 0;
      const resolved = await w.ben.client.data(
        w.ben.client.post('/rest/credentials/test', {
          type: 'testApi',
          projectId: w.b.id,
          data: data('={{ $secrets.vaultB.key }}'),
        }),
      );
      expect(resolved.status).toBe('OK');
      expect(received.at(-1)?.headers['x-api-key']).toBe('vault-of-b');

      received.length = 0;
      const refused = await w.ann.client.data(
        w.ann.client.post('/rest/credentials/test', { type: 'testApi', projectId: w.a.id, data: data('={{ $secrets.vaultB.key }}') }),
      );
      expect(refused.status).toBe('Error');
      expect(JSON.stringify(refused)).not.toContain('vault-of-b');
      expect(received).toEqual([]);

      const vars = await w.ann.client.data(
        w.ann.client.post('/rest/credentials/test', { type: 'testApi', projectId: w.a.id, data: data('={{ $vars.p6iso }}') }),
      );
      expect(vars.status).toBe('OK');
      expect(received.at(-1)?.headers['x-api-key']).toBe('a-value');
      expect(received.filter((r) => r.headers['x-api-key'] === 'b-value')).toHaveLength(0);
    });

    it("OAuth callback: a state started in A for a user who lost A is refused, and never reaches B's credential", async () => {
      const w = await world();
      const oauth = await credentialIn(server, w.tenantId, w.a.id, {
        type: 'testPkceOAuth2Api',
        data: {
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/token`,
          clientId: 'client-1',
          clientSecret: 'secret-1',
        },
      });
      const state = async (who: Who, id: string) => {
        const res = await who.client.get(`/rest/oauth2/authorize?credentialId=${id}`);
        return res.statusCode === 200 ? new URL(res.json().data.url).searchParams.get('state')! : undefined;
      };
      const callback = (s: string) =>
        server.app.inject({ url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(s)}` });
      // ben cannot even start the flow on A's credential
      expect((await w.ben.client.get(`/rest/oauth2/authorize?credentialId=${oauth.id}`)).statusCode).toBe(403);
      const kept = await callback((await state(w.ann, oauth.id))!);
      expect(kept.body).toContain('"status":"success"');
      const lost = (await state(w.ann, oauth.id))!;
      await repos().projects.relations.remove(w.tenantId, w.a.id, w.ann.user.id);
      const tokens = received.filter((r) => r.url === '/token').length;
      const revoked = await callback(lost);
      expect(revoked.statusCode).toBe(400);
      expect(received.filter((r) => r.url === '/token')).toHaveLength(tokens);
    });

    it('data tables: B is hidden on every verb, absent from the list; no create or CSV preview reaches B', async () => {
      const w = await world();
      const { client } = w.ann;
      const id = w.tableB.id;
      expectHidden(
        [
          await client.get(`/rest/data-tables/${id}`),
          await client.patch(`/rest/data-tables/${id}`, { name: 'x' }),
          await client.delete(`/rest/data-tables/${id}`),
          await client.get(`/rest/data-tables/${id}/columns`),
          await client.get(`/rest/data-tables/${id}/rows`),
          await client.get(`/rest/data-tables/${id}/dependencies`),
          await client.get(`/rest/data-tables/${id}/download-csv`),
          await client.post(`/rest/data-tables/${id}/insert`, { data: [] }),
          await client.delete(`/rest/data-tables/${id}/rows/clear`),
          await client.post('/rest/data-tables', { name: 'into_b', columns: [], projectId: w.b.id }),
          await client.get(`/rest/data-tables?projectId=${w.b.id}`),
        ],
        'data tables',
      );
      const list = await client.get('/rest/data-tables');
      expect(idsOf(list.json())).toEqual([w.tableA.id]);
      expect((await client.get(`/rest/data-tables/${w.tableA.id}`)).statusCode).toBe(200);
    });

    it('folders: B is hidden on every verb and in the list; ann creates in A only, and cannot move a folder into B', async () => {
      const w = await world();
      const { client } = w.ann;
      expectHidden(
        [
          await client.get(`/rest/folders/${w.folderB.id}`),
          await client.patch(`/rest/folders/${w.folderB.id}`, { name: 'x' }),
          await client.delete(`/rest/folders/${w.folderB.id}`),
          await client.post('/rest/folders', { name: 'Into B', projectId: w.b.id }),
          await client.get(`/rest/folders?projectId=${w.b.id}`),
        ],
        'folders',
      );
      expect(idsOf((await client.get('/rest/folders')).json())).toEqual([w.folderA.id]);
      expect((await client.post('/rest/folders', { name: 'Into A', projectId: w.a.id })).statusCode).toBe(
        200,
      );
      const crossParent = await client.patch(`/rest/folders/${w.folderA.id}`, {
        parentFolderId: w.folderB.id,
      });
      expect(crossParent.statusCode).toBe(400);
      expect((await repos().folders.get(w.tenantId, w.folderA.id))?.parentFolderId ?? null).toBeNull();
    });

    it('variables: a project variable of B is hidden from ann; ann cannot write one in B or a global one', async () => {
      const w = await world();
      const made = await w.ben.client.data(
        w.ben.client.post('/rest/variables', { key: 'BEN_ONLY', value: 'b', projectId: w.b.id }),
      );
      expectHidden(
        [
          await w.ann.client.get(`/rest/variables/${made.id}`),
          await w.ann.client.get(`/rest/variables?projectId=${w.b.id}`),
          await w.ann.client.post('/rest/variables', { key: 'INTO_B', value: 'x', projectId: w.b.id }),
          await w.ann.client.post('/rest/variables', { key: 'GLOBAL', value: 'x' }),
          await w.ann.client.patch(`/rest/variables/${made.id}`, { value: 'x' }),
          await w.ann.client.delete(`/rest/variables/${made.id}`),
        ],
        'variables',
      );
      const seen = await w.ann.client.data<Array<{ key: string }>>(w.ann.client.get('/rest/variables'));
      expect(seen.map((v) => v.key)).not.toContain('BEN_ONLY');
      expect((await repos().variables.get(w.tenantId, made.id))?.value).toBe('b');
    });

    it('project vault routes: ann reaches none of B, and the secret never appears', async () => {
      const w = await world();
      const token = `token-${randomUUID()}`;
      vaults.set(token, { key: 'vault-value-b' });
      const made = await w.owner.client.post(`/rest/secret-providers/projects/${w.b.id}/connections`, {
        providerKey: 'vaultB2',
        type: 'memoryVault',
        settings: { token },
        isEnabled: true,
      });
      expect(made.statusCode).toBe(200);
      const url = `/rest/secret-providers/projects/${w.b.id}/connections`;
      for (const res of [
        await w.ann.client.get(url),
        await w.ann.client.post(url, { providerKey: 'x', type: 'memoryVault', settings: { token }, isEnabled: true }),
        await w.ann.client.get(`/rest/secret-providers/completions/secrets/project/${w.b.id}`),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('vault-value-b');
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('projects, transfers, shares, favorites, test webhooks, MCP toggle, public per-id routes, another workspace', () => {
    /** ann is also admin of A and of a project C of her own: she holds the `:move` and `:share` scopes at home */
    async function adminWorld() {
      const w = await world();
      const c = await projectIn(server, w.tenantId, 'C');
      await addToProject(server, w.tenantId, w.a.id, w.ann.user.id, 'project:admin');
      await addToProject(server, w.tenantId, c.id, w.ann.user.id, 'project:admin');
      return { ...w, c };
    }

    it('projects: ann has no verb on project B, cannot add herself or change its members; A passes', async () => {
      const w = await world();
      const { client } = w.ann;
      const url = `/rest/projects/${w.b.id}`;
      expectHidden(
        [
          await client.get(url),
          await client.patch(url, { name: 'Hijacked' }),
          await client.delete(url),
          await client.post(`${url}/users`, {
            relations: [{ userId: w.ann.user.id, role: 'project:admin' }],
          }),
          await client.patch(`${url}/users/${w.ben.user.id}`, { role: 'project:viewer' }),
          await client.delete(`${url}/users/${w.ben.user.id}`),
        ],
        'projects',
      );
      expect(await repos().projects.relations.get(w.tenantId, w.b.id, w.ann.user.id)).toBeUndefined();
      expect((await repos().projects.relations.get(w.tenantId, w.b.id, w.ben.user.id))?.role).toBe(
        'project:editor',
      );
      expect((await repos().projects.get(w.tenantId, w.b.id))?.name).toBe('B');
      expect(JSON.stringify((await client.get('/rest/projects')).json())).not.toContain(w.b.id);
      expect((await client.get(`/rest/projects/${w.a.id}`)).statusCode).toBe(200);
    });

    it('transfers: ann cannot move A or B rows into B, nothing moves, and a move inside her own projects passes', async () => {
      const w = await adminWorld();
      const { client } = w.ann;
      const into = (id: string, kind: 'workflows' | 'credentials' | 'folders', destination: string) =>
        client.put(`/rest/${kind}/${id}/transfer`, { destinationProjectId: destination });
      // only the destination check stands between A and B here: ann holds `:move` on A's rows
      expectHidden(
        [
          await into(w.wfA.id, 'workflows', w.b.id),
          await into(w.credA.id, 'credentials', w.b.id),
          await into(w.folderA.id, 'folders', w.b.id),
          await client.get(`/rest/workflows/${w.wfA.id}/transfer-preview?destinationProjectId=${w.b.id}`),
          await client.get(`/rest/credentials/${w.credA.id}/transfer-preview?destinationProjectId=${w.b.id}`),
          await client.get(`/rest/folders/${w.folderA.id}/transfer-preview?destinationProjectId=${w.b.id}`),
          // and the rows of B, even into A
          await into(w.wfB.id, 'workflows', w.a.id),
          await into(w.credB.id, 'credentials', w.a.id),
          await into(w.folderB.id, 'folders', w.a.id),
          await client.get(`/rest/workflows/${w.wfB.id}/transfer-preview?destinationProjectId=${w.a.id}`),
        ],
        'transfers',
      );
      expect((await repos().workflows.get(w.tenantId, w.wfA.id))?.projectId).toBe(w.a.id);
      expect((await repos().credentials.get(w.tenantId, w.credA.id))?.projectId).toBe(w.a.id);
      expect((await repos().folders.get(w.tenantId, w.folderA.id))?.projectId).toBe(w.a.id);
      expect((await repos().workflows.get(w.tenantId, w.wfB.id))?.projectId).toBe(w.b.id);
      expect((await repos().credentials.get(w.tenantId, w.credB.id))?.projectId).toBe(w.b.id);
      expect((await repos().folders.get(w.tenantId, w.folderB.id))?.projectId).toBe(w.b.id);
      // control: into C, where she is admin, the same calls pass
      expect((await into(w.wfA.id, 'workflows', w.c.id)).statusCode).toBe(200);
      expect((await into(w.credA.id, 'credentials', w.c.id)).statusCode).toBe(200);
      expect((await into(w.folderA.id, 'folders', w.c.id)).statusCode).toBe(200);
      expect((await repos().workflows.get(w.tenantId, w.wfA.id))?.projectId).toBe(w.c.id);
      expect((await repos().credentials.get(w.tenantId, w.credA.id))?.projectId).toBe(w.c.id);
      expect((await repos().folders.get(w.tenantId, w.folderA.id))?.projectId).toBe(w.c.id);
    });

    it('shares: ann cannot share a row of B into A; the owner and the project admin share what they hold', async () => {
      const w = await adminWorld();
      const { client } = w.ann;
      expectHidden(
        [
          await client.put(`/rest/workflows/${w.wfB.id}/share`, { shareWithIds: [w.a.id] }),
          await client.put(`/rest/credentials/${w.credB.id}/share`, { shareWithIds: [w.a.id] }),
          // the project admin holds no `workflow:share` even on A's own workflow (the workspace owner does)
          await client.put(`/rest/workflows/${w.wfA.id}/share`, { shareWithIds: [w.c.id] }),
        ],
        'shares',
      );
      expect(await repos().shares.listForWorkflow(w.tenantId, w.wfB.id)).toEqual([]);
      expect(await repos().shares.listForCredential(w.tenantId, w.credB.id)).toEqual([]);
      expect(await repos().shares.listForWorkflow(w.tenantId, w.wfA.id)).toEqual([]);
      expect(idsOf((await client.get('/rest/workflows')).json())).toEqual([w.wfA.id]);
      expect(idsOf((await client.get('/rest/credentials')).json())).toEqual([w.credA.id]);
      // controls: ann shares her credential with C (`credential:share` as project admin), the owner a workflow
      const credShare = await client.put(`/rest/credentials/${w.credA.id}/share`, { shareWithIds: [w.c.id] });
      expect(credShare.statusCode, credShare.body).toBe(200);
      expect((await repos().shares.listForCredential(w.tenantId, w.credA.id)).length).toBe(1);
      const wfShare = await w.owner.client.put(`/rest/workflows/${w.wfA.id}/share`, {
        shareWithIds: [w.c.id],
      });
      expect(wfShare.statusCode, wfShare.body).toBe(200);
      expect((await repos().shares.listForWorkflow(w.tenantId, w.wfA.id)).length).toBe(1);
    });

    it('favorites: ann cannot bookmark a row or the project of B; her own A rows are listed', async () => {
      const w = await world();
      const { client } = w.ann;
      const add = (resourceType: string, resourceId: string) =>
        client.post('/rest/favorites', { resourceType, resourceId });
      expectHidden(
        [
          await add('workflow', w.wfB.id),
          await add('project', w.b.id),
          await add('folder', w.folderB.id),
          await add('dataTable', w.tableB.id),
        ],
        'favorites',
      );
      expect((await add('workflow', w.wfA.id)).statusCode).toBe(200);
      expect((await add('project', w.a.id)).statusCode).toBe(200);
      const listed = JSON.stringify((await client.get('/rest/favorites')).json());
      expect(listed).toContain(w.wfA.id);
      expect(listed).not.toContain(w.wfB.id);
      expect(listed).not.toContain(w.b.id);
    });

    it('test webhooks: ann cannot listen on the webhook of B, and none is registered; A listens', async () => {
      const w = await world();
      const hook = async (projectId: string) => {
        const path = `p6iso-${randomUUID().slice(0, 8)}`;
        const wf = await workflowIn(server, w.tenantId, projectId, {
          nodes: [
            node('Hook', 'core.webhook', { path, httpMethod: 'GET' }, [0, 0], { webhookId: randomUUID() }),
          ],
        });
        return { id: wf.id, url: `/webhook-test/${w.owner.tenant.slug}/${path}` };
      };
      const inA = await hook(w.a.id);
      const inB = await hook(w.b.id);
      expectHidden(
        [await w.ann.client.post(`/rest/workflows/${inB.id}/listen-test-webhook`, { nodeName: 'Hook' })],
        'test webhook',
      );
      expect((await server.app.inject({ method: 'GET', url: inB.url })).statusCode).toBe(404);
      const own = await w.ann.client.post(`/rest/workflows/${inA.id}/listen-test-webhook`, {
        nodeName: 'Hook',
      });
      expect(own.statusCode, own.body).toBe(200);
      await w.ann.client.request('DELETE', `/rest/workflows/${inA.id}/listen-test-webhook`, {
        nodeName: 'Hook',
      });
    });

    it('MCP access toggle: ann cannot switch a workflow of B, one of B stops the whole change, A passes', async () => {
      const w = await world();
      const flag = async (id: string) =>
        ((await repos().workflows.get(w.tenantId, id))?.settings as { availableInMCP?: boolean } | undefined)
          ?.availableInMCP === true;
      const toggle = (body: Record<string, unknown>) =>
        w.ann.client.patch('/rest/mcp/workflows/toggle-access', body);
      expectHidden(
        [
          await toggle({ availableInMCP: true, workflowIds: [w.wfB.id] }),
          await toggle({ availableInMCP: true, workflowIds: [w.wfA.id, w.wfB.id] }),
          await toggle({ availableInMCP: true, projectId: w.b.id }),
        ],
        'toggle-access',
      );
      expect(await flag(w.wfB.id)).toBe(false);
      expect(await flag(w.wfA.id)).toBe(false);
      const own = await toggle({ availableInMCP: true, workflowIds: [w.wfA.id] });
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().data.updatedCount).toBe(1);
      expect(await flag(w.wfA.id)).toBe(true);
      expect(await flag(w.wfB.id)).toBe(false);
    });

    it('public API: the per-id routes of project B, its users, folders, tables and rows are 403 for ann; lists hold A only', async () => {
      const w = await world();
      const annKey = (await w.ann.client.data(w.ann.client.post('/rest/api-keys', { name: 'k' })))
        .key as string;
      const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
        server.app.inject({
          method,
          url: `/api/v1${url}`,
          headers: { 'x-api-key': annKey },
          payload: payload as object,
        });
      const runB = randomUUID();
      await repos().executions.create(
        w.tenantId,
        {
          id: runB,
          workflowId: w.wfB.id,
          workflowName: 'Run',
          mode: 'manual',
          status: 'error',
          startedAt: new Date(),
          stoppedAt: new Date(),
        },
        { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
      );
      await repos().variables.create(w.tenantId, { key: 'P6ISOB', value: 'b', projectId: w.b.id });
      expectHidden(
        [
          await api('PUT', `/projects/${w.b.id}`, { name: 'Hijacked' }),
          await api('DELETE', `/projects/${w.b.id}`),
          await api('GET', `/projects/${w.b.id}/users`),
          await api('POST', `/projects/${w.b.id}/users`, {
            relations: [{ userId: w.ann.user.id, role: 'project:admin' }],
          }),
          await api('PATCH', `/projects/${w.b.id}/users/${w.ben.user.id}`, { role: 'project:viewer' }),
          await api('DELETE', `/projects/${w.b.id}/users/${w.ben.user.id}`),
          await api('GET', `/projects/${w.b.id}/folders`),
          await api('POST', `/projects/${w.b.id}/folders`, { name: 'Into B' }),
          await api('GET', `/projects/${w.b.id}/folders/${w.folderB.id}`),
          await api('DELETE', `/projects/${w.b.id}/folders/${w.folderB.id}`),
          await api('GET', `/data-tables/${w.tableB.id}`),
          await api('DELETE', `/data-tables/${w.tableB.id}`),
          await api('GET', `/executions/${runB}`),
          await api('DELETE', `/credentials/${w.credB.id}`),
        ],
        'public per-id',
      );
      expect(await repos().projects.get(w.tenantId, w.b.id)).toBeDefined();
      expect(await repos().folders.get(w.tenantId, w.folderB.id)).toBeDefined();
      expect(await repos().credentials.get(w.tenantId, w.credB.id)).toBeDefined();
      expect(await repos().executions.get(w.tenantId, runB)).toBeDefined();
      for (const list of ['/executions', '/variables', '/data-tables']) {
        const res = await api('GET', list);
        expect(res.statusCode, list).toBe(200);
        const text = JSON.stringify(res.json());
        for (const hidden of [w.credB.id, w.tableB.id, runB, 'P6ISOB'])
          expect(text, list).not.toContain(hidden);
      }
      // controls: A's own rows
      expect((await api('GET', `/projects/${w.a.id}/folders`)).statusCode).toBe(200);
      expect((await api('GET', `/data-tables/${w.tableA.id}`)).statusCode).toBe(200);
    });

    it("another workspace's ids are 404 on the route families, the transfer destination and the public API", async () => {
      const w = await adminWorld();
      const other = await signup();
      const p2 = await projectIn(server, other.tenant.id, 'Other');
      const wf2 = await workflowIn(server, other.tenant.id, p2.id, { name: 'Other flow' });
      const cred2 = await credentialIn(server, other.tenant.id, p2.id, {
        name: 'Other key',
        data: { apiKey: 'other-secret' },
      });
      const table2 = await dataTableIn(server, other.tenant.id, p2.id, 'other_table');
      const folder2 = await folderIn(server, other.tenant.id, p2.id, 'Other folder');
      const gone = (responses: Array<{ statusCode: number; body: string }>, label: string) =>
        responses.forEach((res, i) => {
          expect(res.statusCode, `${label} #${i}: ${res.body.slice(0, 120)}`).toBe(404);
          expect(res.body).not.toContain('other-secret');
        });
      const { client } = w.ann;
      const annKey = (await client.data(client.post('/rest/api-keys', { name: 'k' }))).key as string;
      const api = (url: string) =>
        server.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-api-key': annKey } });
      gone(
        [
          await client.get(`/rest/workflows/${wf2.id}`),
          await client.get(`/rest/credentials/${cred2.id}`),
          await client.get(`/rest/data-tables/${table2.id}`),
          await client.get(`/rest/folders/${folder2.id}`),
          await client.get(`/rest/projects/${p2.id}`),
          await client.post('/rest/favorites', { resourceType: 'workflow', resourceId: wf2.id }),
          await client.put(`/rest/workflows/${w.wfA.id}/transfer`, { destinationProjectId: p2.id }),
          await client.get(`/rest/workflows/${wf2.id}/test-runs`),
          await api(`/workflows/${wf2.id}`),
          await api(`/data-tables/${table2.id}`),
          await api(`/projects/${p2.id}/folders`),
        ],
        'another workspace',
      );
      expect((await repos().workflows.get(w.tenantId, w.wfA.id))?.projectId).toBe(w.a.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('binary data, node options, live events', () => {
    const fileOf = async (tenantId: string, folder: string): Promise<string> => {
      const name = randomUUID();
      const dir = path.join(server.ctx.config.binaryData.dir, tenantId, ...folder.split('/'));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), 'file bytes');
      return `fs:${tenantId}/${folder}/${name}`;
    };
    const fetchFile = (who: Who, id: string) =>
      who.client.get(`/rest/binary-data?id=${encodeURIComponent(id)}&mimeType=text/plain&fileName=f.txt`);
    const runRow = async (tenantId: string, workflowId: string | null) => {
      const id = randomUUID();
      await repos().executions.create(
        tenantId,
        { id, workflowId, workflowName: 'Run', mode: 'manual', status: 'success', startedAt: new Date() },
        { workflowData: { name: 'Run', nodes: [], connections: {} }, runOptions: {} },
      );
      return id;
    };

    it("binary data: ann reads A's run files, not B's, not a run with no workflow, and never a thread's of another user", async () => {
      const w = await world();
      const own = await fileOf(w.tenantId, await runRow(w.tenantId, w.wfA.id));
      const theirs = await fileOf(w.tenantId, await runRow(w.tenantId, w.wfB.id));
      const orphan = await fileOf(w.tenantId, await runRow(w.tenantId, null));
      const ok = await fetchFile(w.ann, own);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('file bytes');
      expectHidden([await fetchFile(w.ann, theirs), await fetchFile(w.ann, orphan)], 'binary');
      expect((await fetchFile(w.owner, theirs)).statusCode).toBe(200);
      // an Assistant thread's files are the thread owner's only (Phase 5 attachments)
      const thread = await repos().assistantThreads.create(w.tenantId, w.ann.user.id);
      const attachment = await fileOf(w.tenantId, thread.id);
      expect((await fetchFile(w.ann, attachment)).statusCode).toBe(200);
      expect((await fetchFile(w.ben, attachment)).statusCode).toBe(404);
      expect((await fetchFile(w.owner, attachment)).statusCode).toBe(404);
    });

    it('node options: a project credential reaches the method of its own project only; a workflow of B is refused', async () => {
      const w = await world();
      const call = (who: Who, workflowId: string, credential: { id: string; name: string }) =>
        who.client.post('/rest/node-types/options', {
          nodeType: 'test.p6IsolationOptions',
          method: 'keyLength',
          kind: 'loadOptions',
          workflowId,
          node: {
            ...node('Options', 'test.p6IsolationOptions'),
            credentials: { testApi: { id: credential.id, name: credential.name } },
          },
        });
      const ok = await call(w.ann, w.wfA.id, w.credA);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data).toEqual([{ name: '10', value: 'length' }]);
      // B's credential on A's workflow: refused for ann and for the owner, no value in the answer
      for (const who of [w.ann, w.owner]) {
        const res = await call(who, w.wfA.id, w.credB);
        expect(res.statusCode).toBe(400);
        expect(res.body).not.toContain('"name":"11"');
        expect(res.body).not.toContain('b-secret-22');
      }
      // B's workflow for ann: the scope check, before the method
      expectHidden([await call(w.ann, w.wfB.id, w.credB)], 'options');
    });

    it('live events (SSE): the stream of ann carries the events of A only', async () => {
      const w = await world();
      const controller = new AbortController();
      const events: Array<{ event: string; data: any }> = [];
      const res = await fetch(`${server.url}/rest/push`, {
        headers: { cookie: w.ann.client.cookie! },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const pump = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
              const frame = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              const event = /^event: (.*)$/m.exec(frame)?.[1];
              const data = /^data: (.*)$/m.exec(frame)?.[1];
              if (event) events.push({ event, data: data ? JSON.parse(data) : null });
            }
          }
        } catch {
          /* aborted */
        }
      })();
      try {
        await waitFor(async () => events.some((e) => e.event === 'connected'), { message: 'SSE connection' });
        const send = (executionId: string, workflowId: string) =>
          server.ctx.push.send(w.tenantId, 'executionStarted', { executionId, workflowId, mode: 'manual' }, { workflowId });
        send('run-b', w.wfB.id);
        send('run-a', w.wfA.id);
        await waitFor(async () => events.some((e) => e.data?.executionId === 'run-a'), { message: 'the event of A' });
        expect(events.some((e) => e.data?.executionId === 'run-b')).toBe(false);
      } finally {
        controller.abort();
        await pump;
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('publish check, reviews, evaluations, form and chat sign-in', () => {
    it("publish check: A's workflow whose version names B's credential is refused for ann and for the owner", async () => {
      const w = await world();
      const hookNode = node('Hook', 'core.webhook', { path: `p6-${randomUUID().slice(0, 8)}`, httpMethod: 'GET' }, [0, 0], {
        webhookId: randomUUID(),
      });
      const created = await server.ctx.workflows.create(
        w.tenantId,
        {
          name: 'To publish',
          nodes: [hookNode, node('Use', 'test.useCredential', {}, [200, 0], { credentials: { testApi: { id: w.credA.id, name: 'x' } } })],
          connections: chain('Hook', 'Use'),
          settings: {},
          projectId: w.a.id,
        } as never,
        {},
      );
      // the credential moves to B after the save (a lost credential)
      await repos().credentials.update(w.tenantId, w.credA.id, { projectId: w.b.id });
      for (const who of [w.ann, w.owner]) {
        const res = await who.client.post(`/rest/workflows/${created.id}/activate`, {});
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(NO_ACCESS);
      }
      expect((await repos().workflows.get(w.tenantId, created.id))?.active).toBe(false);
      await repos().credentials.update(w.tenantId, w.credA.id, { projectId: w.a.id });
      expect((await w.ann.client.post(`/rest/workflows/${created.id}/activate`, {})).statusCode).toBe(200);
    });

    it("reviews: ben cannot open a review on A's workflow, ann can; ben never sees or answers it", async () => {
      const w = await world();
      await w.owner.client.data(w.owner.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
      const saved = await w.owner.client.data<{ id: string; versionId: string }>(
        w.owner.client.post('/rest/workflows', {
          name: 'Reviewed',
          projectId: w.a.id,
          nodes: [
            node('Webhook', 'core.webhook', { httpMethod: 'POST', path: `r${randomUUID().slice(0, 8)}` }, [0, 0], { webhookId: randomUUID() }),
            setNode('Set', 'greeting', 'v1'),
          ],
          connections: chain('Webhook', 'Set'),
        }),
      );
      const body = { workflowId: saved.id, title: 'Please check', versionName: 'v1', reviewerUserIds: [w.owner.user.id] };
      expectHidden([await w.ben.client.post('/rest/workflow-reviews', body)], 'review create');
      const opened = await w.ann.client.post('/rest/workflow-reviews', body);
      expect(opened.statusCode).toBe(200);
      const id = opened.json().data.id as string;
      const read = await w.ben.client.get(`/rest/workflow-reviews/${id}`);
      // a review of another project is not there for ben (a participant-only answer)
      expect(read.statusCode).toBe(404);
      const list = await w.ben.client.get('/rest/workflow-reviews');
      expect(JSON.stringify(list.json())).not.toContain(id);
      // the real decision route: ben gets the same 404 and the review stays open
      const decided = await w.ben.client.post(`/rest/workflow-reviews/${id}/decision`, {
        decision: 'approved',
      });
      expect(decided.statusCode).toBe(404);
      expect((await repos().reviews.get(w.tenantId, id))?.state).toBe('open');
      // control: the route exists, and the author is refused by its own rule (403), not by the router
      const own = await w.ann.client.post(`/rest/workflow-reviews/${id}/decision`, { decision: 'approved' });
      expect(own.statusCode).toBe(403);
      expect((await repos().reviews.get(w.tenantId, id))?.state).toBe('open');
    });

    it('evaluations: ben has no test-run route of A (read, run, cancel, delete); ann reads her own', async () => {
      const w = await world();
      const run = await repos().testRuns.create(w.tenantId, { workflowId: w.wfA.id, status: 'completed' });
      const url = `/rest/workflows/${w.wfA.id}/test-runs`;
      // a caller who cannot read the workflow gets its 404 (as n8n's test-runs controller), on every verb
      for (const [i, res] of [
        await w.ben.client.get(url),
        await w.ben.client.get(`${url}/${run.id}`),
        await w.ben.client.get(`${url}/${run.id}/test-cases`),
        await w.ben.client.post(`${url}/new`, {}),
        await w.ben.client.post(`${url}/${run.id}/cancel`),
        await w.ben.client.delete(`${url}/${run.id}`),
      ].entries()) {
        expect(res.statusCode, `evaluations #${i}: ${res.body.slice(0, 120)}`).toBe(404);
        expect(res.json().error.message, `evaluations #${i}`).toBe('Workflow not found');
      }
      expect((await w.ann.client.get(`${url}/${run.id}`)).statusCode).toBe(200);
      expect(await repos().testRuns.get(w.tenantId, w.wfA.id, run.id)).toBeTruthy();
      // the route gate of the other project's workflow is the same for ann
      expect((await w.ann.client.get(`/rest/workflows/${w.wfB.id}/test-runs`)).statusCode).toBe(404);
    });

    it("evaluations: a run of A's workflow reads the dataset of A's own project, never a table of B", async () => {
      const w = await world();
      const table = async (projectId: string, tag: string) => {
        const created = await w.owner.client.data<{ id: string }>(
          w.owner.client.post('/rest/data-tables', {
            name: `eval_${tag}_${randomUUID().slice(0, 6)}`,
            columns: [{ name: 'question', type: 'string' }],
            projectId,
          }),
        );
        await w.owner.client.data(
          w.owner.client.post(`/rest/data-tables/${created.id}/insert`, {
            data: [{ question: `${tag}-one` }, { question: `${tag}-two` }],
          }),
        );
        return created.id;
      };
      const tableOfA = await table(w.a.id, 'alpha');
      const tableOfB = await table(w.b.id, 'beta');
      const locator = (value: string) => ({ __rl: true, mode: 'id', value });
      const evalWorkflow = (tableId: string) =>
        workflowIn(server, w.tenantId, w.a.id, {
          name: `Evaluated ${randomUUID().slice(0, 6)}`,
          nodes: [
            node(
              'Dataset',
              EVALUATION_TRIGGER_TYPE,
              { source: 'dataTable', dataTableId: locator(tableId) },
              [0, 0],
            ),
            node('Metrics', EVALUATION_NODE_TYPE, {
              operation: 'setMetrics',
              metric: 'customMetrics',
              metrics: {
                assignments: [{ id: randomUUID(), name: 'score', value: '={{ 1 }}', type: 'number' }],
              },
            }),
          ],
          connections: chain('Dataset', 'Metrics'),
        });
      const runOf = async (workflowId: string) => {
        const started = await w.ann.client.post(`/rest/workflows/${workflowId}/test-runs/new`, {});
        expect(started.statusCode, started.body).toBe(202);
        const runId = started.json().data.testRunId as string;
        return waitFor(
          async () => {
            const run = await w.ann.client.data<{
              status: string;
              errorCode: string | null;
              caseCounts: { total: number };
            }>(w.ann.client.get(`/rest/workflows/${workflowId}/test-runs/${runId}`));
            return run.status === 'new' || run.status === 'running' ? undefined : run;
          },
          { timeout: 30_000, interval: 50, message: 'the test run to finish' },
        );
      };
      // the trigger names the table of B: the dataset read is bound to the workflow's own project, so it finds none
      const foreign = await evalWorkflow(tableOfB);
      const refused = await runOf(foreign.id);
      expect(refused.status).toBe('error');
      expect(refused.errorCode).toBe('CANT_FETCH_TEST_CASES');
      expect(refused.caseCounts.total).toBe(0);
      // control: the same workflow shape on the table of A reads A's rows
      const own = await evalWorkflow(tableOfA);
      const ok = await runOf(own.id);
      expect(ok.status).toBe('completed');
      expect(ok.caseCounts.total).toBe(2);
    });

    it('form sign-in: canExecute is workflow:execute through the projects of the user, per workflow', async () => {
      const w = await world();
      const { formAuth } = server.ctx;
      expect(await formAuth.canExecute(w.ann.user.id, w.wfA.id)).toBe(true);
      expect(await formAuth.canExecute(w.ann.user.id, w.wfB.id)).toBe(false);
      expect(await formAuth.canExecute(w.ben.user.id, w.wfA.id)).toBe(false);
      expect(await formAuth.canExecute(w.ben.user.id, w.wfB.id)).toBe(true);
      await repos().projects.relations.remove(w.tenantId, w.a.id, w.ann.user.id);
      expect(await formAuth.canExecute(w.ann.user.id, w.wfA.id)).toBe(false);
    });

    it("chat sign-in: the hosted chat of B's workflow is closed to ann, A's chat opens for her", async () => {
      const w = await world();
      const chat = async (projectId: string, id: string) => {
        const wf = await w.owner.client.data<{ id: string }>(
          w.owner.client.post('/rest/workflows', {
            name: `Chat ${id}`,
            projectId,
            nodes: [
              node('Chat', 'ai.chatTrigger', { public: true, authentication: 'n8nUserAuth', requireExecuteAccess: true }, [0, 0], {
                webhookId: id,
              }),
            ],
            connections: {},
          }),
        );
        expect((await w.owner.client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(200);
        return `/webhook/${w.owner.tenant.slug}/${id}/chat`;
      };
      const open = async (who: Who, url: string) => {
        const issued = await who.client.data<{ code: string }>(who.client.post('/rest/form-auth/code', { returnTo: url }));
        return server.app.inject({ method: 'GET', url: `${url}?code=${issued.code}` });
      };
      const urlA = await chat(w.a.id, `chat-a-${randomUUID().slice(0, 6)}`);
      const urlB = await chat(w.b.id, `chat-b-${randomUUID().slice(0, 6)}`);
      const ok = await open(w.ann, urlA);
      expect(ok.statusCode).toBe(302);
      expect(String(ok.headers['set-cookie'])).toContain('=');
      const refused = await open(w.ann, urlB);
      expect(refused.statusCode).toBe(403);
      expect(refused.headers['set-cookie']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('MCP, builder, public API', () => {
    let rpcId = 0;
    const rpc = async (slug: string, key: string, method: string, params?: DataObject) => {
      const res = await fetch(`${server.url}/mcp-server/${slug}/http`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
      });
      return (await res.json()) as { result?: any; error?: { message: string } };
    };
    const mcpKey = async (w: World, member: TestMember) =>
      (await server.ctx.auth.createApiKey(w.tenantId, member.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)).key;
    const call = async (w: World, key: string, name: string, args: DataObject = {}) => {
      const body = await rpc(w.owner.tenant.slug, key, 'tools/call', { name, arguments: args });
      if (body.error) return { isError: true, text: body.error.message, value: undefined as any };
      const text = (body.result.content ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      return { isError: Boolean(body.result.isError), text, value: body.result.isError ? undefined : JSON.parse(text) };
    };

    it("MCP key: ann's key searches A only and cannot read, run, publish or create in B; a removed relation closes A at once", async () => {
      const w = await world();
      await repos().workflows.update(w.tenantId, w.wfA.id, undefined, { versionId: w.wfA.versionId, settings: { availableInMCP: true } } as never);
      await repos().workflows.update(w.tenantId, w.wfB.id, undefined, { versionId: w.wfB.versionId, settings: { availableInMCP: true } } as never);
      const key = await mcpKey(w, w.ann);
      const search = await call(w, key, 'search_workflows', {});
      expect(search.value.data.map((x: { id: string }) => x.id)).toEqual([w.wfA.id]);
      const inB = await call(w, key, 'search_workflows', { projectId: w.b.id });
      expect(inB.isError).toBe(true);
      expect(inB.text).toContain(FORBIDDEN);
      for (const [name, args] of [
        ['get_workflow_details', { workflowId: w.wfB.id }],
        ['execute_workflow', { workflowId: w.wfB.id, executionMode: 'manual' }],
        ['publish_workflow', { workflowId: w.wfB.id }],
        ['archive_workflow', { workflowId: w.wfB.id }],
      ] as const) {
        const res = await call(w, key, name, args);
        expect(res.isError, name).toBe(true);
      }
      const created = await call(w, key, 'create_workflow_from_code', { name: 'Into B', code: 'x', projectId: w.b.id });
      expect(created.isError).toBe(true);
      expect((await repos().workflows.get(w.tenantId, w.wfB.id))?.isArchived).toBe(false);

      await repos().projects.relations.remove(w.tenantId, w.a.id, w.ann.user.id);
      const after = await call(w, key, 'search_workflows', {});
      expect(after.value?.data ?? []).toEqual([]);
    });

    it('MCP OAuth: a client grant, its consent and its tokens belong to one user; ben lists, revokes and reads none of them', async () => {
      const w = await world();
      const clientId = `client-${randomUUID()}`;
      const { mcpOAuth } = repos();
      await mcpOAuth.createClient({
        id: clientId,
        tenantId: w.tenantId,
        name: 'Ann client',
        redirectUris: ['http://localhost:4444/cb'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'none',
      });
      await mcpOAuth.saveConsent({ tenantId: w.tenantId, userId: w.ann.user.id, clientId, scope: ['workflow:read'] });
      const access = `wfo_at_${randomUUID()}`;
      const row = {
        tenantId: w.tenantId,
        clientId,
        userId: w.ann.user.id,
        resource: `${server.url}/mcp-server/${w.owner.tenant.slug}/http`,
        scope: ['workflow:read'],
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      await mcpOAuth.saveTokens(
        { ...row, tokenHash: createHash('sha256').update(access).digest('hex') },
        { ...row, tokenHash: createHash('sha256').update(`wfo_rt_${randomUUID()}`).digest('hex') },
      );
      expect((await mcpOAuth.listClientsByUser(w.tenantId, w.ann.user.id)).map((c) => c.id)).toEqual([clientId]);
      expect(await mcpOAuth.listClientsByUser(w.tenantId, w.ben.user.id)).toEqual([]);
      expect(await mcpOAuth.revokeForUser(w.tenantId, w.ben.user.id, clientId)).toBe(false);
      // the routes: ben's list is empty and his delete is refused
      const list = await w.ben.client.get('/rest/mcp/oauth-clients');
      if (list.statusCode === 200) expect(JSON.stringify(list.json())).not.toContain(clientId);
      const del = await w.ben.client.delete(`/rest/mcp/oauth-clients/${clientId}`);
      expect(del.statusCode).toBe(404);
      expect((await mcpOAuth.listClientsByUser(w.tenantId, w.ann.user.id)).map((c) => c.id)).toEqual([
        clientId,
      ]);
      expect(await mcpOAuth.revokeForUser(w.tenantId, w.ann.user.id, clientId)).toBe(true);
    });

    it("MCP trigger session: a token of ann reaches the trigger of A and gets insufficient_scope on B's", async () => {
      const w = await world();
      const makeTrigger = async (projectId: string) => {
        const p = `iso-${randomUUID().slice(0, 8)}`;
        const wf = await w.owner.client.data<{ id: string }>(
          w.owner.client.post('/rest/workflows', {
            name: `Trigger ${p}`,
            projectId,
            nodes: [
              node('MCP Server Trigger', 'ai.mcpTrigger', { path: p, authentication: 'n8nOAuth2' }, [0, 0], { webhookId: randomUUID() }),
              node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
            ],
            connections: { Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] } },
          }),
        );
        await w.owner.client.data(w.owner.client.post(`/rest/workflows/${wf.id}/activate`));
        return { id: wf.id, url: `${server.url}/mcp/${w.owner.tenant.slug}/${p}` };
      };
      const tokenFor = async (who: TestMember, resource: string) => {
        const redirectUri = 'http://127.0.0.1:7788/cb';
        const reg = await fetch(`${server.url}/mcp-oauth/${w.owner.tenant.slug}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_name: 'Iso client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
        });
        const { client_id: clientId } = (await reg.json()) as { client_id: string };
        const verifier = randomBytes(32).toString('base64url');
        const authorize = await fetch(
          `${server.url}/mcp-oauth/${w.owner.tenant.slug}/authorize?${new URLSearchParams({
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
        const { redirectUrl } = await who.client.data<{ redirectUrl: string }>(
          who.client.post('/rest/consent/approve', { flow, approved: true }),
        );
        const code = new URL(redirectUrl).searchParams.get('code') ?? '';
        const res = await fetch(`${server.url}/mcp-oauth/${w.owner.tenant.slug}/token`, {
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
      };
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
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
          }),
        });
      const inA = await makeTrigger(w.a.id);
      const inB = await makeTrigger(w.b.id);
      const helper = createMcpAuthHelper(server.ctx);
      expect(await helper.canExecute(w.ann.user.id, inA.id)).toBe(true);
      expect(await helper.canExecute(w.ann.user.id, inB.id)).toBe(false);
      const refused = await initialize(inB.url, await tokenFor(w.ann, inB.url));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });
      const opened = await initialize(inA.url, await tokenFor(w.ann, inA.url));
      expect(opened.status).toBe(200);
    });

    it("builder: ben's session routes and build call on A's workflow are 403 before any model call; ann's own session opens", async () => {
      const w = await world();
      const routes: Array<[string, Record<string, unknown>]> = [
        ['/rest/ai/sessions', {}],
        ['/rest/ai/build/truncate-messages', { messageId: 'm1' }],
        ['/rest/ai/build/clear-session', {}],
        ['/rest/ai/build/accepted-version', { versionId: 'v1' }],
        ['/rest/ai/build', { text: 'Say hello' }],
      ];
      for (const [route, extra] of routes) {
        expectHidden([await w.ben.client.post(route, { workflowId: w.wfA.id, ...extra })], route);
      }
      expect((await w.ann.client.post('/rest/ai/sessions', { workflowId: w.wfA.id })).statusCode).toBe(200);
      expect((await w.ann.client.post('/rest/ai/sessions', { workflowId: w.wfB.id })).statusCode).toBe(403);
    });

    it('public API: ann\'s key lists and changes A only; B reads 403 with n8n\'s text; a key never widens the member', async () => {
      const w = await world();
      const keyOf = async (client: TestClient) =>
        (await client.data(client.post('/rest/api-keys', { name: 'k' }))).key as string;
      const annKey = await keyOf(w.ann.client);
      const api = (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
        server.app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, payload: payload as object });
      const mine = (await api(annKey, 'GET', '/workflows')).json();
      expect(mine.data.map((x: { id: string }) => x.id)).toEqual([w.wfA.id]);
      expectHidden(
        [
          await api(annKey, 'GET', `/workflows/${w.wfB.id}`),
          await api(annKey, 'PUT', `/workflows/${w.wfB.id}`, { name: 'x', nodes: [], connections: {} }),
          await api(annKey, 'DELETE', `/workflows/${w.wfB.id}`),
          await api(annKey, 'POST', `/workflows/${w.wfB.id}/activate`, {}),
        ],
        'public api',
      );
      // a project filter the key's user holds nothing in is 200 and empty (as n8n), never B's workflow
      const foreign = await api(annKey, 'GET', `/workflows?projectId=${w.b.id}`);
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().data).toEqual([]);
      expect(foreign.body).not.toContain(w.wfB.id);
      expect((await api(annKey, 'GET', `/workflows/${w.wfA.id}`)).statusCode).toBe(200);
      const projects = (await api(annKey, 'GET', '/projects')).json();
      expect(JSON.stringify(projects)).not.toContain(w.b.id);
      expect((await repos().workflows.get(w.tenantId, w.wfB.id))?.isArchived).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// the Assistant: its own server (the fake model and the harness)

describe('Assistant, two members, two projects', () => {
  let h: AssistantHarness;
  let a: string;
  let b: string;
  let ann: HarnessUser;
  let ben: HarnessUser;
  const suffix = () => randomUUID().slice(0, 6);

  const newMember = async (): Promise<HarnessUser> => {
    const made = await realMember(h.owner, { remoteAddress: nextAddress() });
    return { client: made.client, userId: made.user.id, email: made.email, role: 'member', tenantId: h.tenantId };
  };

  beforeAll(async () => {
    h = await createAssistantHarness({});
    a = (await projectIn(h.server, h.tenantId, `A ${suffix()}`)).id;
    b = (await projectIn(h.server, h.tenantId, `B ${suffix()}`)).id;
    ann = await newMember();
    ben = await newMember();
    await addToProject(h.server, h.tenantId, a, ann.userId, 'project:editor');
    await addToProject(h.server, h.tenantId, b, ben.userId, 'project:editor');
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => h.checkRequests());

  it("tools: list tools show A's rows to ann and never B's; a tool on a row of B is refused", async () => {
    const own = await workflowIn(h.server, h.tenantId, a, { name: `Alpha ${suffix()}` });
    const foreign = await workflowIn(h.server, h.tenantId, b, { name: `Bravo ${suffix()}` });
    const ownTable = await dataTableIn(h.server, h.tenantId, a, `alpha_${suffix()}`);
    const foreignTable = await dataTableIn(h.server, h.tenantId, b, `bravo_${suffix()}`);
    const list = await h.callTool(ann, 'list_workflows', {});
    expect(list.result).toContain(own.name);
    expect(list.result).not.toContain(foreign.name);
    const tables = await h.callTool(ann, 'list_data_tables', {});
    expect(tables.result).toContain(ownTable.name);
    expect(tables.result).not.toContain(foreignTable.name);
    for (const [tool, args] of [
      ['get_workflow', { workflowId: foreign.id }],
      ['get_data_table_schema', { dataTableId: foreignTable.id }],
      ['list_workflows', { projectId: b }],
    ] as const) {
      const turn = await h.callTool(ann, tool, args);
      expect(turn.result, tool).toContain(FORBIDDEN);
      expect(turn.result, tool).not.toContain(foreign.name);
    }
  });

  it("test_credential: ann's call on B's credential is refused with the missing scope and never reaches the service", async () => {
    const mine = await credentialIn(h.server, h.tenantId, a, { name: `Own ${suffix()}`, data: { apiKey: 'own-key-0001' } });
    const theirs = await credentialIn(h.server, h.tenantId, b, { name: `Theirs ${suffix()}`, data: { apiKey: 'their-key-0002' } });
    const refused = await h.callTool(ann, 'test_credential', { credentialId: theirs.id });
    expect(refused.result).toContain(FORBIDDEN);
    expect(refused.result).not.toContain('their-key-0002');
    const own = await h.callTool(ann, 'test_credential', { credentialId: mine.id });
    expect(own.result).not.toContain(FORBIDDEN);
    expect(JSON.stringify(h.fake.requests)).not.toContain('their-key-0002');
  });

  it("get_node_parameter_options: B's credential is refused for ann before any request, and B's project too", async () => {
    const theirs = await credentialIn(h.server, h.tenantId, b, {
      name: `Models ${suffix()}`,
      type: 'openAiApi',
      data: { apiKey: 'sk-iso-test-0000000000000000', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    const withCredential = await h.callTool(ann, 'get_node_parameter_options', {
      nodeType: 'ai.lmChatOpenAi',
      version: 1,
      parameterPath: 'model',
      credentialId: theirs.id,
      projectId: a,
    });
    expect(withCredential.result).toMatch(/^Error: /);
    expect(withCredential.result).toContain(NO_ACCESS);
    const inB = await h.callTool(ann, 'get_node_parameter_options', {
      nodeType: 'ai.lmChatOpenAi',
      version: 1,
      parameterPath: 'model',
      credentialId: theirs.id,
      projectId: b,
    });
    expect(inB.result).toContain(FORBIDDEN);
    expect(JSON.stringify(h.fake.requests)).not.toContain('sk-iso-test');
  });

  it("threads and confirmations: ben sees none of ann's threads and cannot answer her card; her call still runs", async () => {
    const own = await workflowIn(h.server, h.tenantId, a, { name: `Archive me ${suffix()}` });
    const threadId = await h.createThread(ann);
    expect(JSON.stringify((await ben.client.get('/rest/assistant/threads')).json())).not.toContain(threadId);
    expect((await ben.client.get(`/rest/assistant/threads/${threadId}/status`)).statusCode).toBe(404);

    const turn = await h.callTool(ann, 'archive_workflow', { workflowId: own.id });
    const status = await h.waitForStatus(ann, turn.threadId, (s) => s.pending.length > 0);
    const card = status.pending[0] as { requestId: string };
    const stolen = await h.confirm(ben, card.requestId, { kind: 'approval', approved: true });
    expect(stolen.statusCode).toBe(404);
    expect((await h.ctx.repos.workflows.get(h.tenantId, own.id))?.isArchived).toBe(false);
    const mine = await h.confirm(ann, card.requestId, { kind: 'approval', approved: true });
    expect(mine.statusCode).toBe(200);
    await h.waitForStatus(ann, turn.threadId, 'idle');
    expect((await h.ctx.repos.workflows.get(h.tenantId, own.id))?.isArchived).toBe(true);
  });

  it("drafts: a draft built for B is refused to ann on accept and stays open, ben never reads ann's draft, A's draft lands in A", async () => {
    const putDraft = async (projectId: string) => {
      const threadId = await h.createThread(ann);
      const id = randomUUID();
      const now = new Date().toISOString();
      await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
        id,
        name: `Draft ${suffix()}`,
        workflowId: null,
        baseVersionId: null,
        projectId,
        definition: { name: 'Draft', nodes: [], connections: {}, settings: {} },
        createdAt: now,
        updatedAt: now,
        status: 'open',
        nodeCount: 0,
        issues: [],
      });
      return { url: `/rest/assistant/threads/${threadId}/drafts/${id}`, updatedAt: now };
    };
    const forB = await putDraft(b);
    const refused = await ann.client.post(`${forB.url}/accept`, { updatedAt: forB.updatedAt });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(FORBIDDEN);
    const view = await ann.client.data<{ draft: { status: string } }>(ann.client.get(forB.url));
    expect(view.draft.status).toBe('open');
    const forA = await putDraft(a);
    // ben has neither the thread nor the draft of ann
    expect((await ben.client.get(forA.url)).statusCode).toBe(404);
    expect((await ben.client.post(`${forA.url}/accept`, { updatedAt: forA.updatedAt })).statusCode).toBe(404);
    expect((await ben.client.post(`${forA.url}/discard`, {})).statusCode).toBe(404);
    const accepted = await ann.client.post(`${forA.url}/accept`, { updatedAt: forA.updatedAt });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await h.ctx.repos.workflows.get(h.tenantId, accepted.json().data.workflowId))?.projectId).toBe(a);
  });

  it('MCP connections: a member never writes one; an admin cannot pin a credential of B, and can pin one the workspace shares', async () => {
    await h.setSettings({ mcpAccessEnabled: true });
    const theirs = await credentialIn(h.server, h.tenantId, b, {
      name: `Mcp ${suffix()}`,
      type: 'httpHeaderAuth',
      data: { name: 'X', value: 'v-iso-3' },
    });
    const shared = await credentialIn(h.server, h.tenantId, b, {
      name: `Mcp shared ${suffix()}`,
      type: 'httpHeaderAuth',
      data: { name: 'X', value: 'v-iso-4' },
      isGlobal: true,
    });
    const body = (credentialId: string, name: string) => ({
      name,
      url: 'https://mcp.example.com/mcp',
      authentication: 'headerAuth',
      credentialId,
    });
    // a member never writes connections (the workspace scope), with a credential of its own project or not
    const created = await ann.client.post('/rest/assistant/mcp-connections', body(theirs.id, 'Docs'));
    expect(created.statusCode).toBe(403);
    expect(created.json().error.message).toBe(FORBIDDEN);
    const list = await ben.client.get('/rest/assistant/mcp-connections');
    expect(JSON.stringify(list.json())).not.toContain(theirs.id);
    // the admin reaches the credential check (a sign-in method is chosen) and is refused: B's credential is not
    // usable from the admin's project
    const asAdmin = await h.admin.client.post('/rest/assistant/mcp-connections', body(theirs.id, 'Docs'));
    expect(asAdmin.statusCode).toBe(400);
    expect(asAdmin.body).toContain(NO_ACCESS);
    expect(asAdmin.body).not.toContain('v-iso-3');
    expect(
      JSON.stringify((await h.admin.client.get('/rest/assistant/mcp-connections')).json()),
    ).not.toContain(theirs.id);
    // control: the same body with a credential the workspace shares is saved
    const control = await h.admin.client.post(
      '/rest/assistant/mcp-connections',
      body(shared.id, 'Docs shared'),
    );
    expect(control.statusCode, control.body).toBe(200);
    expect(control.body).not.toContain('v-iso-4');
  });
});

