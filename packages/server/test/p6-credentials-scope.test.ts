/**
 * P6-24 credentials by project, the worst case of the phase. A run, a save and a publish use only the
 * credentials owned by, shared with or global for the workflow's project (by id and by name), with n8n's
 * texts; `allow` comes from server paths only; an inline sub-workflow checks against the parent's project.
 * The routes check scopes on the credential or the target project for a true `member`, the list passes
 * the access filter, GET and PATCH answer `scopes`, `isGlobal` needs `credential:shareGlobally`, the test
 * route resolves `$vars` under one project, and an OAuth callback after lost access is refused.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  assertCredentialsUsable,
  InaccessibleCredentialError,
  InvalidCredentialError,
} from '../src/services/credential-usable';
import {
  addToProject,
  chain,
  createTestServer,
  credentialIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
  waitForExecution,
  workflowIn,
} from './helpers';

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/check') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'p6-token', token_type: 'Bearer', expires_in: 3600 }));
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
  received.length = 0;
});

const repos = () => server.ctx.repos;
const suffix = () => randomUUID().slice(0, 8);

/** an owner, its workspace and two team projects */
async function setup() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const mine = await projectIn(server, tenantId, `Mine ${suffix()}`);
  const other = await projectIn(server, tenantId, `Other ${suffix()}`);
  return { owner, tenantId, mine, other };
}

const useNode = (credential: { id: string | null; name: string }, extra: Partial<WorkflowNode> = {}) =>
  node('Use', 'test.useCredential', {}, [200, 0], { credentials: { testApi: credential }, ...extra });

function definitionWith(...nodes: WorkflowNode[]): WorkflowDefinition {
  return { name: 'Flow', nodes, connections: {} };
}

/** a saved workflow in `projectId` (through the service, so the save check runs) */
async function savedWorkflow(tenantId: string, projectId: string, nodes: WorkflowNode[]) {
  return server.ctx.workflows.create(
    tenantId,
    {
      name: `Flow ${suffix()}`,
      nodes,
      connections: chain(...nodes.map((n) => n.name)),
      settings: {},
      projectId,
    } as never,
    {},
  );
}

async function runStatus(
  owner: Awaited<ReturnType<typeof signup>>,
  workflowId: string,
): Promise<{ status: number; body?: unknown; execution?: Awaited<ReturnType<typeof waitForExecution>> }> {
  const res = await owner.client.post(`/rest/workflows/${workflowId}/run`, {});
  if (res.statusCode >= 400) return { status: res.statusCode, body: res.json() };
  const { executionId } = res.json().data as { executionId: string };
  const row = await waitForExecution(server.ctx, owner.tenant.id, executionId);
  return { status: 200, execution: row };
}

