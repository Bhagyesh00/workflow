/**
 * Phase 5 S3 contract step (C0d2): server wiring. Config, evaluation mode, chunk meta and node run ends,
 * runNodeOperation, webhook sub-nodes and custom data, the chat listen token, `addColumn`, the
 * `/chat-widget` reservation, and the evaluation routes, scopes and OpenAPI components. Stub bodies
 * (EvaluationService, the public evaluation handlers, the widget route) are never asserted.
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import {
  CHAT_TEST_TOKEN_TTL_S,
  CHAT_TOKEN_KINDS,
  type ChatChunkMeta,
  DATASET_GET_ROWS,
  type DataObject,
  type NodePackage,
  type NodeType,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { API_KEY_SCOPES } from '../src/http/api-key-scopes';
import { currentPeriod } from '../src/plans';
import { PUBLIC_ROUTES } from '../src/routes/public-api';
import { PUBLIC_EVALUATION_ROUTES } from '../src/routes/public-evaluations';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  ORIGIN,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
  testConfig,
  waitFor,
} from './helpers';

const closed: string[] = [];

const described = (
  name: string,
  inputs: NodeType['description']['inputs'],
  outputs: NodeType['description']['outputs'],
  extra: Partial<NodeType['description']> = {},
): NodeType['description'] => ({
  name,
  displayName: name,
  description: '',
  group: ['transform'],
  version: 1,
  defaults: { name },
  inputs,
  outputs,
  properties: [],
  ...extra,
});

/** a memory stand-in: reads its session from the request item, closes after the webhook */
const memoryType: NodeType = {
  description: described('test.p5s3Memory', [], ['ai_memory'], {
    properties: [
      { displayName: 'Session', name: 'sessionKey', type: 'string', default: '={{ $json.sessionId }}' },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const sessionId = String(ctx.getNodeParameter('sessionKey', itemIndex));
    return {
      response: { sessionId },
      closeFunction: async () => {
        closed.push(sessionId);
      },
    };
  },
};

/** a chat-trigger-like webhook: reads its memory sub-node and sets custom data for the run */
const hookType: NodeType = {
  description: described(
    'test.p5s3Hook',
    [{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }],
    ['main'],
    {
      group: ['trigger'],
      webhooks: [{ name: 'default', httpMethod: 'POST', path: 'hook' }],
    },
  ),
  async webhook(ctx) {
    const memory = (await ctx.getInputConnectionData('ai_memory', 0)) as { sessionId: string };
    return {
      workflowData: [[{ json: { sessionId: memory.sessionId } }]],
      customData: { sessionId: memory.sessionId, source: 'hook' },
    };
  },
};

/** sends two chunks from one run (items 0 and 1) */
const chunkerType: NodeType = {
  description: described('test.p5s3Chunker', ['main'], ['main']),
  async execute(ctx) {
    ctx.sendChunk('a');
    ctx.sendChunk('b', { itemIndex: 1 });
    return [ctx.getInputData()];
  },
};

/** an Evaluation Trigger stand-in: `execute` and the dataset operation */
const sourceType: NodeType = {
  description: described('test.p5s3Source', [], ['main'], { group: ['trigger'] }),
  async execute() {
    return [[{ json: { executed: true } }]];
  },
  customOperations: {
    [DATASET_GET_ROWS]: async () => [[{ json: { row: 0 } }, { json: { row: 1 } }]],
  },
};

const testNodes: NodePackage = {
  name: 'p5s3-contract-tests',
  credentials: [],
  nodes: [memoryType, hookType, chunkerType, sourceType],
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage, testNodes] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  closed.length = 0;
});

const definitionOf = (
  nodes: WorkflowDefinition['nodes'],
  connections: WorkflowDefinition['connections'] = {},
  settings: WorkflowDefinition['settings'] = {},
): WorkflowDefinition => ({
  name: 'P5S3',
  nodes,
  connections,
  settings,
});

