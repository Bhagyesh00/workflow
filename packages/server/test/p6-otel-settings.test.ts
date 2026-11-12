/**
 * P6-67 (S5 L11): a workspace's OpenTelemetry settings, REST (/rest/otel) and public (/api/v1/settings/otel).
 * Saved header values reach the tenant's fake collector and never appear in a GET, a public GET, an audit row or a
 * log line; a blank value keeps the stored one only while scheme, host and port stay the same; headers over plain
 * http:// are refused; a member is 403; a key with `otel:manage` works and a narrow key is 403; another workspace's
 * settings are unreachable; the per-process cache follows saves and the `otel:reload` bus message. Fixed fake
 * values only; nothing captured is printed. The collector fakes sit on 127.0.0.1 (the test server allows it).
 */
import { randomUUID } from 'node:crypto';
import tls from 'node:tls';
import type { OtelSettings } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '../src/repositories';
import { loadTlsFixtures } from './fakes/http-sink';
import { type OtlpCollector, startOtlpCollector } from './fakes/otlp';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  realMember,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

const MISSING = 'User is missing a scope required to perform this action';
const KEY_VALUE = 'fake-otlp-key-l11-aaaa';
const TOKEN_VALUE = 'fake-otlp-token-l11-bbbb';
const NEW_VALUE = 'fake-otlp-new-l11-cccc';
const SECRETS = [KEY_VALUE, TOKEN_VALUE, NEW_VALUE];

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;
let member: Awaited<ReturnType<typeof realMember>>;
let collector: OtlpCollector;
let other: OtlpCollector;
let ip = 1;
let keyCount = 0;
const systemCas = tls.getCACertificates('default');

const world = () => signup(server.app, { remoteAddress: `127.6.5.${(ip++ % 250) + 1}` });
type Who = { client: Awaited<ReturnType<typeof signup>>['client'] };

/** the settings body of a save: https collector, the two fake headers */
const body = (over: Partial<OtelSettings> = {}): OtelSettings => ({
  enabled: true,
  exporterProtocol: 'http/protobuf',
  exporterEndpoint: collector.url,
  exporterTracingPath: '/v1/traces',
  exporterServiceName: 'my-service',
  exporterHeaders: `X-Api-Key=${KEY_VALUE},Authorization=${TOKEN_VALUE}`,
  tracesSampleRate: 1,
  startupConnectivityTimeoutMs: 0,
  includeNodeSpans: true,
  emitWorkflowStartSpan: false,
  emitNodeStartSpan: false,
  injectOutbound: true,
  productionExecutionsOnly: false,
  ...over,
});

const put = (w: Who, payload: unknown) => w.client.put('/rest/otel/settings', payload);
const dataOf = <T>(res: { json(): any }) => res.json().data as T;
const noSecret = (text: string) => {
  for (const secret of SECRETS) expect(text.includes(secret)).toBe(false);
};

async function keyOf(w: Who, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await w.client.data(
    w.client.post('/rest/api-keys', {
      name: `otel-${keyCount}-${randomUUID().slice(0, 6)}`,
      ...(scopes ? { scopes } : {}),
    }),
  );
  return made.key as string;
}

