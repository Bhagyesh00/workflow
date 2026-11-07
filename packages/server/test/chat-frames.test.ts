/**
 * P5-56 stream frames: each node run that sends chunks gets its own begin..end group, every frame carries
 * the run's metadata (node id and name, run and item index, time), object content is JSON text, and a
 * failed run closes its open groups before one `error` frame with fixed text and no detail.
 */
import { rm } from 'node:fs/promises';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { DataObject, NodePackage, WorkflowNode } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { createWorkflow, node, resetDatabase, signup, testConfig, testPackage } from './helpers';

/** sends each comma-separated part as one chunk (or an object, or for item 1), then passes its input on or fails */
const chunkPackage: NodePackage = {
  name: 'chat-frames-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.chunker',
        displayName: 'Chunker',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Chunker' },
        inputs: ['main'],
        outputs: ['main'],
        properties: [
          { displayName: 'Parts', name: 'parts', type: 'string', default: '' },
          { displayName: 'Object', name: 'object', type: 'boolean', default: false },
          { displayName: 'Item Index', name: 'itemIndex', type: 'number', default: 0 },
          { displayName: 'Fail', name: 'fail', type: 'boolean', default: false },
        ],
      },
      async execute(ctx) {
        const parts = String(ctx.getNodeParameter('parts', 0, ''))
          .split(',')
          .filter(Boolean);
        const itemIndex = Number(ctx.getNodeParameter('itemIndex', 0, 0));
        for (const part of parts) ctx.sendChunk(part, itemIndex ? { itemIndex } : undefined);
        if (ctx.getNodeParameter('object', 0, false)) ctx.sendChunk({ total: 7, ok: true });
        if (ctx.getNodeParameter('fail', 0, false)) throw new Error('secret detail sk-test-1234567890abcdef');
        return [ctx.getInputData()];
      },
    },
  ],
};

let ctx: ServerContext;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  const config = testConfig();
  dir = config.binaryData.dir;
  ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, nodesAiPackage, chunkPackage],
  });
  await resetDatabase(ctx);
  app = await buildApp(ctx);
  await ctx.startMain();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase(ctx);
});

const trigger = () =>
  node('Chat', 'ai.chatTrigger', { public: true, options: { responseMode: 'streaming' } }, [0, 0], {
    webhookId: 'chat-id',
  });
const chunker = (name: string, parameters: DataObject) => node(name, 'test.chunker', parameters);

function connect(...pairs: Array<[string, string]>) {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> =
    {};
  for (const [from, to] of pairs) {
    connections[from] ??= { main: [[]] };
    connections[from].main[0].push({ node: to, type: 'main', index: 0 });
  }
  return connections;
}

async function chat(nodes: WorkflowNode[], connections: Record<string, unknown>) {
  const { client, tenant } = await signup(app);
  const wf = await createWorkflow(client, { nodes, connections } as never);
  const activated = await client.post(`/rest/workflows/${wf.id}/activate`);
  expect(activated.statusCode, activated.body).toBe(200);
  const res = await app.inject({
    method: 'POST',
    url: `/webhook/${tenant.slug}/chat-id/chat`,
    payload: { sessionId: 's1', chatInput: 'Hi' },
  });
  expect(res.headers['content-type']).toContain('application/x-ndjson');
  return {
    client,
    workflowId: wf.id as string,
    frames: res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as DataObject),
  };
}

const idOf = (nodes: WorkflowNode[], name: string) => nodes.find((n) => n.name === name)!.id;

describe('chat stream frames', () => {
  it('gives two streaming nodes two begin..end groups, in run order, with their metadata', async () => {
    const nodes = [trigger(), chunker('First', { parts: 'a1,a2' }), chunker('Second', { parts: 'b1' })];
    const before = Date.now();
    const { frames } = await chat(nodes, connect(['Chat', 'First'], ['First', 'Second']));
    expect(frames.map((f) => [f.type, f.content ?? null, (f.metadata as DataObject).nodeName])).toEqual([
      ['begin', null, 'First'],
      ['item', 'a1', 'First'],
      ['item', 'a2', 'First'],
      ['end', null, 'First'],
      ['begin', null, 'Second'],
      ['item', 'b1', 'Second'],
      ['end', null, 'Second'],
    ]);
    for (const frame of frames) {
      const metadata = frame.metadata as DataObject;
      expect(metadata.nodeId).toBe(idOf(nodes, String(metadata.nodeName)));
      expect(metadata.runIndex).toBe(0);
      expect(metadata.itemIndex).toBe(0);
      expect(metadata.timestamp).toBeGreaterThanOrEqual(before);
      expect(metadata.timestamp).toBeLessThanOrEqual(Date.now());
    }
    const stamps = frames.map((f) => (f.metadata as DataObject).timestamp as number);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('opens one group per run of the same node, each with its run index', async () => {
    // Echo runs once from the trigger and once more after Middle: two runs, two groups
    const nodes = [trigger(), chunker('Echo', { parts: 'e' }), chunker('Middle', {})];
    const { frames } = await chat(nodes, connect(['Chat', 'Echo'], ['Chat', 'Middle'], ['Middle', 'Echo']));
    const echo = frames.filter((f) => (f.metadata as DataObject).nodeName === 'Echo');
    expect(echo.map((f) => [f.type, (f.metadata as DataObject).runIndex])).toEqual([
      ['begin', 0],
      ['item', 0],
      ['end', 0],
      ['begin', 1],
      ['item', 1],
      ['end', 1],
    ]);
  });

  it('writes object content as JSON text and keeps the item index of a chunk', async () => {
    const nodes = [trigger(), chunker('Obj', { parts: 'x', object: true, itemIndex: 1 })];
    const { frames } = await chat(nodes, connect(['Chat', 'Obj']));
    const items = frames.filter((f) => f.type === 'item');
    expect(items.map((f) => f.content)).toEqual(['x', JSON.stringify({ total: 7, ok: true })]);
    expect(items.map((f) => (f.metadata as DataObject).itemIndex)).toEqual([1, 0]);
    expect(frames.map((f) => f.type)).toEqual(['begin', 'item', 'item', 'end']);
  });

  it('closes the open group before one error frame with fixed text, no detail and no stack', async () => {
    const nodes = [trigger(), chunker('Breaks', { parts: 'partial', fail: true })];
    const { frames } = await chat(nodes, connect(['Chat', 'Breaks']));
    expect(frames.map((f) => f.type)).toEqual(['begin', 'item', 'end', 'error']);
    expect(frames[2].metadata).toMatchObject({ nodeName: 'Breaks', runIndex: 0 });
    expect(frames[3]).toEqual({ type: 'error', content: 'Error in workflow', message: 'Error in workflow' });
    const text = JSON.stringify(frames);
    expect(text).not.toContain('stack');
    expect(text).not.toContain('secret detail');
    expect(text).not.toContain('sk-test');
  });
});
