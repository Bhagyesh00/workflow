/** P5-50 Xata memory: recorded REST calls from a fake Xata, tenant scoping, endpoint error. */
import type { HttpRequestOptions } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { connect, FakeHttpClient, node, run, scriptModel, services, toolNodeTypes } from './harness';

const ENDPOINT = 'https://ws-1.us-east-1.xata.sh/db/chatdb';
const creds = (databaseEndpoint = ENDPOINT) => ({
  xataApi: { databaseEndpoint, branch: 'main', apiKey: 'xau_test' },
});

type Reply = { status?: number; body: unknown };

/** in-memory Xata: records of one table, ids in creation order; `table` false means the table does not exist yet */
function fakeXata(options: { table?: boolean; query?: (index: number) => Reply; schemaError?: number } = {}) {
  const rows: Array<Record<string, any>> = [];
  let n = 0;
  let queries = 0;
  let exists = options.table ?? false;
  const created: { columns?: Array<{ name: string; type: string }> } = {};
  const handler = (req: HttpRequestOptions) => {
    const url = String(req.url);
    const body = req.body as any;
    if (url.endsWith('/schema')) {
      if (req.method === 'PUT') {
        created.columns = body.columns;
        return { body: {} };
      }
      if (options.schemaError) return { status: options.schemaError, body: { message: 'nope' } };
      return exists
        ? { body: { columns: created.columns ?? [] } }
        : { status: 404, body: { message: 'table not found' } };
    }
    if (req.method === 'PUT' && /\/tables\/[^/]+$/.test(url)) {
      exists = true;
      return { status: 201, body: {} };
    }
    if (url.endsWith('/query')) {
      if (options.query) return options.query(queries++);
      const want = body.filter.sessionId.$is;
      let found = rows.filter((r) => r.sessionId === want);
      if (body.sort['xata.createdAt'] === 'desc') found = [...found].reverse();
      return { body: { records: found.slice(0, body.page.size), meta: { page: { more: false } } } };
    }
    if (req.method === 'POST' && url.endsWith('/data')) {
      rows.push({ ...body, id: `rec${++n}` });
      return { status: 201, body: { id: `rec${n}` } };
    }
    const del = /\/data\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && del) {
      const i = rows.findIndex((r) => r.id === del[1]);
      if (i >= 0 && !options.query) rows.splice(i, 1);
      return { body: {} };
    }
    return { status: 404, body: {} };
  };
  return { rows, created, http: new FakeHttpClient(handler) };
}

const memNode = () =>
  node(
    'Mem',
    'ai.memoryXata',
    { sessionIdType: 'customKey', sessionKey: 's1' },
    { credentials: { xataApi: { id: 'x', name: 'x' } } },
  );

async function converse(http: FakeHttpClient, tenantId = 't1', endpoint = ENDPOINT, text = 'ok') {
  scriptModel('Model', [text]);
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'hello' }),
      node('Model', 'test.fakeChatModel'),
      memNode(),
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Mem', 'Agent', 'ai_memory']),
    {
      nodeTypes: toolNodeTypes,
      services: services({ nodeTypes: toolNodeTypes, creds: creds(endpoint), http, tenantId }),
    },
  );
}

beforeEach(() => clearBufferMemory());

