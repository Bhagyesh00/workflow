/**
 * P6-49 (L4): /rest node and credential type policies: the workspace scope, the documents, the attachments,
 * `available-types` and the sub-workflow start preview. A write sends the version it read (a stale one is 409),
 * `nodeTypePolicy:manage` is the gate (a member gets n8n's 403 text), each write leaves an audit row
 * `type_policy.*`, and a project denial never names the project.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  node,
  policyDeny,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const MISSING = 'User is missing a scope required to perform this action';
const rule = (name: string, action: 'allow' | 'deny' | 'delegate' = 'deny') => ({
  action,
  selector: { name },
});

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  return { owner, member, tenantId, alpha, beta };
}

const audits = async (tenantId: string) =>
  (await server.ctx.repos.audit.list(tenantId, 100)).map((row) => row.action);

describe('REST type policy scope', () => {
  it('reads an unwritten scope as allow at version 0, then writes with the version it read', async () => {
    const { owner, tenantId } = await setup();
    const first = await owner.client.data(owner.client.get('/rest/node-type-policies/instance'));
    expect(first).toMatchObject({
      id: null,
      defaultAction: 'allow',
      version: 0,
      attachments: [],
      projectId: null,
    });
    const written = await owner.client.data(
      owner.client.put('/rest/node-type-policies/instance', { defaultAction: 'deny', expectedVersion: 0 }),
    );
    expect(written).toMatchObject({ defaultAction: 'deny', version: 1, kind: 'node' });
    const stale = await owner.client.put('/rest/node-type-policies/instance', {
      defaultAction: 'allow',
      expectedVersion: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(await audits(tenantId)).toContain('type_policy.scope.updated');
    // the credential kind is its own scope
    const credential = await owner.client.data(owner.client.get('/rest/credential-type-policies/instance'));
    expect(credential).toMatchObject({ defaultAction: 'allow', version: 0, kind: 'credential' });
  });

  it('refuses a body without expectedVersion and a project scope that delegates', async () => {
    const { owner, alpha } = await setup();
    const missing = await owner.client.put('/rest/node-type-policies/instance', { defaultAction: 'deny' });
    expect(missing.statusCode).toBe(400);
    const store = server.ctx.typePolicies;
    await expect(
      store.putScope(owner.tenant.id, 'node', alpha.id, { defaultAction: 'delegate' }, 0),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('is 403 with n8n text for a member, on read and write, and 401 without a session', async () => {
    const { member } = await setup();
    const { app } = server;
    for (const base of ['node', 'credential']) {
      const read = await member.client.get(`/rest/${base}-type-policies/instance`);
      expect(read.statusCode).toBe(403);
      expect(read.json().error.message).toBe(MISSING);
      const write = await member.client.put(`/rest/${base}-type-policies/instance`, {
        defaultAction: 'deny',
        expectedVersion: 0,
      });
      expect(write.statusCode).toBe(403);
      const create = await member.client.post(`/rest/${base}-type-policies/policies`, {
        name: 'x',
        rules: [],
      });
      expect(create.statusCode).toBe(403);
    }
    const anonymous = await app.inject({ method: 'GET', url: '/rest/node-type-policies/instance' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('REST type policy documents', () => {
  it('creates, reads, lists, changes and deletes a document, with audit rows', async () => {
    const { owner, tenantId } = await setup();
    const created = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', {
        name: 'no http',
        description: 'blocks the request node',
        rules: [rule('core.httpRequest'), { id: 'r2', ...rule('core.code') }],
      }),
    );
    expect(created).toMatchObject({ name: 'no http', version: 1, kind: 'node' });
    expect(created.rules).toHaveLength(2);
    expect(created.rules[0].id).toEqual(expect.any(String));
    expect(created.rules[1].id).toBe('r2');
    expect(Array.isArray(created.warnings)).toBe(true);
    const id = created.id as string;
    expect(
      await owner.client.data(owner.client.get(`/rest/node-type-policies/policies/${id}`)),
    ).toMatchObject({
      id,
      name: 'no http',
    });
    const list = await owner.client.data(owner.client.get('/rest/node-type-policies/policies'));
    expect(list.map((p: { id: string }) => p.id)).toEqual([id]);
    const patched = await owner.client.data(
      owner.client.patch(`/rest/node-type-policies/policies/${id}`, {
        name: 'no http 2',
        expectedVersion: 1,
      }),
    );
    expect(patched).toMatchObject({ name: 'no http 2', version: 2 });
    const stale = await owner.client.patch(`/rest/node-type-policies/policies/${id}`, {
      name: 'again',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    const wrongVersion = await owner.client.delete(
      `/rest/node-type-policies/policies/${id}?expectedVersion=1`,
    );
    expect(wrongVersion.statusCode).toBe(409);
    const noVersion = await owner.client.delete(`/rest/node-type-policies/policies/${id}`);
    expect(noVersion.statusCode).toBe(400);
    expect(
      await owner.client.data(
        owner.client.delete(`/rest/node-type-policies/policies/${id}?expectedVersion=2`),
      ),
    ).toEqual({ ok: true });
    expect((await owner.client.get(`/rest/node-type-policies/policies/${id}`)).statusCode).toBe(404);
    const actions = await audits(tenantId);
    for (const action of [
      'type_policy.document.created',
      'type_policy.document.updated',
      'type_policy.document.deleted',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('keeps the kinds apart: a node policy is 404 under the credential path', async () => {
    const { owner } = await setup();
    const created = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', { name: 'n', rules: [rule('core.set')] }),
    );
    expect((await owner.client.get(`/rest/credential-type-policies/policies/${created.id}`)).statusCode).toBe(
      404,
    );
    const list = await owner.client.data(owner.client.get('/rest/credential-type-policies/policies'));
    expect(list).toEqual([]);
    // the other kind never lists it either way round
    expect((await owner.client.get(`/rest/node-type-policies/policies/${randomUUID()}`)).statusCode).toBe(
      404,
    );
  });

  it('refuses bad rules: two selector fields, an extends selector on a node policy, a duplicate id', async () => {
    const { owner } = await setup();
    const post = (kind: string, rules: unknown[]) =>
      owner.client.post(`/rest/${kind}-type-policies/policies`, { name: `p-${randomUUID()}`, rules });
    expect((await post('node', [{ action: 'deny', selector: { name: 'a', package: 'b' } }])).statusCode).toBe(
      400,
    );
    expect((await post('node', [{ action: 'deny', selector: {} }])).statusCode).toBe(400);
    expect((await post('node', [{ action: 'deny', selector: { extends: 'oAuth2Api' } }])).statusCode).toBe(
      400,
    );
    expect(
      (await post('credential', [{ action: 'deny', selector: { extends: 'oAuth2Api' } }])).statusCode,
    ).toBe(200);
    expect(
      (
        await post('node', [
          { id: 'same', ...rule('a') },
          { id: 'same', ...rule('b') },
        ])
      ).statusCode,
    ).toBe(400);
    const dup = await owner.client.post('/rest/node-type-policies/policies', { name: 'dup', rules: [] });
    expect(dup.statusCode).toBe(200);
    expect(
      (await owner.client.post('/rest/node-type-policies/policies', { name: 'dup', rules: [] })).statusCode,
    ).toBe(409);
  });

  it('is another tenant 404: a policy and a scope id of one workspace are unknown to another', async () => {
    const { owner } = await setup();
    const other = await signup(server.app);
    const created = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', { name: 'mine', rules: [] }),
    );
    expect((await other.client.get(`/rest/node-type-policies/policies/${created.id}`)).statusCode).toBe(404);
    const scope = await owner.client.data(
      owner.client.put('/rest/node-type-policies/instance', { defaultAction: 'deny', expectedVersion: 0 }),
    );
    expect(
      (await other.client.get(`/rest/node-type-policies/scopes/${scope.id}/attachments`)).statusCode,
    ).toBe(404);
  });
});

describe('REST type policy attachments', () => {
  it('attaches a document to the scope, lists it, and holds the delete while attached', async () => {
    const { owner, tenantId } = await setup();
    const doc = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', {
        name: 'deny code',
        rules: [rule('core.code')],
      }),
    );
    const scope = await owner.client.data(
      owner.client.put('/rest/node-type-policies/instance', { defaultAction: 'allow', expectedVersion: 0 }),
    );
    const attached = await owner.client.data(
      owner.client.put(`/rest/node-type-policies/scopes/${scope.id}/attachments`, {
        attachments: [{ policyId: doc.id, priority: 0, isFloor: true }],
        expectedVersion: scope.version,
      }),
    );
    expect(attached).toEqual([{ policyId: doc.id, priority: 0, isFloor: true }]);
    expect(
      await owner.client.data(owner.client.get(`/rest/node-type-policies/scopes/${scope.id}/attachments`)),
    ).toEqual(attached);
    const stale = await owner.client.put(`/rest/node-type-policies/scopes/${scope.id}/attachments`, {
      attachments: [],
      expectedVersion: scope.version,
    });
    expect(stale.statusCode).toBe(409);
    const held = await owner.client.delete(`/rest/node-type-policies/policies/${doc.id}?expectedVersion=1`);
    expect(held.statusCode).toBe(409);
    // the scope read shows the attachment and the bumped version
    const read = await owner.client.data(owner.client.get('/rest/node-type-policies/instance'));
    expect(read.attachments).toHaveLength(1);
    expect(read.version).toBe(scope.version + 1);
    expect(await audits(tenantId)).toContain('type_policy.attachments.updated');
    // a credential path does not reach a node scope
    expect(
      (await owner.client.get(`/rest/credential-type-policies/scopes/${scope.id}/attachments`)).statusCode,
    ).toBe(404);
  });

  it('refuses a document of another kind and a duplicate priority', async () => {
    const { owner } = await setup();
    const credentialDoc = await owner.client.data(
      owner.client.post('/rest/credential-type-policies/policies', { name: 'c', rules: [] }),
    );
    const nodeDoc = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', { name: 'n', rules: [] }),
    );
    const other = await owner.client.data(
      owner.client.post('/rest/node-type-policies/policies', { name: 'n2', rules: [] }),
    );
    const scope = await owner.client.data(
      owner.client.put('/rest/node-type-policies/instance', { defaultAction: 'allow', expectedVersion: 0 }),
    );
    const put = (attachments: unknown[]) =>
      owner.client.put(`/rest/node-type-policies/scopes/${scope.id}/attachments`, {
        attachments,
        expectedVersion: scope.version,
      });
    expect((await put([{ policyId: credentialDoc.id, priority: 0, isFloor: false }])).statusCode).toBe(404);
    expect(
      (
        await put([
          { policyId: nodeDoc.id, priority: 0, isFloor: false },
          { policyId: other.id, priority: 0, isFloor: false },
        ])
      ).statusCode,
    ).toBe(400);
  });
});

describe('available types', () => {
  it('lists every type with available, and only an unavailable row carries a reason', async () => {
    const { owner, tenantId, alpha } = await setup();
    await policyDeny(server, tenantId, 'node', 'core.code');
    const rows = await owner.client.data(owner.client.get(`/rest/projects/${alpha.id}/available-types`));
    const blocked = rows.find((r: { type: string }) => r.type === 'core.code');
    expect(blocked).toMatchObject({ available: false, scope: 'workspace', optInAvailable: false });
    expect(blocked.reason).toBe('Node type "core.code" is blocked by a workspace policy');
    expect(JSON.stringify(blocked)).not.toContain(alpha.id);
    expect(JSON.stringify(blocked)).not.toContain('Alpha');
    const free = rows.find((r: { type: string }) => r.type === 'core.set');
    expect(free).toEqual({ type: 'core.set', available: true });
    for (const row of rows) if (row.available) expect(row).not.toHaveProperty('reason');
  });

  it('reads the workspace policy in every project, and the credential list the same way', async () => {
    const { owner, tenantId, alpha, beta } = await setup();
    await policyDeny(server, tenantId, 'node', 'core.code');
    await policyDeny(server, tenantId, 'credential', 'testApi');
    for (const project of [alpha, beta]) {
      const rows = await owner.client.data(owner.client.get(`/rest/projects/${project.id}/available-types`));
      expect(rows.find((r: { type: string }) => r.type === 'core.code')).toMatchObject({
        available: false,
        scope: 'workspace',
      });
      const credentials = await owner.client.data(
        owner.client.get(`/rest/projects/${project.id}/available-credential-types`),
      );
      expect(credentials.find((r: { type: string }) => r.type === 'testApi')).toMatchObject({
        available: false,
        scope: 'workspace',
      });
    }
  });

  it('refuses a member of another project (403) and answers a member of the project', async () => {
    const { member, tenantId, alpha, beta } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
    const own = await member.client.get(`/rest/projects/${alpha.id}/available-types`);
    expect(own.statusCode).toBe(200);
    for (const path of ['available-types', 'available-credential-types']) {
      const other = await member.client.get(`/rest/projects/${beta.id}/${path}`);
      expect(other.statusCode).toBe(403);
      expect(other.json().error.message).toBe(MISSING);
    }
  });

  it('is 404 for a project that does not exist', async () => {
    const { owner } = await setup();
    expect((await owner.client.get(`/rest/projects/${randomUUID()}/available-types`)).statusCode).toBe(404);
  });
});

describe('sub-workflow policy check', () => {
  async function pair(tenantId: string, callerProject: string, subProject: string) {
    const caller = await workflowIn(server, tenantId, callerProject, { name: 'caller' });
    const sub = await workflowIn(server, tenantId, subProject, {
      name: 'sub',
      nodes: [node('Code', 'core.code'), node('Set', 'core.set')],
    });
    return { caller, sub };
  }

  it('says allowed with no violations when nothing is blocked', async () => {
    const { owner, tenantId, alpha } = await setup();
    const { caller, sub } = await pair(tenantId, alpha.id, alpha.id);
    const answer = await owner.client.data(
      owner.client.get(`/rest/workflows/${caller.id}/sub-workflows/${sub.id}/policy-check`),
    );
    expect(answer).toEqual({ allowed: true, violations: [] });
  });

  it('judges the sub-workflow nodes as a start, and writes no policy.blocked row', async () => {
    const { owner, tenantId, alpha, beta } = await setup();
    await policyDeny(server, tenantId, 'node', 'core.code');
    const { caller, sub } = await pair(tenantId, alpha.id, beta.id);
    const answer = await owner.client.data(
      owner.client.get(`/rest/workflows/${caller.id}/sub-workflows/${sub.id}/policy-check`),
    );
    expect(answer.allowed).toBe(false);
    expect(answer.violations).toEqual([
      expect.objectContaining({
        kind: 'node-type-unavailable',
        type: 'core.code',
        scope: 'workspace',
        nodeName: 'Code',
      }),
    ]);
    expect(await audits(tenantId)).not.toContain('policy.blocked');
  });

  it('hides a sub-workflow the caller cannot read (404) and gates the caller on workflow:update', async () => {
    const { owner, member, tenantId, alpha, beta } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
    const { caller, sub } = await pair(tenantId, alpha.id, beta.id);
    const hidden = await member.client.get(
      `/rest/workflows/${caller.id}/sub-workflows/${sub.id}/policy-check`,
    );
    expect(hidden.statusCode).toBe(404);
    const missing = await member.client.get(
      `/rest/workflows/${caller.id}/sub-workflows/${randomUUID()}/policy-check`,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe(hidden.json().error.message);
    // a viewer of the caller's project cannot update it
    const viewer = await realMember(owner);
    await addToProject(server, tenantId, alpha.id, viewer.user.id, 'project:viewer');
    const own = await workflowIn(server, tenantId, alpha.id, { name: 'own sub' });
    const denied = await viewer.client.get(
      `/rest/workflows/${caller.id}/sub-workflows/${own.id}/policy-check`,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING);
  });
});
