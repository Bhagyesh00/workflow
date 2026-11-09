/**
 * Test harness: a real server (Fastify + Postgres `workflow_test` + Redis db 1) with small test
 * node types, an inject-based client that keeps the session cookie, and polling helpers.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
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
import type { CredentialRow, DataTableRow, FolderRow, ProjectRow, Role, WorkflowRow } from '../src/db/schema';
import type { AiRuntime } from '../src/services/ai-builder/runtime';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import type { SecretProviderType } from '../src/services/secrets/types';

export const BASE_URL = 'http://localhost:5678';
export const ORIGIN = 'http://localhost:5678';
// overridable so separate test runs can each use their own database and Redis db
export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/workflow_test';
export const TEST_REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
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
  'workflow_shares',
  'credential_shares',
  'project_secret_access',
  'project_relations',
  'roles',
  'assistant_pending_confirmations',
  'assistant_events',
  'assistant_messages',
  'assistant_threads',
  'assistant_mcp_connections',
  'workflow_builder_sessions',
  'oauth_user_consents',
  'oauth_refresh_tokens',
  'oauth_access_tokens',
  'oauth_authorization_codes',
  'oauth_clients',
  'test_case_executions',
  'test_runs',
  'data_table_rows',
  'data_table_columns',
  'data_tables',
  'secret_connections',
  'workflow_review_comments',
  'workflow_review_activity',
  'workflow_review_authors',
  'workflow_review_reviewers',
  'workflow_review_requests',
  'workflow_publish_history',
  'folder_tags',
  'execution_annotation_tags',
  'execution_annotations',
  'annotation_tags',
  'user_favorites',
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
  'folders',
  'api_keys',
  'invitations',
  'sessions',
  'projects',
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
  options: {
    startMain?: boolean;
    reset?: boolean;
    http?: HttpClient;
    /** appended after the built-in and test packages */
    nodePackages?: NodePackage[];
    secretProviderTypes?: SecretProviderType[];
    /** P5-09: the builder's agent runtime (`createContext`'s `aiRuntime`) */
    aiRuntime?: AiRuntime;
    /** P5-67: extra Assistant tools (`createContext`'s `assistantTools`, the test seam) */
    assistantTools?: AssistantToolDefinition[];
  } = {},
): Promise<TestServer> {
  const config = testConfig(overrides);
  const ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, ...(options.nodePackages ?? [])],
    secretProviderTypes: options.secretProviderTypes,
    aiRuntime: options.aiRuntime,
    assistantTools: options.assistantTools,
    // local test servers (credential test, OAuth2 token endpoint) live on 127.0.0.1
    http:
      options.http ??
      new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
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

/** a free TCP port on 127.0.0.1 (the OS picks it; closed again before the caller listens on it) */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('No free port'))));
    });
  });
}

/**
 * P5-03, P5-04, P5-14: a test server listening on a free port of 127.0.0.1, with `BASE_URL` and
 * `MCP_BASE_URL` both `http://127.0.0.1:<port>`, so real MCP clients pass the Host check. `url` is that
 * base URL. Overrides win (pass `MCP_ACCESS_ENABLED: 'true'` for the tenant server); `close()` stops
 * the listener and the context. A `TestClient` for `/rest` calls needs `new TestClient(app, url)`.
 */
export async function startMcpTestServer(
  overrides: Record<string, string> = {},
  options: Parameters<typeof createTestServer>[1] = {},
): Promise<TestServer & { url: string; port: number }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = await createTestServer({ BASE_URL: url, MCP_BASE_URL: url, ...overrides }, options);
  try {
    await server.app.listen({ port, host: '127.0.0.1' });
  } catch (error) {
    await server.close();
    throw error;
  }
  return { ...server, url, port };
}

// ---------------------------------------------------------------------------------------------
// client

export class TestClient {
  cookie?: string;