describe('P5-50 Xata memory', () => {
  it('appends a turn and loads it on the next run, keyed by tenant and session', async () => {
    const x = fakeXata({ table: true });
    expect((await converse(x.http, 't1', ENDPOINT, 'first')).status).toBe('success');
    expect(x.rows.map((r) => [r.sessionId, r.type, r.content])).toEqual([
      ['t1:s1', 'human', 'hello'],
      ['t1:s1', 'ai', 'first'],
    ]);
    expect(x.http.requests.find((r) => String(r.url).endsWith('/query'))?.url).toBe(
      `${ENDPOINT}:main/tables/chatdb/query`,
    );
    expect((await converse(x.http, 't1', ENDPOINT, 'second')).status).toBe('success');
    expect(x.rows).toHaveLength(4);
  });

  it('another tenant sees nothing of the history', async () => {
    const x = fakeXata({ table: true });
    await converse(x.http, 't1');
    x.http.requests.length = 0;
    await converse(x.http, 't2');
    const queries = x.http.requests.filter((r) => String(r.url).endsWith('/query'));
    expect((queries[0].body as any).filter.sessionId.$is).toBe('t2:s1');
    expect(x.rows.filter((r) => r.sessionId === 't2:s1')).toHaveLength(2);
    expect(x.rows.filter((r) => r.sessionId === 't1:s1')).toHaveLength(2);
  });

  it('reports an endpoint without a database', async () => {
    const x = fakeXata();
    const r = await converse(x.http, 't1', 'https://example.com/nothing');
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain(
      'It was not possible to extract the table from the Database Endpoint.',
    );
    expect(x.http.requests).toHaveLength(0);
  });

  it('loadAll, replace and clear through the Memory Manager', async () => {
    const x = fakeXata({ table: true });
    const manage = async (parameters: Record<string, unknown>) => {
      const r = await run(
        [node('Trigger', 'test.trigger'), node('Manager', 'ai.memoryManager', parameters), memNode()],
        connect(['Trigger', 'Manager'], ['Mem', 'Manager', 'ai_memory']),
        {
          nodeTypes: toolNodeTypes,
          services: services({ nodeTypes: toolNodeTypes, creds: creds(), http: x.http }),
        },
      );
      expect(r.status, JSON.stringify(r.error)).toBe('success');
      return r;
    };
    const rows = (list: Array<[string, string]>) => ({
      messageValues: list.map(([type, message]) => ({ type, message, hideFromUI: false })),
    });
    await manage({
      mode: 'insert',
      messages: rows([
        ['user', 'a'],
        ['ai', 'b'],
        ['user', 'c'],
      ]),
    });
    const loaded = await manage({ mode: 'load', simplifyOutput: false });
    expect((loaded.output('Manager')[0].messages as any[]).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    await manage({ mode: 'insert', insertMode: 'override', messages: rows([['user', 'z']]) });
    expect(x.rows.map((r) => r.content)).toEqual(['z']);
    await manage({ mode: 'delete', deleteMode: 'all' });
    expect(x.rows).toHaveLength(0);
  });

  it('creates the table with its six columns on first use, as n8n does, and only once', async () => {
    const x = fakeXata();
    expect((await converse(x.http)).status).toBe('success');
    const calls = x.http.requests.map((r) => `${r.method} ${String(r.url).replace(`${ENDPOINT}:main`, '')}`);
    expect(calls.slice(0, 3)).toEqual([
      'GET /tables/chatdb/schema',
      'PUT /tables/chatdb',
      'PUT /tables/chatdb/schema',
    ]);
    expect(x.created.columns?.map((c) => c.name)).toEqual([
      'sessionId',
      'type',
      'role',
      'content',
      'name',
      'additionalKwargs',
    ]);
    x.http.requests.length = 0;
    expect((await converse(x.http, 't1', ENDPOINT, 'second')).status).toBe('success');
    expect(x.http.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('keeps an existing table and passes a schema error other than 404 through', async () => {
    const x = fakeXata({ table: true });
    await converse(x.http);
    expect(x.http.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    const denied = fakeXata({ schemaError: 401 });
    const r = await converse(denied.http);
    expect(r.status).toBe('error');
    expect(denied.http.requests.filter((q) => q.method === 'PUT')).toHaveLength(0);
  });

  it('writes one record per message, in order, and never a bulk call', async () => {
    const x = fakeXata({ table: true });
    await converse(x.http, 't1', ENDPOINT, 'first');
    const writes = x.http.requests.filter((r) => r.method === 'POST' && !String(r.url).endsWith('/query'));
    expect(writes.map((r) => String(r.url).replace(`${ENDPOINT}:main`, ''))).toEqual([
      '/tables/chatdb/data',
      '/tables/chatdb/data',
    ]);
    expect(writes.map((r) => (r.body as any).type)).toEqual(['human', 'ai']);
    expect(x.http.requests.some((r) => String(r.url).endsWith('/bulk'))).toBe(false);
  });

  it('keeps the hide flag in additionalKwargs and writes no hideFromUI column', async () => {
    const x = fakeXata({ table: true });
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Manager', 'ai.memoryManager', {
          mode: 'insert',
          messages: {
            messageValues: [
              { type: 'user', message: 'a', hideFromUI: true },
              { type: 'ai', message: 'b', hideFromUI: false },
            ],
          },
        }),
        memNode(),
      ],
      connect(['Trigger', 'Manager'], ['Mem', 'Manager', 'ai_memory']),
      {
        nodeTypes: toolNodeTypes,
        services: services({ nodeTypes: toolNodeTypes, creds: creds(), http: x.http }),
      },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(x.rows.map((row) => [row.type, row.additionalKwargs, 'hideFromUI' in row])).toEqual([
      ['human', '{"hideFromUI":true}', false],
      ['ai', '{}', false],
    ]);
    const loaded = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Manager', 'ai.memoryManager', { mode: 'load', simplifyOutput: false }),
        memNode(),
      ],
      connect(['Trigger', 'Manager'], ['Mem', 'Manager', 'ai_memory']),
      {
        nodeTypes: toolNodeTypes,
        services: services({ nodeTypes: toolNodeTypes, creds: creds(), http: x.http }),
      },
    );
    expect((loaded.output('Manager')[0].messages as any[]).map((m) => m.content)).toEqual(['a', 'b']);
  });

  describe('bounded reads', () => {
    const manager = (http: FakeHttpClient, parameters: Record<string, unknown>) =>
      run(
        [node('Trigger', 'test.trigger'), node('Manager', 'ai.memoryManager', parameters), memNode()],
        connect(['Trigger', 'Manager'], ['Mem', 'Manager', 'ai_memory']),
        { nodeTypes: toolNodeTypes, services: services({ nodeTypes: toolNodeTypes, creds: creds(), http }) },
      );

    it('a session that never ends stops at the page cap with a too-many-records error', async () => {
      const x = fakeXata({
        table: true,
        query: (i) => ({ body: { records: [], meta: { page: { more: true, cursor: `c${i}` } } } }),
      });
      const r = await manager(x.http, { mode: 'load', simplifyOutput: false });
      expect(r.status).toBe('error');
      expect(r.error?.message).toContain('The session holds more than 100000 records');
      expect(x.http.requests.filter((q) => String(q.url).endsWith('/query'))).toHaveLength(500);
    });

    it('a repeated page cursor stops the read', async () => {
      const x = fakeXata({
        table: true,
        query: () => ({ body: { records: [], meta: { page: { more: true, cursor: 'same' } } } }),
      });
      const r = await manager(x.http, { mode: 'load', simplifyOutput: false });
      expect(r.status).toBe('error');
      expect(r.error?.message).toContain('same page cursor twice');
      expect(x.http.requests.filter((q) => String(q.url).endsWith('/query'))).toHaveLength(2);
    });

    it('a delete that removes nothing stops after the second round', async () => {
      const x = fakeXata({
        table: true,
        query: () => ({
          body: { records: [{ id: 'rec1' }, { id: 'rec2' }], meta: { page: { more: false } } },
        }),
      });
      const r = await manager(x.http, { mode: 'delete', deleteMode: 'all' });
      expect(r.status).toBe('error');
      expect(r.error?.message).toContain('Xata did not delete the records');
      expect(x.http.requests.filter((q) => q.method === 'DELETE')).toHaveLength(2);
    });
  });
});
