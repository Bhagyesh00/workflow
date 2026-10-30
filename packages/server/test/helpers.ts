/**
 * Test harness: a real server (Fastify + Postgres `workflow_test` + Redis db 1) with small test
 * node types, an inject-based client that keeps the session cookie, and polling helpers.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import {
  type CredentialType,
  type DataObject,
  type Item,
  type NodePackage,
  type NodeType,
  sleep,
  type WorkflowNode,
} from '@workflow/workflow';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { createContext, type ServerContext } from '../src/context';

export const BASE_URL = 'http://localhost:5678';
export const ORIGIN = 'http://localhost:5678';
export const TEST_DB = 'postgres://postgres:postgres@127.0.0.1:5432/workflow_test';
export const TEST_REDIS = 'redis://127.0.0.1:6379/1';
export const TEST_KEY = `test:${Buffer.alloc(32, 7).toString('base64')}`;

// ---------------------------------------------------------------------------------------------
// test node types

/** calls recorded by test.hookRegister's webhookMethods */
export const hookRegistry: Array<{ action: string; url: string }> = [];

const trigger = (name: string, extra: Partial<NodeType> = {}): NodeType => ({
  description: {
    name,
    displayName: name,
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name },
    inputs: [],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    return [items.length ? items : [{ json: {} }]];
  },
  ...extra,
});

const testNodes: NodeType[] = [
  {
    description: {
      name: 'test.fail',
      displayName: 'Fail',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Fail' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [
        { displayName: 'Message', name: 'message', type: 'string', default: 'Intentional failure' },
      ],
    },
    async execute(ctx) {
      throw new Error(String(ctx.getNodeParameter('message', 0)));
    },
  },
  {
    description: {
      name: 'test.wait',
      displayName: 'Wait',
      description: '',
      group: ['organization'],
      version: 1,
      defaults: { name: 'Wait' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [{ displayName: 'Milliseconds', name: 'ms', type: 'number', default: 3_600_000 }],
    },
    async execute(ctx) {
      await ctx.putExecutionToWait(new Date(Date.now() + Number(ctx.getNodeParameter('ms', 0))));
      return [ctx.getInputData()];
    },
  },
  {
    description: {
      name: 'test.waitHook',
      displayName: 'Wait for webhook',
      description: '',
      group: ['organization'],
      version: 1,
      defaults: { name: 'Wait for webhook' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [],
      webhooks: [{ name: 'default', httpMethod: 'POST', path: '', restartWebhook: true }],
    },
    async execute(ctx) {
      await ctx.putExecutionToWait(new Date(Date.now() + 3_600_000));
      return [ctx.getInputData()];
    },
    async webhook(ctx) {
      const body = ctx.getBodyData();
      if (body.reject) return { webhookResponse: { statusCode: 403, body: { message: 'rejected' } } };
      return { workflowData: [[{ json: { resumedWith: body, via: 'webhook()' } }]] };
    },
  },
  {
    description: {
      name: 'test.interval',
      displayName: 'Interval trigger',
      description: '',
      group: ['trigger'],
      version: 1,
      defaults: { name: 'Interval' },
      inputs: [],
      outputs: ['main'],
      properties: [{ displayName: 'Interval', name: 'intervalMs', type: 'number', default: 100 }],
    },
    async trigger(ctx) {
      let tick = 0;
      const emit = () => ctx.emit([[{ json: { tick: ++tick } }]]);
      if (ctx.getMode() === 'manual') return { manualTriggerFunction: async () => emit() };
      const timer = setInterval(emit, Number(ctx.getNodeParameter('intervalMs', 0)));
      return { closeFunction: async () => clearInterval(timer) };
    },
  },
  {
    description: {
      name: 'test.poll',
      displayName: 'Poller',
      description: '',
      group: ['trigger'],
      version: 1,
      defaults: { name: 'Poller' },
      inputs: [],
      outputs: ['main'],
      polling: true,
      properties: [],
    },
    async poll(ctx) {
      const state = ctx.getWorkflowStaticData('node');
      state.count = Number(state.count ?? 0) + 1;
      return [[{ json: { count: state.count } }]];
    },
  },
  {
    description: {
      name: 'test.hookRegister',
      displayName: 'Third-party trigger',
      description: '',
      group: ['trigger'],
      version: 1,
      defaults: { name: 'Third-party' },
      inputs: [],
      outputs: ['main'],
      properties: [],
      webhooks: [{ name: 'default', httpMethod: 'POST', path: 'events' }],
    },
    webhookMethods: {
      default: {
        async checkExists() {
          return false;
        },
        async create(ctx) {
          hookRegistry.push({ action: 'create', url: ctx.getNodeWebhookUrl('default') });
          ctx.getWorkflowStaticData('node').remoteId = 'remote-1';
          return true;
        },
        async delete(ctx) {
          hookRegistry.push({ action: 'delete', url: ctx.getNodeWebhookUrl('default') });
          return true;
        },
      },
    },
    async webhook(ctx) {
      return { workflowData: [[{ json: { event: ctx.getBodyData() } }]] };
    },
  },
  {
    description: {
      name: 'test.callWorkflow',
      displayName: 'Call workflow',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Call workflow' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [
        { displayName: 'Workflow', name: 'workflowId', type: 'string', default: '' },
        { displayName: 'Do not wait', name: 'doNotWait', type: 'boolean', default: false },
      ],
    },
    async execute(ctx) {
      const result = await ctx.executeWorkflow(
        { source: 'database', workflowId: String(ctx.getNodeParameter('workflowId', 0)) },
        ctx.getInputData(),
        { doNotWaitToFinish: Boolean(ctx.getNodeParameter('doNotWait', 0)) },
      );
      return result.data ?? [ctx.getInputData()];
    },
  },
  {
    description: {
      name: 'test.useCredential',
      displayName: 'Use credential',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Use credential' },
      inputs: ['main'],
      outputs: ['main'],
      credentials: [{ name: 'testApi', required: true }],
      properties: [],
    },
    async execute(ctx) {
      const creds = await ctx.getCredentials<{ apiKey?: string; region?: string }>('testApi');
      return [[{ json: { keyLength: creds.apiKey?.length ?? 0, region: creds.region } }]];
    },
  },
  {
    description: {
      name: 'test.sleep',
      displayName: 'Sleep',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Sleep' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [{ displayName: 'Milliseconds', name: 'ms', type: 'number', default: 5000 }],
    },
    async execute(ctx) {
      await sleep(Number(ctx.getNodeParameter('ms', 0)), ctx.signal);
      return [ctx.getInputData()];
    },
  },
  {
    description: {
      name: 'test.chunks',
      displayName: 'Stream chunks',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Stream' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [{ displayName: 'Text', name: 'text', type: 'string', default: 'Hello' }],
    },
    async execute(ctx) {
      for (const part of String(ctx.getNodeParameter('text', 0)).split(' ')) {
        ctx.sendChunk(part);
        await sleep(5, ctx.signal);
      }
      return [ctx.getInputData()];
    },
  },
  trigger('core.executeWorkflowTrigger'),
  trigger('core.errorTrigger'),
];

