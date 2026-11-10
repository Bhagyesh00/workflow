/**
 * P6-33 and P6-34 (L13): a public PUT that would put a new version of a published workflow live is a publish.
 * It needs the key scope workflow:activate and the user's workflow:publish on the workflow (personal space
 * publishing off and custom roles apply), as the activate route does. Without either the draft is saved and
 * the answer is 403 with the draft's versionId; publishIfActive=false and an unpublished workflow save as before.
 * (Own file: the signup limit is 20 an hour for each server, and p6-public-scope.test.ts uses most of it.)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const api = (key: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

let keyCount = 0;
/** a label is unique per user since P6-21, so each key gets its own */
async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k${keyCount}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

/** an owner, a real member, and a team project where the member holds `role` */
async function setup(custom = false) {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const role = custom ? (await updaterRole(owner)).slug : 'project:editor';
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  return { owner, member, alpha, memberKey: await keyOf(member.client) };
}

/** a custom project role that may edit a workflow but not publish it */
async function updaterRole(owner: { client: TestClient }) {
  return owner.client.data<{ slug: string }>(
    owner.client.post('/rest/roles', {
      displayName: `Updater ${randomUUID().slice(0, 6)}`,
      roleType: 'project',
      scopes: ['workflow:read', 'workflow:update'],
    }),
  );
}

describe('a save of a published workflow', () => {
  const hook = () =>
    node('Hook', 'core.webhook', { path: `p6-put-${randomUUID().slice(0, 8)}`, httpMethod: 'GET' }, [0, 0], {
      webhookId: randomUUID(),
    });

  async function published(tenantId: string, projectId: string) {
    const wf = await server.ctx.workflows.create(
      tenantId,
      { name: 'Live', nodes: [hook()], connections: {}, settings: {}, projectId, folderId: null } as never,
      {},
    );
    await server.ctx.activeWorkflows.activate(tenantId, wf.id);
    return (await server.ctx.repos.workflows.get(tenantId, wf.id))!;
  }

  const save = (key: string, wf: { id: string; nodes: unknown; connections: unknown }, query = '') =>
    api(key, 'PUT', `/workflows/${wf.id}${query}`, {
      name: 'Renamed',
      nodes: wf.nodes,
      connections: wf.connections,
    });

  /** the draft was saved and the live version did not move */
  async function expectDraftOnly(tenantId: string, before: { id: string; versionId: string }) {
    const row = await server.ctx.repos.workflows.get(tenantId, before.id);
    expect(row?.versionId).not.toBe(before.versionId);
    expect(row?.publishedVersionId).toBe(before.versionId);
    expect(row?.active).toBe(true);
    return row!;
  }

  it('a project editor, who holds workflow:publish, publishes the new version', async () => {
    const { owner, alpha, memberKey } = await setup();
    const wf = await published(owner.tenant.id, alpha.id);
    const res = await save(memberKey, wf);
    expect(res.statusCode).toBe(200);
    const row = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(row?.publishedVersionId).toBe(row?.versionId);
    expect(row?.publishedVersionId).not.toBe(wf.versionId);
  });

  it('a custom project role with workflow:update but not workflow:publish saves a draft and gets 403', async () => {
    const { owner, alpha, memberKey: key } = await setup(true);
    const wf = await published(owner.tenant.id, alpha.id);

    const res = await save(key, wf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe('insufficient_permissions');
    expect(res.json().error.message).toContain('saved as a draft');
    const row = await expectDraftOnly(owner.tenant.id, wf);
    expect(res.json().error.details.versionId).toBe(row.versionId);

    // publishIfActive=false is a plain draft save
    const draft = await save(key, row, '?publishIfActive=false');
    expect(draft.statusCode).toBe(200);
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))?.publishedVersionId).toBe(
      wf.versionId,
    );
  });

  it('a personal owner cannot republish once personal space publishing is off', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const space = await server.ctx.repos.projects.ensurePersonal(owner.tenant.id, member.user);
    const wf = await published(owner.tenant.id, space.id);
    const key = await keyOf(member.client);
    expect((await save(key, wf)).statusCode).toBe(200);

    const tenant = await server.ctx.repos.tenants.get(owner.tenant.id);
    const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
    await server.ctx.repos.tenants.updateSettings(owner.tenant.id, {
      ...settings,
      securityPolicy: { ...((settings.securityPolicy as object) ?? {}), personalSpacePublishing: false },
    });
    const live = (await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))!;
    const res = await save(key, live);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe('insufficient_permissions');
    await expectDraftOnly(owner.tenant.id, { id: wf.id, versionId: live.versionId });
    // the activate route refuses the same user
    expect((await api(key, 'POST', `/workflows/${wf.id}/activate`, {})).statusCode).toBe(403);
  });

  it('a key without workflow:activate saves a draft and gets 403, whatever its user holds', async () => {
    const { owner, alpha, member } = await setup();
    const wf = await published(owner.tenant.id, alpha.id);
    const key = await keyOf(member.client, ['workflow:read', 'workflow:update']);
    const res = await save(key, wf);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe('insufficient_api_key_scope');
    await expectDraftOnly(owner.tenant.id, wf);
  });

  it('an unpublished workflow is saved without workflow:publish', async () => {
    const { owner, alpha, memberKey: key } = await setup(true);
    const wf = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'Idle' });
    const res = await save(key, wf);
    expect(res.statusCode).toBe(200);
  });
});
