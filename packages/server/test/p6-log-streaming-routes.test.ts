/**
 * P6-06 (S5 L3): the REST routes /rest/eventbus/*. Scopes (the `?id=` read and the update-by-id cases the route
 * matrix does not cover), validation, credential rules, secrets (blank on read, kept on a blank save while the
 * endpoint is unchanged), another tenant's id and the roles that cannot hold the destination scopes. Senders are
 * the test's own fake types; no network. Values are fixed fakes and no test prints a secret.
 */
import { randomUUID } from 'node:crypto';
import type { LogDestination } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationSecretBinding } from '../src/services/log-streaming/secrets';
import {
  createTestServer,
  credentialIn,
  memberAs,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

const MISSING = 'User is missing a scope required to perform this action';
let server: TestServer;
let ip = 1;
const seen: Array<{ destinationId: string; settings: Record<string, any> }> = [];

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  seen.length = 0;
  for (const type of ['webhook', 'syslog', 'sentry'] as const) {
    server.ctx.logStreaming.registerType(type, {
      create: (_deps, destination) => ({
        async send() {
          seen.push({ destinationId: destination.id, settings: structuredClone(destination.settings) });
        },
      }),
      validate: (settings) => {
        const s = settings as Record<string, unknown>;
        if (type === 'webhook' && typeof s.url === 'string' && !s.url.startsWith('http')) {
          return 'The URL must start with http:// or https://';
        }
        return null;
      },
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const world = () => signup(server.app, { remoteAddress: `127.6.5.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof signup>>;
type Who = { client: World['client'] };

const webhook = (over: Record<string, unknown> = {}) => ({
  url: 'https://hooks.example.test/in',
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
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  type: 'webhook',
  label: 'Hook',
  enabled: true,
  subscribedEvents: ['workflow'],
  settings: webhook(),
  ...over,
});

const save = (w: Who, over: Record<string, unknown> = {}) =>
  w.client.post('/rest/eventbus/destination', body(over));
const created = async (w: Who, over: Record<string, unknown> = {}) => {
  const res = await save(w, over);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as LogDestination;
};

describe('scopes', () => {
  it('a true member is 403 with n8n text on every route', async () => {
    const w = await world();
    const dest = await created(w);
    const member = await realMember(w);
    const calls = [
      await member.client.get('/rest/eventbus/eventnames'),
      await member.client.get('/rest/eventbus/destination'),
      await member.client.get(`/rest/eventbus/destination?id=${dest.id}`),
      await save(member),
      await save(member, { id: dest.id }),
      await member.client.delete(`/rest/eventbus/destination?id=${dest.id}`),
      await member.client.post(`/rest/eventbus/testmessage?id=${dest.id}`),
    ];
    for (const res of calls) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.message).toBe(MISSING);
    }
  });

  it('an admin lists, reads by id, creates, updates by id, tests and deletes', async () => {
    const w = await world();
    const admin = await memberAs(w, 'admin');
    const made = await created(admin);
    expect(made).toMatchObject({
      type: 'webhook',
      label: 'Hook',
      enabled: true,
      subscribedEvents: ['workflow'],
    });
    expect(made.circuitBreaker).toEqual({ maxFailures: 5, failureWindowMs: 60000 });
    const list = await admin.client.data<LogDestination[]>(admin.client.get('/rest/eventbus/destination'));
    expect(list.map((d) => d.id)).toEqual([made.id]);
    const one = await admin.client.data<LogDestination>(
      admin.client.get(`/rest/eventbus/destination?id=${made.id}`),
    );
    expect(one.id).toBe(made.id);
    const updated = await admin.client.data<LogDestination>(
      save(admin, { id: made.id, label: 'Renamed', enabled: false }),
    );
    expect(updated).toMatchObject({ id: made.id, label: 'Renamed', enabled: false });
    expect((await admin.client.post(`/rest/eventbus/testmessage?id=${made.id}`)).statusCode).toBe(200);
    expect((await admin.client.delete(`/rest/eventbus/destination?id=${made.id}`)).statusCode).toBe(200);
    expect((await admin.client.get(`/rest/eventbus/destination?id=${made.id}`)).statusCode).toBe(404);
  });

  it('lists the event names a destination can subscribe to', async () => {
    const w = await world();
    const names = await w.client.data<string[]>(w.client.get('/rest/eventbus/eventnames'));
    expect(names).toEqual(
      expect.arrayContaining(['workflow.started', 'node.finished', 'audit.user.login.success']),
    );
    expect(names).not.toContain('destination.test');
  });

  it('a custom role cannot hold the destination scopes', async () => {
    const w = await world();
    for (const scope of [
      'eventBusDestination:create',
      'eventBusDestination:update',
      'eventBusDestination:list',
    ]) {
      const res = await w.client.post('/rest/roles', {
        displayName: `Role ${randomUUID().slice(0, 6)}`,
        roleType: 'global',
        scopes: [scope],
      });
      expect(res.statusCode, scope).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
  });
});

describe('another workspace', () => {
  it('its destination id is 404 on read, update, delete and test', async () => {
    const a = await world();
    const b = await world();
    const dest = await created(a);
    expect((await b.client.get(`/rest/eventbus/destination?id=${dest.id}`)).statusCode).toBe(404);
    expect((await save(b, { id: dest.id })).statusCode).toBe(404);
    expect((await b.client.delete(`/rest/eventbus/destination?id=${dest.id}`)).statusCode).toBe(404);
    expect((await b.client.post(`/rest/eventbus/testmessage?id=${dest.id}`)).statusCode).toBe(404);
    expect(await b.client.data<LogDestination[]>(b.client.get('/rest/eventbus/destination'))).toEqual([]);
    expect((await a.client.get(`/rest/eventbus/destination?id=${dest.id}`)).statusCode).toBe(200);
  });
});

describe('validation', () => {
  it('refuses an unknown event, a bad label, a changed type and settings the type refuses', async () => {
    const w = await world();
    const unknown = await save(w, { subscribedEvents: ['workflow.started', 'not.an.event'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain('not.an.event');
    expect((await save(w, { label: '' })).statusCode).toBe(400);
    expect((await save(w, { label: 'x'.repeat(256) })).statusCode).toBe(400);
    const bad = await save(w, { settings: webhook({ url: 'ftp://nope.example.test' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('The URL must start with http:// or https://');
    const dest = await created(w);
    const retype = await save(w, { id: dest.id, type: 'syslog', settings: {} });
    expect(retype.statusCode).toBe(400);
    const good = await created(w, { subscribedEvents: ['*', 'audit.user', 'node.started'] });
    expect(good.subscribedEvents).toEqual(['*', 'audit.user', 'node.started']);
  });

  it('keeps the old settings when an update names none', async () => {
    const w = await world();
    const dest = await created(w, { settings: webhook({ url: 'https://keep.example.test/x' }) });
    const updated = await w.client.data<LogDestination>(
      w.client.post('/rest/eventbus/destination', { id: dest.id, type: 'webhook', label: 'Again' }),
    );
    expect((updated.settings as { url: string }).url).toBe('https://keep.example.test/x');
    expect(updated.label).toBe('Again');
  });
});

describe('the limit of destinations (sweep-4)', () => {
  it('a workspace holds 20: the 21st create is 400, an update and another workspace are not', async () => {
    const w = await world();
    const other = await world();
    const first = await created(w, { enabled: false });
    for (let n = 1; n < 20; n++) await created(w, { enabled: false, label: `Hook ${n}` });
    const over = await save(w, { enabled: false, label: 'One too many' });
    expect(over.statusCode, over.body).toBe(400);
    expect(over.json().error.message).toBe("Couldn't add another destination: the limit is 20.");
    const update = await save(w, { id: first.id, label: 'Renamed', enabled: false });
    expect(update.statusCode, update.body).toBe(200);
    const list = await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination'));
    expect(list).toHaveLength(20);
    expect((await save(other, { enabled: false })).statusCode).toBe(200);
    // a delete frees a place
    await w.client.delete(`/rest/eventbus/destination?id=${first.id}`);
    expect((await save(w, { enabled: false, label: 'Again' })).statusCode).toBe(200);
  });
});

describe('credentials', () => {
  it('accepts a generic auth credential of the workspace', async () => {
    const w = await world();
    const credential = await credentialIn(server, w.tenant.id, w.client.defaultProjectId!, {
      type: 'httpHeaderAuth',
      data: { name: 'X-Auth', value: 'fake-value' },
    });
    const dest = await created(w, { credentialId: credential.id });
    expect(dest.credentialId).toBe(credential.id);
    const cleared = await w.client.data<LogDestination>(save(w, { id: dest.id, credentialId: null }));
    expect(cleared.credentialId ?? null).toBeNull();
  });

  it('another workspace credential is 404, a non-generic type is 400, a missing read right is 403', async () => {
    const a = await world();
    const b = await world();
    const foreign = await credentialIn(server, b.tenant.id, b.client.defaultProjectId!, {
      type: 'httpBasicAuth',
      data: { user: 'u', password: 'p' },
    });
    expect((await save(a, { credentialId: foreign.id })).statusCode).toBe(404);
    expect((await save(a, { credentialId: randomUUID() })).statusCode).toBe(404);
    const plain = await credentialIn(server, a.tenant.id, a.client.defaultProjectId!, { type: 'testApi' });
    expect((await save(a, { credentialId: plain.id })).statusCode).toBe(400);
    const mine = await credentialIn(server, a.tenant.id, a.client.defaultProjectId!, {
      type: 'httpBasicAuth',
      data: { user: 'u', password: 'p' },
    });
    vi.spyOn(server.ctx.access, 'scopesFor').mockResolvedValueOnce(new Set());
    const denied = await save(a, { credentialId: mine.id });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING);
    expect((await save(a, { credentialId: mine.id })).statusCode).toBe(200);
  });

  it('the credential check runs on every save that ends with a credential, and on the test send (R5)', async () => {
    const w = await world();
    const credential = await credentialIn(server, w.tenant.id, w.client.defaultProjectId!, {
      type: 'httpHeaderAuth',
      data: { name: 'X-Auth', value: 'fake-value' },
    });
    const dest = await created(w, { credentialId: credential.id });
    // the credential stays and only the URL changes: the check still runs
    vi.spyOn(server.ctx.access, 'scopesFor').mockResolvedValueOnce(new Set());
    const moved = await save(w, {
      id: dest.id,
      credentialId: credential.id,
      settings: webhook({ url: 'https://other.example.test/in' }),
    });
    expect(moved.statusCode, moved.body).toBe(403);
    expect(moved.json().error.message).toBe(MISSING);
    // a save that names no credential keeps the stored one and is checked too
    vi.spyOn(server.ctx.access, 'scopesFor').mockResolvedValueOnce(new Set());
    const label = await w.client.post('/rest/eventbus/destination', {
      id: dest.id,
      type: 'webhook',
      label: 'Renamed',
    });
    expect(label.statusCode, label.body).toBe(403);
    // the test send is checked
    vi.spyOn(server.ctx.access, 'scopesFor').mockResolvedValueOnce(new Set());
    const tested = await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(tested.statusCode, tested.body).toBe(403);
    expect((await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`)).statusCode).toBe(200);
  });

  it('only a webhook destination takes a credential', async () => {
    const w = await world();
    const credential = await credentialIn(server, w.tenant.id, w.client.defaultProjectId!, {
      type: 'httpBasicAuth',
      data: { user: 'u', password: 'p' },
    });
    const res = await save(w, {
      type: 'syslog',
      settings: { host: 'logs.example.test', port: 514 },
      credentialId: credential.id,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('secrets', () => {
  const secretHook = (url: string, header = 'HEADER-SECRET-1', query = 'QUERY-SECRET-1') =>
    webhook({
      url,
      sendHeaders: true,
      headerParameters: [{ name: 'X-Token', value: header }],
      sendQuery: true,
      queryParameters: [{ name: 'k', value: query }],
    });

  async function stored(w: World, id: string) {
    const { rows } = await server.ctx.database.pool.query(
      'select settings, secrets_enc from log_destinations where id = $1 and tenant_id = $2',
      [id, w.tenant.id],
    );
    return rows[0] as { settings: Record<string, any>; secrets_enc: string | null };
  }

  it('stores secrets encrypted with the logDestination binding and answers them blank', async () => {
    const w = await world();
    const dest = await created(w, {
      settings: secretHook('https://hooks.example.test/in?token=URL-SECRET-1'),
    });
    const text = JSON.stringify(dest);
    for (const secret of ['HEADER-SECRET-1', 'QUERY-SECRET-1', 'URL-SECRET-1'])
      expect(text).not.toContain(secret);
    const settings = dest.settings as ReturnType<typeof webhook>;
    expect(settings.headerParameters).toEqual([{ name: 'X-Token', value: '' }]);
    expect(settings.queryParameters).toEqual([{ name: 'k', value: '' }]);
    expect(settings.url).toContain('token=');
    const list = JSON.stringify(
      await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination')),
    );
    expect(list).not.toContain('HEADER-SECRET-1');
    const row = await stored(w, dest.id);
    expect(JSON.stringify(row.settings)).not.toContain('HEADER-SECRET-1');
    expect(row.secrets_enc).toBeTruthy();
    expect(row.secrets_enc).not.toContain('HEADER-SECRET-1');
    const plain = JSON.stringify(
      server.ctx.cipher.decrypt(row.secrets_enc!, destinationSecretBinding(w.tenant.id, dest.id)),
    );
    expect(plain).toContain('HEADER-SECRET-1');
    expect(() =>
      server.ctx.cipher.decrypt(row.secrets_enc!, destinationSecretBinding(w.tenant.id, randomUUID())),
    ).toThrow();
  });

  it('a blank value on save keeps the stored one while scheme, host and port are unchanged', async () => {
    const w = await world();
    const dest = await created(w, {
      settings: secretHook('https://hooks.example.test/in?token=URL-SECRET-1'),
    });
    const blank = secretHook('https://hooks.example.test/other-path?token=', '', '');
    const updated = await w.client.data<LogDestination>(save(w, { id: dest.id, settings: blank }));
    expect(JSON.stringify(updated)).not.toContain('HEADER-SECRET-1');
    expect((await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`)).statusCode).toBe(200);
    const last = seen.at(-1)!.settings;
    expect(last.headerParameters).toEqual([{ name: 'X-Token', value: 'HEADER-SECRET-1' }]);
    expect(last.queryParameters).toEqual([{ name: 'k', value: 'QUERY-SECRET-1' }]);
    expect(last.url).toBe('https://hooks.example.test/other-path?token=URL-SECRET-1');
  });

  it('a new value replaces the old one, an old one is not kept on a new host', async () => {
    const w = await world();
    const dest = await created(w, { settings: secretHook('https://hooks.example.test/in') });
    await w.client.data(
      save(w, { id: dest.id, settings: secretHook('https://hooks.example.test/in', 'HEADER-SECRET-2', '') }),
    );
    await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(seen.at(-1)!.settings.headerParameters[0].value).toBe('HEADER-SECRET-2');
    expect(seen.at(-1)!.settings.queryParameters[0].value).toBe('QUERY-SECRET-1');

    const moved = await save(w, {
      id: dest.id,
      settings: secretHook('https://evil.example.test/in', '', ''),
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error.message).toBe(
      "Couldn't keep the saved secret values: the endpoint changed. Re-enter them.",
    );
    for (const url of ['http://hooks.example.test/in', 'https://hooks.example.test:8443/in']) {
      const res = await save(w, { id: dest.id, settings: secretHook(url, '', '') });
      expect(res.statusCode, url).toBe(400);
    }
    const reentered = await save(w, {
      id: dest.id,
      settings: secretHook('https://evil.example.test/in', 'HEADER-SECRET-3', 'QUERY-SECRET-3'),
    });
    expect(reentered.statusCode, reentered.body).toBe(200);
    await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(seen.at(-1)!.settings.headerParameters[0].value).toBe('HEADER-SECRET-3');
  });

  it('a blank save cannot move the endpoint with a ? # or backslash before an @ (logstream-1)', async () => {
    const w = await world();
    const dest = await created(w, {
      settings: secretHook('https://hooks.example.test/in?token=URL-SECRET-1'),
    });
    for (const url of [
      'https://evil.example.test?token=&x=@hooks.example.test/in',
      'https://evil.example.test#@hooks.example.test/in?token=',
      'https://evil.example.test\\@hooks.example.test/in?token=',
    ]) {
      const res = await save(w, { id: dest.id, settings: secretHook(url, '', '') });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.message, url).toBe(
        "Couldn't keep the saved secret values: the endpoint changed. Re-enter them.",
      );
    }
    seen.length = 0;
    await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(seen.at(-1)!.settings.url).toBe('https://hooks.example.test/in?token=URL-SECRET-1');
  });

  it('a password with an unencoded @ is split as the URL parser reads it (logstream-1)', async () => {
    const w = await world();
    const dest = await created(w, {
      settings: webhook({ url: 'https://user:pass@word-1@hooks.example.test/in' }),
    });
    expect((dest.settings as { url: string }).url).toBe('https://user:@hooks.example.test/in');
    const { rows } = await server.ctx.database.pool.query(
      'select secrets_enc from log_destinations where id = $1',
      [dest.id],
    );
    const plain = server.ctx.cipher.decrypt<Record<string, string>>(
      rows[0].secrets_enc,
      destinationSecretBinding(w.tenant.id, dest.id),
    );
    expect(plain['url.password']).toBe('pass@word-1');
    const blank = await save(w, {
      id: dest.id,
      settings: webhook({ url: 'https://user:@hooks.example.test/in' }),
    });
    expect(blank.statusCode, blank.body).toBe(200);
    await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(seen.at(-1)!.settings.url).toBe('https://user:pass@word-1@hooks.example.test/in');
  });

  it('keeps the Sentry DSN key for the same host and refuses it for another', async () => {
    const w = await world();
    const dest = await created(w, {
      type: 'sentry',
      settings: { dsn: 'https://SENTRYKEY-1@o1.ingest.example.test/42', sendPayload: true },
    });
    expect(JSON.stringify(dest)).not.toContain('SENTRYKEY-1');
    expect((dest.settings as { dsn: string }).dsn).toBe('https://@o1.ingest.example.test/42');
    const same = await save(w, {
      id: dest.id,
      type: 'sentry',
      settings: { dsn: 'https://@o1.ingest.example.test/43', sendPayload: true },
    });
    expect(same.statusCode, same.body).toBe(200);
    await w.client.post(`/rest/eventbus/testmessage?id=${dest.id}`);
    expect(seen.at(-1)!.settings.dsn).toBe('https://SENTRYKEY-1@o1.ingest.example.test/43');
    const other = await save(w, {
      id: dest.id,
      type: 'sentry',
      settings: { dsn: 'https://@o2.ingest.example.test/43', sendPayload: true },
    });
    expect(other.statusCode).toBe(400);
  });
});