const testCredentials: CredentialType[] = [
  {
    name: 'testApi',
    displayName: 'Test API',
    properties: [
      { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: '' },
      { displayName: 'Region', name: 'region', type: 'string', default: 'eu' },
      {
        displayName: 'API key',
        name: 'apiKey',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
    ],
    authenticate: { type: 'generic', properties: { headers: { 'x-api-key': '={{$credentials.apiKey}}' } } },
    test: { request: { url: '={{$credentials.baseUrl}}/check' } },
  },
  {
    name: 'oAuth2Api',
    displayName: 'OAuth2',
    properties: [
      { displayName: 'Grant type', name: 'grantType', type: 'hidden', default: 'authorizationCode' },
      { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '' },
      { displayName: 'Access token URL', name: 'accessTokenUrl', type: 'string', default: '' },
      { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
      {
        displayName: 'Client secret',
        name: 'clientSecret',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
      { displayName: 'Scope', name: 'scope', type: 'string', default: '' },
    ],
  },
  {
    name: 'testPkceOAuth2Api',
    displayName: 'Test PKCE OAuth2',
    extends: ['oAuth2Api'],
    properties: [{ displayName: 'Grant type', name: 'grantType', type: 'hidden', default: 'pkce' }],
  },
];

const existingNodes = new Set(nodesBasePackage.nodes.map((n) => n.description.name));
const existingCredentials = new Set(nodesBasePackage.credentials.map((c) => c.name));

export const testPackage: NodePackage = {
  name: 'server-tests',
  nodes: testNodes.filter((n) => !existingNodes.has(n.description.name)),
  credentials: testCredentials.filter((c) => !existingCredentials.has(c.name)),
};

// ---------------------------------------------------------------------------------------------
// server

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    BASE_URL,
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEYS: TEST_KEY,
    BINARY_DATA_DIR: overrides.BINARY_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'wf-binary-')),
    LOGIN_RATE_LIMIT_MAX: '5',
    WAIT_TRACKER_INTERVAL_MS: '600000',
    QUEUE_PREFIX: 'wftest',
    EDITOR_DIST: path.join(tmpdir(), 'no-editor-dist'),
    ...overrides,
  });
}

const TABLES = [
  'webhook_idempotency',
  'usage_counters',
  'audit_log',
  'variables',
  'webhooks',
  'execution_data',
  'executions',
  'credentials',
  'workflow_tags',
  'tags',
  'workflow_versions',
  'workflows',
  'api_keys',
  'invitations',
  'sessions',
  'memberships',
  'users',
  'tenants',
];

