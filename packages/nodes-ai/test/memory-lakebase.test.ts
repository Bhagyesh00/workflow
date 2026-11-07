/** P5-51 Lakebase memory: recorded Data API calls from a fake PostgREST, tenant scoping, errors, host rule. */
import type { HttpRequestOptions } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import {
  connect,
  FakeHttpClient,
  type FakeReply,
  node,
  run,
  scriptModel,
  services,
  toolNodeTypes,
} from './harness';

const HOST = 'https://adb-1.7.azuredatabricks.net';
/** the Data API is the read-write endpoint of the branch, not the workspace host */
const endpointUrl = (branch: string) =>
  `https://ep-${branch}.database.7.azuredatabricks.net/api/2.0/workspace/42/rest/db1/public/ai_chat_histories`;
const TABLE_URL = endpointUrl('main');
const creds = (host = HOST) => ({
  databricksOAuth2Api: { host, grantType: 'pkce', oauthTokenData: { access_token: 'dapi-test-token' } },
});

interface Row {
  id: number;
  session_id: string;
  message: Record<string, unknown>;
}

/** in-memory PostgREST for one table; `fail` answers every table call with that status and body */
function fakeLakebase(fail?: { status: number; body: unknown }, pageTotal?: number) {
  const rows: Row[] = [];
  let n = 0;
  const handler = (req: HttpRequestOptions): FakeReply => {
    const url = new URL(req.url);
    const endpoints = /\/branches\/([^/]+)\/endpoints$/.exec(url.pathname);
    if (endpoints) {
      return {
        body: {
          endpoints: [
            {
              status: {
                endpoint_type: 'ENDPOINT_TYPE_READ_WRITE',
                hosts: { host: `ep-${endpoints[1]}.database.7.azuredatabricks.net` },
              },
            },
          ],
        },
        headers: { 'x-databricks-org-id': '42' },
      };
    }
    if (fail) return { status: fail.status, body: fail.body };
    const filter = String(req.qs?.session_id ?? '');
    const want = filter.startsWith('eq.') ? filter.slice(3) : '';
    if (req.method === 'POST') {
      for (const r of req.body as Array<Omit<Row, 'id'>>) rows.push({ ...r, id: ++n });
      return { status: 201, body: '' };
    }
    if (req.method === 'DELETE') {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].session_id === want) rows.splice(i, 1);
      return { status: 204, body: '' };
    }
    let found = rows.filter((r) => r.session_id === want);
    if (req.qs?.order === 'id.desc') found = [...found].reverse();
    const offset = Number(req.qs?.offset ?? 0);
    const limit = Number(req.qs?.limit ?? 1000);
    const total = pageTotal ?? found.length;
    const page = pageTotal
      ? Array.from({ length: Math.min(limit, total - offset) }, (_, i) => rows[0] ?? { id: i })
      : found.slice(offset, offset + limit);
    return { body: page, headers: { 'content-range': `${offset}-${offset + page.length - 1}/${total}` } };
  };
  return { rows, http: new FakeHttpClient(handler) };
}

const loc = (value: string) => ({ __rl: true, mode: 'id', value });
const memNode = (extra: Record<string, unknown> = {}) =>
  node(
    'Mem',
    'ai.memoryLakebaseChat',
    {
      project: loc('proj'),
      branch: loc('main'),
      database: loc('db1'),
      schema: loc('public'),
      sessionIdType: 'customKey',
      sessionKey: 's1',
      ...extra,
    },
    { credentials: { databricksOAuth2Api: { id: 'd', name: 'd' } } },
  );

async function converse(
  http: FakeHttpClient,
  { tenantId = 't1', host = HOST, text = 'ok', mem = memNode() } = {},
) {
  scriptModel('Model', [text]);
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'hello' }),
      node('Model', 'test.fakeChatModel'),
      mem,
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Mem', 'Agent', 'ai_memory']),
    {
      nodeTypes: toolNodeTypes,
      services: services({ nodeTypes: toolNodeTypes, creds: creds(host), http, tenantId }),
    },
  );
}

