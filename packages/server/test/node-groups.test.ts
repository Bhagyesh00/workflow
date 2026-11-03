/**
 * P3-04 (rules): the save path checks nodeGroups with validateWorkflowNodeGroups.
 * Basic checks always, full checks (trigger, section, boundary) when the member types resolve.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

/** Start -> A -> B -> C -> D */
function line() {
  const nodes = [
    node('Start', 'core.manualTrigger'),
    setNode('A', 'a', 1, [200, 0]),
    setNode('B', 'b', 2, [400, 0]),
    setNode('C', 'c', 3, [600, 0]),
    setNode('D', 'd', 4, [800, 0]),
  ];
  const id = (name: string) => nodes.find((n) => n.name === name)?.id as string;
  return { nodes, connections: chain('Start', 'A', 'B', 'C', 'D'), id };
}

const group = (id: string, name: string, nodeIds: string[], description?: string) => ({
  id,
  name,
  nodeIds,
  ...(description === undefined ? {} : { description }),
});

async function create(client: TestClient, body: Record<string, unknown>) {
  return client.post('/rest/workflows', { name: 'G', ...body });
}

/** a 400 invalid_node_groups naming this code */
function expectRejected(res: Awaited<ReturnType<TestClient['post']>>, code: string) {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.error?.code ?? body.code).toBe('invalid_node_groups');
  const details = body.error?.details ?? body.details;
  expect(details.map((d: { code: string }) => d.code)).toContain(code);
  expect(String(body.error?.message ?? body.message).length).toBeGreaterThan(10);
}

describe('node group save checks', () => {
  it('accepts valid groups on create and keeps them', async () => {
    const { client } = await signup(server.app);
    const w = line();
    const groups = [
      group('g1', 'Group', [w.id('B'), w.id('C')], 'Middle part'),
      group('g2', 'Group 2', [w.id('D')]),
    ];
    const res = await create(client, { nodes: w.nodes, connections: w.connections, nodeGroups: groups });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.nodeGroups).toEqual(groups);
  });

  it('accepts a workflow with no groups', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expect((await create(client, { nodes: w.nodes, connections: w.connections })).statusCode).toBe(200);
  });

  it('400: duplicate group id', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'A', [w.id('A')]), group('g1', 'B', [w.id('B')])],
      }),
      'duplicate_group_id',
    );
  });

  it('400: duplicate group name', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'Same', [w.id('A')]), group('g2', 'Same', [w.id('B')])],
      }),
      'duplicate_group_name',
    );
  });

  it('400: empty group', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, { nodes: w.nodes, connections: w.connections, nodeGroups: [group('g1', 'A', [])] }),
      'empty_group',
    );
  });

  it('400: unknown node id', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'A', [w.id('A'), 'no-such-node'])],
      }),
      'unknown_node',
    );
  });

  it('400: a node in two groups', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'A', [w.id('A'), w.id('B')]), group('g2', 'B', [w.id('B'), w.id('C')])],
      }),
      'node_in_multiple_groups',
    );
  });

  it('400: a trigger in a group (full check, types resolve)', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'A', [w.id('Start'), w.id('A')])],
      }),
      'trigger',
    );
  });

  it('400: a disconnected group', async () => {
    const { client } = await signup(server.app);
    const w = line();
    expectRejected(
      await create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'A', [w.id('A'), w.id('C')])],
      }),
      'disconnected',
    );
  });

  it('400: two entry nodes', async () => {
    const { client } = await signup(server.app);
    const x = setNode('X', 'x', 1, [0, 100]);
    const y = setNode('Y', 'y', 1, [0, 200]);
    const m = setNode('M', 'm', 1, [200, 100]);
    const n = setNode('N', 'n', 1, [400, 100]);
    const connections = { ...chain('X', 'M'), ...chain('Y', 'N'), ...chain('M', 'N') };
    expectRejected(
      await create(client, { nodes: [x, y, m, n], connections, nodeGroups: [group('g1', 'A', [m.id, n.id])] }),
      'multiple_entry',
    );
  });

  it('400: the description over 145 characters', async () => {
    const { client } = await signup(server.app);
    const w = line();
    const res = await create(client, {
      nodes: w.nodes,
      connections: w.connections,
      nodeGroups: [group('g1', 'A', [w.id('A')], 'x'.repeat(146))],
    });
    expect(res.statusCode).toBe(400);
  });

  it('checks again on update when nodes, connections or nodeGroups change', async () => {
    const { client } = await signup(server.app);
    const w = line();
    const created = await client.data(
      create(client, {
        nodes: w.nodes,
        connections: w.connections,
        nodeGroups: [group('g1', 'Group', [w.id('B'), w.id('C')])],
      }),
    );
    // new groups that break a rule
    const bad = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: created.versionId,
      nodeGroups: [group('g1', 'Group', [w.id('A'), w.id('C')])],
    });
    expectRejected(bad, 'disconnected');
    // removing the connection B -> C leaves the existing group disconnected
    const { B, ...rest } = w.connections as Record<string, unknown>;
    expect(B).toBeDefined();
    const broken = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: created.versionId,
      connections: rest,
    });
    expectRejected(broken, 'disconnected');
    // removing a node that a group lists
    const gone = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: created.versionId,
      nodes: w.nodes.filter((n) => n.name !== 'C'),
      connections: chain('Start', 'A', 'B'),
    });
    expectRejected(gone, 'unknown_node');
    // a valid change passes and bumps the version
    const ok = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: created.versionId,
      nodeGroups: [group('g1', 'Renamed', [w.id('B'), w.id('C')], 'Now with text')],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.nodeGroups[0]).toMatchObject({ name: 'Renamed', description: 'Now with text' });
  });

  it('keeps groups through a version restore and a rename-only update', async () => {
    const { client } = await signup(server.app);
    const w = line();
    const groups = [group('g1', 'Group', [w.id('B'), w.id('C')])];
    const created = await client.data(
      create(client, { nodes: w.nodes, connections: w.connections, nodeGroups: groups }),
    );
    const renamed = await client.data(
      client.patch(`/rest/workflows/${created.id}`, { versionId: created.versionId, name: 'Other' }),
    );
    expect(renamed.nodeGroups).toEqual(groups);
    const restored = await client.data(
      client.post(`/rest/workflows/${created.id}/versions/${created.versionId}/restore`),
    );
    expect(restored.nodeGroups).toEqual(groups);
    const version = await client.data(client.get(`/rest/workflows/${created.id}/versions/${created.versionId}`));
    expect(version.nodeGroups).toEqual(groups);
  });
});
