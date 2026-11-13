/**
 * P6-60 (S5 L4): the webhook destination type. Every request goes to an in-process receiver on 127.0.0.1
 * (test/fakes/http-sink.ts, or a small server of this file for a redirect, a digest challenge or a slow answer);
 * the real HttpClient guards it. Secrets (header and query values, credentials) travel only over https, so the
 * tests that send them use the TLS sink with `allowUnauthorizedCerts`. Values are fixed fakes; no test prints a
 * header value or a credential.
 */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { HttpRequestOptions, WebhookDestinationSettings } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/services/events/stream';
import {
  createWebhookSender,
  validateWebhookSettings,
} from '../src/services/log-streaming/destinations/webhook';
import type { SenderDeps, StoredDestination } from '../src/services/log-streaming/types';
import { type HttpSink, loadTlsFixtures, startHttpSink } from './fakes/http-sink';
import { createTestServer, credentialIn, resetDatabase, signup, type TestServer } from './helpers';

const tls = loadTlsFixtures();
const FAKE_VALUE = 'fake-secret-value-1234';
const FAKE_QUERY = 'fake-query-secret-5678';

let server: TestServer;
let plain: HttpSink;
let secure: HttpSink;
const extra: Server[] = [];
let ip = 1;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  plain = await startHttpSink();
  secure = await startHttpSink({ tls: { key: tls.key, cert: tls.cert } });
});
afterAll(async () => {
  await plain.close();
  await secure.close();
  await server.close();
});
afterEach(async () => {
  plain.requests.length = 0;
  secure.requests.length = 0;
  plain.respondWith(200);
  secure.respondWith(200);
  for (const s of extra.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const settings = (
  over: Partial<WebhookDestinationSettings> & { url: string },
): WebhookDestinationSettings => ({
  method: 'POST',
  sendQuery: false,
  queryParameters: [],
  sendHeaders: false,
  headerParameters: [],
  sendPayload: true,
  responseCodeMustMatch: false,
  expectedStatusCode: 200,
  ...over,
  options: {
    allowUnauthorizedCerts: false,
    queryParameterArrays: 'brackets',
    redirect: { followRedirects: false, maxRedirects: 21 },
    timeout: 5000,
    ...(over.options ?? {}),
  },
});
/** an https target that the client trusts only with `allowUnauthorizedCerts` */
const secureOptions = (over: Partial<WebhookDestinationSettings['options']> = {}) => ({
  allowUnauthorizedCerts: true,
  ...over,
});

function eventOf(
  eventName = 'n8n.workflow.success',
  payload: StreamEvent['payload'] = { workflowId: 'wf-1' },
): StreamEvent {
  return {
    id: randomUUID(),
    ts: '2026-11-12T10:00:00.000Z',
    eventName,
    message: eventName,
    payload,
    tenantId: randomUUID(),
  };
}

function destinationOf(
  config: WebhookDestinationSettings,
  over: { tenantId?: string; credentialId?: string | null; anonymize?: boolean } = {},
): StoredDestination {
  return {
    id: randomUUID(),
    tenantId: over.tenantId ?? randomUUID(),
    type: 'webhook',
    label: 'Webhook',
    enabled: true,
    subscribedEvents: ['*'],
    anonymizeAuditMessages: over.anonymize ?? false,
    circuitBreaker: null,
    credentialId: over.credentialId ?? null,
    settings: config,
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as StoredDestination;
}

const depsWith = (http: SenderDeps['http'] = server.ctx.http): SenderDeps => ({
  http,
  credentials: server.ctx.credentials,
  cipher: server.ctx.cipher,
  config: server.ctx.config,
  logger: server.ctx.logger,
});
const send = (
  config: WebhookDestinationSettings,
  over: Parameters<typeof destinationOf>[1] = {},
  options: { test?: boolean; deps?: SenderDeps; event?: StreamEvent } = {},
) =>
  createWebhookSender(options.deps ?? depsWith(), destinationOf(config, over)).send(
    options.event ?? eventOf(),
    { test: options.test },
  );

const bodyOf = (request: { body: Buffer }) =>
  JSON.parse(request.body.toString('utf8')) as Record<string, any>;
const queryOf = (path: string) => decodeURIComponent(path.split('?')[1] ?? '');

async function listen(server_: Server): Promise<string> {
  extra.push(server_);
  await new Promise<void>((resolve) => server_.listen(0, '127.0.0.1', resolve));
  return String((server_.address() as AddressInfo).port);
}

async function withWorld() {
  await resetDatabase(server.ctx);
  const world = await signup(server.app, { remoteAddress: `127.9.7.${(ip++ % 250) + 1}` });
  return { world, tenantId: world.tenant.id, projectId: world.client.defaultProjectId as string };
}

describe('P6-60 webhook destination: settings validation', () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    ...settings({ url: 'https://hooks.example.test/in' }),
    ...over,
  });

  it('takes valid settings, with defaults for what is left out', () => {
    expect(validateWebhookSettings(ok())).toBeNull();
    expect(validateWebhookSettings({ url: 'http://hooks.example.test/in' })).toBeNull();
    expect(validateWebhookSettings({ url: 'https://hooks.example.test/in', method: 'PATCH' })).toBeNull();
  });

  it('refuses a missing or bad URL, a bad scheme and a bad method', () => {
    for (const bad of [
      undefined,
      5,
      '',
      'not a url',
      'ftp://hooks.example.test/in',
      'file:///etc/passwd',
      'https://',
    ]) {
      expect(validateWebhookSettings(ok({ url: bad })), String(bad)).toMatch(/URL/);
    }
    expect(validateWebhookSettings(ok({ method: 'DELETE' }))).toMatch(/method/i);
    expect(validateWebhookSettings(null)).not.toBeNull();
    expect(validateWebhookSettings('x')).not.toBeNull();
  });

  it('refuses bad pairs, a bad status code, a bad timeout and bad redirect settings', () => {
    expect(validateWebhookSettings(ok({ headerParameters: [{ name: 'bad name', value: 'x' }] }))).toMatch(
      /header/i,
    );
    expect(validateWebhookSettings(ok({ headerParameters: [{ name: '', value: 'x' }] }))).toMatch(/header/i);
    expect(validateWebhookSettings(ok({ queryParameters: [{ name: '', value: 'x' }] }))).toMatch(/query/i);
    expect(validateWebhookSettings(ok({ queryParameters: 'x' }))).toMatch(/query/i);
    expect(validateWebhookSettings(ok({ expectedStatusCode: 99 }))).toMatch(/status/i);
    expect(validateWebhookSettings(ok({ expectedStatusCode: 'abc' }))).toMatch(/status/i);
    for (const timeout of [0, -1, 60_001, 'x', 1.5]) {
      expect(validateWebhookSettings(ok({ options: { ...ok().options, timeout } })), String(timeout)).toMatch(
        /timeout/i,
      );
    }
    expect(
      validateWebhookSettings(
        ok({ options: { ...ok().options, redirect: { followRedirects: true, maxRedirects: 22 } } }),
      ),
    ).toMatch(/redirect/i);
    expect(
      validateWebhookSettings(ok({ options: { ...ok().options, queryParameterArrays: 'commas' } })),
    ).toMatch(/array/i);
  });

  it('refuses a secret over plain http:// and takes it over https://', () => {
    const header = { sendHeaders: true, headerParameters: [{ name: 'X-Token', value: FAKE_VALUE }] };
    const query = { sendQuery: true, queryParameters: [{ name: 'key', value: FAKE_VALUE }] };
    expect(validateWebhookSettings(ok({ url: 'http://hooks.example.test/in', ...header }))).toMatch(/https/);
    expect(validateWebhookSettings(ok({ url: 'http://hooks.example.test/in', ...query }))).toMatch(/https/);
    expect(validateWebhookSettings(ok({ url: `http://hooks.example.test/in?token=${FAKE_QUERY}` }))).toMatch(
      /https/,
    );
    expect(validateWebhookSettings(ok({ url: 'http://user:pw@hooks.example.test/in' }))).toMatch(/https/);
    expect(
      validateWebhookSettings(ok({ url: 'https://hooks.example.test/in', ...header, ...query })),
    ).toBeNull();
    // a blank value (kept secret, or none) and a pair that is switched off carry nothing
    expect(
      validateWebhookSettings(
        ok({
          url: 'http://hooks.example.test/in',
          sendHeaders: true,
          headerParameters: [{ name: 'X', value: '' }],
        }),
      ),
    ).toBeNull();
    expect(
      validateWebhookSettings(
        ok({
          url: 'http://hooks.example.test/in',
          sendHeaders: false,
          headerParameters: [{ name: 'X', value: FAKE_VALUE }],
        }),
      ),
    ).toBeNull();
  });

  it('does not echo a secret in its text', () => {
    const text = validateWebhookSettings(
      ok({
        url: `http://hooks.example.test/in?token=${FAKE_QUERY}`,
        sendHeaders: true,
        headerParameters: [{ name: 'X', value: FAKE_VALUE }],
      }),
    );
    expect(text).not.toContain(FAKE_QUERY);
    expect(text).not.toContain(FAKE_VALUE);
  });
});

describe('P6-60 webhook destination: the request', () => {
  it('POSTs the event as JSON', async () => {
    const event = eventOf('n8n.workflow.success', { workflowId: 'wf-9', executionId: 'ex-1' });
    await send(settings({ url: `${plain.url}/in` }), {}, { event });
    const [request] = plain.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/in');
    expect(String(request.headers['content-type'])).toMatch(/^application\/json/);
    const body = bodyOf(request);
    expect(body).toMatchObject({
      __type: '$$EventMessage',
      id: event.id,
      ts: '2026-11-12T10:00:00.000Z',
      eventName: 'n8n.workflow.success',
      payload: { workflowId: 'wf-9', executionId: 'ex-1' },
    });
  });

  it('sends PUT and PATCH with the body and GET without one', async () => {
    await send(settings({ url: plain.url, method: 'PUT' }));
    await send(settings({ url: plain.url, method: 'PATCH' }));
    await send(settings({ url: plain.url, method: 'GET' }));
    expect(plain.requests.map((r) => r.method)).toEqual(['PUT', 'PATCH', 'GET']);
    expect(bodyOf(plain.requests[0]).eventName).toBe('n8n.workflow.success');
    expect(bodyOf(plain.requests[1]).eventName).toBe('n8n.workflow.success');
    expect(plain.requests[2].body.length).toBe(0);
  });

  it('sends no body when sendPayload is off', async () => {
    await send(settings({ url: plain.url, sendPayload: false }));
    expect(plain.requests[0].body.length).toBe(0);
  });

  it('sends the test message as an event', async () => {
    await send(
      settings({ url: plain.url }),
      {},
      { test: true, event: eventOf('n8n.destination.test', { testMessage: true }) },
    );
    expect(bodyOf(plain.requests[0])).toMatchObject({
      eventName: 'n8n.destination.test',
      payload: { testMessage: true },
    });
  });

  it('keeps the query of the URL and adds the query pairs', async () => {
    await send(
      settings({
        url: `${secure.url}/in?a=1`,
        sendQuery: true,
        queryParameters: [{ name: 'key', value: FAKE_QUERY }],
        options: secureOptions() as never,
      }),
    );
    expect(queryOf(secure.requests[0].path)).toBe(`a=1&key=${FAKE_QUERY}`);
  });

  it('sends the header pairs, a repeated name once per value, and the JSON content type', async () => {
    await send(
      settings({
        url: secure.url,
        sendHeaders: true,
        headerParameters: [
          { name: 'X-Fake-One', value: FAKE_VALUE },
          { name: 'X-Fake-Many', value: 'first' },
          { name: 'X-Fake-Many', value: 'second' },
        ],
        options: secureOptions() as never,
      }),
    );
    const { headers } = secure.requests[0];
    expect(headers['x-fake-one']).toBe(FAKE_VALUE);
    expect(String(headers['x-fake-many'])).toBe('first, second');
    expect(String(headers['content-type'])).toMatch(/^application\/json/);
  });

  it('sends no pair that is switched off', async () => {
    await send(
      settings({
        url: plain.url,
        sendQuery: false,
        queryParameters: [{ name: 'key', value: FAKE_QUERY }],
        sendHeaders: false,
        headerParameters: [{ name: 'X-Fake-One', value: FAKE_VALUE }],
      }),
    );
    expect(plain.requests[0].path).toBe('/');
    expect(plain.requests[0].headers['x-fake-one']).toBeUndefined();
  });

  it.each([
    ['brackets', 'tag[]=a&tag[]=b&solo=z'],
    ['indices', 'tag[0]=a&tag[1]=b&solo=z'],
    ['repeat', 'tag=a&tag=b&solo=z'],
  ] as const)('expands a repeated query name as %s', async (format, expected) => {
    // a value in the query is a secret, so the pairs go over https
    await send(
      settings({
        url: secure.url,
        sendQuery: true,
        queryParameters: [
          { name: 'tag', value: 'a' },
          { name: 'tag', value: 'b' },
          { name: 'solo', value: 'z' },
        ],
        options: secureOptions({ queryParameterArrays: format }) as never,
      }),
    );
    expect(queryOf(secure.requests[0].path)).toBe(expected);
  });
});

describe('P6-60 webhook destination: the answer', () => {
  it('fails on a 500 and keeps the answer body out of the error', async () => {
    plain.respondWith(500, `internal ${FAKE_VALUE}`);
    const error = await send(settings({ url: plain.url })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/500/);
    expect((error as Error).message).not.toContain(FAKE_VALUE);
  });

  it('fails on a 4xx and takes any 2xx', async () => {
    plain.respondWith(404);
    await expect(send(settings({ url: plain.url }))).rejects.toThrow(/404/);
    plain.respondWith(204);
    await expect(send(settings({ url: plain.url }))).resolves.toBeUndefined();
  });

  it('fails when the code does not match the expected one, and takes the expected one', async () => {
    plain.respondWith(202);
    await expect(
      send(settings({ url: plain.url, responseCodeMustMatch: true, expectedStatusCode: 200 })),
    ).rejects.toThrow(/202/);
    await expect(
      send(settings({ url: plain.url, responseCodeMustMatch: true, expectedStatusCode: 202 })),
    ).resolves.toBeUndefined();
  });

  it('times out on a silent receiver', async () => {
    const slow = createHttpServer(() => {
      /* never answers */
    });
    const port = await listen(slow);
    const started = Date.now();
    await expect(
      send(settings({ url: `http://127.0.0.1:${port}`, options: { timeout: 300 } as never })),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('P6-60 webhook destination: redirects', () => {
  async function redirector(location: string, status = 302): Promise<string> {
    const s = createHttpServer((_req, res) => {
      res.writeHead(status, { location });
      res.end();
    });
    return `http://127.0.0.1:${await listen(s)}`;
  }

  it('does not follow a redirect by default and counts it as a failure', async () => {
    const origin = await redirector(`${plain.url}/landed`);
    await expect(send(settings({ url: origin }))).rejects.toThrow(/redirect/i);
    expect(plain.requests).toHaveLength(0);
  });

  it('follows a redirect when asked to', async () => {
    const origin = await redirector(`${plain.url}/landed`);
    await send(
      settings({ url: origin, options: { redirect: { followRedirects: true, maxRedirects: 5 } } as never }),
    );
    expect(plain.requests.map((r) => r.path)).toEqual(['/landed']);
  });

  it('refuses a followed redirect to a blocked address', async () => {
    const origin = await redirector('http://169.254.169.254/latest/meta-data');
    await expect(
      send(
        settings({ url: origin, options: { redirect: { followRedirects: true, maxRedirects: 5 } } as never }),
      ),
    ).rejects.toThrow(/blocked/i);
  });

  it('counts a 3xx as the expected code only when the destination says so', async () => {
    const origin = await redirector(`${plain.url}/landed`);
    await expect(
      send(settings({ url: origin, responseCodeMustMatch: true, expectedStatusCode: 302 })),
    ).resolves.toBeUndefined();
    expect(plain.requests).toHaveLength(0);
  });
});

describe('P6-60 webhook destination: the SSRF guard and TLS', () => {
  const guarded = () => depsWith(new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } }));

  it.each(['http://10.0.0.5/in', 'http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:9/in'])(
    'refuses %s with the guard on',
    async (url) => {
      await expect(send(settings({ url }), {}, { deps: guarded() })).rejects.toThrow(/blocked/i);
    },
  );

  it('reaches the request with the skip flag only when allowUnauthorizedCerts is set', async () => {
    const seen: HttpRequestOptions[] = [];
    const spy = {
      request: async (options: HttpRequestOptions) => {
        seen.push(options);
        return { body: '', headers: {}, statusCode: 200, statusMessage: 'OK' };
      },
    } as unknown as SenderDeps['http'];
    await send(settings({ url: 'https://hooks.example.test/in' }), {}, { deps: depsWith(spy) });
    await send(
      settings({ url: 'https://hooks.example.test/in', options: { allowUnauthorizedCerts: true } as never }),
      {},
      { deps: depsWith(spy) },
    );
    expect(seen[0].skipSslCertificateValidation).not.toBe(true);
    expect(seen[1].skipSslCertificateValidation).toBe(true);
    // redirects are off unless the destination turns them on; no proxy option exists
    expect(seen[0].followRedirects).toBe(false);
    expect(seen[0].timeout).toBe(5000);
    expect(Object.keys(seen[0]).filter((key) => /proxy|agent|socket/i.test(key))).toEqual([]);
  });

  it('refuses a certificate the platform does not trust, and takes it with allowUnauthorizedCerts', async () => {
    await expect(send(settings({ url: secure.url }))).rejects.toThrow();
    expect(secure.requests).toHaveLength(0);
    await send(settings({ url: secure.url, options: secureOptions() as never }));
    expect(secure.requests).toHaveLength(1);
  });
});

describe('P6-60 webhook destination: credential auth', () => {
  const sendWith = async (
    type: string,
    data: Record<string, unknown>,
    over: Partial<WebhookDestinationSettings> = {},
  ) => {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, { type, data });
    return {
      tenantId,
      credential,
      run: () =>
        send(settings({ url: secure.url, options: secureOptions() as never, ...over }), {
          tenantId,
          credentialId: credential.id,
        }),
    };
  };

  it('authenticates with basic auth', async () => {
    const { run } = await sendWith('httpBasicAuth', { user: 'fake-user', password: FAKE_VALUE });
    await run();
    const expected = `Basic ${Buffer.from(`fake-user:${FAKE_VALUE}`).toString('base64')}`;
    expect(secure.requests[0].headers.authorization).toBe(expected);
  });

  it('authenticates with a header', async () => {
    const { run } = await sendWith('httpHeaderAuth', { name: 'X-Fake-Key', value: FAKE_VALUE });
    await run();
    expect(secure.requests[0].headers['x-fake-key']).toBe(FAKE_VALUE);
  });

  it('authenticates with a query value', async () => {
    const { run } = await sendWith('httpQueryAuth', { name: 'fake_key', value: FAKE_VALUE });
    await run();
    expect(queryOf(secure.requests[0].path)).toBe(`fake_key=${FAKE_VALUE}`);
  });

  it('authenticates with a custom auth JSON', async () => {
    const { run } = await sendWith('httpCustomAuth', {
      json: JSON.stringify({ headers: { 'X-Fake-Custom': FAKE_VALUE }, qs: { fake_q: 'v' } }),
    });
    await run();
    expect(secure.requests[0].headers['x-fake-custom']).toBe(FAKE_VALUE);
    expect(queryOf(secure.requests[0].path)).toBe('fake_q=v');
  });

  it('answers a digest challenge with one retry', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const digest = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      seen.push(req.headers);
      req.resume();
      if (!String(req.headers.authorization ?? '').startsWith('Digest ')) {
        res.writeHead(401, {
          'www-authenticate': 'Digest realm="fake", nonce="fakenonce123", qop="auth", algorithm=MD5',
        });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const port = await listen(digest);
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'httpDigestAuth',
      data: { user: 'fake-user', password: FAKE_VALUE },
    });
    await send(settings({ url: `https://127.0.0.1:${port}/in`, options: secureOptions() as never }), {
      tenantId,
      credentialId: credential.id,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].authorization).toBeUndefined();
    expect(String(seen[1].authorization)).toMatch(/^Digest .*username="fake-user"/);
    expect(String(seen[1].authorization)).not.toContain(FAKE_VALUE);
  });

  it('refuses a credential over plain http:// and sends nothing', async () => {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'httpHeaderAuth',
      data: { name: 'X-Fake-Key', value: FAKE_VALUE },
    });
    const error = await send(settings({ url: plain.url }), { tenantId, credentialId: credential.id }).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toMatch(/https/);
    expect((error as Error).message).not.toContain(FAKE_VALUE);
    expect(plain.requests).toHaveLength(0);
  });

  it('refuses header and query secrets over plain http:// at send time too', async () => {
    await expect(
      send(
        settings({
          url: plain.url,
          sendHeaders: true,
          headerParameters: [{ name: 'X-Fake', value: FAKE_VALUE }],
        }),
      ),
    ).rejects.toThrow(/https/);
    await expect(
      send(
        settings({ url: plain.url, sendQuery: true, queryParameters: [{ name: 'k', value: FAKE_QUERY }] }),
      ),
    ).rejects.toThrow(/https/);
    expect(plain.requests).toHaveLength(0);
  });

  it("never uses another workspace's credential, nor a deleted one", async () => {
    const a = await withWorld();
    const credential = await credentialIn(server, a.tenantId, a.projectId, {
      type: 'httpHeaderAuth',
      data: { name: 'X-Fake-Key', value: FAKE_VALUE },
    });
    const b = await signup(server.app, { remoteAddress: `127.9.8.${(ip++ % 250) + 1}` });
    await expect(
      send(settings({ url: secure.url, options: secureOptions() as never }), {
        tenantId: b.tenant.id,
        credentialId: credential.id,
      }),
    ).rejects.toThrow();
    await expect(
      send(settings({ url: secure.url, options: secureOptions() as never }), {
        tenantId: a.tenantId,
        credentialId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(secure.requests).toHaveLength(0);
  });

  it('refuses a credential of another type', async () => {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'testApi',
      data: { apiKey: FAKE_VALUE },
    });
    const error = await send(settings({ url: secure.url, options: secureOptions() as never }), {
      tenantId,
      credentialId: credential.id,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(FAKE_VALUE);
    expect(secure.requests).toHaveLength(0);
  });

  it('holds a credential to its allowed domains', async () => {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'httpHeaderAuth',
      data: {
        name: 'X-Fake-Key',
        value: FAKE_VALUE,
        allowedHttpRequestDomains: 'domains',
        allowedDomains: 'api.example.test',
      },
    });
    await expect(
      send(settings({ url: secure.url, options: secureOptions() as never }), {
        tenantId,
        credentialId: credential.id,
      }),
    ).rejects.toThrow();
    expect(secure.requests).toHaveLength(0);
  });
});