const tableCalls = (http: FakeHttpClient, url = TABLE_URL) =>
  http.requests.filter((r) => r.url.startsWith(url));

beforeEach(() => clearBufferMemory());

describe('P5-51 Lakebase memory', () => {
  it('appends a turn and loads it on the next run, keyed by tenant and session', async () => {
    const x = fakeLakebase();
    expect((await converse(x.http, { text: 'first' })).status).toBe('success');
    expect(x.rows.map((r) => [r.session_id, r.message.role, r.message.content])).toEqual([
      ['t1:s1', 'user', 'hello'],
      ['t1:s1', 'assistant', 'first'],
    ]);
    const load = tableCalls(x.http)[0];
    expect(load.method).toBe('GET');
    expect(load.qs).toMatchObject({ session_id: 'eq.t1:s1', order: 'id.desc', limit: 10 });
    expect(x.http.requests.every((r) => (r.headers as any)?.authorization === 'Bearer dapi-test-token')).toBe(
      true,
    );
    const post = tableCalls(x.http).find((r) => r.method === 'POST')!;
    expect(Array.isArray(post.body)).toBe(true);
    expect(post.followRedirects).toBe(false);
    expect((await converse(x.http, { text: 'second' })).status).toBe('success');
    expect(x.rows).toHaveLength(4);
    // the second run read the first turn back
    expect(tableCalls(x.http).filter((r) => r.method === 'GET').length).toBeGreaterThan(1);
  });

  it('another tenant sees nothing of the history', async () => {
    const x = fakeLakebase();
    await converse(x.http, { tenantId: 't1' });
    x.http.requests.length = 0;
    await converse(x.http, { tenantId: 't2' });
    expect(tableCalls(x.http)[0].qs?.session_id).toBe('eq.t2:s1');
    expect(x.rows.filter((r) => r.session_id === 't2:s1')).toHaveLength(2);
    expect(x.rows.filter((r) => r.session_id === 't1:s1')).toHaveLength(2);
  });

  it('a session id with & and = stays one filter value and never reaches the URL text', async () => {
    const x = fakeLakebase();
    const r = await converse(x.http, { mem: memNode({ sessionKey: 'a&b=c#d' }) });
    expect(r.status).toBe('success');
    const call = tableCalls(x.http)[0];
    expect(call.url).toBe(TABLE_URL);
    expect(call.qs?.session_id).toBe('eq.t1:a&b=c#d');
    expect(x.rows[0].session_id).toBe('t1:a&b=c#d');
  });

  it('uses the table name from the node, default ai_chat_histories', async () => {
    const x = fakeLakebase();
    await converse(x.http, { mem: memNode({ lakebaseTable: 'my_chats' }) });
    expect(x.http.requests.some((r) => r.url === TABLE_URL.replace('ai_chat_histories', 'my_chats'))).toBe(
      true,
    );
  });

  it('refuses an http credential host before any request', async () => {
    const x = fakeLakebase();
    const r = await converse(x.http, { host: 'http://adb-1.databricks.com' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/https URL/);
    expect(x.http.requests).toHaveLength(0);
  });

  it('a missing table shows n8n-style text and the SQL to run', async () => {
    const x = fakeLakebase({ status: 404, body: { code: '42P01', message: 'relation does not exist' } });
    const r = await converse(x.http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain(`Table "ai_chat_histories" doesn't exist in schema "public"`);
    expect((r.error as any).description).toContain('CREATE TABLE IF NOT EXISTS "public"."ai_chat_histories"');
  });

  it('a missing grant says so and shows the GRANT, in n8n words', async () => {
    const x = fakeLakebase({
      status: 403,
      body: { code: '42501', message: 'permission denied for table ai_chat_histories' },
    });
    const r = await converse(x.http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('The OAuth2 identity cannot use table public.ai_chat_histories');
    expect((r.error as any).description).toContain('GRANT SELECT, INSERT, DELETE');
    expect((r.error as any).description).toContain('"your-role"');
  });

  it('a 403 that is not a table grant keeps its own message and gets the role hint', async () => {
    const x = fakeLakebase({
      status: 403,
      body: { code: '42501', message: 'permission denied to set role "me"' },
    });
    const r = await converse(x.http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('permission denied to set role "me"');
    expect((r.error as any).description).toContain('GRANT "your-role" TO authenticator');
  });

  it('a PGRST301 answer says to reconnect the credential, and a plain 401 is not called a missing grant', async () => {
    const x = fakeLakebase({
      status: 403,
      body: { code: 'PGRST301', message: 'No suitable key or wrong key type' },
    });
    const r = await converse(x.http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('No suitable key or wrong key type');
    expect((r.error as any).description).toContain('Reconnect the Databricks OAuth2 credential');
    const plain = await converse(fakeLakebase({ status: 401, body: { message: 'Unauthorized' } }).http);
    expect(plain.status).toBe('error');
    expect(plain.error?.message).not.toMatch(/doesn't exist|cannot use table|No permission/);
  });

  it('the branch picks the compute endpoint: two branches with one database name never share a URL', async () => {
    const x = fakeLakebase();
    await converse(x.http, { mem: memNode({ branch: loc('main') }) });
    await converse(x.http, { mem: memNode({ branch: loc('dev') }) });
    expect(tableCalls(x.http, endpointUrl('main')).length).toBeGreaterThan(0);
    expect(tableCalls(x.http, endpointUrl('dev')).length).toBeGreaterThan(0);
    const lookups = x.http.requests.filter((r) => r.url.endsWith('/endpoints')).map((r) => r.url);
    expect(lookups).toEqual([
      `${HOST}/api/2.0/postgres/projects/proj/branches/main/endpoints`,
      `${HOST}/api/2.0/postgres/projects/proj/branches/dev/endpoints`,
    ]);
    // every table call went to one endpoint host; the bearer token stays on the Databricks domain
    expect(x.http.requests.every((r) => new URL(r.url).hostname.endsWith('.azuredatabricks.net'))).toBe(true);
  });

  it('an unrelated server error passes through', async () => {
    const x = fakeLakebase({ status: 500, body: { message: 'boom' } });
    const r = await converse(x.http);
    expect(r.status).toBe('error');
    expect(r.error?.message).not.toMatch(/doesn't exist|No permission/);
  });

  it('loadAll, replace and clear through the Memory Manager', async () => {
    const x = fakeLakebase();
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
    x.http.requests.length = 0;
    await manage({ mode: 'insert', insertMode: 'override', messages: rows([['user', 'z']]) });
    // replace is a DELETE, then one array POST
    expect(
      tableCalls(x.http)
        .map((r) => r.method)
        .filter((m) => m !== 'GET'),
    ).toEqual(['DELETE', 'POST']);
    expect(x.rows.map((r) => r.message.content)).toEqual(['z']);
    await manage({ mode: 'delete', deleteMode: 'all' });
    expect(x.rows).toHaveLength(0);
  });

  it('loadAll pages through Content-Range', async () => {
    const x = fakeLakebase(undefined, 2500);
    const r = await run(
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
    // the paged fake returns blank rows (no stored message): the paging itself is what is checked
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const gets = tableCalls(x.http).filter((q) => q.method === 'GET');
    expect(gets.map((q) => q.qs?.offset)).toEqual([0, 1000, 2000]);
    expect((gets[0].headers as any).prefer).toBe('count=exact');
  });

  it('a session over 1000 x 100 rows ends with the too-many-rows error', async () => {
    const x = fakeLakebase(undefined, 5_000_000);
    const r = await run(
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
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('more than 100000 rows');
  });
});