export async function resetDatabase(ctx: ServerContext): Promise<void> {
  await ctx.database.pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function flushRedis(): Promise<void> {
  const redis = new Redis(TEST_REDIS, { maxRetriesPerRequest: 1 });
  await redis.flushdb();
  await redis.quit();
}

export interface TestServer {
  ctx: ServerContext;
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function createTestServer(
  overrides: Record<string, string> = {},
  options: { startMain?: boolean; reset?: boolean } = {},
): Promise<TestServer> {
  const config = testConfig(overrides);
  const ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage],
    // local test servers (credential test, OAuth2 token endpoint) live on 127.0.0.1
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  if (options.reset !== false) await resetDatabase(ctx);
  const app = await buildApp(ctx);
  await app.ready();
  if (options.startMain !== false) await ctx.startMain();
  return {
    ctx,
    app,
    async close() {
      await app.close();
      await ctx.close();
      await rm(config.binaryData.dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// client

export class TestClient {
  cookie?: string;

  constructor(
    readonly app: FastifyInstance,
    readonly origin = ORIGIN,
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== 'GET' ? { origin: this.origin, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.cookies.find((c) => c.name === 'wf_session');
    if (setCookie) this.cookie = setCookie.value ? `wf_session=${setCookie.value}` : undefined;
    return res;
  }

  get = (url: string, headers?: Record<string, string>) => this.request('GET', url, undefined, headers);
  post = (url: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.request('POST', url, body, headers);
  patch = (url: string, body: unknown = {}) => this.request('PATCH', url, body);
  put = (url: string, body: unknown = {}) => this.request('PUT', url, body);
  delete = (url: string) => this.request('DELETE', url);

  /** `data` of a successful response; fails the test with the error body otherwise */
  async data<T = any>(promise: Promise<LightMyRequestResponse>): Promise<T> {
    const res = await promise;
    if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
    return res.json().data as T;
  }
}

let counter = 0;

export async function signup(
  app: FastifyInstance,
  input: Partial<{ email: string; password: string; name: string; workspaceName: string }> = {},
) {
  counter++;
  const client = new TestClient(app);
  const res = await client.post('/rest/auth/signup', {
    email: input.email ?? `user${counter}-${randomUUID().slice(0, 8)}@example.com`,
    password: input.password ?? 'Passw0rd!',
    name: input.name ?? `User ${counter}`,
    workspaceName: input.workspaceName ?? `Workspace ${counter}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as {
    user: { id: string; email: string };
    tenant: { id: string; slug: string };
    role: string;
  };
  return { client, ...data };
}

// ---------------------------------------------------------------------------------------------
// workflows

export function node(
  name: string,
  type: string,
  parameters: DataObject = {},
  position: [number, number] = [0, 0],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id: randomUUID(), name, type, typeVersion: 1, position, parameters, ...extra };
}

export function chain(...names: string[]) {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> =
    {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  }
  return connections;
}

export const setNode = (name: string, field: string, value: unknown, position: [number, number] = [200, 0]) =>
  node(
    name,
    'core.set',
    {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: randomUUID(), name: field, value, type: typeof value === 'number' ? 'number' : 'string' },
        ],
      },
    },
    position,
  );

export async function createWorkflow(
  client: TestClient,
  definition: { name?: string; nodes: WorkflowNode[]; connections?: unknown; settings?: DataObject },
) {
  return client.data<{ id: string; versionId: string; active: boolean }>(
    client.post('/rest/workflows', {
      name: definition.name ?? 'Test workflow',
      nodes: definition.nodes,
      connections: definition.connections ?? {},
      settings: definition.settings ?? {},
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// waiting

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  { timeout = 10_000, interval = 25, message = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function waitForExecution(
  ctx: ServerContext,
  tenantId: string,
  executionId: string,
  statuses: string[] = ['success', 'error', 'canceled', 'crashed'],
  timeout = 10_000,
) {
  return waitFor(
    async () => {
      const row = await ctx.repos.executions.get(tenantId, executionId);
      return row && statuses.includes(row.status) ? row : undefined;
    },
    { timeout, message: `execution ${executionId} to reach ${statuses.join('/')}` },
  );
}

export async function executionsOf(ctx: ServerContext, tenantId: string, workflowId?: string) {
  return ctx.repos.executions.list(tenantId, { workflowId, limit: 100 });
}

export function outputOf(state: any, nodeName: string, run = -1): DataObject[] {
  const runs = state.resultData.runData[nodeName];
  const task = runs[run < 0 ? runs.length - 1 : run];
  return ((task.data?.main?.[0] ?? []) as Item[]).map((i) => i.json);
}
