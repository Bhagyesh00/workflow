/**
 * P6 S5 (C0c): the server contracts of commit 0. `API_KEY_SCOPES` gains the six `eventBusDestination:*` scopes and
 * `otel:manage` after `insights:read`; every new public row has `access` and a key `scope`, and its answer is named
 * in the OpenAPI components; every new REST route answers at its final path with its gate (a stub's answer is not
 * checked, only that the path exists and the gate holds) and a true member gets 403 on list and test; the context
 * builds and closes with the new services; `EventStream` builds no payload when no sink accepts, keeps the emit
 * order and survives a throwing sink; `LifecycleObservers` survives a throwing observer; `forTenant` (FULL); the
 * METRICS_* defaults are n8n's; `ctx.metrics` got `config.metrics`; a blocked request reaches `metrics.onGuard`;
 * a closed context's audit listener is gone while a live one still gets rows; the queue's job events and
 * `jobCounts` (FULL); the three C0 validators pass settings valid under n8n's rules.
 * Fixed fake values only: no header value is ever printed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodesBasePackage } from '@workflow/nodes-base';
import { type DataObject, SCOPES } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { packageDir } from '../src/config';
import { createContext, type ServiceDeps } from '../src/context';
import { API_KEY_SCOPES } from '../src/http/api-key-scopes';
import type { ApiRoute } from '../src/routes/public-api';
import { PUBLIC_LOG_STREAMING_ROUTES } from '../src/routes/public-log-streaming';
import { PUBLIC_OTEL_ROUTES } from '../src/routes/public-otel';
import { handleAuditEntry } from '../src/services/events/audit-events';
import { type EventSink, EventStream, type StreamEvent } from '../src/services/events/stream';
import { validateSentrySettings } from '../src/services/log-streaming/destinations/sentry';
import { validateSyslogSettings } from '../src/services/log-streaming/destinations/syslog';
import { validateWebhookSettings } from '../src/services/log-streaming/destinations/webhook';
import { LogStreamingManager } from '../src/services/log-streaming/manager';
import { type LifecycleObserver, LifecycleObservers } from '../src/services/observability/lifecycle';
import { ExecutionQueue, type QueueEventListener } from '../src/services/queue';
import { OtelSettingsService, otelHeadersBinding } from '../src/services/tracing/settings';
import { TracingService } from '../src/services/tracing/tracer';
import {
  createTestServer,
  ORIGIN,
  realMember,
  signup,
  TEST_REDIS,
  TestClient,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
} from './helpers';

// the audit listener's target, so the test sees which context's listener ran (a no-op, as the C0 stub)
vi.mock('../src/services/events/audit-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/events/audit-events')>();
  return { ...actual, handleAuditEntry: vi.fn() };
});

let server: TestServer;
let binaryDir: string;

beforeAll(async () => {
  server = await createTestServer();
  binaryDir = await mkdtemp(path.join(tmpdir(), 'wf-p6s5-config-'));
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (binaryDir) await rm(binaryDir, { recursive: true, force: true });
});

const ROUTER_404 = /^Route .* not found$/;
const MISSING_SCOPE = 'User is missing a scope required to perform this action';

const S5_KEY_SCOPES = [
  'eventBusDestination:list',
  'eventBusDestination:read',
  'eventBusDestination:create',
  'eventBusDestination:update',
  'eventBusDestination:test',
  'eventBusDestination:delete',
  'otel:manage',
];

const S5_PUBLIC_ROWS: Record<string, ApiRoute[]> = { PUBLIC_LOG_STREAMING_ROUTES, PUBLIC_OTEL_ROUTES };

async function keyFor(client: TestClient, scopes?: string[]) {
  const body: Record<string, unknown> = { name: `p6s5-${randomUUID().slice(0, 8)}` };
  if (scopes) body.scopes = scopes;
  const key = await client.data<{ key: string }>(client.post('/rest/api-keys', body));
  return key.key;
}

describe('P6 S5 API key scopes', () => {
  it('the seven scopes sit right after insights:read, each once', () => {
    const at = API_KEY_SCOPES.indexOf('insights:read');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(API_KEY_SCOPES.slice(at + 1)).toEqual(S5_KEY_SCOPES);
    expect(API_KEY_SCOPES).toHaveLength(90);
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
    for (const scope of S5_KEY_SCOPES) expect(SCOPES as readonly string[]).toContain(scope);
  });
});

describe('P6 S5 public rows', () => {
  it('every new public row has `access` with its scope and the same key scope', () => {
    for (const [name, rows] of Object.entries(S5_PUBLIC_ROWS)) {
      for (const row of rows) {
        const label = `${name} ${row.method} ${row.path}`;
        expect(row.access, label).toBeDefined();
        expect(typeof row.handler, label).toBe('function');
        expect(row.anyKey, label).toBeUndefined();
        expect('scope' in row.access, label).toBe(true);
        const userScope = 'scope' in row.access ? row.access.scope : undefined;
        expect(userScope, label).toBe(row.scope);
        expect(SCOPES as readonly string[], label).toContain(userScope);
        expect(API_KEY_SCOPES as readonly string[], label).toContain(row.scope);
      }
    }
  });

  it('the rows sit at their final paths with their scopes', () => {
    const summary = (rows: ApiRoute[]) => rows.map((r) => `${r.method} ${r.path} ${r.scope}`);
    expect(summary(PUBLIC_LOG_STREAMING_ROUTES)).toEqual([
      'GET /settings/log-streaming/event-types eventBusDestination:list',
      'GET /settings/log-streaming/destinations eventBusDestination:list',
      'GET /settings/log-streaming/destinations/:id eventBusDestination:read',
      'POST /settings/log-streaming/destinations eventBusDestination:create',
      'PUT /settings/log-streaming/destinations/:id eventBusDestination:update',
      'DELETE /settings/log-streaming/destinations/:id eventBusDestination:delete',
      'POST /settings/log-streaming/destinations/:id/test eventBusDestination:test',
    ]);
    expect(summary(PUBLIC_OTEL_ROUTES)).toEqual([
      'GET /settings/otel otel:manage',
      'PUT /settings/otel otel:manage',
      'POST /settings/otel/test-trace otel:manage',
    ]);
  });

  it('the OpenAPI document names every S5 answer and the two new tags', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    const schemas = doc.components.schemas as Record<string, unknown>;
    for (const name of [
      'LogStreamingDestination',
      'LogStreamingEventTypes',
      'LogStreamingTestResult',
      'OtelSettings',
      'OtelTestTraceResult',
    ]) {
      expect(schemas[name], name).toBeDefined();
    }
    const names = new Set(Object.values(S5_PUBLIC_ROWS).flatMap((rows) => rows.map((r) => r.response)));
    for (const name of names) expect(schemas[name], name).toBeDefined();
    const tags = (doc.tags as Array<{ name: string }>).map((t) => t.name);
    expect(tags).toEqual(expect.arrayContaining(['LogStreaming', 'OpenTelemetry']));
    // P6-67: the public project answer carries the project's telemetry tags on detail rows
    const project = schemas.Project as { properties: Record<string, unknown> };
    expect(project.properties.customTelemetryTags).toMatchObject({
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } },
    });
  });

  it('every new public row answers at its path for a full key and refuses a key without its scope', async () => {
    const owner = await signup(server.app);
    const full = await keyFor(owner.client);
    const narrow = await keyFor(owner.client, ['tag:list']);
    const id = randomUUID();
    const call = (method: string, url: string, key: string) =>
      server.app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        headers: { 'x-api-key': key },
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
      });
    for (const row of [...PUBLIC_LOG_STREAMING_ROUTES, ...PUBLIC_OTEL_ROUTES]) {
      const url = row.path.replace(':id', id);
      const res = await call(row.method, url, full);
      const message = res.statusCode === 404 ? (res.json().error?.message ?? res.json().message ?? '') : '';
      expect(message, `${row.method} ${url}`).not.toMatch(ROUTER_404);
      expect(res.statusCode, `${row.method} ${url}`).not.toBe(403);
      expect((await call(row.method, url, narrow)).statusCode, `${row.method} ${url} narrow`).toBe(403);
    }
  });
});

describe('P6 S5 REST routes', () => {
  const id = randomUUID();
  const REST: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
    ['GET', '/eventbus/eventnames'],
    ['GET', '/eventbus/destination'],
    ['GET', `/eventbus/destination?id=${id}`],
    ['POST', '/eventbus/destination'],
    ['DELETE', `/eventbus/destination?id=${id}`],
    ['POST', `/eventbus/testmessage?id=${id}`],
    ['GET', '/otel/settings'],
    ['PUT', '/otel/settings'],
    ['POST', '/otel/test-trace'],
  ];
  const bodyOf = (method: string) => (method === 'GET' || method === 'DELETE' ? undefined : {});

  it('every new REST route answers at its final path (never the router 404) and lets the owner through', async () => {
    const owner = await signup(server.app);
    for (const [method, p] of REST) {
      const res = await owner.client.request(method, `/rest${p}`, bodyOf(method));
      const body = res.statusCode === 404 ? res.json() : undefined;
      expect(body?.error?.message ?? '', `${method} ${p}`).not.toMatch(ROUTER_404);
      expect(res.statusCode, `${method} ${p}`).not.toBe(403);
      expect(res.statusCode, `${method} ${p}`).not.toBe(401);
    }
  });

  it('a signed-out caller gets 401 on every new REST route', async () => {
    const anonymous = new TestClient(server.app, ORIGIN);
    for (const [method, p] of REST) {
      const res = await anonymous.request(method, `/rest${p}`, bodyOf(method));
      expect(res.statusCode, `${method} ${p}`).toBe(401);
    }
  });

  it('a true member gets 403 on every new REST route, list and test included', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    for (const [method, p] of REST) {
      const res = await member.client.request(method, `/rest${p}`, bodyOf(method));
      expect(res.statusCode, `${method} ${p}`).toBe(403);
      expect(res.json().error.message, `${method} ${p}`).toBe(MISSING_SCOPE);
    }
  });
});

describe('P6 S5 config', () => {
  const config = (env: Record<string, string> = {}) => testConfig({ BINARY_DATA_DIR: binaryDir, ...env });

  it("the METRICS_* defaults are n8n's", () => {
    expect(config().metrics).toEqual({
      includeDefaultMetrics: true,
      includeWorkflowIdLabel: false,
      includeWorkflowNameLabel: false,
      includeNodeTypeLabel: false,
      includeCredentialTypeLabel: false,
      includeApiEndpoints: false,
      includeApiPathLabel: false,
      includeApiMethodLabel: false,
      includeApiStatusCodeLabel: false,
      includeMessageEventBusMetrics: false,
      includeQueueMetrics: false,
      includeSchedulerMetrics: false,
      includePollTriggerMetrics: false,
      includeWorkflowStatistics: false,
      includeSsrfMetrics: false,
      includeDnsCacheMetrics: false,
      includeWebhookMetrics: false,
      includeFormMetrics: false,
      includeDbPoolMetrics: false,
      includeWorkflowExecutionDuration: true,
      queueMetricsInterval: 20,
      schedulerInterval: 20,
      activeWorkflowCountInterval: 60,
      workflowStatisticsInterval: 300,
    });
  });

  it('the toggles and intervals take their envs', () => {
    const metrics = config({
      METRICS_INCLUDE_DEFAULT_METRICS: 'false',
      METRICS_INCLUDE_WEBHOOK_METRICS: 'true',
      METRICS_QUEUE_METRICS_INTERVAL: '5',
    }).metrics;
    expect(metrics.includeDefaultMetrics).toBe(false);
    expect(metrics.includeWebhookMetrics).toBe(true);
    expect(metrics.queueMetricsInterval).toBe(5);
  });

  it('environment comes from ENVIRONMENT and version from the server package.json', async () => {
    expect(config().environment).toBeUndefined();
    expect(config({ ENVIRONMENT: 'staging' }).environment).toBe('staging');
    const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(config().version).toBe(pkg.version);
  });
});

describe('P6 S5 context', () => {
  it('the server context holds the S5 services, with the metrics built from config.metrics', () => {
    const { ctx } = server;
    expect(ctx.events).toBeInstanceOf(EventStream);
    expect(ctx.observers).toBeInstanceOf(LifecycleObservers);
    expect(ctx.logStreaming).toBeInstanceOf(LogStreamingManager);
    expect(ctx.otelSettings).toBeInstanceOf(OtelSettingsService);
    expect(ctx.tracing).toBeInstanceOf(TracingService);
    expect(typeof ctx.tracingObserver.headersFor).toBe('function');
    expect(ctx.instance.role).toBe('main');
    expect(ctx.instance.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.metrics.options.toggles).toEqual(ctx.config.metrics);
    expect(ctx.metrics.options.version).toBe(ctx.config.version);
    expect(ctx.repos.logDestinations).toBeDefined();
    expect(ctx.repos.logStreamFailed).toBeDefined();
    expect(ctx.repos.otelSettings).toBeDefined();
  });

  it('the log streaming manager registers the three destination types, and a later register replaces one', () => {
    const types = (server.ctx.logStreaming as unknown as { types: Map<string, unknown> }).types;
    expect([...types.keys()].sort()).toEqual(['sentry', 'syslog', 'webhook']);
    const manager = new LogStreamingManager(server.ctx.serviceDeps);
    const entry = { create: () => ({ send: async () => {} }), validate: () => null };
    manager.registerType('webhook', entry);
    expect((manager as unknown as { types: Map<string, unknown> }).types.get('webhook')).toBe(entry);
  });

  it('a blocked request through ctx.http reaches metrics.onGuard', () => {
    const spy = vi.spyOn(server.ctx.metrics, 'onGuard');
    try {
      expect(() => server.ctx.http.assertUrlAllowed('http://10.0.0.1/')).toThrow();
      expect(spy).toHaveBeenCalledWith({ kind: 'check', allowed: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('a context builds and closes; its audit listener goes while a live context still gets rows', async () => {
    const owner = await signup(server.app);
    const handler = vi.mocked(handleAuditEntry);
    const other = await createContext({
      config: testConfig({ BINARY_DATA_DIR: binaryDir }),
      nodePackages: [nodesBasePackage, testPackage],
    });
    let closed = false;
    try {
      const contextOf = (deps: ServiceDeps) => deps.context();
      const seen = (action: string) =>
        handler.mock.calls.filter(([, , entry]) => entry.action === action).map(([deps]) => contextOf(deps));

      // compared by identity (a context is too big and circular for a deep compare)
      const both = `p6s5.contract.${randomUUID().slice(0, 8)}`;
      await server.ctx.repos.audit.add(owner.tenant.id, { action: both });
      expect(seen(both).includes(server.ctx)).toBe(true);
      expect(seen(both).includes(other)).toBe(true);

      await other.close();
      closed = true;
      const after = `p6s5.contract.${randomUUID().slice(0, 8)}`;
      await server.ctx.repos.audit.add(owner.tenant.id, { action: after });
      expect(seen(after).includes(server.ctx)).toBe(true);
      expect(seen(after).includes(other)).toBe(false);
    } finally {
      if (!closed) await other.close();
    }
  }, 120_000);
});

describe('P6 S5 OtelSettingsService.forTenant (FULL)', () => {
  it('null with no row and with a disabled row; decrypted headers with an enabled one', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const { ctx } = server;
    expect(await ctx.otelSettings.forTenant(tenantId)).toBeNull();
    expect(await ctx.otelSettings.forTenant(randomUUID())).toBeNull();

    const exporterHeadersEnc = ctx.cipher.encrypt(
      'x-fake-key=fake-value-1, x-other = fake-value-2',
      otelHeadersBinding(tenantId),
    );
    await ctx.repos.otelSettings.upsert(tenantId, {
      enabled: false,
      exporterEndpoint: 'https://collector.example.test',
      exporterHeadersEnc,
    });
    expect(await ctx.otelSettings.forTenant(tenantId)).toBeNull();

    await ctx.repos.otelSettings.upsert(tenantId, { enabled: true, tracesSampleRate: 0.5 });
    const settings = await ctx.otelSettings.forTenant(tenantId);
    expect(settings).not.toBeNull();
    expect(settings?.tenantId).toBe(tenantId);
    expect(settings?.exporterEndpoint).toBe('https://collector.example.test');
    expect(settings?.exporterProtocol).toBe('http/protobuf');
    expect(settings?.tracesSampleRate).toBe(0.5);
    expect(settings?.headers).toEqual({ 'x-fake-key': 'fake-value-1', 'x-other': 'fake-value-2' });
    expect(settings && 'exporterHeaders' in settings).toBe(false);

    // another tenant's binding cannot open the payload
    const other = await signup(server.app);
    await ctx.repos.otelSettings.upsert(other.tenant.id, { enabled: true, exporterHeadersEnc });
    await expect(ctx.otelSettings.forTenant(other.tenant.id)).rejects.toThrow();
  });
});

describe('P6 S5 EventStream (FULL)', () => {
  const logger = () => ({ warn: vi.fn() });
  const recorder = (accept: (tenantId: string, name: string) => boolean = () => true) => {
    const events: StreamEvent[] = [];
    const sink: EventSink = { accepts: accept, deliver: (e) => events.push(e) };
    return { sink, events };
  };

  it('builds no payload when no sink accepts', async () => {
    const stream = new EventStream(logger());
    const build = vi.fn(() => ({ secret: 'never built' }));
    stream.emit('t1', 'workflow.started', build);
    const { sink, events } = recorder(() => false);
    stream.addSink(sink);
    stream.emit('t1', 'workflow.started', build);
    await stream.flush();
    expect(build).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('delivers in emit order, an async payload holding later events back', async () => {
    const stream = new EventStream(logger());
    const { sink, events } = recorder();
    stream.addSink(sink);
    let release: (value: DataObject) => void = () => {};
    stream.emit('t1', 'a', { n: 1 });
    stream.emit('t1', 'b', () => new Promise<DataObject>((resolve) => (release = resolve)));
    stream.emit('t1', 'c', { n: 3 });
    stream.emit('t1', 'd', () => ({ n: 4 }));
    expect(events.map((e) => e.eventName)).toEqual(['a']);
    release({ n: 2 });
    await stream.flush();
    expect(events.map((e) => e.eventName)).toEqual(['a', 'b', 'c', 'd']);
    expect(events.map((e) => e.payload.n)).toEqual([1, 2, 3, 4]);
    const [first] = events;
    expect(first.tenantId).toBe('t1');
    expect(first.message).toBe('a');
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
  });

  it('asks each sink per tenant and event, and survives a throwing sink or payload', async () => {
    const log = logger();
    const stream = new EventStream(log);
    const onlyT2 = recorder((tenantId) => tenantId === 't2');
    const all = recorder();
    stream.addSink({
      accepts: () => {
        throw new Error('accepts failed');
      },
      deliver: () => {},
    });
    stream.addSink({
      accepts: () => true,
      deliver: () => {
        throw new Error('deliver failed');
      },
    });
    const remove = stream.addSink(onlyT2.sink);
    stream.addSink(all.sink);
    expect(() => stream.emit('t1', 'x', { n: 1 })).not.toThrow();
    expect(() => stream.emit('t2', 'y', { n: 2 })).not.toThrow();
    expect(() =>
      stream.emit('t2', 'z', () => {
        throw new Error('payload failed');
      }),
    ).not.toThrow();
    stream.emit('t2', 'w', async () => {
      throw new Error('async payload failed');
    });
    remove();
    stream.emit('t2', 'v', { n: 5 });
    await stream.flush();
    expect(onlyT2.events.map((e) => e.eventName)).toEqual(['y']);
    expect(all.events.map((e) => e.eventName)).toEqual(['x', 'y', 'v']);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('P6 S5 LifecycleObservers (FULL)', () => {
  it('calls the observers in order, awaited, and survives a throwing or rejecting observer', async () => {
    const log = { warn: vi.fn() };
    const observers = new LifecycleObservers(log);
    const calls: string[] = [];
    const failing: LifecycleObserver = {
      runStart: () => {
        throw new Error('sync failure');
      },
    };
    const rejecting: LifecycleObserver = { runStart: async () => Promise.reject(new Error('async failure')) };
    const slow: LifecycleObserver = {
      runStart: async () => {
        await new Promise((r) => setTimeout(r, 10));
        calls.push('slow');
      },
    };
    const last: LifecycleObserver = {
      runStart: () => void calls.push('last'),
      runEnd: () => void calls.push('end'),
    };
    observers.add(failing);
    observers.add(rejecting);
    observers.add(slow);
    observers.add({});
    observers.add(last);
    const scope = {
      tenantId: randomUUID(),
      executionId: randomUUID(),
      row: {
        mode: 'manual',
        workflowId: null,
        parentExecutionId: null,
        retryOf: null,
        startedAt: null,
        stoppedAt: null,
      },
      definition: { nodes: [], connections: {} } as never,
      options: {},
      kind: 'run' as const,
    };
    await expect(observers.runStart(scope)).resolves.toBeUndefined();
    expect(calls).toEqual(['slow', 'last']);
    expect(log.warn).toHaveBeenCalledTimes(2);
    observers.remove(last);
    await observers.runEnd({
      ...scope,
      status: 'success',
      redaction: { production: false, manual: false },
      redacted: false,
    });
    expect(calls).toEqual(['slow', 'last']);
  });
});

describe('P6 S5 ExecutionQueue events and jobCounts (FULL)', () => {
  it('reports enqueued, dequeued and completed, counts waiting jobs, and a throwing listener changes nothing', async () => {
    const seen: string[] = [];
    const events: QueueEventListener = {
      enqueued: (job) => {
        seen.push(`enqueued:${job.executionId}`);
        throw new Error('listener failure');
      },
      dequeued: (job) => void seen.push(`dequeued:${job.executionId}`),
      completed: (job) => void seen.push(`completed:${job.executionId}`),
      failed: (job) => void seen.push(`failed:${job.executionId}`),
      stalled: (jobId) => void seen.push(`stalled:${jobId}`),
    };
    const queue = new ExecutionQueue(TEST_REDIS, `p6s5-c0-${randomUUID().slice(0, 8)}`, events);
    try {
      const executionId = randomUUID();
      await queue.enqueue({ executionId, tenantId: randomUUID(), kind: 'run' });
      expect(seen).toEqual([`enqueued:${executionId}`]);
      expect(await queue.jobCounts()).toEqual({ waiting: 1, active: 0 });
      const ran: string[] = [];
      queue.startWorker(async (job) => void ran.push(job.executionId), 1);
      await waitFor(async () => seen.includes(`completed:${executionId}`), {
        message: 'the completed event',
      });
      expect(ran).toEqual([executionId]);
      expect(seen).toEqual([
        `enqueued:${executionId}`,
        `dequeued:${executionId}`,
        `completed:${executionId}`,
      ]);
      expect(await queue.jobCounts()).toEqual({ waiting: 0, active: 0 });
    } finally {
      await queue.close();
    }
  }, 60_000);
});

describe('P6 S5 destination validators (PASS until L4, L5, L6)', () => {
  it("settings valid under n8n's rules pass each validator", () => {
    expect(
      validateWebhookSettings({
        url: 'https://hooks.example.test/events',
        method: 'POST',
        sendQuery: false,
        queryParameters: [],
        sendHeaders: false,
        headerParameters: [],
        sendPayload: true,
        responseCodeMustMatch: false,
        expectedStatusCode: 200,
        options: {
          allowUnauthorizedCerts: false,
          queryParameterArrays: 'brackets',
          redirect: { followRedirects: false, maxRedirects: 21 },
          timeout: 5000,
        },
      }),
    ).toBeNull();
    expect(
      validateSyslogSettings({
        host: 'logs.example.test',
        port: 514,
        protocol: 'udp',
        facility: 16,
        app_name: 'workflow',
        eol: '\n',
      }),
    ).toBeNull();
    expect(
      validateSentrySettings({ dsn: 'https://fakepublickey@o0.ingest.example.test/1', sendPayload: true }),
    ).toBeNull();
  });
});