describe('config', () => {
  it('reads the chat and evaluation settings with their defaults', () => {
    const config = testConfig();
    expect(config.chatWidgetDist.replaceAll('\\', '/')).toMatch(/\/packages\/chat-widget\/dist$/);
    expect(config.disablePublicChatTrigger).toBe(false);
    expect(config.evaluationConcurrencyLimit).toBe(5);
  });

  it('caps CONCURRENCY_EVALUATION_LIMIT at 10 and refuses 0', () => {
    expect(testConfig({ CONCURRENCY_EVALUATION_LIMIT: '50' }).evaluationConcurrencyLimit).toBe(10);
    expect(testConfig({ CONCURRENCY_EVALUATION_LIMIT: '3' }).evaluationConcurrencyLimit).toBe(3);
    expect(() => loadConfig({ NODE_ENV: 'test', CONCURRENCY_EVALUATION_LIMIT: '0' })).toThrow(ConfigError);
  });

  it('reads DISABLE_PUBLIC_CHAT_TRIGGER and CHAT_WIDGET_DIST', () => {
    const config = testConfig({ DISABLE_PUBLIC_CHAT_TRIGGER: 'true', CHAT_WIDGET_DIST: 'widget-dist' });
    expect(config.disablePublicChatTrigger).toBe(true);
    expect(config.chatWidgetDist.replaceAll('\\', '/')).toMatch(/\/widget-dist$/);
  });

  it('hands disablePublicChatTrigger to the engine services', async () => {
    const { tenant } = await signup(server.app);
    const row = (await server.ctx.repos.tenants.get(tenant.id))!;
    const config = server.ctx.config;
    expect(
      (
        await server.ctx.executions.buildServices({
          tenant: row,
          executionId: '',
          projectId: await teamProjectOf(server, tenant.id),
          mode: 'manual',
        })
      ).disablePublicChatTrigger,
    ).toBe(false);
    config.disablePublicChatTrigger = true;
    try {
      const services = await server.ctx.executions.buildServices({
        tenant: row,
        executionId: '',
        projectId: await teamProjectOf(server, tenant.id),
        mode: 'manual',
      });
      expect(services.disablePublicChatTrigger).toBe(true);
    } finally {
      config.disablePublicChatTrigger = false;
    }
  });
});

describe('executions', () => {
  it('runs an evaluation case past the plan limit and saves it under saveDataSuccessExecution none', async () => {
    const { client, tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { concurrentExecutions: 0 } });
    const nodes = [node('Start', 'core.manualTrigger'), setNode('Set', 'done', 'yes')];
    const wf = await createWorkflow(client, { nodes, connections: chain('Start', 'Set') });
    const workflow = definitionOf(nodes, chain('Start', 'Set'), { saveDataSuccessExecution: 'none' });

    // the plan's concurrent limit stops every other mode
    await expect(
      server.ctx.executions.start({
        tenantId: tenant.id,
        workflow,
        workflowId: wf.id,
        mode: 'trigger',
        startNode: 'Start',
      }),
    ).rejects.toMatchObject({ statusCode: 429 });

    const { executionId, finished } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow,
      workflowId: wf.id,
      mode: 'evaluation',
      startNode: 'Start',
      pinData: { Start: [{ json: { question: 'q1' } }] },
      wait: true,
    });
    expect((await finished)?.status).toBe('success');
    const row = await server.ctx.repos.executions.get(tenant.id, executionId);
    expect(row).toMatchObject({ mode: 'evaluation', status: 'success' });
    // not billable
    const usage = await server.ctx.repos.usage.get(tenant.id, currentPeriod());
    expect(usage.executions).toBe(0);
  });

  it('drops a production run under saveDataSuccessExecution none (the evaluation exception is the only one)', async () => {
    const { client, tenant } = await signup(server.app);
    const nodes = [node('Start', 'core.manualTrigger'), setNode('Set', 'done', 'yes')];
    const wf = await createWorkflow(client, { nodes, connections: chain('Start', 'Set') });
    const { executionId, finished } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: definitionOf(nodes, chain('Start', 'Set'), { saveDataSuccessExecution: 'none' }),
      workflowId: wf.id,
      mode: 'trigger',
      startNode: 'Start',
      wait: true,
    });
    expect((await finished)?.status).toBe('success');
    expect(await server.ctx.repos.executions.get(tenant.id, executionId)).toBeUndefined();
  });

  it('passes chunk meta to observers and announces the end of a node run that sent chunks', async () => {
    const { client, tenant } = await signup(server.app);
    const nodes = [
      node('Start', 'core.manualTrigger'),
      node('Chunker', 'test.p5s3Chunker', {}, [200, 0]),
      setNode('Set', 'x', 1, [400, 0]),
    ];
    const wf = await createWorkflow(client, { nodes, connections: chain('Start', 'Chunker', 'Set') });
    const events: Array<{ kind: 'chunk' | 'end'; chunk?: unknown; meta?: ChatChunkMeta }> = [];
    const { finished } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: definitionOf(nodes, chain('Start', 'Chunker', 'Set')),
      workflowId: wf.id,
      mode: 'manual',
      startNode: 'Start',
      wait: true,
      observer: {
        onChunk: (chunk, meta) => events.push({ kind: 'chunk', chunk, meta }),
        onNodeRunEnd: (meta) => events.push({ kind: 'end', meta }),
      },
    });
    expect((await finished)?.status).toBe('success');
    const chunker = nodes[1];
    const meta = (itemIndex: number) => ({ nodeId: chunker.id, nodeName: 'Chunker', runIndex: 0, itemIndex });
    // one end, for the node run that sent chunks, after its chunks; Start and Set sent none
    expect(events).toEqual([
      { kind: 'chunk', chunk: 'a', meta: meta(0) },
      { kind: 'chunk', chunk: 'b', meta: meta(1) },
      { kind: 'end', meta: meta(1) },
    ]);
  });

  it('runNodeOperation returns the custom operation output and makes no execution row', async () => {
    const { client, tenant } = await signup(server.app);
    const nodes = [node('Source', 'test.p5s3Source'), setNode('Set', 'x', 1)];
    const wf = await createWorkflow(client, { nodes, connections: chain('Source', 'Set') });
    const definition = { ...definitionOf(nodes, chain('Source', 'Set')), id: wf.id };
    const items = await server.ctx.executions.runNodeOperation(
      tenant.id,
      definition,
      'Source',
      DATASET_GET_ROWS,
    );
    expect(items.map((i) => i.json)).toEqual([{ row: 0 }, { row: 1 }]);
    await expect(
      server.ctx.executions.runNodeOperation(tenant.id, definition, 'Source', 'dataset.nope'),
    ).rejects.toThrow(/has no operation "dataset.nope"/);
    expect(await executionsOf(server.ctx, tenant.id)).toHaveLength(0);
    const usage = await server.ctx.repos.usage.get(tenant.id, currentPeriod());
    expect(usage.executions).toBe(0);
  });
});

