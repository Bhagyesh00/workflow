/** P5-51 Lakebase client: https host only, table URL, paging, list searches. A hand-made context records the calls. */
import type { HttpRequestOptions, LoadOptionsContext } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  LAKEBASE_MAX_PAGES,
  LAKEBASE_PAGE_SIZE,
  lakebaseHttpsHost,
  lakebaseListSearch,
  lakebaseLocatorProperties,
  lakebaseRequest,
  lakebaseSelectAll,
  lakebaseTableUrl,
} from '../src/utils/databricks-lakebase';

const HOST = 'https://adb-1.7.azuredatabricks.net';
const TARGET = { project: 'p', branch: 'b', database: 'db1', schema: 'public', table: 'chats' };

type Answer = { body: unknown; headers?: Record<string, string> };

function fakeCtx(answer: (req: HttpRequestOptions) => Answer, host = HOST, params: Record<string, unknown> = {}) {
  const calls: Array<{ type: string; req: HttpRequestOptions }> = [];
  const ctx = {
    getCredentials: async () => ({ host }),
    getCurrentNodeParameter: (name: string) => params[name],
    helpers: {
      httpRequestWithAuthentication: async (type: string, req: HttpRequestOptions) => {
        calls.push({ type, req });
        const a = answer(req);
        return req.returnFullResponse ? { body: a.body, headers: a.headers ?? {}, statusCode: 200, statusMessage: 'OK' } : a.body;
      },
    },
  };
  return { ctx: ctx as unknown as LoadOptionsContext, calls };
}

const workspace = (req: HttpRequestOptions): Answer | undefined =>
  req.url.endsWith('/current-metastore-assignment') ? { body: { workspace_id: 42 } } : undefined;

