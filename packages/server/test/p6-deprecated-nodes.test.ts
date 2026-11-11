/**
 * P6-52 (L7) deprecated nodes: a save may not add or edit a node whose description has `deprecated: true`
 * (400, kind `node-type-deprecated`); removal, a move and a replacement are fine; a saved one still runs; an
 * inline sub-workflow with one fails; `DEPRECATED_NODES_BLOCK=false` turns the check off.
 * The test node is saved while it is current, then its description is flipped to deprecated (what a package
 * upgrade does to workflows saved earlier).
 */
import type { NodePackage, NodeType, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoDeprecatedNodes } from '../src/services/deprecated-nodes';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

const OLD = 'p6old.legacy';
const oldNode: NodeType = {
  description: {
    name: OLD,
    displayName: 'Legacy',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Legacy' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'Value', name: 'value', type: 'string', default: '' }],
    replacedBy: 'core.set',
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
};
const pack: NodePackage = { name: 'p6-deprecated', nodes: [oldNode], credentials: [] };

let server: TestServer;
let off: TestServer;
beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [pack] });
});
afterAll(async () => {
  await server.close();
  await off?.close();
});

function setDeprecated(s: TestServer, on: boolean) {
  const type = s.ctx.registries.nodeTypes.get(OLD);
  if (!type) throw new Error('test node missing');
  type.description.deprecated = on;
}

const trigger = () => node('Start', 'core.manualTrigger');

type Row = { versionId: string; nodes: WorkflowNode[] };
const read = (client: Awaited<ReturnType<typeof signup>>['client'], id: string) =>
  client.data<Row>(client.get(`/rest/workflows/${id}`));

function violationsOf(res: { statusCode: number; json(): unknown }) {
  expect(res.statusCode).toBe(400);
  const body = res.json() as { error: { details?: { violations?: Array<Record<string, string>> } } };
  return body.error.details?.violations;
}

describe('deprecated nodes', () => {
  it('refuses adding one on create, with n8n text and the replacement', async () => {
    setDeprecated(server, true);
    const { client } = await signup(server.app);
    const res = await client.post('/rest/workflows', {
      name: 'x',
      nodes: [trigger(), node('Old', OLD)],
      connections: chain('Start', 'Old'),
      settings: {},
    });
    expect(violationsOf(res)).toEqual([
      { kind: 'node-type-deprecated', type: OLD, nodeName: 'Old', replacedBy: 'core.set' },
    ]);
    expect((res.json() as { error: { message: string } }).error.message).toContain(
      `Cannot use a "${OLD}" node ("Old"): this node type is deprecated. Replace it with the`,
    );
  });

  it('a saved one runs; a move is saved; an edit is refused; a replacement is saved', async () => {
    setDeprecated(server, false);
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [trigger(), node('Old', OLD, { value: 'a' })],
      connections: chain('Start', 'Old'),
    });
    setDeprecated(server, true);

    const run = await client.data<{ executionId: string }>(client.post(`/rest/workflows/${wf.id}/run`, {}));
    expect((await waitForExecution(server.ctx, tenant.id, run.executionId)).status).toBe('success');

    const first = await read(client, wf.id);
    const moved = first.nodes.map((n) => (n.type === OLD ? { ...n, position: [500, 40] } : n));
    const ok = await client.patch(`/rest/workflows/${wf.id}`, { versionId: first.versionId, nodes: moved });
    expect(ok.statusCode).toBe(200);

    const second = await read(client, wf.id);
    const edited = second.nodes.map((n) => (n.type === OLD ? { ...n, parameters: { value: 'b' } } : n));
    const refused = await client.patch(`/rest/workflows/${wf.id}`, {
      versionId: second.versionId,
      nodes: edited,
    });
    expect(violationsOf(refused)?.[0]).toMatchObject({ kind: 'node-type-deprecated', nodeName: 'Old' });

    const replaced = second.nodes.map((n) =>
      n.type === OLD ? { ...n, type: 'core.set', parameters: {} } : n,
    );
    const swapped = await client.patch(`/rest/workflows/${wf.id}`, {
      versionId: second.versionId,
      nodes: replaced,
    });
    expect(swapped.statusCode).toBe(200);
  });

  it('removal of a deprecated node is allowed', async () => {
    setDeprecated(server, false);
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [trigger(), node('Old', OLD)],
      connections: chain('Start', 'Old'),
    });
    setDeprecated(server, true);
    const current = await read(client, wf.id);
    const res = await client.patch(`/rest/workflows/${wf.id}`, {
      versionId: current.versionId,
      nodes: current.nodes.filter((n) => n.type !== OLD),
      connections: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('an inline sub-workflow with a deprecated node fails', async () => {
    setDeprecated(server, true);
    const { client, tenant } = await signup(server.app);
    const inner = JSON.stringify({ nodes: [node('Old', OLD)], connections: {} });
    const wf = await createWorkflow(client, {
      nodes: [trigger(), node('Sub', 'core.executeWorkflow', { source: 'parameter', workflowJson: inner })],
      connections: chain('Start', 'Sub'),
    });
    const run = await client.data<{ executionId: string }>(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const done = await waitForExecution(server.ctx, tenant.id, run.executionId);
    expect(done.status).toBe('error');
    expect(JSON.stringify(done)).toContain('deprecated');
  });

  it('assertNoDeprecatedNodes names every deprecated node', async () => {
    setDeprecated(server, true);
    const deps = server.ctx.serviceDeps;
    await expect(
      assertNoDeprecatedNodes(deps, [{ name: 'Fine', type: 'core.set' }]),
    ).resolves.toBeUndefined();
    await expect(
      assertNoDeprecatedNodes(deps, [
        { name: 'A', type: OLD },
        { name: 'B', type: OLD },
      ]),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { violations: [{ nodeName: 'A' }, { nodeName: 'B' }] },
    });
  });

  it('DEPRECATED_NODES_BLOCK=false lets a save add one', async () => {
    off = await createTestServer({ DEPRECATED_NODES_BLOCK: 'false' }, { nodePackages: [pack] });
    setDeprecated(off, true);
    const { client } = await signup(off.app);
    const res = await client.post('/rest/workflows', {
      name: 'x',
      nodes: [trigger(), node('Old', OLD)],
      connections: chain('Start', 'Old'),
      settings: {},
    });
    expect(res.statusCode).toBeLessThan(300);
    await expect(
      assertNoDeprecatedNodes(off.ctx.serviceDeps, [{ name: 'A', type: OLD }]),
    ).resolves.toBeUndefined();
  });
});
