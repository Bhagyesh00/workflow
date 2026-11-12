/**
 * P6-06 (S5 L3): the 7 public rows under /api/v1/settings/log-streaming, through `ctx.logStreaming` as REST does.
 * A key's scopes are checked per row (`eventBusDestination:list|read|create|update|delete|test`); a member's key
 * never holds them; another workspace's id is 404; secrets come back blank. Senders are the test's own fakes.
 */
import { randomUUID } from 'node:crypto';
import type { LogDestination } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, realMember, resetDatabase, signup, type TestServer } from './helpers';

const MISSING = 'User is missing a scope required to perform this action';
let server: TestServer;
let ip = 1;
let keyCount = 0;
let sends = 0;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  sends = 0;
  for (const type of ['webhook', 'syslog', 'sentry'] as const) {
    server.ctx.logStreaming.registerType(type, {
      create: () => ({
        async send() {
          sends += 1;
        },
      }),
      validate: () => null,
    });
  }
});

const world = () => signup(server.app, { remoteAddress: `127.4.3.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof signup>>;
type Who = { client: World['client'] };

async function keyOf(w: Who, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await w.client.data(
    w.client.post('/rest/api-keys', {
      name: `logstream-${keyCount}-${randomUUID().slice(0, 6)}`,
      ...(scopes ? { scopes } : {}),
    }),
  );
  return made.key as string;
}

const api = (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

const BASE = '/settings/log-streaming';
const webhook = (over: Record<string, unknown> = {}) => ({
  url: 'https://hooks.example.test/in',
  method: 'POST',
  sendQuery: false,
  queryParameters: [],
  sendHeaders: true,
  headerParameters: [{ name: 'X-Token', value: 'PUBLIC-SECRET-1' }],
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
const dest = (over: Record<string, unknown> = {}) => ({
  type: 'webhook',
  label: 'Public hook',
  enabled: true,
  subscribedEvents: ['workflow'],
  settings: webhook(),
  ...over,
});
const dataOf = <T>(res: { json(): any }) => res.json().data as T;

describe('the rows with a full key', () => {
  it('lists event types and runs create, list, read, replace, test and delete', async () => {
    const w = await world();
    const key = await keyOf(w);

    const types = await api(key, 'GET', `${BASE}/event-types`);
    expect(types.statusCode, types.body).toBe(200);
    expect(dataOf<string[]>(types)).toEqual(
      expect.arrayContaining(['workflow.started', 'audit.user.login.success']),
    );

    const made = await api(key, 'POST', `${BASE}/destinations`, dest());
    expect(made.statusCode, made.body).toBe(200);
    const created = dataOf<LogDestination>(made);
    expect(created).toMatchObject({ type: 'webhook', label: 'Public hook', enabled: true });
    expect(made.body).not.toContain('PUBLIC-SECRET-1');

    const list = await api(key, 'GET', `${BASE}/destinations`);
    expect(list.statusCode).toBe(200);
    expect(dataOf<LogDestination[]>(list).map((d) => d.id)).toEqual([created.id]);
    expect(list.body).not.toContain('PUBLIC-SECRET-1');

    const read = await api(key, 'GET', `${BASE}/destinations/${created.id}`);
    expect(read.statusCode).toBe(200);
    expect(dataOf<LogDestination>(read).id).toBe(created.id);

    const put = await api(
      key,
      'PUT',
      `${BASE}/destinations/${created.id}`,
      dest({ label: 'Replaced', enabled: false }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(dataOf<LogDestination>(put)).toMatchObject({ id: created.id, label: 'Replaced', enabled: false });

    const tested = await api(key, 'POST', `${BASE}/destinations/${created.id}/test`);
    expect(tested.statusCode, tested.body).toBe(200);
    expect(dataOf<{ success: boolean }>(tested).success).toBe(true);
    expect(sends).toBe(1);

    const removed = await api(key, 'DELETE', `${BASE}/destinations/${created.id}`);
    expect(removed.statusCode).toBe(200);
    expect((await api(key, 'GET', `${BASE}/destinations/${created.id}`)).statusCode).toBe(404);
  });

  it('answers 400 for a bad body and 404 for an unknown id', async () => {
    const w = await world();
    const key = await keyOf(w);
    expect(
      (await api(key, 'POST', `${BASE}/destinations`, dest({ subscribedEvents: ['nope'] }))).statusCode,
    ).toBe(400);
    expect((await api(key, 'POST', `${BASE}/destinations`, { label: 'no type' })).statusCode).toBe(400);
    expect((await api(key, 'GET', `${BASE}/destinations/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('key scopes', () => {
  it('a key without the destination scopes is 403 on every row', async () => {
    const w = await world();
    const key = await keyOf(w, ['tag:list']);
    const id = randomUUID();
    const calls = [
      await api(key, 'GET', `${BASE}/event-types`),
      await api(key, 'GET', `${BASE}/destinations`),
      await api(key, 'GET', `${BASE}/destinations/${id}`),
      await api(key, 'POST', `${BASE}/destinations`, dest()),
      await api(key, 'PUT', `${BASE}/destinations/${id}`, dest()),
      await api(key, 'DELETE', `${BASE}/destinations/${id}`),
      await api(key, 'POST', `${BASE}/destinations/${id}/test`),
    ];
    for (const res of calls) expect(res.statusCode, res.body).toBe(403);
  });

  it('a key with update and not create updates and cannot create', async () => {
    const w = await world();
    const full = await keyOf(w);
    const created = dataOf<LogDestination>(await api(full, 'POST', `${BASE}/destinations`, dest()));
    const narrow = await keyOf(w, ['eventBusDestination:update']);
    const put = await api(
      narrow,
      'PUT',
      `${BASE}/destinations/${created.id}`,
      dest({ label: 'By narrow key' }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(dataOf<LogDestination>(put).label).toBe('By narrow key');
    const post = await api(narrow, 'POST', `${BASE}/destinations`, dest());
    expect(post.statusCode).toBe(403);
    expect((await api(narrow, 'GET', `${BASE}/destinations`)).statusCode).toBe(403);
    expect((await api(narrow, 'DELETE', `${BASE}/destinations/${created.id}`)).statusCode).toBe(403);
  });

  it('a list key lists and cannot read one, and a read key reads and cannot list', async () => {
    const w = await world();
    const full = await keyOf(w);
    const created = dataOf<LogDestination>(await api(full, 'POST', `${BASE}/destinations`, dest()));
    const lister = await keyOf(w, ['eventBusDestination:list']);
    expect((await api(lister, 'GET', `${BASE}/destinations`)).statusCode).toBe(200);
    expect((await api(lister, 'GET', `${BASE}/event-types`)).statusCode).toBe(200);
    expect((await api(lister, 'GET', `${BASE}/destinations/${created.id}`)).statusCode).toBe(403);
    const reader = await keyOf(w, ['eventBusDestination:read']);
    expect((await api(reader, 'GET', `${BASE}/destinations/${created.id}`)).statusCode).toBe(200);
    expect((await api(reader, 'GET', `${BASE}/destinations`)).statusCode).toBe(403);
    const tester = await keyOf(w, ['eventBusDestination:test']);
    expect((await api(tester, 'POST', `${BASE}/destinations/${created.id}/test`)).statusCode).toBe(200);
    const deleter = await keyOf(w, ['eventBusDestination:delete']);
    expect((await api(deleter, 'DELETE', `${BASE}/destinations/${created.id}`)).statusCode).toBe(200);
  });

  it('a true member cannot give a key the destination scopes, and a plain member key is 403', async () => {
    const w = await world();
    const member = await realMember(w);
    const refused = await member.client.post('/rest/api-keys', {
      name: `member-${randomUUID().slice(0, 6)}`,
      scopes: ['eventBusDestination:list'],
    });
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    const plain = await keyOf(member);
    const res = await api(plain, 'GET', `${BASE}/destinations`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING);
    expect((await api(plain, 'POST', `${BASE}/destinations`, dest())).statusCode).toBe(403);
  });
});

describe('another workspace', () => {
  it('its destination id is 404 on read, replace, delete and test, and it never shows in a list', async () => {
    const a = await world();
    const b = await world();
    const keyA = await keyOf(a);
    const keyB = await keyOf(b);
    const created = dataOf<LogDestination>(await api(keyA, 'POST', `${BASE}/destinations`, dest()));
    expect((await api(keyB, 'GET', `${BASE}/destinations/${created.id}`)).statusCode).toBe(404);
    expect((await api(keyB, 'PUT', `${BASE}/destinations/${created.id}`, dest())).statusCode).toBe(404);
    expect((await api(keyB, 'DELETE', `${BASE}/destinations/${created.id}`)).statusCode).toBe(404);
    expect((await api(keyB, 'POST', `${BASE}/destinations/${created.id}/test`)).statusCode).toBe(404);
    expect(dataOf<LogDestination[]>(await api(keyB, 'GET', `${BASE}/destinations`))).toEqual([]);
    expect((await api(keyA, 'GET', `${BASE}/destinations/${created.id}`)).statusCode).toBe(200);
  });
});