  constructor(
    readonly app: FastifyInstance,
    readonly origin = ORIGIN,
    /** the caller's IP; signup allows 20 calls an hour per IP */
    readonly remoteAddress?: string,
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
      ...(this.remoteAddress ? { remoteAddress: this.remoteAddress } : {}),
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
  input: Partial<{
    email: string;
    password: string;
    name: string;
    workspaceName: string;
    remoteAddress: string;
  }> = {},
) {
  counter++;
  const client = new TestClient(app, ORIGIN, input.remoteAddress);
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
// members and projects (P6 S1)

/** a member made by `memberAs` / `realMember`: a client signed in to the owner's workspace */
export interface TestMember {
  client: TestClient;
  user: { id: string; email: string; name: string };
  tenant: { id: string; slug: string; name: string };
  role: string;
  email: string;
}

/**
 * Invites a new user into `owner`'s workspace with `role` and accepts the invitation on a new client
 * (invite plus accept, as the old tests did by hand). `owner` is any signed-in admin or owner, such as
 * the answer of `signup`. L24 changes only this body (legacy roles become `member` plus a project role).
 */
export async function memberAs(
  owner: { client: TestClient },
  role: Role,
  options: { email?: string; name?: string; password?: string; remoteAddress?: string; origin?: string } = {},
): Promise<TestMember> {
  counter++;
  const email = options.email ?? `${role}-${counter}-${randomUUID().slice(0, 8)}@example.com`;
  const invite = await owner.client.data<{ token: string }>(
    owner.client.post('/rest/members/invite', { email, role }),
  );
  const client = new TestClient(owner.client.app, options.origin ?? ORIGIN, options.remoteAddress);
  const accepted = await client.data<Omit<TestMember, 'client' | 'email'>>(
    client.post(`/rest/invitations/${invite.token}/accept`, {
      name: options.name ?? role,
      password: options.password ?? 'Passw0rd!',
    }),
  );
  return { client, ...accepted, email };
}

/** a real `member` of `owner`'s workspace (invited as `member`): it holds only what its projects give it */
export async function realMember(
  owner: { client: TestClient },
  options: Parameters<typeof memberAs>[2] = {},
): Promise<TestMember> {
  return memberAs(owner, 'member', options);
}

/** the id of the workspace's team project, where the old tests' work lives (signup makes it) */
export async function teamProjectOf(server: { ctx: ServerContext }, tenantId: string): Promise<string> {
  return server.ctx.repos.projects.defaultProjectFor(tenantId);
}

/** a team project of the workspace, made through the repository (no route) */
export async function projectIn(
  server: { ctx: ServerContext },
  tenantId: string,
  name: string,
  options: { icon?: ProjectRow['icon']; description?: string; creatorId?: string } = {},
): Promise<ProjectRow> {
  return server.ctx.repos.projects.create(tenantId, { name, type: 'team', ...options });
}

/** gives `userId` the project role `role` (such as `project:editor`); an existing relation takes the new role */
export async function addToProject(
  server: { ctx: ServerContext },
  tenantId: string,
  projectId: string,
  userId: string,
  role: string,
): Promise<void> {
  const { relations } = server.ctx.repos.projects;
  if (!(await relations.add(tenantId, projectId, userId, role))) {
    await relations.updateRole(tenantId, projectId, userId, role);
  }
}

/** a saved workflow owned by `projectId`, made through the repository */
export async function workflowIn(
  server: { ctx: ServerContext },
  tenantId: string,
  projectId: string,
  input: {
    name?: string;
    nodes?: WorkflowNode[];
    connections?: Record<string, unknown>;
    settings?: DataObject;
    folderId?: string | null;
    createdBy?: string;
  } = {},
): Promise<WorkflowRow> {
  return server.ctx.repos.workflows.create(tenantId, {
    name: input.name ?? `Workflow ${randomUUID().slice(0, 8)}`,
    nodes: input.nodes ?? [],
    connections: input.connections ?? {},
    settings: input.settings ?? {},
    pinData: {},
    stickyNotes: [],
    versionId: randomUUID(),
    folderId: input.folderId ?? null,
    createdBy: input.createdBy,
    projectId,
  });
}

/** a credential owned by `projectId` (data encrypted by the credential service, no route) */
export async function credentialIn(
  server: { ctx: ServerContext },
  tenantId: string,
  projectId: string,
  input: { name?: string; type?: string; data?: DataObject; isGlobal?: boolean; createdBy?: string } = {},
): Promise<CredentialRow> {
  const created = await server.ctx.credentials.create(
    tenantId,
    {
      name: input.name ?? `Credential ${randomUUID().slice(0, 8)}`,
      type: input.type ?? 'testApi',
      data: input.data ?? { apiKey: 'secret' },
      projectId,
    },
    input.createdBy,
  );
  if (input.isGlobal) await server.ctx.repos.credentials.update(tenantId, created.id, { isGlobal: true });
  return (await server.ctx.repos.credentials.get(tenantId, created.id))!;
}

/** an empty data table owned by `projectId`, made through the repository */
export async function dataTableIn(
  server: { ctx: ServerContext },
  tenantId: string,
  projectId: string,
  name = `table_${randomUUID().slice(0, 8)}`,
): Promise<DataTableRow> {
  return server.ctx.repos.dataTables.create(tenantId, projectId, name);
}

/** a folder owned by `projectId`, made through the repository */
export async function folderIn(
  server: { ctx: ServerContext },
  tenantId: string,
  projectId: string,
  name = `Folder ${randomUUID().slice(0, 8)}`,
  parentFolderId: string | null = null,
): Promise<FolderRow> {
  return server.ctx.repos.folders.create(tenantId, { name, parentFolderId, projectId });
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