describe('webhooks', () => {
  it('supplies sub-nodes to the webhook context and stores its customData on the execution', async () => {
    const { client, tenant } = await signup(server.app);
    const nodes = [
      node('Hook', 'test.p5s3Hook', {}, [0, 0], { webhookId: 'p5s3-hook' }),
      node('Memory', 'test.p5s3Memory', {}, [0, 200]),
      setNode('Set', 'seen', '={{ $json.sessionId }}'),
    ];
    const wf = await createWorkflow(client, {
      nodes,
      connections: {
        Hook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        Memory: { ai_memory: [[{ node: 'Hook', type: 'ai_memory', index: 0 }]] },
      },
    });
    const listen = await client.data(
      client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Hook' }),
    );
    expect(listen.chatTestToken).toBeUndefined();
    const res = await server.app.inject({
      method: 'POST',
      url: new URL(listen.testUrl).pathname,
      payload: { sessionId: 's-42' },
    });
    expect(res.statusCode).toBeLessThan(300);
    // the sub-node read the request body, and was closed once the webhook answered
    expect(closed).toEqual(['s-42']);
    const row = await waitFor(
      async () => {
        const [first] = await executionsOf(server.ctx, tenant.id, wf.id);
        return first?.status === 'success' ? first : undefined;
      },
      { message: 'the hook execution' },
    );
    const saved = await server.ctx.repos.executions.get(tenant.id, row.id);
    expect(saved?.customData).toEqual({ sessionId: 's-42', source: 'hook' });
  });
});