describe('assertCredentialsUsable', () => {
  it('passes owned, shared, global and allowed credentials, and refuses the rest with n8n texts', async () => {
    const { tenantId, mine, other } = await setup();
    const own = await credentialIn(server, tenantId, mine.id, { name: 'Own' });
    const foreign = await credentialIn(server, tenantId, other.id, { name: 'Foreign' });
    const global = await credentialIn(server, tenantId, other.id, { name: 'Global', isGlobal: true });
    const check = (n: WorkflowNode, options?: { allow?: string[] }) =>
      assertCredentialsUsable(server.ctx, tenantId, mine.id, definitionWith(n), options);

    await expect(check(useNode({ id: own.id, name: 'Own' }))).resolves.toBeUndefined();
    await expect(check(useNode({ id: global.id, name: 'Global' }))).resolves.toBeUndefined();

    const refused = await check(useNode({ id: foreign.id, name: 'Foreign' })).catch((e) => e);
    expect(refused).toBeInstanceOf(InaccessibleCredentialError);
    expect(refused.message).toBe('Node "Use" does not have access to the credential');
    expect(refused.description).toBe(
      `Please make sure that the credential is shared with the project "${mine.name}"`,
    );
    expect(refused.statusCode).toBe(400);

    // `allow` (a server path's ids) and a share make it usable
    await expect(check(useNode({ id: foreign.id, name: 'Foreign' }), { allow: [foreign.id] })).resolves.toBe(
      undefined,
    );
    await repos().shares.set(tenantId, 'credential', foreign.id, [mine.id]);
    await expect(check(useNode({ id: foreign.id, name: 'Foreign' }))).resolves.toBeUndefined();
  });

  it('refuses a malformed ref as invalid; an id or a name with no row is left to the provider', async () => {
    const { tenantId, mine } = await setup();
    const elsewhere = await signup(server.app);
    const theirs = await credentialIn(
      server,
      elsewhere.tenant.id,
      await teamProjectOf(server, elsewhere.tenant.id),
    );
    const check = (credentials: unknown) =>
      assertCredentialsUsable(
        server.ctx,
        tenantId,
        mine.id,
        definitionWith(node('Use', 'test.useCredential', {}, [200, 0], { credentials } as never)),
      );
    for (const credentials of [
      { testApi: { id: null, name: '' } },
      { testApi: 'x' },
      { testApi: { id: 7 } },
      ['x'],
    ]) {
      const error = await check(credentials).catch((e) => e);
      expect(error, JSON.stringify(credentials)).toBeInstanceOf(InvalidCredentialError);
      expect(error.message).toBe('Node "Use" uses invalid credential');
      expect(error.description).toBe('Please recreate the credential.');
    }
    for (const ref of [
      { id: randomUUID(), name: 'Gone' },
      { id: 'not-a-uuid', name: 'Bad' },
      { id: theirs.id, name: 'Theirs' },
      { id: null, name: 'Nowhere' },
    ]) {
      await expect(check({ testApi: ref }), JSON.stringify(ref)).resolves.toBeUndefined();
      // and the run refuses it when the node reads it
      await expect(server.ctx.credentials.provider(tenantId, mine.id).get(ref, 'testApi')).rejects.toThrow(
        /was not found/,
      );
    }
  });

  it('checks a name-only ref inside the project, skips expression ids and disabled nodes', async () => {
    const { tenantId, mine, other } = await setup();
    await credentialIn(server, tenantId, other.id, { name: 'Elsewhere' });
    await credentialIn(server, tenantId, mine.id, { name: 'Here' });
    const foreign = await credentialIn(server, tenantId, other.id, { name: 'Off' });
    const check = (n: WorkflowNode) =>
      assertCredentialsUsable(server.ctx, tenantId, mine.id, definitionWith(n));

    await expect(check(useNode({ id: null, name: 'Here' }))).resolves.toBeUndefined();
    await expect(check(useNode({ id: null, name: 'Elsewhere' }))).rejects.toBeInstanceOf(
      InaccessibleCredentialError,
    );
    // an expression id is resolved and checked by the provider at run time
    await expect(check(useNode({ id: '={{ $json.id }}', name: 'x' }))).resolves.toBeUndefined();
    // a disabled node does not run (n8n skips it too)
    await expect(
      check(useNode({ id: foreign.id, name: 'Off' }, { disabled: true })),
    ).resolves.toBeUndefined();
  });

  it('names a personal project with the personal text', async () => {
    const { owner, tenantId, other } = await setup();
    const personal = await repos().projects.getPersonal(tenantId, owner.user.id);
    expect(personal).toBeDefined();
    const foreign = await credentialIn(server, tenantId, other.id);
    const error = await assertCredentialsUsable(
      server.ctx,
      tenantId,
      personal!.id,
      definitionWith(useNode({ id: foreign.id, name: 'x' })),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InaccessibleCredentialError);
    expect(error.description).toBe('Please recreate the credential or ask its owner to share it with you.');
  });
});