const api = (key: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

beforeAll(async () => {
  const fixtures = loadTlsFixtures();
  tls.setDefaultCACertificates([...systemCas, fixtures.ca]);
  collector = await startOtlpCollector({ tls: { key: fixtures.key, cert: fixtures.cert } });
  other = await startOtlpCollector({ tls: { key: fixtures.key, cert: fixtures.cert } });
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  owner = await world();
  member = await realMember(owner);
});
afterAll(async () => {
  tls.setDefaultCACertificates(systemCas);
  await server?.close();
  await collector?.close();
  await other?.close();
});

describe('GET and PUT /rest/otel/settings', () => {
  it('answers n8n defaults before anything is saved', async () => {
    const w = await world();
    const res = await w.client.get('/rest/otel/settings');
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<OtelSettings>(res)).toEqual({
      enabled: false,
      exporterProtocol: 'http/protobuf',
      exporterEndpoint: '',
      exporterTracingPath: '/v1/traces',
      exporterServiceName: 'workflow',
      exporterHeaders: '',
      tracesSampleRate: 1,
      startupConnectivityTimeoutMs: 2000,
      includeNodeSpans: true,
      emitWorkflowStartSpan: false,
      emitNodeStartSpan: false,
      injectOutbound: true,
      productionExecutionsOnly: true,
    });
  });

  it('saves a full replacement and answers every header as name= with the value blank', async () => {
    const w = await world();
    const saved = await put(w, body({ exporterServiceName: 'svc-one', tracesSampleRate: 0.5 }));
    expect(saved.statusCode, saved.body).toBe(200);
    expect(dataOf<OtelSettings>(saved)).toMatchObject({
      enabled: true,
      exporterEndpoint: collector.url,
      exporterServiceName: 'svc-one',
      exporterHeaders: 'X-Api-Key=,Authorization=',
      tracesSampleRate: 0.5,
    });
    noSecret(saved.body);
    const read = await w.client.get('/rest/otel/settings');
    expect(dataOf<OtelSettings>(read).exporterHeaders).toBe('X-Api-Key=,Authorization=');
    noSecret(read.body);

    // stored encrypted: the row holds no plain value, and forTenant decrypts it for the exporter only
    const row = await server.ctx.repos.otelSettings.get(w.tenant.id);
    expect(row?.exporterHeadersEnc).toBeTruthy();
    noSecret(JSON.stringify(row));
    const effective = await server.ctx.otelSettings.forTenant(w.tenant.id);
    expect(effective?.headers).toEqual({ 'X-Api-Key': KEY_VALUE, Authorization: TOKEN_VALUE });

    // a second save is a full replacement: a header left out is removed
    const second = await put(w, body({ exporterHeaders: 'X-Api-Key=' }));
    expect(second.statusCode, second.body).toBe(200);
    expect(dataOf<OtelSettings>(second).exporterHeaders).toBe('X-Api-Key=');
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.headers).toEqual({
      'X-Api-Key': KEY_VALUE,
    });
    const cleared = await put(w, body({ exporterHeaders: '' }));
    expect(dataOf<OtelSettings>(cleared).exporterHeaders).toBe('');
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.headers).toEqual({});
  });

  it('a member is 403 on every route; the same text for a signed-out call is not given', async () => {
    for (const res of [
      await member.client.get('/rest/otel/settings'),
      await put(member, body()),
      await member.client.post('/rest/otel/test-trace', body()),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain(MISSING);
    }
    expect((await server.app.inject({ method: 'GET', url: '/rest/otel/settings' })).statusCode).toBe(401);
  });

  it('refuses a bad body with 400', async () => {
    const w = await world();
    expect((await put(w, body({ tracesSampleRate: 1.5 }))).statusCode).toBe(400);
    expect((await put(w, body({ tracesSampleRate: -0.1 }))).statusCode).toBe(400);
    expect((await put(w, { enabled: true })).statusCode).toBe(400);
    expect((await put(w, body({ exporterProtocol: 'smtp' as never }))).statusCode).toBe(400);
  });

  it('refuses the endpoint rules at once: scheme, user info, a literal blocked address, a blank endpoint when on', async () => {
    const w = await world();
    const refuse = async (over: Partial<OtelSettings>, text: RegExp) => {
      const res = await put(w, body({ exporterHeaders: '', ...over }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toMatch(text);
    };
    await refuse({ exporterEndpoint: 'ftp://collector.example.test' }, /http:\/\/ or https:\/\//);
    await refuse({ exporterEndpoint: 'not a url' }, /valid URL/);
    await refuse({ exporterEndpoint: 'https://user:pass@collector.example.test' }, /user name or a password/);
    await refuse({ exporterEndpoint: 'http://169.254.169.254/latest' }, /isn't allowed/);
    await refuse({ exporterEndpoint: 'https://10.1.2.3:4318' }, /isn't allowed/);
    await refuse({ exporterEndpoint: '' }, /enter the collector endpoint/);
    await refuse({ exporterTracingPath: 'v1/traces' }, /tracing path/);
    await refuse({ exporterTracingPath: '/v1/traces?key=x' }, /tracing path/);
    // a blank endpoint is fine while tracing is off
    const off = await put(w, body({ enabled: false, exporterEndpoint: '', exporterHeaders: '' }));
    expect(off.statusCode, off.body).toBe(200);
    expect(await server.ctx.otelSettings.forTenant(w.tenant.id)).toBeNull();
  });

  it('refuses headers over plain http:// and allows them over https://', async () => {
    const w = await world();
    const http = await put(w, body({ exporterEndpoint: 'http://collector.example.test:4318' }));
    expect(http.statusCode, http.body).toBe(400);
    expect(http.body).toContain('https://');
    noSecret(http.body);
    expect(await server.ctx.repos.otelSettings.get(w.tenant.id)).toBeUndefined();
    const plain = await put(
      w,
      body({ exporterEndpoint: 'http://collector.example.test:4318', exporterHeaders: '' }),
    );
    expect(plain.statusCode, plain.body).toBe(200);
    expect((await put(w, body())).statusCode).toBe(200);
  });

  it("refuses n8n's two header problems and bad header characters, without echoing a value", async () => {
    const w = await world();
    const noEquals = await put(w, body({ exporterHeaders: `X-Api-Key=${KEY_VALUE},broken` }));
    expect(noEquals.statusCode).toBe(400);
    expect(noEquals.body).toMatch(/header 2/);
    const noName = await put(w, body({ exporterHeaders: `=${TOKEN_VALUE}` }));
    expect(noName.statusCode).toBe(400);
    expect(noName.body).toMatch(/header 1/);
    const badName = await put(w, body({ exporterHeaders: `bad name=${NEW_VALUE}` }));
    expect(badName.statusCode).toBe(400);
    const badValue = await put(w, body({ exporterHeaders: `X-A=a\u0001b${KEY_VALUE}` }));
    expect(badValue.statusCode).toBe(400);
    for (const res of [noEquals, noName, badName, badValue]) noSecret(res.body);
    expect(await server.ctx.repos.otelSettings.get(w.tenant.id)).toBeUndefined();
  });
});

describe('blank header values', () => {
  it('keep the stored value while scheme, host and port are unchanged', async () => {
    const w = await world();
    expect((await put(w, body())).statusCode).toBe(200);
    const again = await put(
      w,
      body({
        exporterTracingPath: '/otlp/v1/traces',
        exporterHeaders: `X-Api-Key=,Authorization=,X-New=${NEW_VALUE}`,
      }),
    );
    expect(again.statusCode, again.body).toBe(200);
    noSecret(again.body);
    expect(dataOf<OtelSettings>(again).exporterHeaders).toBe('X-Api-Key=,Authorization=,X-New=');
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.headers).toEqual({
      'X-Api-Key': KEY_VALUE,
      Authorization: TOKEN_VALUE,
      'X-New': NEW_VALUE,
    });
  });

  it('on a save to a new host give 400 and change nothing; new values for the new host are accepted', async () => {
    const w = await world();
    expect((await put(w, body())).statusCode).toBe(200);
    const moved = await put(
      w,
      body({ exporterEndpoint: other.url, exporterHeaders: 'X-Api-Key=,Authorization=' }),
    );
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.body).toContain(
      "Couldn't keep the saved header values: the endpoint changed. Re-enter them.",
    );
    noSecret(moved.body);
    expect((await server.ctx.repos.otelSettings.get(w.tenant.id))?.exporterEndpoint).toBe(collector.url);
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.headers).toEqual({
      'X-Api-Key': KEY_VALUE,
      Authorization: TOKEN_VALUE,
    });
    const fresh = await put(
      w,
      body({
        exporterEndpoint: other.url,
        exporterHeaders: `X-Api-Key=${NEW_VALUE},Authorization=${NEW_VALUE}`,
      }),
    );
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.headers).toEqual({
      'X-Api-Key': NEW_VALUE,
      Authorization: NEW_VALUE,
    });
  });

  it('a port change is a changed endpoint too', async () => {
    const w = await world();
    expect((await put(w, body())).statusCode).toBe(200);
    const url = new URL(collector.url);
    const otherPort = `${url.protocol}//${url.hostname}:${Number(url.port) + 1}`;
    const res = await put(w, body({ exporterEndpoint: otherPort, exporterHeaders: 'X-Api-Key=' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('the audit row', () => {
  it('names the changed fields and holds no header value', async () => {
    const w = await world();
    expect((await put(w, body({ exporterServiceName: 'audited' }))).statusCode).toBe(200);
    const rows = await server.ctx.repos.audit.list(w.tenant.id, 50);
    const row = rows.find((r: { action: string }) => r.action === 'otel.settings_updated');
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).toContain('exporterServiceName');
    expect(JSON.stringify(row)).toContain('exporterHeaders');
    noSecret(JSON.stringify(rows));
  });
});

describe('what reaches the collector', () => {
  it('saved headers reach the tenant fake collector on a run, and are in no answer', async () => {
    const w = await world();
    const mine = await startOtlpCollector({
      tls: { key: loadTlsFixtures().key, cert: loadTlsFixtures().cert },
    });
    try {
      const saved = await put(w, body({ exporterEndpoint: mine.url }));
      expect(saved.statusCode, saved.body).toBe(200);
      const workflow = await createWorkflow(w.client, {
        nodes: [node('Start', 'core.manualTrigger')],
        connections: chain('Start'),
      });
      const { executionId } = await w.client.data<{ executionId: string }>(
        w.client.post(`/rest/workflows/${workflow.id}/run`, {}),
      );
      await waitForExecution(server.ctx, w.tenant.id, executionId, ['success']);
      await waitFor(
        async () => {
          await server.ctx.tracing.flush();
          return mine.requests.length > 0 ? true : undefined;
        },
        { timeout: 15_000, message: 'a request at the collector' },
      );
      const request = mine.requests[mine.requests.length - 1];
      expect(request.headers['x-api-key']).toBe(KEY_VALUE);
      expect(request.headers.authorization).toBe(TOKEN_VALUE);
      for (const res of [
        await w.client.get('/rest/otel/settings'),
        await w.client.get('/rest/audit-log').catch(() => ({ body: '' })),
      ]) {
        noSecret(res.body);
      }
    } finally {
      await mine.close();
    }
  });

  it('writes no header value to the log', async () => {
    const w = await world();
    const lines: string[] = [];
    const logger = server.ctx.logger as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = ['info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        // the HTTP request and response logs hold the raw Node objects (pino prints their serializers only)
        const first = args[0] as Record<string, unknown> | undefined;
        if (first && typeof first === 'object' && ('req' in first || 'res' in first)) return;
        lines.push(JSON.stringify(args));
      }),
    );
    try {
      await put(w, body());
      await put(w, body({ exporterEndpoint: 'http://collector.example.test' }));
      await w.client.post('/rest/otel/test-trace', body());
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    noSecret(lines.join('\n'));
  });
});

describe('POST /rest/otel/test-trace', () => {
  it('sends one test span with the supplied fields and saves nothing', async () => {
    const w = await world();
    const before = collector.requests.length;
    const res = await w.client.post('/rest/otel/test-trace', body({ exporterServiceName: 'try-it' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<{ success: boolean }>(res)).toEqual({ success: true });
    const request = collector.requests[collector.requests.length - 1];
    expect(collector.requests.length).toBe(before + 1);
    expect(request.headers['x-api-key']).toBe(KEY_VALUE);
    expect(collector.spans().some((s) => s.name === 'test_trace')).toBe(true);
    expect(await server.ctx.repos.otelSettings.get(w.tenant.id)).toBeUndefined();
    noSecret(res.body);
  });

  it('fills a blank header value from storage only while the endpoint is unchanged', async () => {
    const w = await world();
    expect((await put(w, body())).statusCode).toBe(200);
    const same = await w.client.post(
      '/rest/otel/test-trace',
      body({ exporterHeaders: 'X-Api-Key=,Authorization=' }),
    );
    expect(dataOf<{ success: boolean }>(same).success).toBe(true);
    const sent = collector.requests[collector.requests.length - 1];
    expect(sent.headers['x-api-key']).toBe(KEY_VALUE);
    expect(sent.headers.authorization).toBe(TOKEN_VALUE);

    const before = other.requests.length;
    const moved = await w.client.post(
      '/rest/otel/test-trace',
      body({ exporterEndpoint: other.url, exporterHeaders: 'X-Api-Key=,Authorization=' }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    const last = other.requests[other.requests.length - 1];
    expect(other.requests.length).toBe(before + 1);
    expect(last.headers['x-api-key'] ?? '').not.toBe(KEY_VALUE);
    expect(last.headers.authorization ?? '').not.toBe(TOKEN_VALUE);
    noSecret(moved.body);
  });

  it('answers success false with the collector text, and 400 for a bad field', async () => {
    const w = await world();
    other.respondWith({ status: 401, body: 'invalid api key', headers: { 'content-type': 'text/plain' } });
    try {
      const res = await w.client.post('/rest/otel/test-trace', body({ exporterEndpoint: other.url }));
      expect(res.statusCode).toBe(200);
      expect(dataOf<{ success: boolean; error?: string }>(res)).toMatchObject({ success: false });
      noSecret(res.body);
    } finally {
      other.respondWith({ status: 200 });
    }
    const blocked = await w.client.post(
      '/rest/otel/test-trace',
      body({ exporterEndpoint: 'https://10.9.9.9' }),
    );
    expect(blocked.statusCode).toBe(400);
    const noHeaders = await w.client.post(
      '/rest/otel/test-trace',
      body({ exporterEndpoint: 'http://collector.example.test' }),
    );
    expect(noHeaders.statusCode).toBe(400);
  });
});

describe('another workspace', () => {
  it('has its own settings, and its runs go to its own collector only', async () => {
    const a = await world();
    const b = await world();
    expect((await put(a, body())).statusCode).toBe(200);
    const readB = await b.client.get('/rest/otel/settings');
    expect(dataOf<OtelSettings>(readB)).toMatchObject({
      enabled: false,
      exporterEndpoint: '',
      exporterHeaders: '',
    });
    expect(await server.ctx.otelSettings.forTenant(b.tenant.id)).toBeNull();
    expect((await server.ctx.otelSettings.forTenant(a.tenant.id))?.tenantId).toBe(a.tenant.id);
    // b saves its own: a is unchanged
    expect(
      (await put(b, body({ exporterEndpoint: other.url, exporterHeaders: `X-B=${NEW_VALUE}` }))).statusCode,
    ).toBe(200);
    expect((await server.ctx.otelSettings.forTenant(a.tenant.id))?.headers).toEqual({
      'X-Api-Key': KEY_VALUE,
      Authorization: TOKEN_VALUE,
    });
    expect(dataOf<OtelSettings>(await a.client.get('/rest/otel/settings')).exporterEndpoint).toBe(
      collector.url,
    );
  });
});

describe('the per-process cache', () => {
  it('serves repeated reads from memory and follows a save', async () => {
    const w = await world();
    expect((await put(w, body())).statusCode).toBe(200);
    const spy = vi.spyOn(server.ctx.repos.otelSettings, 'get');
    try {
      await server.ctx.otelSettings.forTenant(w.tenant.id);
      const afterFirst = spy.mock.calls.length;
      const first = await server.ctx.otelSettings.forTenant(w.tenant.id);
      await server.ctx.otelSettings.forTenant(w.tenant.id);
      expect(spy.mock.calls.length).toBe(afterFirst);
      expect(first?.exporterServiceName).toBe('my-service');
      expect((await put(w, body({ exporterServiceName: 'renamed' }))).statusCode).toBe(200);
      expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterServiceName).toBe('renamed');
      expect((await put(w, body({ enabled: false }))).statusCode).toBe(200);
      expect(await server.ctx.otelSettings.forTenant(w.tenant.id)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('drops an entry at once when this process writes the row', async () => {
    const w = await world();
    expect(await server.ctx.otelSettings.forTenant(w.tenant.id)).toBeNull();
    await server.ctx.repos.otelSettings.upsert(w.tenant.id, {
      enabled: true,
      exporterEndpoint: collector.url,
    });
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterEndpoint).toBe(collector.url);
  });

  it('drops an entry when another process announces otel:reload', async () => {
    const w = await world();
    expect((await put(w, body({ exporterServiceName: 'before' }))).statusCode).toBe(200);
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterServiceName).toBe('before');
    // another process saves: the row changes behind this process's cache (a repository of its own), then the bus tells it
    const elsewhere = createRepositories(server.ctx.database.db).otelSettings;
    await elsewhere.upsert(w.tenant.id, { exporterServiceName: 'after' });
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterServiceName).toBe('before');
    await server.ctx.bus.publish('otel:reload', { tenantId: w.tenant.id });
    await waitFor(
      async () =>
        (await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterServiceName === 'after'
          ? true
          : undefined,
      { message: 'the cache to reload' },
    );
    // a message for another tenant leaves this entry alone
    await elsewhere.upsert(w.tenant.id, { exporterServiceName: 'third' });
    await server.ctx.bus.publish('otel:reload', { tenantId: randomUUID() });
    await new Promise((r) => setTimeout(r, 150));
    expect((await server.ctx.otelSettings.forTenant(w.tenant.id))?.exporterServiceName).toBe('after');
  });
});

describe('the public API /api/v1/settings/otel', () => {
  it('a full key gets, replaces and tests; header values stay blank', async () => {
    const w = await world();
    const key = await keyOf(w);
    const read = await api(key, 'GET', '/settings/otel');
    expect(read.statusCode, read.body).toBe(200);
    expect(dataOf<OtelSettings>(read).enabled).toBe(false);
    const saved = await api(key, 'PUT', '/settings/otel', body());
    expect(saved.statusCode, saved.body).toBe(200);
    expect(dataOf<OtelSettings>(saved).exporterHeaders).toBe('X-Api-Key=,Authorization=');
    noSecret(saved.body);
    const again = await api(key, 'GET', '/settings/otel');
    expect(dataOf<OtelSettings>(again).exporterHeaders).toBe('X-Api-Key=,Authorization=');
    noSecret(again.body);
    const tested = await api(
      key,
      'POST',
      '/settings/otel/test-trace',
      body({ exporterHeaders: 'X-Api-Key=' }),
    );
    expect(tested.statusCode, tested.body).toBe(200);
    expect(dataOf<{ success: boolean }>(tested).success).toBe(true);
    expect((await api(key, 'PUT', '/settings/otel', body({ tracesSampleRate: 2 }))).statusCode).toBe(400);
    const moved = await api(
      key,
      'PUT',
      '/settings/otel',
      body({ exporterEndpoint: other.url, exporterHeaders: 'X-Api-Key=' }),
    );
    expect(moved.statusCode).toBe(400);
  });

  it('a key with only otel:manage works; a narrow key and a member key are 403', async () => {
    const w = await world();
    const only = await keyOf(w, ['otel:manage']);
    expect((await api(only, 'GET', '/settings/otel')).statusCode).toBe(200);
    expect(
      (await api(only, 'PUT', '/settings/otel', body({ enabled: false, exporterHeaders: '' }))).statusCode,
    ).toBe(200);
    const narrow = await keyOf(w, ['tag:list']);
    for (const res of [
      await api(narrow, 'GET', '/settings/otel'),
      await api(narrow, 'PUT', '/settings/otel', body()),
      await api(narrow, 'POST', '/settings/otel/test-trace', body()),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    const memberKey = await keyOf(member);
    const denied = await api(memberKey, 'GET', '/settings/otel');
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain(MISSING);
  });
});
