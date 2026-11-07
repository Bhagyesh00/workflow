/**
 * MongoDB Chat Memory against the atlas-local test server (MONGO_TEST_URL), database p5s2_memory,
 * dropped after the run. Every connection of the node goes through the loopback SOCKS5 guard.
 */
import { HttpClient } from '@workflow/core';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryMongoDbChatNode } from '../src/nodes/memory/MemoryMongoDbChat.node';
import { mongoDbConnectionTest } from '../src/shared/mongo';
import { sharedResourceCount } from '../src/shared/shared-resource';
import { connect, MONGO_TEST_URL, node, run, services } from './harness';

const DATABASE = 'p5s2_memory';
const suffix = `${process.pid}_${Date.now()}`;
const COLLECTION = `chat_${suffix}`;
const MONGO_CREDENTIALS: DataObject = {
  configurationType: 'connectionString',
  connectionString: MONGO_TEST_URL,
  database: DATABASE,
};

const http = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
const raw = new MongoClient(MONGO_TEST_URL, { serverSelectionTimeoutMS: 10_000 });

beforeAll(async () => {
  await raw.connect();
});
afterAll(async () => {
  await raw.db(DATABASE).dropDatabase();
  await raw.close();
});

let counter = 0;
const newSession = () => `mg_${suffix}_${++counter}`;

function memoryNode(parameters: DataObject): WorkflowNode {
  return node(
    'Memory',
    'ai.memoryMongoDbChat',
    { collectionName: COLLECTION, contextWindowLength: 1, ...parameters },
    { credentials: { mongoDb: { id: 'm', name: 'm' } } },
  );
}

async function manage(
  session: string,
  parameters: DataObject,
  options: { tenantId?: string; creds?: DataObject; memory?: DataObject; items?: DataObject[] } = {},
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Manager', 'ai.memoryManager', parameters),
      memoryNode({ sessionIdType: 'customKey', sessionKey: session, ...options.memory }),
    ],
    connect(['Trigger', 'Manager'], ['Memory', 'Manager', 'ai_memory']),
    {
      triggerItems: (options.items ?? [{}]).map((json) => ({ json })),
      services: services({
        creds: { mongoDb: options.creds ?? MONGO_CREDENTIALS },
        tenantId: options.tenantId ?? 't1',
      }),
    },
  );
}

async function ok(r: Awaited<ReturnType<typeof manage>>) {
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r;
}

function insert(session: string, rows: Array<[type: string, message: string]>, tenantId = 't1') {
  return manage(
    session,
    { mode: 'insert', messages: { messageValues: rows.map(([type, message]) => ({ type, message })) } },
    { tenantId },
  ).then(ok);
}

async function contents(session: string, tenantId = 't1'): Promise<string[]> {
  const r = await ok(await manage(session, { mode: 'load', simplifyOutput: false }, { tenantId }));
  return (r.output('Manager')[0].messages as DataObject[]).map((m) => String(m.content));
}