describe('CredentialService.provider', () => {
  it('finds by id and by name only what the project can use; allow comes from the caller', async () => {
    const { tenantId, mine, other } = await setup();
    const own = await credentialIn(server, tenantId, mine.id, { name: 'Same', data: { apiKey: 'own-key' } });
    const foreign = await credentialIn(server, tenantId, other.id, {
      name: 'Only There',
      data: { apiKey: 'foreign-key' },
    });
    await credentialIn(server, tenantId, other.id, { name: 'Same', data: { apiKey: 'other-same' } });
    const provider = server.ctx.credentials.provider(tenantId, mine.id);

    expect((await provider.get({ id: own.id, name: 'Same' }, 'testApi')).apiKey).toBe('own-key');
    await expect(provider.get({ id: foreign.id, name: 'Only There' }, 'testApi')).rejects.toThrow(
      /was not found/,
    );
    // by name: only inside the project, the project's own first
    expect((await provider.get({ id: null, name: 'Same' }, 'testApi')).apiKey).toBe('own-key');
    await expect(provider.get({ id: null, name: 'Only There' }, 'testApi')).rejects.toThrow(/was not found/);
    // OAuth write-back goes through the same lookup
    await expect(
      provider.update({ id: foreign.id, name: 'x' }, 'testApi', { oauthTokenData: { access_token: 't' } }),
    ).rejects.toThrow(/was not found/);
    const stored = server.ctx.credentials.decrypt((await repos().credentials.get(tenantId, foreign.id))!);
    expect(stored.oauthTokenData).toBeUndefined();

    // a server path's allow list, a share and the global flag each make it usable
    const allowed = server.ctx.credentials.provider(tenantId, mine.id, { allow: [foreign.id] });
    expect((await allowed.get({ id: foreign.id, name: 'x' }, 'testApi')).apiKey).toBe('foreign-key');
    await repos().credentials.update(tenantId, foreign.id, { isGlobal: true });
    expect((await provider.get({ id: foreign.id, name: 'x' }, 'testApi')).apiKey).toBe('foreign-key');
    await repos().credentials.update(tenantId, foreign.id, { isGlobal: false });
    await repos().shares.set(tenantId, 'credential', foreign.id, [mine.id]);
    expect((await provider.get({ id: foreign.id, name: 'x' }, 'testApi')).apiKey).toBe('foreign-key');
  });
});