describe('listen for a test event', () => {
  it('returns a chatTestToken bound to a fresh listenId for a chat trigger, and none for a webhook', async () => {
    const { client, tenant } = await signup(server.app);
    const nodes = [
      node('Chat', 'ai.chatTrigger', {}, [0, 0], { webhookId: 'p5s3-chat' }),
      node('Webhook', 'core.webhook', { httpMethod: 'POST', path: 'p5s3-plain' }, [0, 300], {
        webhookId: 'p5s3-plain',
      }),
      setNode('Set', 'x', 1),
    ];
    const wf = await createWorkflow(client, { nodes, connections: chain('Chat', 'Set') });
    const listen = (body: DataObject) =>
      client.data(client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, body));

    const first = await listen({ nodeName: 'Chat', destinationNode: 'Set' });
    expect(typeof first.chatTestToken).toBe('string');
    const payload = server.ctx.formTokens.verify(first.chatTestToken);
    expect(payload).toMatchObject({
      kind: CHAT_TOKEN_KINDS.test,
      tenantId: tenant.id,
      workflowId: wf.id,
      node: 'Chat',
    });
    // verify() drops `exp` from the payload it returns, so read it from the signed body
    const signedBody = JSON.parse(
      Buffer.from(String(first.chatTestToken).split('.')[0], 'base64url').toString(),
    ) as { exp?: unknown };
    expect(typeof signedBody.exp).toBe('number');
    const ttlLeft = Number(signedBody.exp) - Math.floor(Date.now() / 1000);
    expect(ttlLeft).toBeGreaterThan(0);
    expect(ttlLeft).toBeLessThanOrEqual(CHAT_TEST_TOKEN_TTL_S);
    const registrations = (await server.ctx.testWebhooks.list(tenant.id)).filter(
      (r) => r.nodeName === 'Chat',
    );
    expect(registrations.length).toBeGreaterThan(0);
    for (const r of registrations) {
      expect(r.listenId).toBe(payload?.listenId);
      expect(r.destinationNode).toBe('Set');
    }

    // a second listen replaces the registration with a new id
    const second = await listen({ nodeName: 'Chat' });
    const again = server.ctx.formTokens.verify(second.chatTestToken);
    expect(again?.listenId).not.toBe(payload?.listenId);
    const now = (await server.ctx.testWebhooks.list(tenant.id)).filter((r) => r.nodeName === 'Chat');
    expect(now.every((r) => r.listenId === again?.listenId && r.destinationNode === undefined)).toBe(true);

    const plain = await listen({ nodeName: 'Webhook' });
    expect(plain.testUrl).toContain('/webhook-test/');
    expect('chatTestToken' in plain).toBe(false);
    expect(
      (await server.ctx.testWebhooks.list(tenant.id)).find((r) => r.nodeName === 'Webhook')?.listenId,
    ).toBeUndefined();

    const unknown = await client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, {
      nodeName: 'Chat',
      destinationNode: 'Nope',
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('data tables', () => {
  it('addColumn adds a last column and stays in its tenant', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const table = await server.ctx.dataTables.create(a.tenant.id, {
      name: 'cases',
      columns: [{ name: 'question', type: 'string' }],
      projectId: await teamProjectOf(server, a.tenant.id),
    });
    const access = server.ctx.dataTables.forProject(a.tenant.id, await teamProjectOf(server, a.tenant.id));
    const added = await access.addColumn(table.id, { name: 'score', type: 'number' });
    expect(added).toMatchObject({ name: 'score', type: 'number' });
    expect((await access.listColumns(table.id)).map((c) => c.name)).toEqual(['question', 'score']);
    await expect(access.addColumn(table.id, { name: 'score', type: 'number' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      server.ctx.dataTables
        .forProject(b.tenant.id, await teamProjectOf(server, b.tenant.id))
        .addColumn(table.id, { name: 'other', type: 'string' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await access.listColumns(table.id)).map((c) => c.name)).toEqual(['question', 'score']);
  });
});

describe('routes', () => {
  it('never answers /chat-widget with the SPA fallback', async () => {
    // the bundle holds "<!doctype html>" as text (its markdown library), so the body's start is what counts
    for (const [url, type] of [
      ['/chat-widget/chat.js', 'javascript'],
      ['/chat-widget/chat.css', 'text/css'],
      ['/chat-widget', undefined],
    ] as const) {
      const res = await server.app.inject({ method: 'GET', url, headers: { accept: 'text/html,*/*' } });
      const contentType = String(res.headers['content-type'] ?? '');
      expect(contentType, url).not.toContain('text/html');
      // a file is served with its own type; a missing build answers the JSON "not available"
      if (type) expect(contentType, url).toContain(res.statusCode === 200 ? type : 'application/json');
      expect(res.body.trim().toLowerCase().startsWith('<!doctype'), url).toBe(false);
    }
  });

  it('registers the 7 evaluation routes under /rest, behind the session', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const base = `/rest/workflows/${id}/test-runs`;
    const routes: Array<['GET' | 'POST' | 'DELETE', string]> = [
      ['GET', base],
      ['POST', `${base}/new`],
      ['GET', `${base}/${id}`],
      ['GET', `${base}/${id}/test-cases`],
      ['DELETE', `${base}/${id}`],
      ['POST', `${base}/${id}/cancel`],
      ['POST', `${base}/${id}/test-cases/${id}/cancel`],
    ];
    for (const [method, url] of routes) {
      const res = await server.app.inject({
        method,
        url,
        headers:
          method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : { origin: ORIGIN },
        payload: method === 'POST' ? '{}' : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    // ids are checked before the service runs
    const { client } = await signup(server.app);
    expect((await client.get('/rest/workflows/not-a-uuid/test-runs')).statusCode).toBe(400);
    // P6-38: the scope is checked on the workflow first, so an unknown workflow is 404 before the body check
    expect((await client.post(`${base}/new`, { concurrency: 11 })).statusCode).toBe(404);
  });

  it('PUBLIC_EVALUATION_ROUTES holds the 5 rows with their key scopes and workflow access, spread into PUBLIC_ROUTES', () => {
    const rows = Object.fromEntries(
      PUBLIC_EVALUATION_ROUTES.map((r) => [
        `${r.method} ${r.path}`,
        [r.scope, 'scope' in r.access ? r.access.scope : null, r.response],
      ]),
    );
    expect(rows).toEqual({
      'GET /workflows/:workflowId/test-runs': ['testRun:list', 'workflow:read', 'TestRun'],
      'POST /workflows/:workflowId/test-runs': ['testRun:create', 'workflow:execute', 'TestRun'],
      'GET /workflows/:workflowId/test-runs/:runId': ['testRun:read', 'workflow:read', 'TestRun'],
      'GET /workflows/:workflowId/test-runs/:runId/test-cases': ['testRun:read', 'workflow:read', 'TestCase'],
      'POST /workflows/:workflowId/test-runs/:runId/cancel': ['testRun:cancel', 'workflow:execute', 'Ok'],
    });
    expect(PUBLIC_EVALUATION_ROUTES.every((r) => r.tag === 'Evaluations')).toBe(true);
    expect(
      PUBLIC_EVALUATION_ROUTES.find((r) => r.method === 'POST' && !r.path.endsWith('/cancel'))?.status,
    ).toBe(201);
    expect(PUBLIC_ROUTES.filter((r) => r.tag === 'Evaluations')).toHaveLength(5);
    expect(API_KEY_SCOPES).toEqual(
      expect.arrayContaining(['testRun:list', 'testRun:create', 'testRun:read', 'testRun:cancel']),
    );
  });

  it('gates the public evaluation routes by key and scope before any handler', async () => {
    const { client } = await signup(server.app);
    const url = '/api/v1/workflows/00000000-0000-4000-8000-000000000000/test-runs';
    expect((await server.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const key = await client.data(client.post('/rest/api-keys', { name: 'tags only', scopes: ['tag:list'] }));
    const refused = await server.app.inject({ method: 'GET', url, headers: { 'x-api-key': key.key } });
    expect(refused.statusCode).toBe(403);
  });

  it('the OpenAPI document has TestRun and TestCase, the test-run paths, and 201 on create', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    const schemas = doc.components.schemas;
    expect(Object.keys(schemas.TestRun.properties)).toEqual([
      'id',
      'workflowId',
      'status',
      'runAt',
      'completedAt',
      'metrics',
      'errorCode',
      'errorDetails',
      'concurrency',
      'finalResult',
      'caseCounts',
      'createdAt',
      'updatedAt',
    ]);
    expect(Object.keys(schemas.TestCase.properties)).toEqual([
      'id',
      'testRunId',
      'executionId',
      'status',
      'runIndex',
      'runAt',
      'completedAt',
      'errorCode',
      'errorDetails',
      'metrics',
      'inputs',
      'outputs',
    ]);
    const runs = doc.paths['/workflows/{workflowId}/test-runs'];
    expect(runs.get.tags).toEqual(['Evaluations']);
    expect(Object.keys(runs.post.responses)).toContain('201');
    expect(doc.paths['/workflows/{workflowId}/test-runs/{runId}/test-cases'].get).toBeDefined();
    const refs = [...res.body.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    for (const name of new Set(refs)) expect(schemas[name], name).toBeDefined();
  });
});
