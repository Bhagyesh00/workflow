/**
 * P6-49 (L4): GET /rest/workflows?executionBlockedBy=restrictedNode keeps the workflows with a node of a
 * blocked type, through the repository's `usesNodeTypes`: a query of its own, so 25 blocked types all count
 * (the search's `nodeTypes` stops at 20), and an empty list matches none.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  node,
  projectIn,
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

/** one document that denies every name, attached to the workspace scope */
async function denyMany(tenantId: string, names: string[]) {
  const store = server.ctx.typePolicies;
  const { policy } = await store.createPolicy(tenantId, 'node', {
    name: `many ${randomUUID().slice(0, 8)}`,
    rules: names.map((name) => ({ id: randomUUID(), action: 'deny' as const, selector: { name } })),
  });
  const scope = await store.getScope(tenantId, 'node', null);
  await store.putScope(
    tenantId,
    'node',
    null,
    {
      defaultAction: 'allow',
      attachments: [
        ...scope.attachments,
        { policyId: policy.id, priority: scope.attachments.length, isFloor: false },
      ],
    },
    scope.version,
  );
}

const listBlocked = async (client: { get(url: string): Promise<{ json(): any }> }, query = '') =>
  (await client.get(`/rest/workflows?executionBlockedBy=restrictedNode${query}`)).json().data as Array<{
    id: string;
    name: string;
  }>;

describe('workflow list filter executionBlockedBy=restrictedNode', () => {
  it('finds a workflow that uses any one of 25 blocked types, and none that use none', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, 'Alpha');
    const blocked = Array.from({ length: 25 }, (_, i) => `acme.blocked${String(i).padStart(2, '0')}`);
    await denyMany(tenantId, blocked);
    const first = await workflowIn(server, tenantId, project.id, {
      name: 'uses the first',
      nodes: [node('A', blocked[0])],
    });
    const last = await workflowIn(server, tenantId, project.id, {
      name: 'uses the 25th',
      nodes: [node('Start', 'core.set'), node('B', blocked[24])],
    });
    const middle = await workflowIn(server, tenantId, project.id, {
      name: 'uses the 21st',
      nodes: [node('C', blocked[20])],
    });
    await workflowIn(server, tenantId, project.id, { name: 'clean', nodes: [node('S', 'core.set')] });
    await workflowIn(server, tenantId, project.id, { name: 'empty', nodes: [] });
    const found = await listBlocked(owner.client);
    expect(found.map((w) => w.id).sort()).toEqual([first.id, last.id, middle.id].sort());
  });

  it('keeps the other filters: the project, the name and the paging', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const alpha = await projectIn(server, tenantId, 'Alpha');
    const beta = await projectIn(server, tenantId, 'Beta');
    await denyMany(tenantId, ['acme.blocked']);
    const a = await workflowIn(server, tenantId, alpha.id, {
      name: 'alpha bad',
      nodes: [node('X', 'acme.blocked')],
    });
    const b = await workflowIn(server, tenantId, beta.id, {
      name: 'beta bad',
      nodes: [node('X', 'acme.blocked')],
    });
    expect((await listBlocked(owner.client, `&projectId=${alpha.id}`)).map((w) => w.id)).toEqual([a.id]);
    expect((await listBlocked(owner.client, `&projectId=${beta.id}`)).map((w) => w.id)).toEqual([b.id]);
    const paged = (
      await owner.client.get('/rest/workflows?executionBlockedBy=restrictedNode&limit=1')
    ).json();
    expect(paged.data).toHaveLength(1);
    expect(paged.nextCursor).toEqual(expect.any(String));
  });

  it('lists nothing when no type is blocked, and every workflow without the filter', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, 'Alpha');
    await workflowIn(server, tenantId, project.id, { nodes: [node('S', 'core.set')] });
    expect(await listBlocked(owner.client)).toEqual([]);
    const all = (await owner.client.get('/rest/workflows')).json().data;
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('the repository filter matches any node, not the capped nodeTypes, and an empty list matches none', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, 'Alpha');
    const types = Array.from({ length: 40 }, (_, i) => `acme.t${i}`);
    const hit = await workflowIn(server, tenantId, project.id, {
      nodes: [node('S', 'core.set'), node('Z', types[39])],
    });
    await workflowIn(server, tenantId, project.id, { nodes: [node('S', 'core.set')] });
    const base = { limit: 50, archived: 'false' as const, projectId: project.id };
    const rows = await server.ctx.repos.workflows.list(tenantId, { ...base, usesNodeTypes: types } as never);
    expect(rows.map((r) => r.id)).toEqual([hit.id]);
    expect(await server.ctx.repos.workflows.list(tenantId, { ...base, usesNodeTypes: [] } as never)).toEqual(
      [],
    );
    // a type name holding a quote or a percent sign is a bound value, not SQL or a pattern
    const odd = await server.ctx.repos.workflows.list(tenantId, {
      ...base,
      usesNodeTypes: [`x') or 1=1 --`, '%'],
    } as never);
    expect(odd).toEqual([]);
  });

  it('does not see another workspace workflows', async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const project = await projectIn(server, other.tenant.id, 'Theirs');
    await denyMany(owner.tenant.id, ['acme.blocked']);
    await denyMany(other.tenant.id, ['acme.blocked']);
    await workflowIn(server, other.tenant.id, project.id, { nodes: [node('X', 'acme.blocked')] });
    expect(await listBlocked(owner.client)).toEqual([]);
    expect(await listBlocked(other.client)).toHaveLength(1);
  });
});
