import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromStoredMessage, toStoredMessage } from '../src/nodes/memory/memory-shared';
import { connect, node, PG_CREDENTIALS, REDIS_CREDENTIALS, run, services } from './harness';

const suffix = `${process.pid}_${Date.now()}`;
const REDIS_DB3 = { ...REDIS_CREDENTIALS, database: 3 };

interface Store {
  label: string;
  memory: (session: string) => WorkflowNode;
  creds: Record<string, DataObject>;
}

const table = `ai_mm_test_${suffix}`;
const pgClient = new pg.Client({ ...PG_CREDENTIALS });
const redisClient = new Redis({ host: '127.0.0.1', port: 6379, db: 3, lazyConnect: true });
const redisSessions = new Set<string>();

const stores: Store[] = [
  {
    label: 'Simple memory',
    creds: {},
    memory: (session) =>
      node('Memory', 'ai.memoryBufferWindow', { sessionIdType: 'customKey', sessionKey: session, contextWindowLength: 1 }),
  },
  {
    label: 'Postgres memory',
    creds: { postgres: PG_CREDENTIALS },
    memory: (session) =>
      node(
        'Memory',
        'ai.memoryPostgresChat',
        { sessionIdType: 'customKey', sessionKey: session, tableName: table, contextWindowLength: 1 },
        { credentials: { postgres: { id: 'pg', name: 'pg' } } },
      ),
  },
  {
    label: 'Redis memory',
    creds: { redis: REDIS_DB3 },
    memory: (session) => {
      redisSessions.add(session);
      return node(
        'Memory',
        'ai.memoryRedisChat',
        { sessionIdType: 'customKey', sessionKey: session, contextWindowLength: 1 },
        { credentials: { redis: { id: 'r', name: 'r' } } },
      );
    },
  },
];

beforeAll(async () => {
  await pgClient.connect();
  await redisClient.connect();
});
afterAll(async () => {
  await pgClient.query(`DROP TABLE IF EXISTS "${table}"`);
  await pgClient.end();
  for (const session of redisSessions) {
    await redisClient.del(`wf:ai:chat:t1:${session}`, `wf:ai:chat:t2:${session}`);
  }
  redisClient.disconnect();
});

let counter = 0;
const newSession = () => `mm_${suffix}_${++counter}`;

async function manage(
  store: Store,
  session: string,
  parameters: DataObject,
  tenantId = 't1',
  items = [{ json: {} }],
) {
  const r = await run(
    [node('Trigger', 'test.trigger'), node('Manager', 'ai.memoryManager', parameters), store.memory(session)],
    connect(['Trigger', 'Manager'], ['Memory', 'Manager', 'ai_memory']),
    { triggerItems: items, services: services({ creds: store.creds, tenantId }) },
  );
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r;
}

function insert(
  store: Store,
  session: string,
  rows: Array<[type: string, message: string, hideFromUI?: boolean]>,
  extra: DataObject = {},
) {
  return manage(store, session, {
    mode: 'insert',
    ...extra,
    messages: {
      messageValues: rows.map(([type, message, hideFromUI]) => ({
        type,
        message,
        hideFromUI: hideFromUI ?? false,
      })),
    },
  });
}

type Raw = Array<{ type: string; content: string; additional_kwargs: DataObject }>;

async function loadRaw(store: Store, session: string, tenantId = 't1'): Promise<Raw> {
  const r = await manage(store, session, { mode: 'load', simplifyOutput: false }, tenantId);
  return r.output('Manager')[0].messages as Raw;
}

const contents = (messages: unknown) => (messages as DataObject[]).map((m) => m.content);

describe('stored message shape', () => {
  it('keeps hideFromUI only when true and reads it back', () => {
    expect(toStoredMessage({ role: 'user', content: 'a' })).toEqual({ role: 'user', content: 'a' });
    expect(toStoredMessage({ role: 'user', content: 'a', hideFromUI: false })).toEqual({
      role: 'user',
      content: 'a',
    });
    expect(toStoredMessage({ role: 'assistant', content: 'a', hideFromUI: true })).toEqual({
      role: 'assistant',
      content: 'a',
      hideFromUI: true,
    });
    expect(fromStoredMessage({ role: 'assistant', content: 'a', hideFromUI: true })).toEqual({
      role: 'assistant',
      content: 'a',
      hideFromUI: true,
    });
    expect(fromStoredMessage({ role: 'assistant', content: 'a' })).toEqual({
      role: 'assistant',
      content: 'a',
    });
  });
});