describe('MongoDB Chat Memory', () => {
  it('describes the n8n parameters with our tenant collection default', () => {
    const props = MemoryMongoDbChatNode.description.properties.map((p) => [p.name, p.default]);
    expect(props).toEqual([
      ['sessionIdType', 'fromInput'],
      ['sessionKey', ''],
      ['collectionName', 'ai_chat_histories'],
      ['databaseName', ''],
      ['contextWindowLength', 5],
    ]);
    expect(MemoryMongoDbChatNode.description.credentials).toEqual([
      { name: 'mongoDb', required: true, testedBy: 'mongoDbConnectionTest' },
    ]);
  });

  it('keeps the history for a new client (a restart) and stores tenant, session, message and time', async () => {
    const s = newSession();
    await insert(s, [
      ['user', 'hello'],
      ['ai', 'hi there'],
    ]);
    // the run released its client: nothing stays open between executions
    expect(sharedResourceCount()).toBe(0);
    expect(await contents(s)).toEqual(['hello', 'hi there']);

    const docs = await raw
      .db(DATABASE)
      .collection(COLLECTION)
      .find({ sessionId: s })
      .sort({ _id: 1 })
      .toArray();
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      tenantId: 't1',
      sessionId: s,
      message: { role: 'user', content: 'hello' },
    });
    expect(docs[0].createdAt).toBeInstanceOf(Date);
    const indexes = await raw.db(DATABASE).collection(COLLECTION).indexes();
    expect(
      indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ tenantId: 1, sessionId: 1, _id: 1 })),
    ).toBe(true);
  });

  it('shows another tenant nothing and never deletes its history', async () => {
    const s = newSession();
    await insert(s, [['user', 'mine']]);
    expect(await contents(s, 't2')).toEqual([]);
    await ok(await manage(s, { mode: 'delete', deleteMode: 'all' }, { tenantId: 't2' }));
    expect(await contents(s)).toEqual(['mine']);
  });

  it('delete last N keeps the older messages beyond the window', async () => {
    const s = newSession();
    await insert(s, [
      ['user', 'm1'],
      ['ai', 'm2'],
      ['user', 'm3'],
      ['ai', 'm4'],
      ['user', 'm5'],
      ['ai', 'm6'],
    ]);
    const deleted = await ok(await manage(s, { mode: 'delete', deleteMode: 'lastN', lastMessagesCount: 2 }));
    expect((deleted.output('Manager')[0].messages as DataObject[]).map((m) => m.content)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
    expect(await contents(s)).toEqual(['m1', 'm2', 'm3', 'm4']);
    await ok(
      await manage(s, {
        mode: 'insert',
        insertMode: 'override',
        messages: { messageValues: [{ type: 'user', message: 'fresh' }] },
      }),
    );
    expect(await contents(s)).toEqual(['fresh']);
  });

  it('gives the model only the window', async () => {
    const s = newSession();
    await insert(s, [
      ['user', 'a'],
      ['ai', 'b'],
      ['user', 'c'],
      ['ai', 'd'],
    ]);
    const supplied = await MemoryMongoDbChatNode.supplyData!(
      {
        getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
          (
            ({
              sessionIdType: 'customKey',
              sessionKey: s,
              collectionName: COLLECTION,
              databaseName: '',
              contextWindowLength: 1,
            }) as DataObject
          )[name] ?? fallback,
        getCredentials: async () => MONGO_CREDENTIALS,
        helpers: {
          resolveAllowedHost: (host: string) => http.resolveAllowedHost(host),
          assertHostAllowed: (host: string) => http.assertHostAllowed(host),
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        logSubNodeRun() {},
        getTenantId: () => 't1',
        getExecutionId: () => `window-${suffix}`,
        getNode: () => memoryNode({}),
      } as never,
      0,
    );
    const memory = supplied.response as import('../src/shared/ai-inputs').SessionMemory;
    try {
      expect((await memory.load(s)).map((m) => m.content)).toEqual(['c', 'd']);
      expect((await memory.loadAll(s)).map((m) => m.content)).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      await supplied.closeFunction?.();
    }
  });

  it('refuses an object session id', async () => {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Manager', 'ai.memoryManager', { mode: 'load' }),
        memoryNode({ sessionIdType: 'fromInput' }),
      ],
      connect(['Trigger', 'Manager'], ['Memory', 'Manager', 'ai_memory']),
      {
        triggerItems: [{ json: { sessionId: { $ne: null } } }],
        services: services({ creds: { mongoDb: MONGO_CREDENTIALS } }),
      },
    );
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.error)).toContain('Invalid session ID');
  });

  it('needs a database name from the credential or the node', async () => {
    const s = newSession();
    const creds = { configurationType: 'connectionString', connectionString: MONGO_TEST_URL };
    const missing = await manage(s, { mode: 'load' }, { creds });
    expect(missing.status).toBe('error');
    expect(JSON.stringify(missing.error)).toContain(
      'Database name must be provided either in credentials or in node parameters',
    );
    await ok(await manage(s, { mode: 'load' }, { creds, memory: { databaseName: DATABASE } }));
  });

  it('passes the credential test through the guard', async () => {
    const ctx = {
      helpers: {
        resolveAllowedHost: (host: string) => http.resolveAllowedHost(host),
        assertHostAllowed: (host: string) => http.assertHostAllowed(host),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      getTenantId: () => 't1',
    };
    expect(await mongoDbConnectionTest(ctx, { type: 'mongoDb', data: MONGO_CREDENTIALS })).toEqual({
      status: 'OK',
      message: 'Connection successful',
    });
    const wrong = await mongoDbConnectionTest(ctx, {
      type: 'mongoDb',
      data: {
        configurationType: 'connectionString',
        connectionString: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1000',
      },
    });
    expect(wrong.status).toBe('Error');
    expect(wrong.message).not.toContain('mongodb://');
  });
});
