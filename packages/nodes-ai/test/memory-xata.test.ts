/** P5-50 Xata memory: recorded REST calls from a fake Xata, tenant scoping, endpoint error. */
import type { HttpRequestOptions } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { connect, FakeHttpClient, node, run, scriptModel, services, toolNodeTypes } from './harness';

const ENDPOINT = 'https://ws-1.us-east-1.xata.sh/db/chatdb';
const creds = (databaseEndpoint = ENDPOINT) => ({
  xataApi: { databaseEndpoint, branch: 'main', apiKey: 'xau_test' },
});

/** in-memory Xata: records of one table, ids in creation order */
function fakeXata() {
  const rows: Array<Record<string, any>> = [];
  let n = 0;
  const handler = (req: HttpRequestOptions) => {
    const url = String(req.url);
    const body = req.body as any;
    if (url.endsWith('/query')) {
      const want = body.filter.sessionId.$is;
      let found = rows.filter((r) => r.sessionId === want);
      if (body.sort['xata.createdAt'] === 'desc') found = [...found].reverse();
      return { body: { records: found.slice(0, body.page.size), meta: { page: { more: false } } } };
    }
    if (url.endsWith('/bulk')) {
      for (const r of body.records) rows.push({ ...r, id: `rec${++n}` });
      return { body: { recordIDs: [] } };
    }
    const del = /\/data\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && del) {
      const i = rows.findIndex((r) => r.id === del[1]);
      if (i >= 0) rows.splice(i, 1);
      return { body: {} };
    }
    return { status: 404, body: {} };
  };
  return { rows, http: new FakeHttpClient(handler) };
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
    const x = fakeXata();
    expect((await converse(x.http, 't1', ENDPOINT, 'first')).status).toBe('success');
    expect(x.rows.map((r) => [r.sessionId, r.role, r.content])).toEqual([
      ['t1:s1', 'user', 'hello'],
      ['t1:s1', 'assistant', 'first'],
    ]);
    expect(x.http.requests[0].url).toBe(`${ENDPOINT}:main/tables/chatdb/query`);
    expect((await converse(x.http, 't1', ENDPOINT, 'second')).status).toBe('success');
    expect(x.rows).toHaveLength(4);
  });

  it('another tenant sees nothing of the history', async () => {
    const x = fakeXata();
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
    expect(r.error?.message).toContain('It was not possible to extract the table from the Database Endpoint.');
    expect(x.http.requests).toHaveLength(0);
  });

  it('loadAll, replace and clear through the Memory Manager', async () => {
    const x = fakeXata();
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
    await manage({ mode: 'insert', messages: rows([['user', 'a'], ['ai', 'b'], ['user', 'c']]) });
    const loaded = await manage({ mode: 'load', simplifyOutput: false });
    expect((loaded.output('Manager')[0].messages as any[]).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    await manage({ mode: 'insert', insertMode: 'override', messages: rows([['user', 'z']]) });
    expect(x.rows.map((r) => r.content)).toEqual(['z']);
    await manage({ mode: 'delete', deleteMode: 'all' });
    expect(x.rows).toHaveLength(0);
  });
});