describe('P6-60 webhook destination: user and password in the URL', () => {
  const withUserinfo = (url: string, userinfo: string, query = '') =>
    `${url.replace('://', `://${userinfo}@`)}/in${query}`;

  it('sends the URL user and password as Basic auth and keeps them out of the request URL', async () => {
    // an encoded password: `pa{ss`
    await send(
      settings({
        url: withUserinfo(secure.url, 'user:pa%7Bss', `?token=${FAKE_QUERY}`),
        options: secureOptions() as never,
      }),
    );
    const [request] = secure.requests;
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from('user:pa{ss').toString('base64')}`);
    expect(request.path).toBe(`/in?token=${FAKE_QUERY}`);
  });

  it('hands the client a URL without user and password', async () => {
    const seen: HttpRequestOptions[] = [];
    const spy = {
      request: async (options: HttpRequestOptions) => {
        seen.push(options);
        return { body: '', headers: {}, statusCode: 200, statusMessage: 'OK' };
      },
    } as unknown as SenderDeps['http'];
    await send(settings({ url: 'https://user:pa%7Bss@hooks.example.test/in' }), {}, { deps: depsWith(spy) });
    expect(seen[0].url).toBe('https://hooks.example.test/in');
    expect(seen[0].auth).toEqual({ username: 'user', password: 'pa{ss' });
  });

  it('lets a credential win over the URL user and password', async () => {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'httpBasicAuth',
      data: { user: 'cred-user', password: FAKE_VALUE },
    });
    await send(settings({ url: withUserinfo(secure.url, 'user:pw'), options: secureOptions() as never }), {
      tenantId,
      credentialId: credential.id,
    });
    expect(secure.requests[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`cred-user:${FAKE_VALUE}`).toString('base64')}`,
    );
  });

  it('keeps any URL out of an error text, whatever the client echoes', async () => {
    const echo = {
      request: async () => {
        throw new TypeError(
          'Request cannot be constructed from a URL that includes credentials: https://user:pa%7Bss@hooks.example.test/in?token=abc+def%2Fxyz',
        );
      },
    } as unknown as SenderDeps['http'];
    const error = await send(
      settings({ url: 'https://user:pa%7Bss@hooks.example.test/in?token=abc+def%2Fxyz' }),
      {},
      { deps: depsWith(echo) },
    ).catch((e: Error) => e);
    const text = (error as Error).message;
    expect(text).toMatch(/^Couldn't reach the webhook/);
    for (const leak of ['pa%7Bss', 'pa{ss', 'abc', 'hooks.example.test', 'user:']) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe('P6-60 webhook destination: followed redirects', () => {
  const follow = (maxRedirects: number) => ({ redirect: { followRedirects: true, maxRedirects } }) as never;
  const secureFollow = () => secureOptions({ redirect: { followRedirects: true, maxRedirects: 5 } }) as never;

  async function plainHop(location: string): Promise<string> {
    const s = createHttpServer((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    return `http://127.0.0.1:${await listen(s)}`;
  }

  /** an https receiver that records each request and answers a redirect for the paths `to` names */
  async function secureHop(to: (path: string) => string | null, status = 302) {
    const seen: Array<{ method: string; path: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
    const s = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const path = req.url ?? '/';
        seen.push({ method: req.method ?? 'GET', path, headers: req.headers, body: Buffer.concat(chunks) });
        const location = to(path);
        if (location) res.writeHead(status, { location });
        else res.writeHead(200);
        res.end();
      });
    });
    return { origin: `https://127.0.0.1:${await listen(s)}`, seen };
  }

  const headerPair = { sendHeaders: true, headerParameters: [{ name: 'X-Fake-One', value: FAKE_VALUE }] };

  async function headerCredential() {
    const { tenantId, projectId } = await withWorld();
    const credential = await credentialIn(server, tenantId, projectId, {
      type: 'httpHeaderAuth',
      data: { name: 'X-Fake-Key', value: FAKE_VALUE },
    });
    return { tenantId, credentialId: credential.id };
  }

  it('stops after maxRedirects hops', async () => {
    const last = await plainHop(`${plain.url}/landed`);
    const first = await plainHop(last);
    await expect(send(settings({ url: first, options: follow(1) }))).rejects.toThrow(/more than 1 times/);
    expect(plain.requests).toHaveLength(0);
    await send(settings({ url: first, options: follow(2) }));
    expect(plain.requests.map((r) => r.path)).toEqual(['/landed']);
    plain.requests.length = 0;
    await expect(send(settings({ url: last, options: follow(0) }))).rejects.toThrow(/more than 0 times/);
    expect(plain.requests).toHaveLength(0);
  });

  it('keeps the header pairs on a hop inside the same origin and turns a POST into a GET on a 302', async () => {
    const hop = await secureHop((path) => (path === '/in' ? '/next' : null));
    await send(settings({ url: `${hop.origin}/in`, ...headerPair, options: secureFollow() }));
    expect(hop.seen.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /in', 'GET /next']);
    expect(hop.seen[0].headers['x-fake-one']).toBe(FAKE_VALUE);
    expect(hop.seen[1].headers['x-fake-one']).toBe(FAKE_VALUE);
    expect(hop.seen[1].body.length).toBe(0);
  });

  it('keeps the method and the body on a 307', async () => {
    const hop = await secureHop((path) => (path === '/in' ? '/next' : null), 307);
    await send(settings({ url: `${hop.origin}/in`, options: secureFollow() }));
    expect(hop.seen.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(bodyOf(hop.seen[1]).eventName).toBe('n8n.workflow.success');
  });

  it('drops the header pairs and the query pairs on a hop to another origin', async () => {
    const hop = await secureHop(() => `${secure.url}/landed`);
    await send(
      settings({
        url: `${hop.origin}/in`,
        ...headerPair,
        sendQuery: true,
        queryParameters: [{ name: 'key', value: FAKE_QUERY }],
        options: secureFollow(),
      }),
    );
    expect(hop.seen[0].headers['x-fake-one']).toBe(FAKE_VALUE);
    expect(secure.requests).toHaveLength(1);
    expect(secure.requests[0].path).toBe('/landed');
    expect(secure.requests[0].headers['x-fake-one']).toBeUndefined();
  });

  it('drops the credential on a hop to another origin', async () => {
    const over = await headerCredential();
    const hop = await secureHop(() => `${secure.url}/landed`);
    await send(settings({ url: `${hop.origin}/in`, options: secureFollow() }), over);
    expect(hop.seen[0].headers['x-fake-key']).toBe(FAKE_VALUE);
    expect(secure.requests).toHaveLength(1);
    expect(secure.requests[0].headers['x-fake-key']).toBeUndefined();
  });

  it('drops the URL user and password on a hop to another origin', async () => {
    const hop = await secureHop(() => `${secure.url}/landed`);
    await send(settings({ url: `${hop.origin.replace('://', '://user:pw@')}/in`, options: secureFollow() }));
    expect(hop.seen[0].headers.authorization).toBe(`Basic ${Buffer.from('user:pw').toString('base64')}`);
    expect(secure.requests[0].headers.authorization).toBeUndefined();
  });

  it('refuses a hop to plain http:// when the request carries a secret, and sends nothing there', async () => {
    const hop = await secureHop(() => `${plain.url}/landed`);
    const error = await send(
      settings({ url: `${hop.origin}/in`, ...headerPair, options: secureFollow() }),
    ).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/plain http/);
    expect((error as Error).message).not.toContain(FAKE_VALUE);
    expect(plain.requests).toHaveLength(0);
  });

  it('refuses a hop to plain http:// when a credential is set', async () => {
    const over = await headerCredential();
    const hop = await secureHop(() => `${plain.url}/landed`);
    await expect(send(settings({ url: `${hop.origin}/in`, options: secureFollow() }), over)).rejects.toThrow(
      /plain http/,
    );
    expect(plain.requests).toHaveLength(0);
  });

  it('follows a hop to plain http:// when the request carries no secret', async () => {
    const hop = await secureHop(() => `${plain.url}/landed`);
    await send(settings({ url: `${hop.origin}/in`, options: secureFollow() }));
    expect(plain.requests.map((r) => r.path)).toEqual(['/landed']);
  });
});
