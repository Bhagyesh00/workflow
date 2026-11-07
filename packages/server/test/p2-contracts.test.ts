/**
 * Phase 2 contract step. C0a: node limits and misfire grace from the environment, repository stubs.
 * C0b: buildServices nodeLimits, trigger-run static data saved through repos.staticData.merge, the
 * slot store handed to trigger nodes.
 */
import { rm } from 'node:fs/promises';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { NodePackage, NodeType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import type { DbOrTx } from '../src/db/client';
import { createRepositories } from '../src/repositories';
import {
  chain,
  createWorkflow,
  executionsOf,
  node,
  resetDatabase,
  signup,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

const MB = 1024 * 1024;

describe('Phase 2 config', () => {
  it('has the planned defaults', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.nodeLimits).toEqual({
      maxDecompressedBytes: 100 * MB,
      maxArchiveEntries: 1000,
      maxImagePixels: 50_000_000,
      maxImageInputBytes: 25 * MB,
      maxSpreadsheetCells: 1_000_000,
      maxRemoteFileBytes: 100 * MB,
      maxPassthroughBinaryBytes: 52_428_800,
    });
    expect(config.scheduleMisfireGraceS).toBe(60);
  });

  it('reads the env variables', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      NODE_DECOMPRESS_MAX_MB: '5',
      NODE_ARCHIVE_MAX_ENTRIES: '20',
      NODE_IMAGE_MAX_MEGAPIXELS: '3',
      NODE_IMAGE_MAX_INPUT_MB: '2',
      NODE_SHEET_MAX_CELLS: '1000',
      NODE_REMOTE_FILE_MAX_MB: '7',
      AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES: '1024',
      SCHEDULE_MISFIRE_GRACE_S: '0',
    });
    expect(config.nodeLimits).toEqual({
      maxDecompressedBytes: 5 * MB,
      maxArchiveEntries: 20,
      maxImagePixels: 3_000_000,
      maxImageInputBytes: 2 * MB,
      maxSpreadsheetCells: 1000,
      maxRemoteFileBytes: 7 * MB,
      maxPassthroughBinaryBytes: 1024,
    });
    expect(config.scheduleMisfireGraceS).toBe(0);
  });

  it('refuses zero or invalid limits', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', NODE_DECOMPRESS_MAX_MB: '0' })).toThrow(
      /NODE_DECOMPRESS_MAX_MB/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', NODE_SHEET_MAX_CELLS: 'many' })).toThrow(
      /NODE_SHEET_MAX_CELLS/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', SCHEDULE_MISFIRE_GRACE_S: '-1' })).toThrow(
      /SCHEDULE_MISFIRE_GRACE_S/,
    );
  });
});

describe('Phase 2 repository stubs', () => {
  const repos = createRepositories({} as DbOrTx);

  it('registers staticData and scheduleSlots', () => {
    expect(typeof repos.staticData.merge).toBe('function');
    expect(typeof repos.scheduleSlots.storeFor).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------------
// C0b: node limits in the execution services, static data saved through the repository, the
// schedule slot store handed to trigger nodes (needs TEST_DATABASE_URL / TEST_REDIS_URL)

const triggerSeen: Array<{ hasStore: boolean; grace?: number }> = [];

const p2Package: NodePackage = {
  name: 'p2-contracts',
  nodes: [
    {
      description: {
        name: 'p2.emitter',
        displayName: 'Emitter',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Emitter' },
        inputs: [],
        outputs: ['main'],
        properties: [],
      },
      async trigger(ctx) {
        triggerSeen.push({
          hasStore: ctx.scheduleSlots !== undefined,
          grace: ctx.scheduleSlots?.defaultGraceSeconds,
        });
        if (ctx.getMode() === 'manual') return {};
        const timer = setTimeout(() => ctx.emit([[{ json: { fired: true } }]]), 50);
        return { closeFunction: async () => clearTimeout(timer) };
      },
    },
    {
      description: {
        name: 'p2.counter',
        displayName: 'Counter',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Counter' },
        inputs: ['main'],
        outputs: ['main'],
        properties: [],
      },
      async execute(ctx) {
        const scope = ctx.getWorkflowStaticData('node');
        scope.count = Number(scope.count ?? 0) + 1;
        const global = ctx.getWorkflowStaticData('global');
        global.runs = Number(global.runs ?? 0) + 1;
        return [[{ json: { count: scope.count } }]];
      },
    },
  ] as NodeType[],
  credentials: [],
};

describe('Phase 2 shared server logic', () => {
  let server: TestServer;

  beforeAll(async () => {
    const config = testConfig({ NODE_DECOMPRESS_MAX_MB: '3', SCHEDULE_MISFIRE_GRACE_S: '45' });
    const ctx = await createContext({
      config,
      nodePackages: [nodesBasePackage, testPackage, p2Package],
      http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
    });
    await resetDatabase(ctx);
    const app = await buildApp(ctx);
    await app.ready();
    await ctx.startMain();
    server = {
      ctx,
      app,
      async close() {
        await app.close();
        await ctx.close();
        await rm(config.binaryData.dir, { recursive: true, force: true });
      },
    };
  });
  afterAll(async () => {
    await server?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives nodes the configured instance limits', async () => {
    const { tenant } = await signup(server.app);
    const row = (await server.ctx.repos.tenants.get(tenant.id))!;
    const services = await server.ctx.executions.buildServices({
      tenant: row,
      executionId: '',
      mode: 'manual',
    });
    expect(services.nodeLimits).toEqual(server.ctx.config.nodeLimits);
    expect(services.nodeLimits?.maxDecompressedBytes).toBe(3 * MB);
  });

  it('saves the static data of a trigger run through repos.staticData.merge', async () => {
    triggerSeen.length = 0;
    const merge = vi.spyOn(server.ctx.repos.staticData, 'merge');
    const storeFor = vi.spyOn(server.ctx.repos.scheduleSlots, 'storeFor');
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Emitter', 'p2.emitter'), node('Counter', 'p2.counter', {}, [200, 0])],
      connections: chain('Emitter', 'Counter'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    const [execution] = await waitFor(async () => {
      const list = await executionsOf(server.ctx, tenant.id, wf.id);
      return list.length ? list : undefined;
    });
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    await waitFor(async () => merge.mock.calls.length > 0, { message: 'static data save' });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));

    expect(merge).toHaveBeenCalledWith(
      tenant.id,
      wf.id,
      {},
      {
        'node:Counter': { count: 1 },
        global: { runs: 1 },
      },
    );
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    expect(row?.staticData).toEqual({ 'node:Counter': { count: 1 }, global: { runs: 1 } });

    // the saved workflow's trigger got a slot store with the instance grace
    expect(storeFor).toHaveBeenCalledWith(tenant.id, wf.id, 'Emitter', 45);
    expect(triggerSeen).toContainEqual({ hasStore: true, grace: 45 });
  });
});