describe('lakebaseHttpsHost', () => {
  it('keeps an https origin and refuses http, credentials, query and fragment', () => {
    expect(lakebaseHttpsHost(`${HOST}/`)).toBe(HOST);
    for (const bad of ['http://x.databricks.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'nope', '']) {
      expect(() => lakebaseHttpsHost(bad), bad).toThrow(/https URL/);
    }
  });
});

describe('lakebaseRequest', () => {
  it('sends on databricksOAuth2Api without following redirects', async () => {
    const { ctx, calls } = fakeCtx(() => ({ body: { ok: true } }));
    await lakebaseRequest(ctx, 0, { url: `${HOST}/api/x`, method: 'GET' });
    expect(calls[0].type).toBe('databricksOAuth2Api');
    expect(calls[0].req.followRedirects).toBe(false);
  });

  it('refuses an http credential host and a URL on another host before any call', async () => {
    const http = fakeCtx(() => ({ body: {} }), 'http://adb-1.databricks.com');
    await expect(lakebaseRequest(http.ctx, 0, { url: 'http://adb-1.databricks.com/x' })).rejects.toThrow(/https URL/);
    expect(http.calls).toHaveLength(0);
    const other = fakeCtx(() => ({ body: {} }));
    await expect(lakebaseRequest(other.ctx, 0, { url: 'https://evil.example/x' })).rejects.toThrow(/host of the Databricks credential/);
    expect(other.calls).toHaveLength(0);
  });
});

describe('lakebaseTableUrl', () => {
  it('builds the Data API URL from the workspace id', async () => {
    const { ctx, calls } = fakeCtx((r) => workspace(r)!);
    expect(await lakebaseTableUrl(ctx, 0, TARGET)).toBe(`${HOST}/api/2.0/workspace/42/rest/db1/public/chats`);
    expect(calls[0].req.url).toBe(`${HOST}/api/2.1/unity-catalog/current-metastore-assignment`);
  });

  it('refuses a table or schema name that is not a plain name', async () => {
    const { ctx } = fakeCtx((r) => workspace(r)!);
    await expect(lakebaseTableUrl(ctx, 0, { ...TARGET, table: 'a/b' })).rejects.toThrow(/table name/);
    await expect(lakebaseTableUrl(ctx, 0, { ...TARGET, schema: 'a/../b' })).rejects.toThrow(/schema/);
  });

  it('fails when the workspace id is missing', async () => {
    const { ctx } = fakeCtx(() => ({ body: {} }));
    await expect(lakebaseTableUrl(ctx, 0, TARGET)).rejects.toThrow(/workspace id/);
  });
});

describe('lakebaseSelectAll', () => {
  const rowsOf = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

  it('pages by Content-Range with Prefer: count=exact', async () => {
    const { ctx, calls } = fakeCtx((req) => {
      const offset = Number(req.qs?.offset);
      const n = Math.min(LAKEBASE_PAGE_SIZE, 2300 - offset);
      return { body: rowsOf(n, offset), headers: { 'Content-Range': `${offset}-${offset + n - 1}/2300` } };
    });
    const { rows, truncated } = await lakebaseSelectAll(ctx, 0, `${HOST}/t`, { order: 'id.asc' });
    expect(rows).toHaveLength(2300);
    expect(truncated).toBe(false);
    expect(calls.map((c) => c.req.qs?.offset)).toEqual([0, 1000, 2000]);
    expect(calls[0].req.headers).toMatchObject({ prefer: 'count=exact' });
    expect(calls[0].req.qs).toMatchObject({ order: 'id.asc', limit: 1000 });
  });

  it('stops at 100 pages and says rows were left', async () => {
    const { ctx, calls } = fakeCtx((req) => {
      const offset = Number(req.qs?.offset);
      return { body: rowsOf(LAKEBASE_PAGE_SIZE, offset), headers: { 'content-range': `${offset}-${offset + 999}/9999999` } };
    });
    const { rows, truncated } = await lakebaseSelectAll(ctx, 0, `${HOST}/t`, {});
    expect(calls).toHaveLength(LAKEBASE_MAX_PAGES);
    expect(rows).toHaveLength(LAKEBASE_PAGE_SIZE * LAKEBASE_MAX_PAGES);
    expect(truncated).toBe(true);
  });

  it('without a Content-Range, a short page ends the read', async () => {
    const { ctx, calls } = fakeCtx(() => ({ body: rowsOf(3) }));
    const { rows } = await lakebaseSelectAll(ctx, 0, `${HOST}/t`, {});
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});

describe('list searches', () => {
  it('names match the locators', () => {
    const modes = lakebaseLocatorProperties.map((p) => (p.modes?.[0] as any).typeOptions.searchListMethod);
    expect(modes).toEqual(Object.keys(lakebaseListSearch));
  });

  it('lists projects, filters them and passes the page token on', async () => {
    const { ctx, calls } = fakeCtx(() => ({
      body: {
        projects: [
          { name: 'projects/alpha', status: { display_name: 'Alpha' } },
          { name: 'projects/beta' },
        ],
        next_page_token: 'tok',
      },
    }));
    const all = await lakebaseListSearch.projects(ctx);
    expect(all.results).toEqual([
      { name: 'Alpha', value: 'alpha' },
      { name: 'beta', value: 'beta' },
    ]);
    expect(all.paginationToken).toBe('tok');
    expect((await lakebaseListSearch.projects(ctx, 'alp')).results.map((r) => r.value)).toEqual(['alpha']);
    await lakebaseListSearch.projects(ctx, undefined, 'tok');
    expect(calls[0].req.url).toBe(`${HOST}/api/2.0/postgres/projects`);
    expect(calls[2].req.qs).toEqual({ page_token: 'tok' });
  });

  it('branches and databases read the locators before them, encoded', async () => {
    const { ctx, calls } = fakeCtx(
      () => ({ body: { branches: [{ name: 'projects/p/branches/main' }], databases: [{ name: 'x/databases/d1' }] } }),
      HOST,
      { project: { __rl: true, mode: 'id', value: 'p-1' }, branch: 'main' },
    );
    expect((await lakebaseListSearch.branches(ctx)).results).toEqual([{ name: 'main', value: 'main' }]);
    expect(calls[0].req.url).toBe(`${HOST}/api/2.0/postgres/projects/p-1/branches`);
    expect((await lakebaseListSearch.databases(ctx)).results[0].value).toBe('d1');
  });

  it('asks for the earlier locator first and refuses a path-like value', async () => {
    const { ctx } = fakeCtx(() => ({ body: {} }));
    await expect(lakebaseListSearch.branches(ctx)).rejects.toThrow(/Select a project first/);
    const bad = fakeCtx(() => ({ body: {} }), HOST, { project: '../x' });
    await expect(lakebaseListSearch.branches(bad.ctx)).rejects.toThrow(/not a valid name/);
  });
});