describe.each(stores)('Chat Memory Manager on $label', (store) => {
  it('inserts messages and returns the history after the change', async () => {
    const s = newSession();
    const first = await insert(store, s, [
      ['user', 'hello'],
      ['ai', 'hi there'],
    ]);
    expect(first.output('Manager')[0].messages).toEqual([
      { type: 'human', content: 'hello', additional_kwargs: {} },
      { type: 'ai', content: 'hi there', additional_kwargs: {} },
    ]);
    const second = await insert(store, s, [['system', 'be brief']]);
    expect(contents(second.output('Manager')[0].messages)).toEqual(['hello', 'hi there', 'be brief']);
  });

  it('delete last N keeps the older messages beyond the window', async () => {
    const s = newSession();
    // the window is 1 exchange (2 messages): the other messages must survive a delete
    await insert(store, s, [
      ['user', 'm1'],
      ['ai', 'm2'],
      ['user', 'm3'],
      ['ai', 'm4'],
      ['user', 'm5'],
      ['ai', 'm6'],
    ]);
    const deleted = await manage(store, s, { mode: 'delete', deleteMode: 'lastN', lastMessagesCount: 2 });
    expect(contents(deleted.output('Manager')[0].messages)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await loadRaw(store, s)).map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
    // the default count is 2
    await manage(store, s, { mode: 'delete' });
    expect((await loadRaw(store, s)).map((m) => m.content)).toEqual(['m1', 'm2']);
    // more than stored empties the history
    await manage(store, s, { mode: 'delete', lastMessagesCount: 9 });
    expect(await loadRaw(store, s)).toEqual([]);
  });

  it('delete all clears the conversation', async () => {
    const s = newSession();
    await insert(store, s, [['user', 'x']]);
    const r = await manage(store, s, { mode: 'delete', deleteMode: 'all' });
    expect(r.output('Manager')[0].messages).toEqual([]);
    expect(await loadRaw(store, s)).toEqual([]);
  });

  it('override replaces the whole history', async () => {
    const s = newSession();
    await insert(store, s, [
      ['user', 'old1'],
      ['ai', 'old2'],
    ]);
    const r = await insert(store, s, [['user', 'fresh']], { insertMode: 'override' });
    expect(contents(r.output('Manager')[0].messages)).toEqual(['fresh']);
    expect((await loadRaw(store, s)).map((m) => m.content)).toEqual(['fresh']);
  });

  it('hides messages from the chat and keeps the flag', async () => {
    const s = newSession();
    await insert(store, s, [
      ['user', 'visible'],
      ['ai', 'secret note', true],
    ]);
    const messages = await loadRaw(store, s);
    expect(messages[0].additional_kwargs).toEqual({});
    expect(messages[1].additional_kwargs).toEqual({ hideFromUI: true });
    // a rewrite keeps the flag of the messages that stay
    await insert(store, s, [['user', 'more']]);
    await manage(store, s, { mode: 'delete', lastMessagesCount: 1 });
    expect((await loadRaw(store, s)).map((m) => m.additional_kwargs.hideFromUI ?? false)).toEqual([
      false,
      true,
    ]);
  });

  it('simplifies the output into groups', async () => {
    const s = newSession();
    await insert(store, s, [
      ['user', 'q1'],
      ['ai', 'a1'],
      ['user', 'q2'],
      ['user', 'q3'],
      ['ai', 'a3'],
    ]);
    const grouped = (await manage(store, s, { mode: 'load' })).output('Manager');
    expect(grouped).toEqual([
      { messages: [{ human: 'q1', ai: 'a1' }, { human: 'q2' }, { human: 'q3', ai: 'a3' }], messagesCount: 3 },
    ]);
    const split = await manage(store, s, { mode: 'load', options: { groupMessages: false } });
    expect(split.output('Manager')).toEqual([{ human: 'q1', ai: 'a1' }, { human: 'q2' }, { human: 'q3', ai: 'a3' }]);
    const raw = await manage(store, s, {
      mode: 'load',
      simplifyOutput: false,
      options: { groupMessages: false },
    });
    expect(raw.output('Manager')).toHaveLength(5);
    expect(raw.output('Manager')[0]).toEqual({ type: 'human', content: 'q1', additional_kwargs: {} });
  });

  it('keeps tenants and sessions apart', async () => {
    const s = newSession();
    await insert(store, s, [['user', 'mine']]);
    expect(await loadRaw(store, s, 't2')).toEqual([]);
    await manage(store, s, { mode: 'delete', deleteMode: 'all' }, 't2');
    expect((await loadRaw(store, s)).map((m) => m.content)).toEqual(['mine']);
    expect(await loadRaw(store, newSession())).toEqual([]);
  });
});

describe('Chat Memory Manager storage', () => {
  const [simple, postgres, redis] = stores;

  it('stores the hide flag only when true in Postgres', async () => {
    const s = newSession();
    await insert(postgres, s, [
      ['user', 'a'],
      ['ai', 'b', true],
    ]);
    const rows = await pgClient.query(
      `SELECT message FROM "${table}" WHERE tenant_id = 't1' AND session_id = $1 ORDER BY id`,
      [s],
    );
    expect(rows.rows.map((r) => r.message)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', hideFromUI: true },
    ]);
  });

  it('keeps the order of a replaced history in Postgres', async () => {
    const s = newSession();
    const many = Array.from({ length: 30 }, (_, i): [string, string] => [i % 2 ? 'ai' : 'user', `n${i}`]);
    await insert(postgres, s, many);
    await manage(postgres, s, { mode: 'delete', lastMessagesCount: 4 });
    expect((await loadRaw(postgres, s)).map((m) => m.content)).toEqual(many.slice(0, 26).map((m) => m[1]));
  });

  it('keeps a Redis list in order', async () => {
    const s = newSession();
    await insert(redis, s, [
      ['user', 'a'],
      ['ai', 'b'],
      ['user', 'c'],
    ]);
    await manage(redis, s, { mode: 'delete', lastMessagesCount: 1 });
    const raw = await redisClient.lrange(`wf:ai:chat:t1:${s}`, 0, -1);
    expect(raw.map((x) => JSON.parse(x).content)).toEqual(['a', 'b']);
  });

  it('works for each input item', async () => {
    const s = newSession();
    const r = await manage(
      simple,
      s,
      { mode: 'insert', messages: { messageValues: [{ type: 'user', message: 'x', hideFromUI: false }] } },
      't1',
      [{ json: {} }, { json: {} }],
    );
    expect(r.output('Manager')).toHaveLength(2);
    expect(contents(r.output('Manager')[1].messages)).toEqual(['x', 'x']);
  });
});
