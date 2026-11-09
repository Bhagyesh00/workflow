/**
 * P6-28 project vaults: `$secrets` by the credential's home project (tenant wide + shared + owned), the
 * seven project routes, `projectIds` on workspace connections, the access list on the reload channel,
 * `assertProjectAccess` and the `externalSecrets.systemRolesEnabled` switch. The vault is an in-memory
 * fake provider; the credential test target is a local HTTP server.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import type {
  SecretProvider,
  SecretProviderSettings,
  SecretProviderType,
} from '../src/services/secrets/types';
import {
  addToProject,
  chain,
  credentialIn,
  createTestServer,
  flushRedis,
  memberAs,
  node,
  projectIn,
  realMember,
  signup as signupFrom,
  TEST_REDIS,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const PROVIDERS = '/rest/secret-providers';
const CONNECTIONS = `${PROVIDERS}/connections`;
const projectVaults = (projectId: string) => `${PROVIDERS}/projects/${projectId}/connections`;
const projectCompletions = (projectId: string) => `${PROVIDERS}/completions/secrets/project/${projectId}`;
const NOT_REACHABLE = 'The credential in use pulls secrets from an external store that is not reachable';
const MISSING_SCOPE = 'User is missing a scope required to perform this action';
const LOW_ACCESS = 'Project does not have the required access level for this connection';

// ---------------------------------------------------------------------------------------------
// the fake vault: token -> secrets, held in memory

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
    try {
      this.read();
      return { success: true };
    } catch {
      return { success: false, error: 'The vault answered with an error' };
    }
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
  properties: [
    { displayName: 'Label', name: 'label', type: 'string', default: '' },
    { displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } },
  ],
  create: (settings) => new MemoryProvider(settings),
};

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];

beforeAll(async () => {
  remote = createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  remoteUrl = await new Promise<string>((resolve) =>
    remote.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(remote.address() as AddressInfo).port}`)),
  );
  server = await createTestServer({}, { secretProviderTypes: [memoryType] });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await new Promise((r) => remote.close(r));
});

// signup allows 20 calls an hour per IP
let signups = 0;
const signup = (app: TestServer['app']) => {
  signups++;
  return signupFrom(app, { remoteAddress: `10.88.${signups >> 8}.${signups & 255}` });
};
type Owner = Awaited<ReturnType<typeof signup>>;

/** a vault holding `secrets` and its token */
function vaultWith(secrets: Record<string, unknown>) {
  const token = `token-${randomUUID()}`;
  vaults.set(token, secrets);
  return token;
}

/** a workspace connection (no owner project), enabled */
async function workspaceVault(owner: Owner, providerKey: string, secrets: Record<string, unknown>, projectIds?: string[]) {
  const token = vaultWith(secrets);
  const dto = await owner.client.data(
    owner.client.post(CONNECTIONS, {
      providerKey,
      type: 'memoryVault',
      settings: { label: 'ws', token },
      isEnabled: true,
      ...(projectIds ? { projectIds } : {}),
    }),
  );
  return { dto, token };
}

/** a connection owned by `projectId`, made through the project route, enabled */
async function projectVault(owner: Owner, projectId: string, providerKey: string, secrets: Record<string, unknown>) {
  const token = vaultWith(secrets);
  const dto = await owner.client.data(
    owner.client.post(projectVaults(projectId), {
      providerKey,
      type: 'memoryVault',
      settings: { label: 'project', token },
      isEnabled: true,
    }),
  );
  return { dto, token };
}

/** what `$secrets.<key>.<name>` gives under `projectId`, or the error text */
function read(ctx: ServerContext, tenantId: string, projectId: string | null, key: string, name: string): unknown {
  try {
    return ctx.secrets.secretsFor(tenantId, projectId)[key][name];
  } catch (error) {
    return (error as { description?: string }).description ?? String(error);
  }
}