describe('run, save and publish', () => {
  it('a run naming another project credential is refused with n8n text; share and global make it run', async () => {
    const { owner, tenantId, mine, other } = await setup();
    const foreign = await credentialIn(server, tenantId, other.id, { data: { apiKey: 'abc' } });
    // stored behind the save check (a row made through the repository)
    const wf = await workflowIn(server, tenantId, mine.id, {
      nodes: [node('Start', 'core.manualTrigger'), useNode({ id: foreign.id, name: 'x' })],
      connections: chain('Start', 'Use'),
    });

    const refused = await runStatus(owner, wf.id);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('Node \\"Use\\" does not have access to the credential');
    expect(await repos().executions.list(tenantId, { workflowId: wf.id, limit: 10 })).toHaveLength(0);

    await repos().shares.set(tenantId, 'credential', foreign.id, [mine.id]);
    const shared = await runStatus(owner, wf.id);
    expect(shared.execution?.status).toBe('success');

    await repos().shares.set(tenantId, 'credential', foreign.id, []);
    expect((await runStatus(owner, wf.id)).status).toBe(400);
    await repos().credentials.update(tenantId, foreign.id, { isGlobal: true });
    expect((await runStatus(owner, wf.id)).execution?.status).toBe('success');
  });

  it('a run by name uses the project credential and never another project one', async () => {
    const { owner, tenantId, mine, other } = await setup();
    await credentialIn(server, tenantId, other.id, { name: 'ByName', data: { apiKey: 'long-foreign' } });
    const wf = await workflowIn(server, tenantId, mine.id, {
      nodes: [node('Start', 'core.manualTrigger'), useNode({ id: null, name: 'ByName' })],
      connections: chain('Start', 'Use'),
    });
    const refused = await runStatus(owner, wf.id);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('does not have access to the credential');

    await credentialIn(server, tenantId, mine.id, { name: 'ByName', data: { apiKey: 'own' } });
    const ran = await runStatus(owner, wf.id);
    expect(ran.execution?.status).toBe('success');
    const detail = await owner.client.data(owner.client.get(`/rest/executions/${ran.execution!.id}`));
    expect(detail.state.resultData.runData.Use[0].data.main[0][0].json.keyLength).toBe(3);
  });

  it('POST and PATCH /rest/workflows refuse a ref the workflow project cannot use', async () => {
    const { owner, tenantId, other } = await setup();
    const home = await teamProjectOf(server, tenantId);
    const foreign = await credentialIn(server, tenantId, other.id);
    const own = await credentialIn(server, tenantId, home);
    const nodes = (id: string) => [node('Start', 'core.manualTrigger'), useNode({ id, name: 'x' })];

    const created = await owner.client.post('/rest/workflows', {
      name: 'Refused',
      nodes: nodes(foreign.id),
      connections: chain('Start', 'Use'),
      settings: {},
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.message).toBe('Node "Use" does not have access to the credential');

    const ok = await owner.client.data(
      owner.client.post('/rest/workflows', {
        name: 'Fine',
        nodes: nodes(own.id),
        connections: chain('Start', 'Use'),
        settings: {},
      }),
    );
    const patched = await owner.client.patch(`/rest/workflows/${ok.id}`, {
      versionId: ok.versionId,
      nodes: nodes(foreign.id),
      connections: chain('Start', 'Use'),
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.message).toBe('Node "Use" does not have access to the credential');
  });

  it('a publish refuses a version whose credential the project lost', async () => {
    const { tenantId, mine, other } = await setup();
    const credential = await credentialIn(server, tenantId, mine.id);
    const wf = await savedWorkflow(tenantId, mine.id, [
      node('Hook', 'core.webhook', { path: `p6-cred-${suffix()}`, httpMethod: 'GET' }),
      useNode({ id: credential.id, name: 'x' }),
    ]);
    await repos().credentials.update(tenantId, credential.id, { projectId: other.id });
    await expect(server.ctx.activeWorkflows.activate(tenantId, wf.id)).rejects.toBeInstanceOf(
      InaccessibleCredentialError,
    );
    await repos().credentials.update(tenantId, credential.id, { projectId: mine.id });
    await expect(server.ctx.activeWorkflows.activate(tenantId, wf.id)).resolves.toBeDefined();
  });

  it("an inline sub-workflow checks its credentials against the parent's project", async () => {
    const { owner, tenantId, mine, other } = await setup();
    const own = await credentialIn(server, tenantId, mine.id, { data: { apiKey: 'own' } });
    const foreign = await credentialIn(server, tenantId, other.id, { data: { apiKey: 'foreign' } });
    const inline = (id: string) =>
      JSON.stringify({
        nodes: [node('In', 'core.executeWorkflowTrigger'), useNode({ id, name: 'x' })],
        connections: chain('In', 'Use'),
      });
    const parent = (id: string) => [
      node('Start', 'core.manualTrigger'),
      node('Sub', 'core.executeWorkflow', { source: 'parameter', workflowJson: inline(id) }, [200, 0]),
    ];
    const good = await savedWorkflow(tenantId, mine.id, parent(own.id));
    expect((await runStatus(owner, good.id)).execution?.status).toBe('success');

    const bad = await savedWorkflow(tenantId, mine.id, parent(foreign.id));
    const ran = await runStatus(owner, bad.id);
    expect(ran.execution?.status).toBe('error');
    expect(ran.execution?.errorMessage).toContain('does not have access to the credential');
  });
});

describe('credential routes for a true member', () => {
  async function memberIn(role: string) {
    const ctx = await setup();
    const member = await realMember(ctx.owner);
    await addToProject(server, ctx.tenantId, ctx.mine.id, member.user.id, role);
    return { ...ctx, member };
  }

  it('creates only in a project that gives credential:create', async () => {
    const { tenantId, mine, other, member } = await memberIn('project:editor');
    const made = await member.client.data(
      member.client.post('/rest/credentials', {
        name: 'Mine',
        type: 'testApi',
        data: { apiKey: 'k' },
        projectId: mine.id,
      }),
    );
    expect((await repos().credentials.get(tenantId, made.id))?.projectId).toBe(mine.id);
    const refused = await member.client.post('/rest/credentials', {
      name: 'Theirs',
      type: 'testApi',
      data: {},
      projectId: other.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    // no project: the member's personal project (P6-39), where it creates
    expect(
      (await member.client.post('/rest/credentials', { name: 'x', type: 'testApi', data: {} })).statusCode,
    ).toBe(200);
    expect(
      (await member.client.post('/rest/credentials', { name: 'x', type: 'testApi', projectId: randomUUID() }))
        .statusCode,
    ).toBe(404);
  });

  it('GET and PATCH answer scopes; a project editor holds credential:update, a viewer reads redacted', async () => {
    const { tenantId, mine, other, member } = await memberIn('project:editor');
    const credential = await credentialIn(server, tenantId, mine.id, { data: { apiKey: 'top-secret' } });
    const read = await member.client.data(member.client.get(`/rest/credentials/${credential.id}`));
    expect(read.scopes).toContain('credential:update');
    expect(read.scopes).toContain('credential:read');
    expect(read.scopes.every((s: string) => s.startsWith('credential:'))).toBe(true);
    expect(read.projectId).toBe(mine.id);
    expect(read.homeProject).toMatchObject({ id: mine.id, name: mine.name, type: 'team' });
    expect(read.data.apiKey).toBe('__REDACTED__');

    const patched = await member.client.data(
      member.client.patch(`/rest/credentials/${credential.id}`, { name: 'Renamed' }),
    );
    expect(patched).toMatchObject({ id: credential.id, name: 'Renamed' });
    expect(patched.scopes).toContain('credential:update');

    await addToProject(server, tenantId, mine.id, member.user.id, 'project:viewer');
    const asViewer = await member.client.data(member.client.get(`/rest/credentials/${credential.id}`));
    expect(asViewer.scopes).toContain('credential:read');
    expect(asViewer.scopes).not.toContain('credential:update');
    expect(JSON.stringify(asViewer)).not.toContain('top-secret');
    expect((await member.client.patch(`/rest/credentials/${credential.id}`, { name: 'No' })).statusCode).toBe(
      403,
    );
    expect((await member.client.delete(`/rest/credentials/${credential.id}`)).statusCode).toBe(403);

    const foreign = await credentialIn(server, tenantId, other.id);
    const hidden = await member.client.get(`/rest/credentials/${foreign.id}`);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    expect((await member.client.get(`/rest/credentials/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('isGlobal needs credential:shareGlobally; a global credential is readable and usable everywhere', async () => {
    const { owner, tenantId, mine, other, member } = await memberIn('project:admin');
    const credential = await credentialIn(server, tenantId, mine.id);
    const refused = await member.client.patch(`/rest/credentials/${credential.id}`, { isGlobal: true });
    expect(refused.statusCode).toBe(403);
    expect((await repos().credentials.get(tenantId, credential.id))?.isGlobal).toBe(false);

    const made = await owner.client.data(
      owner.client.patch(`/rest/credentials/${credential.id}`, { isGlobal: true }),
    );
    expect(made.isGlobal).toBe(true);
    expect((await repos().credentials.get(tenantId, credential.id))?.isGlobal).toBe(true);

    // another member with no relation to the owning project reads it (read only) and a run elsewhere uses it
    const outsider = await realMember(owner);
    await addToProject(server, tenantId, other.id, outsider.user.id, 'project:editor');
    const read = await outsider.client.data(outsider.client.get(`/rest/credentials/${credential.id}`));
    expect(read.isGlobal).toBe(true);
    expect(read.scopes).toEqual(['credential:read']);
    await expect(
      assertCredentialsUsable(
        server.ctx,
        tenantId,
        other.id,
        definitionWith(useNode({ id: credential.id, name: 'x' })),
      ),
    ).resolves.toBeUndefined();
  });

  it('the list passes the access filter, with projectId, onlySharedWithMe and includeScopes', async () => {
    const { tenantId, mine, other, member } = await memberIn('project:viewer');
    const own = await credentialIn(server, tenantId, mine.id, { name: 'A own' });
    const foreign = await credentialIn(server, tenantId, other.id, { name: 'B foreign' });
    const global = await credentialIn(server, tenantId, other.id, { name: 'C global', isGlobal: true });
    const sharedIn = await credentialIn(server, tenantId, other.id, { name: 'D shared' });
    const personal = await repos().projects.getPersonal(tenantId, member.user.id);
    expect(personal).toBeDefined();
    await repos().shares.set(tenantId, 'credential', sharedIn.id, [personal!.id]);

    const list = await member.client.data<Array<Record<string, unknown>>>(
      member.client.get('/rest/credentials'),
    );
    expect(list.map((r) => r.id)).toEqual([own.id, global.id, sharedIn.id]);
    expect(list.map((r) => r.id)).not.toContain(foreign.id);
    expect(list[0]).toMatchObject({ projectId: mine.id, isGlobal: false, homeProject: { id: mine.id } });
    expect(list[0]).not.toHaveProperty('data');
    expect(list[0]).not.toHaveProperty('scopes');
    expect(list[2].sharedWithProjects).toEqual([expect.objectContaining({ id: personal!.id })]);

    const scoped = await member.client.data<Array<{ id: string; scopes: string[] }>>(
      member.client.get(`/rest/credentials?includeScopes=true&projectId=${mine.id}`),
    );
    expect(scoped.map((r) => r.id)).toEqual([own.id]);
    expect(scoped[0].scopes).toContain('credential:read');
    expect(scoped[0].scopes).not.toContain('credential:update');

    const sharedWithMe = await member.client.data<Array<{ id: string }>>(
      member.client.get('/rest/credentials?onlySharedWithMe=true'),
    );
    expect(sharedWithMe.map((r) => r.id)).toEqual([sharedIn.id]);
  });

  it('the test route resolves $vars under one project and checks the scope there', async () => {
    const { tenantId, mine, other, member } = await memberIn('project:editor');
    await repos().variables.create(tenantId, { key: 'p6key', value: 'mine-value', projectId: mine.id });
    await repos().variables.create(tenantId, { key: 'p6key', value: 'other-value', projectId: other.id });
    const data = { baseUrl: remoteUrl, apiKey: '={{ $vars.p6key }}' };

    const tested = await member.client.data(
      member.client.post('/rest/credentials/test', { type: 'testApi', data, projectId: mine.id }),
    );
    expect(tested).toMatchObject({ status: 'OK' });
    expect(received.at(-1)?.headers['x-api-key']).toBe('mine-value');

    const refused = await member.client.post('/rest/credentials/test', {
      type: 'testApi',
      data,
      projectId: other.id,
    });
    expect(refused.statusCode).toBe(403);

    // a stored credential: its own project, and the caller needs credential:read on it
    const stored = await credentialIn(server, tenantId, mine.id, { data });
    const byId = await member.client.data(
      member.client.post('/rest/credentials/test', { id: stored.id, type: 'testApi', data }),
    );
    expect(byId.status).toBe('OK');
    expect(received.at(-1)?.headers['x-api-key']).toBe('mine-value');
    const foreign = await credentialIn(server, tenantId, other.id, { data });
    const hidden = await member.client.post('/rest/credentials/test', {
      id: foreign.id,
      type: 'testApi',
      data,
    });
    expect(hidden.statusCode).toBe(403);
    expect(received.filter((r) => r.headers['x-api-key'] === 'other-value')).toHaveLength(0);
  });

  it('OAuth2: a member starts the flow in its project; the callback after lost access is refused', async () => {
    const { tenantId, mine, member } = await memberIn('project:editor');
    const credential = await credentialIn(server, tenantId, mine.id, {
      type: 'testPkceOAuth2Api',
      data: {
        authUrl: 'https://auth.example.com/authorize',
        accessTokenUrl: `${remoteUrl}/token`,
        clientId: 'client-1',
        clientSecret: 'secret-1',
      },
    });
    const start = async () => {
      const { url } = await member.client.data(
        member.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`),
      );
      return new URL(url).searchParams.get('state')!;
    };
    const callback = (state: string) =>
      server.app.inject({ url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}` });

    const kept = await callback(await start());
    expect(kept.statusCode).toBe(200);
    expect(kept.body).toContain('"status":"success"');

    const state = await start();
    await repos().projects.relations.remove(tenantId, mine.id, member.user.id);
    const tokenCalls = received.filter((r) => r.url === '/token').length;
    const revoked = await callback(state);
    expect(revoked.statusCode).toBe(400);
    expect(revoked.body).toContain('no longer edit credentials');
    expect(received.filter((r) => r.url === '/token')).toHaveLength(tokenCalls);
    // and the flow cannot start again
    expect((await member.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`)).statusCode).toBe(
      403,
    );
  });

  it('OAuth1: the callback checks credential:update for the user of the state', async () => {
    const { tenantId, mine, member } = await memberIn('project:viewer');
    const credential = await credentialIn(server, tenantId, mine.id, { type: 'testApi' });
    // the state as the authorize step signs it (the flow itself is covered by oauth1.test.ts)
    const sign = (server.ctx.oauth1 as unknown as { sign(p: unknown): string }).sign.bind(server.ctx.oauth1);
    const state = sign({ t: tenantId, c: credential.id, u: member.user.id, e: Date.now() + 60_000, n: 'n1' });
    await expect(
      server.ctx.oauth1.callback({ oauth_token: 'rt', oauth_verifier: 'v' }, state),
    ).rejects.toThrow('no longer edit credentials');
    expect((await member.client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`)).statusCode).toBe(
      403,
    );
  });
});
