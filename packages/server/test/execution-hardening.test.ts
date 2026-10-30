import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowDefinition } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { binaryDirOf } from '../src/services/executions';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  // a 1 MB body limit keeps the oversized payloads small
  server = await createTestServer({ BODY_LIMIT_MB: '1' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const MB = 1024 * 1024;
/** U+FFFD, which replaces NUL characters in stored run data */
const FFFD = String.fromCodePoint(0xfffd);
const BOUNDARY = 'HARDENINGBOUNDARY';

function multipart(parts: Array<{ name: string; fileName?: string; content: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.fileName
      ? `form-data; name="${part.name}"; filename="${part.fileName}"\r\nContent-Type: application/octet-stream`
      : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const postMultipart = (url: string, payload: Buffer) =>
  server.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });

/** files left under the tenant's binary data directory */
function binaryFilesOf(tenantId: string): string[] {
  const dir = path.join(server.ctx.config.binaryData.dir, tenantId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

async function activeWebhook(
  client: Awaited<ReturnType<typeof signup>>['client'],
  webhookPath: string,
  extra: {
    nodes?: ReturnType<typeof node>[];
    connections?: unknown;
    settings?: Record<string, unknown>;
  } = {},
) {
  const wf = await createWorkflow(client, {
    nodes: [
      node('Webhook', 'core.webhook', { httpMethod: 'POST', path: webhookPath }, [0, 0], {
        webhookId: webhookPath,
      }),
      ...(extra.nodes ?? []),
    ],
    connections: extra.connections,
    settings: extra.settings,
  });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return wf;
}

describe('R12: NUL characters and atomic execution rows', () => {
  it('runs a webhook whose payload holds a NUL character and leaves no stuck execution', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWebhook(client, 'nul');
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/nul`,
      headers: { 'content-type': 'application/json' },
      payload: '{"a":"x\\u0000y","k\\u0000":"\\\\u0000"}',
    });
    expect(res.statusCode).toBe(200);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${execution.id}`));
    const item = data.state.resultData.runData.Webhook[0].data.main[0][0].json;
    expect(item.body).toEqual({ a: `x${FFFD}y`, [`k${FFFD}`]: String.raw`\u0000` });
    expect(await server.ctx.repos.executions.countRunning(tenant.id)).toBe(0);
    expect((await client.data(client.get('/rest/settings'))).usage.executions).toBe(1);
  });

  it('rolls back the execution row when its data cannot be stored', async () => {
    const { tenant } = await signup(server.app);
    const id = randomUUID();
    await expect(
      server.ctx.repos.executions.create(
        tenant.id,
        { id, mode: 'manual', status: 'new' },
        { workflowData: null as unknown as Record<string, unknown>, runOptions: {} },
      ),
    ).rejects.toThrow();
    expect(await server.ctx.repos.executions.get(tenant.id, id)).toBeUndefined();
    expect(await server.ctx.repos.executions.countRunning(tenant.id)).toBe(0);
  });

  it('stores state and run options that hold NUL characters', async () => {
    const { tenant } = await signup(server.app);
    const id = randomUUID();
    await server.ctx.repos.executions.create(
      tenant.id,
      { id, mode: 'manual', status: 'new', workflowName: 'a\u0000b' },
      { workflowData: { name: 'w\u0000' }, runOptions: {} },
    );
    await server.ctx.repos.executions.saveState(tenant.id, id, { text: 'x\u0000' });
    await server.ctx.repos.executions.updateRunOptions(tenant.id, id, { note: '\u0000' });
    await server.ctx.repos.executions.update(tenant.id, id, { status: 'error', errorMessage: 'bad\u0000' });
    const row = await server.ctx.repos.executions.get(tenant.id, id);
    const data = await server.ctx.repos.executions.getData(tenant.id, id);
    expect(row).toMatchObject({ workflowName: `a${FFFD}b`, errorMessage: `bad${FFFD}`, status: 'error' });
    expect(data).toMatchObject({
      workflowData: { name: `w${FFFD}` },
      state: { text: `x${FFFD}` },
      runOptions: { note: FFFD },
    });
  });
});

describe('R14: multipart bodies', () => {
  it('rejects a multipart request whose parts together exceed the body limit', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWebhook(client, 'upload');
    const file = Buffer.alloc(400 * 1024, 'a');
    const res = await postMultipart(
      `/webhook/${tenant.slug}/upload`,
      multipart([
        { name: 'one', fileName: 'one.bin', content: file },
        { name: 'two', fileName: 'two.bin', content: file },
        { name: 'three', fileName: 'three.bin', content: file },
      ]),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);
    expect(binaryFilesOf(tenant.id)).toEqual([]);
  });

  it('counts form fields towards the body limit', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWebhook(client, 'fields');
    const value = 'v'.repeat(300 * 1024);
    const res = await postMultipart(
      `/webhook/${tenant.slug}/fields`,
      multipart([
        { name: 'a', content: value },
        { name: 'b', content: value },
        { name: 'c', content: value },
        { name: 'd', content: value },
      ]),
    );
    expect(res.statusCode).toBe(413);
  });

  it('answers 404 for unknown webhook paths without reading the multipart body', async () => {
    const { tenant } = await signup(server.app);
    // a single part over the body limit would be rejected with 413 if the body were read
    const oversized = multipart([
      { name: 'file', fileName: 'big.bin', content: Buffer.alloc(MB + 1024, 'b') },
    ]);
    for (const url of [
      `/webhook/${tenant.slug}/no-such-path`,
      '/webhook/no-such-tenant/no-such-path',
      `/webhook-test/${tenant.slug}/no-such-path`,
      `/webhook-waiting/${randomUUID()}`,
    ]) {
      const res = await postMultipart(url, oversized);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('still accepts multipart uploads within the limit', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWebhook(client, 'small');
    const res = await postMultipart(
      `/webhook/${tenant.slug}/small`,
      multipart([
        { name: 'title', content: 'Report' },
        { name: 'file', fileName: 'a.bin', content: Buffer.alloc(300 * 1024, 'c') },
      ]),
    );
    expect(res.statusCode).toBe(200);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
  });
});

describe('R17: error workflows', () => {
  it('never starts an error workflow from a failing error workflow', async () => {
    const { client, tenant } = await signup(server.app);
    const last = await createWorkflow(client, {
      name: 'Last resort',
      nodes: [node('Error Trigger', 'core.errorTrigger'), setNode('Note', 'handled', 'yes')],
      connections: chain('Error Trigger', 'Note'),
    });
    const handler = await createWorkflow(client, {
      name: 'Failing handler',
      nodes: [
        node('Error Trigger', 'core.errorTrigger'),
        node('Boom', 'test.fail', { message: 'again' }, [200, 0]),
      ],
      connections: chain('Error Trigger', 'Boom'),
      settings: { errorWorkflow: last.id },
    });
    await activeWebhook(client, 'fragile', {
      nodes: [node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0])],
      connections: chain('Webhook', 'Boom'),
      settings: { errorWorkflow: handler.id },
    });
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/fragile` })).statusCode,
    ).toBe(200);
    const handled = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
      message: 'error workflow execution',
    });
    await waitForExecution(server.ctx, tenant.id, handled.id, ['error']);
    await new Promise((r) => setTimeout(r, 300));
    expect(await executionsOf(server.ctx, tenant.id, last.id)).toHaveLength(0);
  });

  it('stops the error chain when a sub-workflow called by an error workflow fails', async () => {
    const { client, tenant } = await signup(server.app);
    const child = await createWorkflow(client, {
      name: 'Failing child',
      nodes: [
        node('Called', 'core.executeWorkflowTrigger', {}, [0, 0]),
        node('Boom', 'test.fail', { message: 'child failed' }, [200, 0]),
      ],
      connections: chain('Called', 'Boom'),
    });
    const handler = await createWorkflow(client, {
      name: 'Handler calling child',
      nodes: [
        node('Error Trigger', 'core.errorTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Error Trigger', 'Call'),
    });
    const current = await client.data(client.get(`/rest/workflows/${child.id}`));
    await client.data(
      client.patch(`/rest/workflows/${child.id}`, {
        versionId: current.versionId,
        settings: { errorWorkflow: handler.id },
      }),
    );
    await activeWebhook(client, 'chained', {
      nodes: [node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0])],
      connections: chain('Webhook', 'Boom'),
      settings: { errorWorkflow: handler.id },
    });
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/chained` })).statusCode,
    ).toBe(200);
    const first = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
      message: 'error workflow execution',
    });
    await waitForExecution(server.ctx, tenant.id, first.id, ['error']);
    await new Promise((r) => setTimeout(r, 500));
    expect(await executionsOf(server.ctx, tenant.id, handler.id)).toHaveLength(1);
    expect(await executionsOf(server.ctx, tenant.id, child.id)).toHaveLength(1);
  });

  it('applies the concurrent execution limit to error executions', async () => {
    const { tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { concurrentExecutions: 1 } });
    await server.ctx.repos.executions.create(
      tenant.id,
      { id: randomUUID(), mode: 'webhook', status: 'running' },
      { workflowData: {}, runOptions: {} },
    );
    const workflow = {
      name: 'Handler',
      nodes: [node('Error Trigger', 'core.errorTrigger')],
      connections: {},
    } as unknown as WorkflowDefinition;
    await expect(
      server.ctx.executions.start({
        tenantId: tenant.id,
        workflow,
        mode: 'error',
        startNode: 'Error Trigger',
        triggerItems: [{ json: {} }],
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('R18: binary data of executions that never started', () => {
  it('removes uploaded files when the plan limit rejects the execution', async () => {
    const { client, tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { executionsPerMonth: 0 } });
    await activeWebhook(client, 'quota');
    const res = await postMultipart(
      `/webhook/${tenant.slug}/quota`,
      multipart([{ name: 'file', fileName: 'big.bin', content: Buffer.alloc(200 * 1024, 'd') }]),
    );
    expect(res.statusCode).toBe(403);
    expect(await executionsOf(server.ctx, tenant.id)).toHaveLength(0);
    expect(binaryFilesOf(tenant.id)).toEqual([]);
  });

  it('removes the binary data directory when the execution row cannot be created', async () => {
    const { tenant } = await signup(server.app);
    const executionId = randomUUID();
    const dir = binaryDirOf(server.ctx.config, tenant.id, executionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'blob'), 'x');
    const workflow = { name: 'Gone', nodes: [node('Start', 'core.manualTrigger')], connections: {} };
    // the workflow id references no row, so the insert fails
    await expect(
      server.ctx.executions.start({
        tenantId: tenant.id,
        workflow: workflow as unknown as WorkflowDefinition,
        workflowId: randomUUID(),
        mode: 'manual',
        executionId,
      }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