/** a manual run in `projectId` of a node reading `testApi` whose apiKey is `expression`, started by `runner` */
async function runWith(
  owner: Owner,
  projectId: string,
  expression: string,
  runner: Pick<Owner, 'client'> = owner,
) {
  const credential = await credentialIn(server, owner.tenant.id, projectId, { data: { apiKey: expression } });
  const wf = await workflowIn(server, owner.tenant.id, projectId, {
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Use', 'test.useCredential', {}, [200, 0], {
        credentials: { testApi: { id: credential.id, name: credential.name } },
      }),
    ],
    connections: chain('Start', 'Use'),
  });
  const { executionId } = await runner.client.data(runner.client.post(`/rest/workflows/${wf.id}/run`, {}));
  const done = await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success', 'error']);
  const detail = await runner.client.data(runner.client.get(`/rest/executions/${executionId}`));
  return { status: done.status, text: JSON.stringify(detail) };
}

async function setSwitch(tenantId: string, enabled: boolean) {
  const tenant = await server.ctx.repos.tenants.get(tenantId);
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  await server.ctx.repos.tenants.updateSettings(tenantId, {
    ...settings,
    externalSecrets: { systemRolesEnabled: enabled },
  });
}

// ---------------------------------------------------------------------------------------------

describe('$secrets by the credential home project', () => {
  it("project A's secret cannot be read from project B, by a run; tenant wide reads everywhere", async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    await projectVault(owner, a.id, 'vaultA', { key: 'value-of-a' });
    await workspaceVault(owner, 'everyone', { key: 'value-for-all' });

    expect(read(server.ctx, owner.tenant.id, a.id, 'vaultA', 'key')).toBe('value-of-a');
    expect(read(server.ctx, owner.tenant.id, b.id, 'vaultA', 'key')).toBe(NOT_REACHABLE);
    expect(read(server.ctx, owner.tenant.id, null, 'vaultA', 'key')).toBe(NOT_REACHABLE);
    expect(read(server.ctx, owner.tenant.id, b.id, 'everyone', 'key')).toBe('value-for-all');
    expect(read(server.ctx, owner.tenant.id, null, 'everyone', 'key')).toBe('value-for-all');
    expect(Object.keys(server.ctx.secrets.secretsFor(owner.tenant.id, b.id))).toEqual(['everyone']);

    // true members, each an editor of one project only
    const editorOfA = await realMember(owner);
    const editorOfB = await realMember(owner);
    await addToProject(server, owner.tenant.id, a.id, editorOfA.user.id, 'project:editor');
    await addToProject(server, owner.tenant.id, b.id, editorOfB.user.id, 'project:editor');

    const inA = await runWith(owner, a.id, '={{ $secrets.vaultA.key }}', editorOfA);
    expect(inA.status).toBe('success');
    expect(inA.text).toContain('"keyLength":10');

    const inB = await runWith(owner, b.id, '={{ $secrets.vaultA.key }}', editorOfB);
    expect(inB.status).toBe('error');
    expect(inB.text).toContain('Could not load secrets');
    expect(inB.text).toContain(NOT_REACHABLE);
    expect(inB.text).not.toContain('value-of-a');

    const shared = await runWith(owner, b.id, '={{ $secrets.everyone.key }}', editorOfB);
    expect(shared.status).toBe('success');
  });

  it("project A's secret cannot be read from project B by /credentials/test", async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    await projectVault(owner, a.id, 'vaultA', { key: 'test-value-a' });
    const body = (projectId: string) => ({
      type: 'testApi',
      projectId,
      data: { baseUrl: remoteUrl, apiKey: '={{ $secrets.vaultA.key }}' },
    });

    // true members, each an editor of one project only
    const editorOfA = await realMember(owner);
    const editorOfB = await realMember(owner);
    await addToProject(server, owner.tenant.id, a.id, editorOfA.user.id, 'project:editor');
    await addToProject(server, owner.tenant.id, b.id, editorOfB.user.id, 'project:editor');
    const test = (caller: typeof editorOfB, payload: Record<string, unknown>) =>
      caller.client.data(caller.client.post('/rest/credentials/test', payload));

    received.length = 0;
    const fromB = await test(editorOfB, body(b.id));
    expect(fromB.status).toBe('Error');
    expect(fromB.message).toContain('Could not load secrets');
    expect(received).toEqual([]);

    const fromA = await test(editorOfA, body(a.id));
    expect(fromA.status).toBe('OK');
    expect(received.at(-1)?.headers['x-api-key']).toBe('test-value-a');
    expect(JSON.stringify(fromA)).not.toContain('test-value-a');

    // a stored credential of B, tested by id by B's editor, resolves under B
    const stored = await credentialIn(server, owner.tenant.id, b.id, {
      data: { baseUrl: remoteUrl, apiKey: '={{ $secrets.vaultA.key }}' },
    });
    received.length = 0;
    const byId = await test(editorOfB, { id: stored.id, type: 'testApi', data: {} });
    expect(byId.status).toBe('Error');
    expect(JSON.stringify(byId)).not.toContain('test-value-a');
    expect(received).toEqual([]);

    // a credential of A that B only reads (shared to B, or global): its body data is ignored, so B's
    // editor cannot resolve A's vault into it or send it elsewhere
    const sharedToB = await credentialIn(server, owner.tenant.id, a.id, {
      data: { baseUrl: remoteUrl, apiKey: 'stored-shared' },
    });
    const share = { shareWithIds: [b.id] };
    await owner.client.data(owner.client.put(`/rest/credentials/${sharedToB.id}/share`, share));
    const global = await credentialIn(server, owner.tenant.id, a.id, {
      data: { baseUrl: remoteUrl, apiKey: 'stored-global' },
      isGlobal: true,
    });
    for (const [credential, storedKey] of [
      [sharedToB, 'stored-shared'],
      [global, 'stored-global'],
    ] as const) {
      received.length = 0;
      const answer = await test(editorOfB, {
        id: credential.id,
        type: 'testApi',
        data: { baseUrl: `${remoteUrl}/elsewhere`, apiKey: '={{ $secrets.vaultA.key }}' },
      });
      expect(JSON.stringify(answer), storedKey).not.toContain('test-value-a');
      expect(received, storedKey).toHaveLength(1);
      expect(received[0].url, storedKey).toBe('/check');
      expect(received[0].headers['x-api-key'], storedKey).toBe(storedKey);
    }
  });

  it('a workspace connection with projectIds is shared to those projects only, and to all again when emptied', async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'Alpha', { icon: { type: 'emoji', value: 'A' } });
    const b = await projectIn(server, owner.tenant.id, 'Beta');
    const { dto, token } = await workspaceVault(owner, 'limited', { key: 'limited-value' }, [a.id]);
    expect(dto.projectId).toBeNull();
    expect(dto.projects).toEqual([{ id: a.id, name: 'Alpha', type: 'team', icon: a.icon }]);
    expect(JSON.stringify(dto)).not.toContain(token);

    expect(read(server.ctx, owner.tenant.id, a.id, 'limited', 'key')).toBe('limited-value');
    expect(read(server.ctx, owner.tenant.id, b.id, 'limited', 'key')).toBe(NOT_REACHABLE);
    expect(read(server.ctx, owner.tenant.id, null, 'limited', 'key')).toBe(NOT_REACHABLE);

    const moved = await owner.client.data(owner.client.patch(`${CONNECTIONS}/limited`, { projectIds: [b.id] }));
    expect(moved.projects.map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect(read(server.ctx, owner.tenant.id, a.id, 'limited', 'key')).toBe(NOT_REACHABLE);
    expect(read(server.ctx, owner.tenant.id, b.id, 'limited', 'key')).toBe('limited-value');

    const listed = await owner.client.data(owner.client.get(CONNECTIONS));
    expect(listed.find((c: { providerKey: string }) => c.providerKey === 'limited').projects).toHaveLength(1);

    const open = await owner.client.data(owner.client.patch(`${CONNECTIONS}/limited`, { projectIds: [] }));
    expect(open.projects).toEqual([]);
    expect(read(server.ctx, owner.tenant.id, a.id, 'limited', 'key')).toBe('limited-value');

    // a project of another workspace is refused, and nothing changes
    const other = await signup(server.app);
    const foreign = await projectIn(server, other.tenant.id, 'Foreign');
    const refused = await owner.client.patch(`${CONNECTIONS}/limited`, { projectIds: [foreign.id] });
    expect(refused.statusCode).toBe(404);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/limited`))).projects).toEqual([]);
  });
});

describe('project routes', () => {
  it('create, list, get, patch, test and delete in a project; secret values and settings never returned', async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    const created = await projectVault(owner, a.id, 'ownA', { key: 'own-value', more: 'x' });
    expect(created.dto).toMatchObject({
      providerKey: 'ownA',
      projectId: a.id,
      projects: [],
      state: 'connected',
      secretsCount: 2,
      settings: { label: 'project', token: '__REDACTED__' },
    });
    await workspaceVault(owner, 'wide', { key: 'wide-value' });
    await workspaceVault(owner, 'toB', { key: 'b-value' }, [b.id]);

    const listA = await owner.client.data(owner.client.get(projectVaults(a.id)));
    expect(listA.map((c: { providerKey: string }) => c.providerKey).sort()).toEqual(['ownA', 'wide']);
    const listB = await owner.client.data(owner.client.get(projectVaults(b.id)));
    expect(listB.map((c: { providerKey: string }) => c.providerKey).sort()).toEqual(['toB', 'wide']);

    const one = await owner.client.data(owner.client.get(`${projectVaults(a.id)}/ownA`));
    expect(one.settings.token).toBe('__REDACTED__');
    expect((await owner.client.get(`${projectVaults(b.id)}/ownA`)).statusCode).toBe(404);

    const patched = await owner.client.data(
      owner.client.patch(`${projectVaults(a.id)}/ownA`, { settings: { label: 'renamed', token: '__REDACTED__' } }),
    );
    expect(patched.settings).toEqual({ label: 'renamed', token: '__REDACTED__' });
    expect(read(server.ctx, owner.tenant.id, a.id, 'ownA', 'key')).toBe('own-value');

    const tested = await owner.client.data(owner.client.post(`${projectVaults(a.id)}/ownA/test`));
    expect(tested).toMatchObject({ success: true, testState: 'connected' });

    const notHere = await owner.client.patch(`${projectVaults(b.id)}/ownA`, { isEnabled: false });
    expect(notHere.statusCode).toBe(404);
    expect(notHere.json().error.message).toBe(`Connection with key "ownA" not found in project "${b.id}"`);
    // the tenant wide connection is listed for a project but not changed through it
    expect((await owner.client.delete(`${projectVaults(a.id)}/wide`)).statusCode).toBe(404);

    const names = await owner.client.data(owner.client.get(projectCompletions(a.id)));
    expect(names).toEqual({ ownA: ['key', 'more'] });
    const namesB = await owner.client.data(owner.client.get(projectCompletions(b.id)));
    expect(namesB).toEqual({ toB: ['key'] });
    const global = await owner.client.data(owner.client.get(`${PROVIDERS}/completions/secrets/global`));
    expect(global).toEqual({ wide: ['key'] });

    const answers = JSON.stringify([created.dto, listA, listB, one, patched, tested, names, global]);
    for (const value of ['own-value', 'wide-value', 'b-value', created.token]) {
      expect(answers).not.toContain(value);
    }

    expect((await owner.client.delete(`${projectVaults(a.id)}/ownA`)).statusCode).toBe(200);
    expect(read(server.ctx, owner.tenant.id, a.id, 'ownA', 'key')).toBe(NOT_REACHABLE);
    expect(await server.ctx.repos.secrets.get(owner.tenant.id, 'ownA')).toBeUndefined();
  });

  it('keeps the provider key unique per workspace and refuses another workspace project with 404', async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    await workspaceVault(owner, 'taken', { key: 'v' });
    const dup = await owner.client.post(projectVaults(a.id), {
      providerKey: 'taken',
      type: 'memoryVault',
      settings: { token: 't' },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toBe('Connection with key "taken" already exists');

    const other = await signup(server.app);
    const foreign = await projectIn(server, other.tenant.id, 'Foreign');
    expect((await owner.client.get(projectVaults(foreign.id))).statusCode).toBe(404);
    expect((await owner.client.get(projectCompletions(foreign.id))).statusCode).toBe(404);
    expect((await owner.client.get(projectVaults('not-a-uuid'))).statusCode).toBe(404);
  });

  it('a project that is only shared on a connection cannot change it', async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    const b = await projectIn(server, owner.tenant.id, 'B');
    await setSwitch(owner.tenant.id, true);
    await projectVault(owner, a.id, 'ofA', { key: 'a' });
    // share A's connection to B through the workspace route
    await owner.client.data(owner.client.patch(`${CONNECTIONS}/ofA`, { projectIds: [b.id] }));
    expect(read(server.ctx, owner.tenant.id, b.id, 'ofA', 'key')).toBe('a');

    const adminOfB = await realMember(owner);
    await addToProject(server, owner.tenant.id, b.id, adminOfB.user.id, 'project:admin');
    expect((await adminOfB.client.get(`${projectVaults(b.id)}/ofA`)).statusCode).toBe(200);
    for (const [method, url] of [
      ['patch', `${projectVaults(b.id)}/ofA`],
      ['delete', `${projectVaults(b.id)}/ofA`],
      ['post', `${projectVaults(b.id)}/ofA/test`],
    ] as const) {
      const answer =
        method === 'patch'
          ? await adminOfB.client.patch(url, { isEnabled: false })
          : method === 'delete'
            ? await adminOfB.client.delete(url)
            : await adminOfB.client.post(url);
      expect(answer.statusCode, url).toBe(403);
      expect(answer.json().error.message, url).toBe(LOW_ACCESS);
    }
    // the owner holds the workspace scope and passes
    expect((await owner.client.post(`${projectVaults(b.id)}/ofA/test`)).statusCode).toBe(200);
  });
});

describe('the externalSecrets.systemRolesEnabled switch', () => {
  it('off: project roles reach no vault route; on: project admin manages, project editor reads', async () => {
    const owner = await signup(server.app);
    const a = await projectIn(server, owner.tenant.id, 'A');
    await projectVault(owner, a.id, 'ofA', { key: 'a' });
    const admin = await realMember(owner);
    const editor = await realMember(owner);
    const viewer = await realMember(owner);
    await addToProject(server, owner.tenant.id, a.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, a.id, editor.user.id, 'project:editor');
    await addToProject(server, owner.tenant.id, a.id, viewer.user.id, 'project:viewer');
    const create = (client: typeof admin.client, providerKey: string) =>
      client.post(projectVaults(a.id), {
        providerKey,
        type: 'memoryVault',
        settings: { token: vaultWith({ k: 'v' }) },
      });

    for (const member of [admin, editor, viewer]) {
      const list = await member.client.get(projectVaults(a.id));
      expect(list.statusCode).toBe(403);
      expect(list.json().error.message).toBe(MISSING_SCOPE);
      expect((await member.client.get(projectCompletions(a.id))).statusCode).toBe(403);
    }
    expect((await create(admin.client, 'offAdmin')).statusCode).toBe(403);

    await setSwitch(owner.tenant.id, true);
    expect((await admin.client.get(projectVaults(a.id))).statusCode).toBe(200);
    expect((await create(admin.client, 'onAdmin')).statusCode).toBe(200);
    expect((await admin.client.patch(`${projectVaults(a.id)}/onAdmin`, { isEnabled: true })).statusCode).toBe(200);
    expect((await admin.client.delete(`${projectVaults(a.id)}/onAdmin`)).statusCode).toBe(200);

    expect((await editor.client.get(projectVaults(a.id))).statusCode).toBe(200);
    expect((await editor.client.get(`${projectVaults(a.id)}/ofA`)).statusCode).toBe(200);
    expect(await editor.client.data(editor.client.get(projectCompletions(a.id)))).toEqual({ ofA: ['key'] });
    expect((await create(editor.client, 'onEditor')).statusCode).toBe(403);
    expect((await editor.client.patch(`${projectVaults(a.id)}/ofA`, { isEnabled: false })).statusCode).toBe(403);
    expect((await editor.client.delete(`${projectVaults(a.id)}/ofA`)).statusCode).toBe(403);

    expect((await viewer.client.get(projectVaults(a.id))).statusCode).toBe(403);
    // workspace routes stay with the workspace roles
    expect((await admin.client.get(CONNECTIONS)).statusCode).toBe(403);

    // a removed member loses it on the next call
    await server.ctx.repos.projects.relations.remove(owner.tenant.id, a.id, admin.user.id);
    expect((await admin.client.get(projectVaults(a.id))).statusCode).toBe(403);
    await setSwitch(owner.tenant.id, false);
    expect((await editor.client.get(projectVaults(a.id))).statusCode).toBe(403);
  });

  it('GET and POST /external-secrets/settings: workspace owner and admin only; the switch then opens the vault', async () => {
    const SWITCH = '/rest/external-secrets/settings';
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const a = await projectIn(server, tenantId, 'A');
    await projectVault(owner, a.id, 'ofA', { key: 'a' });
    await owner.client.data(owner.client.patch('/rest/settings', { timezone: 'Europe/Berlin' }));
    const member = await realMember(owner);
    await addToProject(server, tenantId, a.id, member.user.id, 'project:editor');

    // a true member, even an editor of a project, neither reads nor turns the switch
    for (const answer of [
      await member.client.get(SWITCH),
      await member.client.post(SWITCH, { systemRolesEnabled: true }),
    ]) {
      expect(answer.statusCode).toBe(403);
      expect(answer.json().error.message).toBe(MISSING_SCOPE);
    }
    expect(await server.ctx.secrets.systemRolesEnabled(tenantId)).toBe(false);
    expect((await member.client.get(projectVaults(a.id))).statusCode).toBe(403);

    expect(await owner.client.data(owner.client.get(SWITCH))).toEqual({ systemRolesEnabled: false });
    expect((await owner.client.post(SWITCH, { systemRolesEnabled: 'yes' })).statusCode).toBe(400);
    expect((await owner.client.post(SWITCH, {})).statusCode).toBe(400);
    expect(await owner.client.data(owner.client.post(SWITCH, { systemRolesEnabled: true }))).toEqual({
      systemRolesEnabled: true,
    });
    expect(await owner.client.data(owner.client.get(SWITCH))).toEqual({ systemRolesEnabled: true });
    // the other settings stay, and the change is audited
    const tenant = await server.ctx.repos.tenants.get(tenantId);
    expect(tenant?.settings).toMatchObject({ timezone: 'Europe/Berlin' });
    const audit = (await server.ctx.repos.audit.list(tenantId, 50)).filter(
      (row) => row.action === 'tenant.settings_updated' && Object.hasOwn(row.metadata, 'externalSecrets'),
    );
    expect(audit.map((row) => [row.userId, row.metadata])).toEqual([
      [owner.user.id, { externalSecrets: { systemRolesEnabled: true } }],
    ]);

    // the project editor now reads the vault
    expect((await member.client.get(projectVaults(a.id))).statusCode).toBe(200);

    // a workspace admin turns it off; another workspace is not touched
    const other = await signup(server.app);
    const admin = await memberAs(owner, 'admin');
    expect(await admin.client.data(admin.client.get(SWITCH))).toEqual({ systemRolesEnabled: true });
    expect(await admin.client.data(admin.client.post(SWITCH, { systemRolesEnabled: false }))).toEqual({
      systemRolesEnabled: false,
    });
    expect((await member.client.get(projectVaults(a.id))).statusCode).toBe(403);
    expect(await other.client.data(other.client.get(SWITCH))).toEqual({ systemRolesEnabled: false });
  });
});

describe('assertProjectAccess', () => {
  it('refuses a vault key the project cannot reach, with n8n text; passes owned, shared and tenant wide', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const a = await projectIn(server, tenantId, 'A');
    const b = await projectIn(server, tenantId, 'B');
    await projectVault(owner, a.id, 'ofA', { k: 'v' });
    await workspaceVault(owner, 'wide', { k: 'v' });
    await workspaceVault(owner, 'onlyB', { k: 'v' }, [b.id]);
    // a disabled connection still counts: access is about the key, not the state
    await owner.client.data(owner.client.patch(`${CONNECTIONS}/onlyB`, { isEnabled: false }));

    await expect(server.ctx.secrets.assertProjectAccess(tenantId, a.id, ['ofA', 'wide'])).resolves.toBeUndefined();
    await expect(server.ctx.secrets.assertProjectAccess(tenantId, b.id, ['wide', 'onlyB'])).resolves.toBeUndefined();
    await expect(server.ctx.secrets.assertProjectAccess(tenantId, b.id, [])).resolves.toBeUndefined();
    await expect(server.ctx.secrets.assertProjectAccess(tenantId, b.id, ['ofA'])).rejects.toMatchObject({
      statusCode: 400,
      message: 'The secret provider "ofA" does not exist in this project',
    });
    await expect(server.ctx.secrets.assertProjectAccess(tenantId, a.id, ['onlyB', 'nope', 'wide'])).rejects.toMatchObject({
      statusCode: 400,
      message: 'The secret providers "nope", "onlyB" do not exist in this project',
    });
    // another workspace's keys are not this one's
    const other = await signup(server.app);
    await expect(server.ctx.secrets.assertProjectAccess(other.tenant.id, a.id, ['wide'])).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('access list on the reload channel', () => {
  it('an unshare on one main reaches a second main through the channel', async () => {
    await flushRedis();
    const env = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: `wfvaults${randomUUID().slice(0, 6)}` };
    const main = await createTestServer(env, { reset: false, secretProviderTypes: [memoryType] });
    let second: ServerContext | undefined;
    try {
      second = await createContext({
        config: testConfig(env),
        nodePackages: [nodesBasePackage, testPackage],
        secretProviderTypes: [memoryType],
        http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
        migrate: false,
      });
      await second.secrets.start();
      const peer = second;
      const owner = await signup(main.app);
      const tenantId = owner.tenant.id;
      const a = await main.ctx.repos.projects.create(tenantId, { name: 'A', type: 'team' });
      const b = await main.ctx.repos.projects.create(tenantId, { name: 'B', type: 'team' });
      const token = vaultWith({ key: 'shared-value' });
      await main.ctx.secrets.createConnection(tenantId, {
        providerKey: 'shared',
        type: 'memoryVault',
        settings: { token },
        isEnabled: true,
        projectIds: [a.id, b.id],
      });
      await waitFor(async () => read(peer, tenantId, b.id, 'shared', 'key') === 'shared-value');
      expect(read(peer, tenantId, null, 'shared', 'key')).toBe(NOT_REACHABLE);

      await main.ctx.secrets.updateConnection(tenantId, 'shared', { projectIds: [a.id] });
      expect(read(main.ctx, tenantId, b.id, 'shared', 'key')).toBe(NOT_REACHABLE);
      await waitFor(async () => read(peer, tenantId, b.id, 'shared', 'key') === NOT_REACHABLE);
      expect(read(peer, tenantId, a.id, 'shared', 'key')).toBe('shared-value');

      // back to tenant wide: every project reads it on the second main
      await main.ctx.secrets.updateConnection(tenantId, 'shared', { projectIds: [] });
      await waitFor(async () => read(peer, tenantId, b.id, 'shared', 'key') === 'shared-value');
    } finally {
      await second?.close();
      await main.close();
    }
  }, 60_000);
});
