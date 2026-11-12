/**
 * P6-67 (S5 L11): custom span attributes. A project tag, a workflow tag and an expression node tag reach the spans
 * of a run as `project.custom.`, `workflow.custom.` and `node.custom.`; `gen_ai` keys are left out of node tags; a
 * redacted run sends no `node.custom.` attribute; the project tags are written through PATCH project (REST and
 * public) with `validateTelemetryTags`. Fixed fake values only.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customAttributes } from '../src/services/tracing/custom-attributes';
import { type OtlpCollector, startOtlpCollector } from './fakes/otlp';
import {
  chain,
  createTestServer,
  createWorkflow,
  enableTracing,
  node,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;
let collector: OtlpCollector;

type Span = ReturnType<OtlpCollector['spans']>[number];

async function spansOf(executionId: string, min: number): Promise<Span[]> {
  return waitFor(
    async () => {
      await server.ctx.tracing.flush();
      const spans = collector.spans().filter((s) => s.attributes['execution.id'] === executionId);
      return spans.length >= min ? spans : undefined;
    },
    { timeout: 15_000, message: `${min} spans of ${executionId}` },
  );
}

const customKeys = (span: Span) => Object.keys(span.attributes).filter((k) => k.includes('.custom.'));

async function manualRun(nodes: WorkflowNode[], connections: unknown, settings?: Record<string, unknown>) {
  const workflow = await createWorkflow(owner.client, { nodes, connections, settings });
  const { executionId } = await owner.client.data<{ executionId: string }>(
    owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
  );
  return { workflowId: workflow.id, executionId };
}

const tagged = (name: string, tags: Array<{ key: string; value: string }>): WorkflowNode => ({
  ...setNode(name, 'b', 'y', [400, 0]),
  customTelemetryTags: { tag: tags },
});

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  owner = await signup(server.app);
  collector = await startOtlpCollector();
  await enableTracing(server, owner.tenant.id, {
    exporterEndpoint: collector.url,
    productionExecutionsOnly: false,
  });
});
afterAll(async () => {
  await server?.close();
  await collector?.close();
});

describe('customAttributes', () => {
  it('prefixes project, workflow and node tags and stringifies values', () => {
    expect(
      customAttributes({
        project: { tags: [{ key: 'region', value: 'eu' }] },
        workflow: { tags: [{ key: 'area', value: 'billing' }] },
        node: { tracing: { plan: 'pro', count: 3, ok: true } },
      }),
    ).toEqual({
      'project.custom.region': 'eu',
      'workflow.custom.area': 'billing',
      'node.custom.plan': 'pro',
      'node.custom.count': '3',
      'node.custom.ok': 'true',
    });
  });

  it('returns nothing for no input, blank keys and non-primitive node values', () => {
    expect(customAttributes({})).toEqual({});
    expect(customAttributes({ project: { tags: [] }, workflow: { tags: [] }, node: {} })).toEqual({});
    expect(
      customAttributes({
        workflow: { tags: [{ key: '   ', value: 'x' }] },
        node: { tracing: { fine: 'v', obj: { a: 1 }, nothing: null } },
      }),
    ).toEqual({ 'node.custom.fine': 'v' });
  });

  it('trims keys, bounds the count and the value length', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: ` k${i} `, value: 'v' }));
    const out = customAttributes({ workflow: { tags: many } });
    expect(Object.keys(out)).toHaveLength(20);
    expect(out['workflow.custom.k0']).toBe('v');
    const long = customAttributes({ project: { tags: [{ key: 'big', value: 'z'.repeat(600) }] } });
    expect(long['project.custom.big']).toHaveLength(256);
  });

  it('leaves gen_ai keys out of node tags, as n8n', () => {
    expect(
      customAttributes({
        node: { tracing: { 'gen_ai.system': 'x', gen_ai: 'y', 'gen_ai.request.model': 'z', other: 'ok' } },
      }),
    ).toEqual({ 'node.custom.other': 'ok' });
  });
});

describe('project tags (PATCH project)', () => {
  type Tags = { customTelemetryTags: Array<{ key: string; value: string }> };
  const detailOf = (id: string) => owner.client.data<Tags>(owner.client.get(`/rest/projects/${id}`));
  const newProject = (prefix: string) =>
    owner.client.data<{ id: string }>(
      owner.client.post('/rest/projects', { name: `${prefix} ${randomUUID().slice(0, 6)}` }),
    );

  it('saves, returns, keeps and clears them', async () => {
    const project = await newProject('Tags');
    const patched = await owner.client.patch(`/rest/projects/${project.id}`, {
      customTelemetryTags: [
        { key: ' region ', value: 'eu' },
        { key: 'team', value: 'core' },
      ],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await detailOf(project.id)).customTelemetryTags).toEqual([
      { key: 'region', value: 'eu' },
      { key: 'team', value: 'core' },
    ]);
    // an update without the field keeps the tags; an empty list clears them
    await owner.client.patch(`/rest/projects/${project.id}`, { name: `Renamed ${randomUUID().slice(0, 6)}` });
    expect((await detailOf(project.id)).customTelemetryTags).toHaveLength(2);
    const cleared = await owner.client.patch(`/rest/projects/${project.id}`, { customTelemetryTags: [] });
    expect(cleared.statusCode).toBe(200);
    expect((await detailOf(project.id)).customTelemetryTags).toEqual([]);
  });

  it('refuses a blank key, a duplicate key, a long key and more than 20 tags with 400', async () => {
    const project = await newProject('Bad');
    const send = (tags: unknown) =>
      owner.client.patch(`/rest/projects/${project.id}`, { customTelemetryTags: tags });
    expect((await send([{ key: '  ', value: 'x' }])).statusCode).toBe(400);
    const dup = await send([
      { key: 'a', value: '1' },
      { key: ' a ', value: '2' },
    ]);
    expect(dup.statusCode).toBe(400);
    expect(dup.body).toContain('used more than once');
    expect((await send([{ key: 'k'.repeat(65), value: 'x' }])).statusCode).toBe(400);
    expect(
      (await send(Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' })))).statusCode,
    ).toBe(400);
    expect((await send('nope')).statusCode).toBe(400);
    expect((await detailOf(project.id)).customTelemetryTags).toEqual([]);
  });

  it('the public update row takes them and the public answer carries them', async () => {
    const project = await newProject('Public');
    const made = await owner.client.data<{ key: string }>(
      owner.client.post('/rest/api-keys', { name: `tags-${randomUUID().slice(0, 8)}` }),
    );
    const call = (payload: unknown) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${project.id}`,
        headers: { 'x-api-key': made.key },
        payload: payload as object,
      });
    const put = await call({ customTelemetryTags: [{ key: 'region', value: 'us' }] });
    expect(put.statusCode, put.body).toBeLessThan(300);
    expect((await detailOf(project.id)).customTelemetryTags).toEqual([{ key: 'region', value: 'us' }]);
    expect(JSON.parse(put.body).data.customTelemetryTags ?? JSON.parse(put.body).customTelemetryTags).toEqual(
      [{ key: 'region', value: 'us' }],
    );
    expect((await call({ customTelemetryTags: [{ key: '', value: 'us' }] })).statusCode).toBe(400);
  });
});

describe('tags on real spans', () => {
  it('a project tag, a workflow tag and an expression node tag appear on the spans', async () => {
    const projectId = owner.client.defaultProjectId as string;
    const set = await owner.client.patch(`/rest/projects/${projectId}`, {
      customTelemetryTags: [{ key: 'region', value: 'eu-1' }],
    });
    expect(set.statusCode, set.body).toBe(200);
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        setNode('First', 'a', 'x'),
        tagged('Second', [
          { key: ' plan ', value: '={{ $json.a }}' },
          { key: 'literal', value: 'fixed' },
          { key: 'sum', value: '={{ 1 + 2 }}' },
          { key: 'gen_ai.system', value: 'nope' },
          { key: 'empty', value: '={{ null }}' },
        ]),
      ],
      chain('Start', 'First', 'Second'),
      { customTelemetryTags: [{ key: 'area', value: 'billing' }] },
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const spans = await spansOf(executionId, 4);
    const run = spans.find((s) => s.name === 'workflow.execute')!;
    expect(run.attributes['project.custom.region']).toBe('eu-1');
    expect(run.attributes['workflow.custom.area']).toBe('billing');
    const second = spans.find((s) => s.name === 'node.execute' && s.attributes['node.name'] === 'Second')!;
    expect(second.attributes['node.custom.plan']).toBe('x');
    expect(second.attributes['node.custom.literal']).toBe('fixed');
    expect(second.attributes['node.custom.sum']).toBe('3');
    expect(second.attributes['node.custom.empty']).toBeUndefined();
    expect(Object.keys(second.attributes).some((k) => k.startsWith('node.custom.gen_ai'))).toBe(false);
    const first = spans.find((s) => s.name === 'node.execute' && s.attributes['node.name'] === 'First')!;
    expect(customKeys(first)).toEqual([]);
  });

  it('a run with redactionPolicy all sends no node.custom attribute', async () => {
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        setNode('First', 'a', 'x'),
        tagged('Second', [{ key: 'plan', value: '={{ $json.a }}' }]),
      ],
      chain('Start', 'First', 'Second'),
      { redactionPolicy: 'all' },
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const spans = await spansOf(executionId, 4);
    expect(spans.length).toBeGreaterThanOrEqual(4);
    for (const span of spans) {
      expect(Object.keys(span.attributes).some((k) => k.startsWith('node.custom.'))).toBe(false);
    }
  });
});
