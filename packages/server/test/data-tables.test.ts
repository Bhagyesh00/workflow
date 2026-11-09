/**
 * P4-03 data tables on the real database: the /rest routes, the access nodes get, quotas, CSV,
 * dependencies and favorites. Done when: rows written through one workflow's access are read through
 * another's. BODY_LIMIT_MB is 1 here so that a CSV over the body limit is cheap to send.
 */
import { DATA_TABLE_ERRORS, type DataTableFilter, type DataTableRow } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCsv, escapeCsvFormula, parseCsv, previewCsv } from '../src/services/data-table-csv';
import { DataTableSizeCache, quotaStatus, warningBytes } from '../src/services/data-table-size';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  resetDatabase,
  signup as signupFrom,
  type TestServer,
  teamProjectOf,
  testConfig,
} from './helpers';

let server: TestServer;
const signup = () =>
  signupFrom(server.app, {
    remoteAddress: `10.3.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
type Owner = Awaited<ReturnType<typeof signup>>;

beforeAll(async () => {
  server = await createTestServer({ BODY_LIMIT_MB: '1', LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  vi.restoreAllMocks();
});

async function member(owner: Owner, role: 'editor' | 'viewer') {
  return (await memberAs(owner, role)).client;
}

const COLUMNS = [
  { name: 'title', type: 'string' },
  { name: 'score', type: 'number' },
  { name: 'done', type: 'boolean' },
  { name: 'due', type: 'date' },
] as const;

async function makeTable(owner: Owner, name = 'Tasks', columns: readonly unknown[] = COLUMNS) {
  return owner.client.data<{ id: string; name: string; columns: Array<{ id: string; name: string }> }>(
    owner.client.post('/rest/data-tables', { name, columns }),
  );
}

const insert = (owner: Owner, id: string, data: unknown[], returnType = 'all') =>
  owner.client.data(owner.client.post(`/rest/data-tables/${id}/insert`, { data, returnType }));

const rowsOf = async (owner: Owner, id: string, query = '') =>
  owner.client.data<{ count: number; data: DataTableRow[] }>(
    owner.client.get(`/rest/data-tables/${id}/rows?take=250${query}`),
  );

const filterQuery = (filter: unknown) => `&filter=${encodeURIComponent(JSON.stringify(filter))}`;

const errorOf = async (promise: Promise<{ statusCode: number; json(): any }>) => {
  const res = await promise;
  return { status: res.statusCode, message: res.json().error?.message as string };
};

const tableRow = async (id: string) => {
  const { rows } = await server.ctx.database.pool.query<{ next_row_id: string }>(
    'select next_row_id from data_tables where id = $1',
    [id],
  );
  return rows[0];
};

const dataOf = async (tableId: string) => {
  const { rows } = await server.ctx.database.pool.query<{
    row_id: string;
    data: Record<string, unknown>;
    size_bytes: number;
  }>('select row_id, data, size_bytes from data_table_rows where table_id = $1 order by row_id', [tableId]);
  return rows;
};

describe('tables', () => {
  it('creates, reads, renames and deletes a table', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    expect(table.columns.map((c) => c.name)).toEqual(['title', 'score', 'done', 'due']);
    const read = await owner.client.data(owner.client.get(`/rest/data-tables/${table.id}`));
    expect(read.columns.map((c: { position: number }) => c.position)).toEqual([0, 1, 2, 3]);
    expect(typeof read.createdAt).toBe('string');

    const renamed = await owner.client.data(
      owner.client.patch(`/rest/data-tables/${table.id}`, { name: '  Renamed  ' }),
    );
    expect(renamed.name).toBe('Renamed');

    await owner.client.data(owner.client.delete(`/rest/data-tables/${table.id}`));
    const gone = await errorOf(owner.client.get(`/rest/data-tables/${table.id}`));
    expect(gone).toEqual({ status: 404, message: DATA_TABLE_ERRORS.tableIdNotFound(table.id) });
  });

  it("refuses a name the workspace already has with n8n's text, and allows it elsewhere", async () => {
    const owner = await signup();
    await makeTable(owner, 'Same');
    const res = await errorOf(owner.client.post('/rest/data-tables', { name: 'Same', columns: [] }));
    expect(res).toEqual({ status: 409, message: DATA_TABLE_ERRORS.tableNameExists('Same') });
    const other = await makeTable(owner, 'Other');
    const rename = await errorOf(owner.client.patch(`/rest/data-tables/${other.id}`, { name: 'Same' }));
    expect(rename.status).toBe(409);
    const someoneElse = await signup();
    expect((await makeTable(someoneElse, 'Same')).name).toBe('Same');
  });

  it('lists with a name search, sort and offset paging, and a count', async () => {
    const owner = await signup();
    for (const name of ['Bravo', 'alpha', 'Charlie_x']) await makeTable(owner, name, []);
    const url = '/rest/data-tables';
    const names = async (query: string) =>
      (await owner.client.data(owner.client.get(`${url}${query}`))).data.map((t: { name: string }) => t.name);
    const ascending = await names('?sortBy=name:asc');
    expect([...ascending].sort()).toEqual(['Bravo', 'Charlie_x', 'alpha']);
    expect(await names('?sortBy=name:desc')).toEqual([...ascending].reverse());
    const paged = await owner.client.data(owner.client.get(`${url}?sortBy=createdAt:asc&take=1&skip=1`));
    expect(paged.count).toBe(3);
    expect(paged.data).toHaveLength(1);
    const search = (name: string) => `${url}?filter=${encodeURIComponent(JSON.stringify({ name }))}`;
    const found = await owner.client.data(owner.client.get(search('ALPH')));
    expect(found.data.map((t: { name: string }) => t.name)).toEqual(['alpha']);
    // % and _ in the search are plain characters
    expect((await owner.client.data(owner.client.get(search('%')))).count).toBe(0);
    expect((await owner.client.data(owner.client.get(search('e_x')))).count).toBe(1);
  });

  it('writes audit rows without any cell value', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'secret-cell' }]);
    const { rows } = await server.ctx.database.pool.query<{ action: string; metadata: unknown }>(
      'select action, metadata from audit_log where tenant_id = $1 and resource_id = $2',
      [owner.tenant.id, table.id],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['dataTable.created', 'dataTable.rows.inserted']),
    );
    expect(JSON.stringify(rows)).not.toContain('secret-cell');
  });
});

describe('columns', () => {
  it("refuses bad names with n8n's texts", async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const add = (name: string) =>
      errorOf(owner.client.post(`/rest/data-tables/${table.id}/columns`, { name, type: 'string' }));
    expect((await add('1bad')).status).toBe(400);
    expect((await add('a-b')).status).toBe(400);
    expect((await add('__proto__')).status).toBe(400);
    for (const name of ['id', 'ID', 'createdAt', 'createdat', 'UPDATEDAT', 'dryRunState']) {
      expect(await add(name)).toEqual({ status: 400, message: DATA_TABLE_ERRORS.columnNameReserved(name) });
    }
    for (const name of ['constructor', 'prototype']) {
      expect(await add(name)).toEqual({ status: 400, message: DATA_TABLE_ERRORS.columnNameReserved(name) });
    }
    expect(await add('title')).toEqual({
      status: 409,
      message: DATA_TABLE_ERRORS.columnNameExists('title', 'Tasks'),
    });
    const dup = await errorOf(
      owner.client.post('/rest/data-tables', {
        name: 'Dup',
        columns: [
          { name: 'a', type: 'string' },
          { name: 'a', type: 'number' },
        ],
      }),
    );
    expect(dup).toEqual({ status: 409, message: DATA_TABLE_ERRORS.columnNameExists('a', 'Dup') });
  });

  it('adds at an index and moves, keeping positions contiguous', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const url = `/rest/data-tables/${table.id}/columns`;
    const added = await owner.client.data(
      owner.client.post(url, { name: 'extra', type: 'number', index: 1 }),
    );
    expect(added.position).toBe(1);
    const names = async () =>
      (await owner.client.data<Array<{ name: string; position: number }>>(owner.client.get(url))).map(
        (c, i) => {
          expect(c.position).toBe(i);
          return c.name;
        },
      );
    expect(await names()).toEqual(['title', 'extra', 'score', 'done', 'due']);
    const moved = await owner.client.data(
      owner.client.patch(`${url}/${table.columns[0].id}/move`, { targetIndex: 99 }),
    );
    expect(moved).toMatchObject({ name: 'title', position: 4 });
    expect(await names()).toEqual(['extra', 'score', 'done', 'due', 'title']);
    await owner.client.data(owner.client.patch(`${url}/${added.id}/move`, { targetIndex: 2 }));
    expect(await names()).toEqual(['score', 'done', 'extra', 'due', 'title']);
  });

  it('renames a column and rewrites the key in every row, in the same transaction', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'a', score: 1 }, { score: 2 }]);
    const before = await dataOf(table.id);
    const url = `/rest/data-tables/${table.id}/columns/${table.columns[0].id}/rename`;
    expect((await owner.client.data(owner.client.patch(url, { name: 'heading' }))).name).toBe('heading');
    const rows = await dataOf(table.id);
    expect(rows[0].data).toEqual({ heading: 'a', score: 1 });
    expect(rows[1].data).toEqual({ score: 2 });
    expect(rows[0].size_bytes).toBeGreaterThan(before[0].size_bytes);
    expect((await rowsOf(owner, table.id)).data[0].heading).toBe('a');

    const clash = await errorOf(owner.client.patch(url, { name: 'score' }));
    expect(clash).toEqual({ status: 409, message: DATA_TABLE_ERRORS.columnNameExists('score', 'Tasks') });
    const reserved = await errorOf(owner.client.patch(url, { name: 'Id' }));
    expect(reserved).toEqual({ status: 400, message: DATA_TABLE_ERRORS.columnNameReserved('Id') });
    expect((await dataOf(table.id))[0].data).toEqual({ heading: 'a', score: 1 });
  });

  it('leaves the rows alone when the rename fails half way', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'a' }]);
    const spy = vi
      .spyOn(server.ctx.repos.audit.constructor.prototype, 'add')
      .mockRejectedValueOnce(new Error('boom'));
    const res = await owner.client.patch(
      `/rest/data-tables/${table.id}/columns/${table.columns[0].id}/rename`,
      { name: 'heading' },
    );
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect((await dataOf(table.id))[0].data).toEqual({ title: 'a' });
    const columns = await owner.client.data(owner.client.get(`/rest/data-tables/${table.id}/columns`));
    expect(columns[0].name).toBe('title');
  });

  it('deletes a column and strips its key from every row', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'a', score: 1 }]);
    const before = await dataOf(table.id);
    const url = `/rest/data-tables/${table.id}/columns`;
    await owner.client.data(owner.client.delete(`${url}/${table.columns[0].id}`));
    const rows = await dataOf(table.id);
    expect(rows[0].data).toEqual({ score: 1 });
    expect(rows[0].size_bytes).toBeLessThan(before[0].size_bytes);
    const left = await owner.client.data<Array<{ name: string; position: number }>>(owner.client.get(url));
    expect(left.map((c) => [c.name, c.position])).toEqual([
      ['score', 0],
      ['done', 1],
      ['due', 2],
    ]);
    const missing = await owner.client.delete(`${url}/${table.columns[0].id}`);
    expect(missing.statusCode).toBe(404);
  });
});

describe('rows', () => {
  it('inserts with the three return types and hands out ids 1, 2, 3 per table', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const other = await makeTable(owner, 'Other');
    expect(await insert(owner, table.id, [{ title: 'a' }, { title: 'b' }], 'count')).toEqual({
      success: true,
      insertedRows: 2,
    });
    expect(await insert(owner, table.id, [{ title: 'c' }], 'id')).toEqual([{ id: 3 }]);
    const all = await insert(owner, table.id, [{ title: 'd', score: '5', done: 'true', due: '2024-03-01' }]);
    expect(all[0]).toMatchObject({
      id: 4,
      title: 'd',
      score: 5,
      done: true,
      due: '2024-03-01T00:00:00.000Z',
    });
    expect(typeof all[0].createdAt).toBe('string');
    expect(await insert(owner, other.id, [{ title: 'x' }], 'id')).toEqual([{ id: 1 }]);
    expect(Number((await tableRow(table.id)).next_row_id)).toBe(5);
    // a column left out reads as null, and a size is stored
    const first = (await rowsOf(owner, table.id)).data[0];
    expect(first).toMatchObject({ id: 1, title: 'a', score: null, done: null, due: null });
    expect((await dataOf(table.id))[0].size_bytes).toBeGreaterThan(0);
  });

  it('keeps row ids unique when inserts race', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const inserted = await Promise.all(
      Array.from({ length: 8 }, (_, i) => insert(owner, table.id, [{ title: String(i) }], 'id')),
    );
    const ids = inserted.flat().map((r: { id: number }) => r.id);
    expect(ids.sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("refuses unknown columns and values of the wrong type with n8n's texts, and writes nothing", async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const url = `/rest/data-tables/${table.id}/insert`;
    const send = (data: unknown[]) => errorOf(owner.client.post(url, { data }));
    expect(await send([{ title: 'ok' }, { nope: 1 }])).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.unknownColumn('nope'),
    });
    expect(await send([{ id: 1 }])).toEqual({ status: 400, message: DATA_TABLE_ERRORS.unknownColumn('id') });
    const number = await send([{ score: 'abc' }]);
    expect(number.status).toBe(400);
    expect(number.message).toContain("value 'abc' does not match column type 'number'");
    expect((await send([{ title: ['x'] }])).status).toBe(400);
    expect(await dataOf(table.id)).toEqual([]);
    expect(Number((await tableRow(table.id)).next_row_id)).toBe(1);
  });

  it('reads no prototype key: __proto__ never reaches a row and constructor is an unknown column', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const url = `/rest/data-tables/${table.id}/insert`;
    const raw = '{"data":[{"title":"a","__proto__":{"polluted":true}}],"returnType":"all"}';
    const res = await server.app.inject({
      method: 'POST',
      url,
      payload: raw,
      headers: {
        cookie: owner.client.cookie as string,
        origin: owner.client.origin,
        'content-type': 'application/json',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify((await dataOf(table.id))[0].data)).toBe('{"title":"a"}');
    expect(await errorOf(owner.client.post(url, { data: [{ constructor: 'x' }] }))).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.unknownColumn('constructor'),
    });
    // the access of a node has no JSON parser in front of it
    const access = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
    );
    const hostile = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    await expect(access.insertRows(table.id, [hostile], 'count')).rejects.toThrow(
      DATA_TABLE_ERRORS.unknownColumn('__proto__'),
    );
  });

  it('reads a column named like an Object method as its own value, or null', async () => {
    const owner = await signup();
    const table = await makeTable(owner, 'Odd', [{ name: 'toString', type: 'string' }]);
    await insert(owner, table.id, [{}, { toString: 'x' }]);
    const { data } = await rowsOf(owner, table.id);
    expect(data[0].toString).toBeNull();
    expect(data[1].toString).toBe('x');
  });

  it('stores hostile strings as plain values', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const evil = "'; drop table data_table_rows; --";
    await insert(owner, table.id, [{ title: evil }, { title: 'other' }]);
    const found = await rowsOf(
      owner,
      table.id,
      filterQuery({ type: 'and', filters: [{ columnName: 'title', condition: 'eq', value: evil }] }),
    );
    expect(found.data.map((r) => r.title)).toEqual([evil]);
    const bad = await errorOf(
      owner.client.get(
        `/rest/data-tables/${table.id}/rows?take=1${filterQuery({
          filters: [{ columnName: 'title" or 1=1 --', condition: 'eq', value: 1 }],
        })}`,
      ),
    );
    expect(bad.message).toBe(DATA_TABLE_ERRORS.unknownColumn('title" or 1=1 --'));
    const sort = await errorOf(
      owner.client.get(`/rest/data-tables/${table.id}/rows?sortBy=${encodeURIComponent('title;--:asc')}`),
    );
    expect(sort.message).toBe(DATA_TABLE_ERRORS.unknownColumn('title;--'));
  });

  describe('filters on Postgres', () => {
    let owner: Owner;
    let tableId: string;
    beforeEach(async () => {
      owner = await signup();
      tableId = (await makeTable(owner)).id;
      await insert(owner, tableId, [
        { title: 'Apple', score: 10, done: true, due: '2024-01-01' },
        { title: 'apple pie', score: 2.5, done: false, due: '2024-06-01' },
        { title: 'a_b', score: -1, due: '2025-01-01' },
        { title: '', score: 100 },
        { done: true },
      ]);
    });
    const ids = async (filters: unknown[], type = 'and') =>
      (await rowsOf(owner, tableId, filterQuery({ type, filters }))).data.map((r) => r.id);
    const clause = (columnName: string, condition: string, value?: unknown) => ({
      columnName,
      condition,
      value,
    });

    it.each([
      ['string eq', clause('title', 'eq', 'Apple'), [1]],
      ['string neq also matches null', clause('title', 'neq', 'Apple'), [2, 3, 4, 5]],
      ['eq null', clause('title', 'eq', null), [5]],
      ['neq null', clause('title', 'neq', null), [1, 2, 3, 4]],
      ['like is case sensitive and adds %', clause('title', 'like', 'pple'), [1, 2]],
      ['like starts with', clause('title', 'like', 'a%'), [2, 3]],
      ['ilike', clause('title', 'ilike', 'APPLE'), [1, 2]],
      ['only % is a wildcard', clause('title', 'like', 'a_b'), [3]],
      ['isEmpty is null or empty text', clause('title', 'isEmpty'), [4, 5]],
      ['isNotEmpty', clause('title', 'isNotEmpty'), [1, 2, 3]],
      ['number eq coerces', clause('score', 'eq', '10'), [1]],
      ['number gt is numeric, not text', clause('score', 'gt', 9), [1, 4]],
      ['number gte', clause('score', 'gte', 10), [1, 4]],
      ['number lt', clause('score', 'lt', 0), [3]],
      ['number lte', clause('score', 'lte', 2.5), [2, 3]],
      ['number neq', clause('score', 'neq', 10), [2, 3, 4, 5]],
      ['number isEmpty', clause('score', 'isEmpty'), [5]],
      ['boolean eq', clause('done', 'eq', true), [1, 5]],
      ['boolean eq false', clause('done', 'eq', false), [2]],
      ['date gt', clause('due', 'gt', '2024-06-01'), [3]],
      ['date lte', clause('due', 'lte', '2024-06-01T00:00:00+00:00'), [1, 2]],
      ['date eq', clause('due', 'eq', '2024-01-01'), [1]],
      ['gt against null matches nothing', clause('score', 'gt', null), []],
      ['id eq', clause('id', 'eq', 3), [3]],
      ['id gte', clause('id', 'gte', '4'), [4, 5]],
    ])('%s', async (_label, filter, expected) => {
      expect(await ids([filter])).toEqual(expected);
    });

    it('filters on createdAt and updatedAt', async () => {
      expect(await ids([clause('createdAt', 'gt', '2000-01-01')])).toEqual([1, 2, 3, 4, 5]);
      expect(await ids([clause('updatedAt', 'lt', '2000-01-01')])).toEqual([]);
    });

    it('joins clauses with and, or', async () => {
      const a = clause('done', 'eq', true);
      const b = clause('score', 'gt', 50);
      expect(await ids([a, clause('score', 'eq', 10)])).toEqual([1]);
      expect(await ids([a, b], 'or')).toEqual([1, 4, 5]);
    });

    it('never fails a cast when another table holds other types under the same column name', async () => {
      const other = await makeTable(owner, 'Mixed', [
        { name: 'score', type: 'string' },
        { name: 'done', type: 'string' },
      ]);
      await insert(owner, other.id, [{ score: 'not a number', done: 'not a boolean' }]);
      expect(await ids([clause('score', 'gt', 50), clause('done', 'eq', true)], 'or')).toEqual([1, 4, 5]);
    });

    it('sorts by type with id as the tie break, and pages with a count', async () => {
      const order = async (query: string) => (await rowsOf(owner, tableId, query)).data.map((r) => r.id);
      expect(await order('&sortBy=score:asc')).toEqual([3, 2, 1, 4, 5]);
      expect(await order('&sortBy=score:desc')).toEqual([5, 4, 1, 2, 3]);
      expect(await order('&sortBy=due:asc')).toEqual([1, 2, 3, 4, 5]);
      expect(await order('&sortBy=done:desc')).toEqual([3, 4, 1, 5, 2]);
      expect(await order('&sortBy=id:desc')).toEqual([5, 4, 3, 2, 1]);
      const page = await owner.client.data(
        owner.client.get(`/rest/data-tables/${tableId}/rows?take=2&skip=1`),
      );
      expect(page.count).toBe(5);
      expect(page.data.map((r: DataTableRow) => r.id)).toEqual([2, 3]);
    });

    it('searches every user column as text, case-insensitively, and not the system columns', async () => {
      const search = async (term: string) =>
        (await rowsOf(owner, tableId, `&search=${encodeURIComponent(term)}`)).data.map((r) => r.id);
      expect(await search('APPLE')).toEqual([1, 2]);
      expect(await search('2.5')).toEqual([2]);
      expect(await search('true')).toEqual([1, 5]);
      expect(await search('2025-01')).toEqual([3]);
      expect(await search('a_b')).toEqual([3]);
      expect(await search('a%e')).toEqual([1, 2]);
      expect(await search('  ')).toEqual([1, 2, 3, 4, 5]);
      expect(await search('zzz')).toEqual([]);
    });

    it('caps take at 250', async () => {
      await insert(
        owner,
        tableId,
        Array.from({ length: 260 }, (_, i) => ({ score: i })),
        'count',
      );
      const page = await owner.client.data(owner.client.get(`/rest/data-tables/${tableId}/rows?take=999`));
      expect(page.count).toBe(265);
      expect(page.data).toHaveLength(250);
      const viaAccess = await server.ctx.dataTables
        .forProject(owner.tenant.id, await teamProjectOf(server, owner.tenant.id))
        .getRows(tableId, { take: 999 });
      expect(viaAccess.data).toHaveLength(250);
    });
  });

  describe('update, upsert, delete', () => {
    let owner: Owner;
    let id: string;
    const byTitle = (title: string) => ({
      type: 'and',
      filters: [{ columnName: 'title', condition: 'eq', value: title }],
    });
    const none = { type: 'and', filters: [] };
    beforeEach(async () => {
      owner = await signup();
      id = (await makeTable(owner)).id;
      await insert(owner, id, [
        { title: 'a', score: 1 },
        { title: 'b', score: 2 },
      ]);
    });

    it('update answers true, or the rows with returnData, and keeps other columns', async () => {
      const url = `/rest/data-tables/${id}/rows`;
      expect(
        await owner.client.data(owner.client.patch(url, { filter: byTitle('a'), data: { score: '9' } })),
      ).toBe(true);
      const rows = await owner.client.data(
        owner.client.patch(url, { filter: byTitle('a'), data: { done: true }, returnData: true }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, title: 'a', score: 9, done: true });
      expect((await rowsOf(owner, id)).data[1].score).toBe(2);
      expect((await dataOf(id))[0].size_bytes).toBeGreaterThan((await dataOf(id))[1].size_bytes);
    });

    it("refuses an empty filter or empty data with n8n's texts", async () => {
      const url = `/rest/data-tables/${id}/rows`;
      expect(await errorOf(owner.client.patch(url, { filter: none, data: { score: 1 } }))).toEqual({
        status: 400,
        message: DATA_TABLE_ERRORS.filterEmpty,
      });
      expect(
        await errorOf(
          owner.client.post(`/rest/data-tables/${id}/upsert`, { filter: none, data: { score: 1 } }),
        ),
      ).toEqual({ status: 400, message: DATA_TABLE_ERRORS.filterEmpty });
      expect(await errorOf(owner.client.patch(url, { filter: byTitle('a'), data: {} }))).toEqual({
        status: 400,
        message: 'Data columns must not be empty',
      });
      expect(await errorOf(owner.client.delete(url))).toEqual({
        status: 400,
        message: DATA_TABLE_ERRORS.filterRequiredForDelete,
      });
      expect((await rowsOf(owner, id)).count).toBe(2);
    });

    it('an update dry run answers before and after rows and writes nothing', async () => {
      const result = await owner.client.data(
        owner.client.patch(`/rest/data-tables/${id}/rows`, {
          filter: byTitle('a'),
          data: { score: 5 },
          dryRun: true,
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 1, score: 1, dryRunState: 'before' });
      expect(result[1]).toMatchObject({ id: 1, score: 5, dryRunState: 'after' });
      expect((await rowsOf(owner, id)).data[0].score).toBe(1);
    });

    it('upsert updates the matches, else inserts one row from data alone', async () => {
      const url = `/rest/data-tables/${id}/upsert`;
      const updated = await owner.client.data(
        owner.client.post(url, { filter: byTitle('a'), data: { score: 7 }, returnData: true }),
      );
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ id: 1, score: 7 });
      const inserted = await owner.client.data(
        owner.client.post(url, { filter: byTitle('zzz'), data: { score: 8 }, returnData: true }),
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({ id: 3, title: null, score: 8 });
      expect(
        await owner.client.data(owner.client.post(url, { filter: byTitle('q'), data: { score: 1 } })),
      ).toBe(true);
      expect((await rowsOf(owner, id)).count).toBe(4);
    });

    it('an upsert dry run with no match shows an empty before row and a new after row', async () => {
      const result = await owner.client.data(
        owner.client.post(`/rest/data-tables/${id}/upsert`, {
          filter: byTitle('zzz'),
          data: { score: 8 },
          dryRun: true,
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: null, title: null, score: null, dryRunState: 'before' });
      expect(result[1]).toMatchObject({ id: 0, title: null, score: 8, dryRunState: 'after' });
      expect((await rowsOf(owner, id)).count).toBe(2);
      expect(Number((await tableRow(id)).next_row_id)).toBe(3);
    });

    it('delete answers true or the rows, and a dry run writes nothing', async () => {
      const url = (query: string) =>
        `/rest/data-tables/${id}/rows?filter=${encodeURIComponent(JSON.stringify(byTitle('a')))}${query}`;
      const dry = await owner.client.data(owner.client.delete(url('&dryRun=true')));
      expect(dry).toHaveLength(2);
      expect(dry[0]).toMatchObject({ id: 1, title: 'a', dryRunState: 'before' });
      expect(dry[1]).toMatchObject({ id: null, title: null, createdAt: null, dryRunState: 'after' });
      expect((await rowsOf(owner, id)).count).toBe(2);
      const deleted = await owner.client.data(owner.client.delete(url('&returnData=true')));
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({ id: 1, title: 'a' });
      expect((await rowsOf(owner, id)).count).toBe(1);
      const more = `/rest/data-tables/${id}/rows?filter=${encodeURIComponent(JSON.stringify(byTitle('b')))}`;
      expect(await owner.client.data(owner.client.delete(more))).toBe(true);
    });

    it('clear removes the rows, keeps the columns and keeps counting ids', async () => {
      const cleared = await owner.client.data(owner.client.delete(`/rest/data-tables/${id}/rows/clear`));
      expect(cleared).toEqual({ deletedCount: 2 });
      expect((await rowsOf(owner, id)).count).toBe(0);
      expect(await insert(owner, id, [{ title: 'c' }], 'id')).toEqual([{ id: 3 }]);
    });
  });
});

describe('roles and tenants', () => {
  it('a viewer reads and cannot write, an editor writes', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const viewer = await member(owner, 'viewer');
    const editor = await member(owner, 'editor');
    expect((await viewer.get(`/rest/data-tables/${table.id}/rows`)).statusCode).toBe(200);
    expect((await viewer.get('/rest/data-tables/limits')).statusCode).toBe(200);
    const write = await viewer.post(`/rest/data-tables/${table.id}/insert`, { data: [{ title: 'x' }] });
    expect(write.statusCode).toBe(403);
    expect((await viewer.post('/rest/data-tables', { name: 'V', columns: [] })).statusCode).toBe(403);
    expect((await viewer.delete(`/rest/data-tables/${table.id}`)).statusCode).toBe(403);
    expect((await editor.post(`/rest/data-tables/${table.id}/insert`, { data: [{}] })).statusCode).toBe(200);
  });

  it("another workspace's table answers n8n's not-found text on every route and stays untouched", async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'mine' }]);
    const stranger = await signup();
    const base = `/rest/data-tables/${table.id}`;
    const filter = { type: 'and', filters: [{ columnName: 'title', condition: 'eq', value: 'mine' }] };
    const calls: Array<Promise<{ statusCode: number; json(): any }>> = [
      stranger.client.get(base),
      stranger.client.patch(base, { name: 'Stolen' }),
      stranger.client.get(`${base}/columns`),
      stranger.client.post(`${base}/columns`, { name: 'x', type: 'string' }),
      stranger.client.get(`${base}/rows`),
      stranger.client.post(`${base}/insert`, { data: [{}] }),
      stranger.client.post(`${base}/upsert`, { filter, data: { title: 'x' } }),
      stranger.client.patch(`${base}/rows`, { filter, data: { title: 'x' } }),
      stranger.client.delete(`${base}/rows?filter=${encodeURIComponent(JSON.stringify(filter))}`),
      stranger.client.delete(`${base}/rows/clear`),
      stranger.client.get(`${base}/download-csv`),
      stranger.client.post(`${base}/import-csv`, { csv: 'title\nx' }),
      stranger.client.get(`${base}/dependencies`),
      stranger.client.delete(base),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe(DATA_TABLE_ERRORS.tableIdNotFound(table.id));
    }
    const column = await stranger.client.delete(`${base}/columns/${table.columns[0].id}`);
    expect(column.statusCode).toBe(404);
    expect((await rowsOf(owner, table.id)).data[0].title).toBe('mine');
    expect((await owner.client.data(owner.client.get(base))).name).toBe('Tasks');
    expect((await stranger.client.data(stranger.client.get('/rest/data-tables'))).count).toBe(0);
  });

  it('a column id of another table is not found', async () => {
    const owner = await signup();
    const a = await makeTable(owner, 'A');
    const b = await makeTable(owner, 'B');
    const res = await owner.client.delete(`/rest/data-tables/${a.id}/columns/${b.columns[0].id}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('what a node sees', () => {
  it('rows written through one workflow are read through another', async () => {
    const owner = await signup();
    const writer = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
      { workflowId: 'workflow-a' },
    );
    const reader = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
      { workflowId: 'workflow-b' },
    );
    const table = await writer.createTable({ name: 'Shared', columns: [{ name: 'city', type: 'string' }] });
    await writer.insertRows(table.id, [{ city: 'Pune' }, { city: 'Mumbai' }], 'count');
    const read = await reader.getRows(table.id, {
      filter: { type: 'and', filters: [{ columnName: 'city', condition: 'eq', value: 'Pune' }] },
    });
    expect(read.count).toBe(1);
    expect(read.data[0]).toMatchObject({ id: 1, city: 'Pune' });
    const byName = await reader.getTable({ name: 'Shared' });
    expect(byName?.id).toBe(table.id);
    expect(byName?.columns.map((c) => c.name)).toEqual(['city']);
    // the REST grid shows them too
    expect((await rowsOf(owner, table.id)).count).toBe(2);
  });

  it('another tenant cannot reach the table, and getTable answers null', async () => {
    const owner = await signup();
    const stranger = await signup();
    const mine = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
    );
    const theirs = server.ctx.dataTables.forProject(
      stranger.tenant.id,
      await teamProjectOf(server, stranger.tenant.id),
    );
    const table = await mine.createTable({ name: 'Mine', columns: [{ name: 'a', type: 'string' }] });
    expect(await theirs.getTable({ id: table.id })).toBeNull();
    expect(await theirs.getTable({ name: 'Mine' })).toBeNull();
    expect(await theirs.getTable({ id: 'not-a-uuid' })).toBeNull();
    const notFound = DATA_TABLE_ERRORS.tableIdNotFound(table.id);
    await expect(theirs.getRows(table.id)).rejects.toThrow(notFound);
    await expect(theirs.insertRows(table.id, [{ a: 'x' }], 'count')).rejects.toThrow(notFound);
    await expect(theirs.deleteTable(table.id)).rejects.toThrow(notFound);
    await expect(theirs.listColumns(table.id)).rejects.toThrow(notFound);
    await expect(theirs.rowsExist(table.id, { type: 'and', filters: [] })).rejects.toThrow(notFound);
  });

  it('runs every table and row method', async () => {
    const owner = await signup();
    const access = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
      { workflowId: 'w' },
    );
    const table = await access.createTable({ name: 'T', columns: [{ name: 'a', type: 'number' }] });
    const reused = await access.createTable({ name: 'T', columns: [], reuseExisting: true });
    expect(reused.id).toBe(table.id);
    await expect(access.createTable({ name: 'T', columns: [] })).rejects.toThrow(
      DATA_TABLE_ERRORS.tableNameExists('T'),
    );
    await expect(access.createTable({ name: '  ', columns: [] })).rejects.toThrow();
    await expect(access.createTable({ name: 'x'.repeat(129), columns: [] })).rejects.toThrow();
    await expect(
      access.createTable({ name: 'B', columns: [{ name: '__proto__', type: 'string' }] }),
    ).rejects.toThrow(DATA_TABLE_ERRORS.columnNameInvalid);
    expect((await access.renameTable(table.id, 'T2')).name).toBe('T2');
    expect((await access.listTables({ name: 't2' })).count).toBe(1);
    expect((await access.listColumns(table.id)).map((c) => c.name)).toEqual(['a']);

    const filter: DataTableFilter = {
      type: 'and',
      filters: [{ columnName: 'a', condition: 'eq', value: 1 }],
    };
    const other: DataTableFilter = {
      type: 'and',
      filters: [{ columnName: 'a', condition: 'eq', value: 99 }],
    };
    const rows = await access.insertRows(table.id, [{ a: 1 }, { a: 2 }], 'all');
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(await access.rowsExist(table.id, filter)).toBe(true);
    expect(await access.rowsExist(table.id, other)).toBe(false);
    const updated = await access.updateRows(table.id, { filter, data: { a: 3 } });
    expect(updated[0]).toMatchObject({ id: 1, a: 3 });
    const dry = await access.upsertRow(table.id, { filter: other, data: { a: 5 } }, { dryRun: true });
    expect(dry.map((r) => ('dryRunState' in r ? r.dryRunState : ''))).toEqual(['before', 'after']);
    const upserted = await access.upsertRow(table.id, { filter: other, data: { a: 99 } });
    expect(upserted[0]).toMatchObject({ id: 3, a: 99 });
    const deleted = await access.deleteRows(table.id, other);
    expect(deleted[0]).toMatchObject({ id: 3 });
    await expect(access.deleteRows(table.id, { type: 'and', filters: [] })).rejects.toThrow(
      DATA_TABLE_ERRORS.filterRequiredForDelete,
    );
    await expect(
      access.updateRows(table.id, { filter: { type: 'and', filters: [] }, data: { a: 1 } }),
    ).rejects.toThrow(DATA_TABLE_ERRORS.filterEmpty);
    expect(await access.clearTable(table.id)).toEqual({ deletedCount: 2 });
    await access.deleteTable(table.id);
    expect(await access.getTable({ id: table.id })).toBeNull();
  });
});

describe('quota', () => {
  const setQuota = (tenantId: string, bytes: number) =>
    server.ctx.database.pool.query(
      `update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{limits}', $2::jsonb) where id = $1`,
      [tenantId, JSON.stringify({ dataTableBytes: bytes })],
    );

  it('reads the limit from the plan override and refuses inserts, upserts and updates over it', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'first' }]);
    await setQuota(owner.tenant.id, 5);
    const limits = await owner.client.data(owner.client.get('/rest/data-tables/limits'));
    expect(limits.maxBytes).toBe(5);
    expect(limits.quotaStatus).toBe('error');
    const insertRes = await errorOf(
      owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: [{ title: 'x' }] }),
    );
    expect(insertRes.status).toBe(400);
    expect(insertRes.message).toBe(DATA_TABLE_ERRORS.sizeLimitExceeded(0, 0));
    const filter = { type: 'and', filters: [{ columnName: 'title', condition: 'eq', value: 'first' }] };
    const upsert = await errorOf(
      owner.client.post(`/rest/data-tables/${table.id}/upsert`, { filter, data: { title: 'x' } }),
    );
    expect(upsert.message).toBe(insertRes.message);
    const update = await errorOf(
      owner.client.patch(`/rest/data-tables/${table.id}/rows`, { filter, data: { title: 'x' } }),
    );
    expect(update.message).toBe(insertRes.message);
    // a dry run writes nothing, so it is allowed, and so is making room
    const dry = await owner.client.patch(`/rest/data-tables/${table.id}/rows`, {
      filter,
      data: { title: 'x' },
      dryRun: true,
    });
    expect(dry.statusCode).toBe(200);
    await owner.client.data(owner.client.delete(`/rest/data-tables/${table.id}/rows/clear`));
    expect(
      await owner.client.data(owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: [{}] })),
    ).toEqual({ success: true, insertedRows: 1 });
  });

  it('one workspace filling up does not touch another', async () => {
    const owner = await signup();
    const other = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'first' }]);
    await setQuota(owner.tenant.id, 1);
    const theirs = await makeTable(other);
    await insert(other, theirs.id, [{ title: 'fine' }]);
    expect((await rowsOf(other, theirs.id)).count).toBe(1);
  });

  it('limits report size per table, status and the upload limit', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'x'.repeat(100) }]);
    const limits = await owner.client.data(owner.client.get('/rest/data-tables/limits'));
    const stored = (await dataOf(table.id))[0].size_bytes;
    expect(limits.totalBytes).toBe(stored);
    expect(limits.quotaStatus).toBe('ok');
    expect(limits.maxBytes).toBe(200 * 1024 * 1024);
    expect(limits.warningBytes).toBe(Math.floor(200 * 1024 * 1024 * 0.8));
    expect(limits.uploadMaxFileSize).toBe(1024 * 1024);
    expect(limits.dataTables[table.id]).toEqual({ id: table.id, name: 'Tasks', sizeBytes: stored });
    await setQuota(owner.tenant.id, stored + 10);
    const warn = await owner.client.data(owner.client.get('/rest/data-tables/limits'));
    expect(warn.quotaStatus).toBe('warn');
    expect(warn.uploadMaxFileSize).toBe(10);
  });

  it('the size is cached for the configured time, per tenant, and writes keep it current', async () => {
    let clock = 1000;
    const cache = new DataTableSizeCache(() => clock);
    const load = vi.fn(async () => 100);
    expect(await cache.bytes('t', 5000, load)).toBe(100);
    clock += 4999;
    expect(await cache.bytes('t', 5000, load)).toBe(100);
    expect(load).toHaveBeenCalledTimes(1);
    cache.added('t', 50);
    expect(await cache.bytes('t', 5000, load)).toBe(150);
    expect(load).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await cache.bytes('t', 5000, load)).toBe(100);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.bytes('other', 5000, load);
    expect(load).toHaveBeenCalledTimes(3);
    cache.reset('t');
    await cache.bytes('t', 5000, load);
    expect(load).toHaveBeenCalledTimes(4);
    cache.added('never-loaded', 5);
    await cache.bytes('never-loaded', 5000, load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('works out status and the warning threshold', () => {
    expect(quotaStatus(10, 80, 100)).toBe('ok');
    expect(quotaStatus(80, 80, 100)).toBe('warn');
    expect(quotaStatus(100, 80, 100)).toBe('error');
    const config = testConfig({
      DATA_TABLES_MAX_SIZE_BYTES: '1000',
      DATA_TABLES_WARNING_THRESHOLD_BYTES: '500',
    });
    expect(warningBytes(config, 1000)).toBe(500);
    // a plan override scales the warning with it
    expect(warningBytes(config, 2000)).toBe(1600);
  });
});

describe('CSV', () => {
  it('parses text with or without headers and infers types from the first 100 rows', () => {
    const preview = previewCsv(
      '﻿name,age,active,joined,blank\nAna,30,true,2024-01-01,\nBo,x,false,2024-01-02,\n',
      true,
    );
    expect(preview.rowCount).toBe(2);
    expect(preview.columnCount).toBe(5);
    expect(preview.columns).toEqual([
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'joined', type: 'date' },
      { name: 'blank', type: 'string' },
    ]);
    const bare = previewCsv('1,a\n2,b\n', false);
    expect(bare.rowCount).toBe(2);
    expect(bare.columns.map((c) => c.name)).toEqual(['Column_1', 'Column_2']);
    expect(previewCsv('', true)).toEqual({ rowCount: 0, columnCount: 0, columns: [] });
    // quoted commas and new lines stay in one cell
    expect(parseCsv('a,b\n"x,1","y\nz"\n', true).rows).toEqual([['x,1', 'y\nz']]);
    // a __proto__ header stays a plain string in an array
    expect(parseCsv('__proto__,b\n1,2\n', true).headers).toEqual(['__proto__', 'b']);
    expect(({} as Record<string, unknown>)['1']).toBeUndefined();
  });

  it('escapes formula cells, also across lines, and leaves numbers alone', () => {
    for (const bad of ['=1+1', '+1', '-1', '@x', '\tx', '\rx', '=a\nb']) {
      expect(escapeCsvFormula(bad)).toBe(`'${bad}`);
    }
    expect(escapeCsvFormula('plain')).toBe('plain');
    expect(escapeCsvFormula(-5)).toBe(-5);
    expect(escapeCsvFormula(null)).toBeNull();
    const csv = buildCsv(['a', 'b'], [['=cmd|x', -5]]);
    expect(csv).toBe("a,b\r\n'=cmd|x,-5");
  });

  it('previews through the route', async () => {
    const owner = await signup();
    const res = await owner.client.data(
      owner.client.post('/rest/data-tables/csv/preview', { csv: 'a,b\n1,x\n', hasHeaders: true }),
    );
    expect(res).toEqual({
      rowCount: 1,
      columnCount: 2,
      columns: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'string' },
      ],
    });
  });

  it('creates a table from CSV: columns from the file, or the given ones by name and position', async () => {
    const owner = await signup();
    const auto = await owner.client.data(
      owner.client.post('/rest/data-tables', { name: 'Auto', columns: [], csv: 'a,b\n1,x\n2,\n' }),
    );
    expect(auto.columns.map((c: { name: string; type: string }) => [c.name, c.type])).toEqual([
      ['a', 'number'],
      ['b', 'string'],
    ]);
    const rows = await rowsOf(owner, auto.id);
    expect(rows.data.map((r) => [r.id, r.a, r.b])).toEqual([
      [1, 1, 'x'],
      [2, 2, null],
    ]);

    const renamed = await owner.client.data(
      owner.client.post('/rest/data-tables', {
        name: 'Renamed',
        columns: [
          { name: 'first_name', type: 'string' },
          { name: 'age', type: 'number' },
        ],
        csv: 'First Name,age\nAna,30\n',
      }),
    );
    expect((await rowsOf(owner, renamed.id)).data[0]).toMatchObject({ first_name: 'Ana', age: 30 });

    const subset = await owner.client.data(
      owner.client.post('/rest/data-tables', {
        name: 'Subset',
        columns: [{ name: 'age', type: 'number' }],
        csv: 'name,age\nAna,30\n',
      }),
    );
    const subsetRow = (await rowsOf(owner, subset.id)).data[0];
    expect(subsetRow.age).toBe(30);
    expect(subsetRow).not.toHaveProperty('name');

    const bare = await owner.client.data(
      owner.client.post('/rest/data-tables', { name: 'Bare', columns: [], csv: '1,x\n', hasHeaders: false }),
    );
    expect((await rowsOf(owner, bare.id)).data[0]).toMatchObject({ Column_1: 1, Column_2: 'x' });
  });

  it('refuses a CSV table it cannot build, and leaves nothing behind', async () => {
    const owner = await signup();
    const post = (body: object) => errorOf(owner.client.post('/rest/data-tables', { name: 'Bad', ...body }));
    expect((await post({ columns: [], csv: '' })).status).toBe(400);
    expect(await post({ columns: [], csv: 'First Name\nAna\n' })).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.columnNameInvalid,
    });
    expect(await post({ columns: [], csv: 'id\n1\n' })).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.columnNameReserved('id'),
    });
    const wrongType = await post({ columns: [{ name: 'a', type: 'number' }], csv: 'a\nx\n' });
    expect(wrongType.message).toContain("value 'x' does not match column type 'number'");
    const unmatched = await post({
      columns: [{ name: 'other', type: 'string' }],
      csv: 'a,b\n1,2\n',
    });
    expect(unmatched.status).toBe(400);
    expect((await owner.client.data(owner.client.get('/rest/data-tables'))).count).toBe(0);
  });

  it('imports into a table: system columns ignored, missing columns null, extras refused', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const url = `/rest/data-tables/${table.id}/import-csv`;
    const result = await owner.client.data(
      owner.client.post(url, { csv: 'id,title,score,createdAt\n77,Ana,5,2020-01-01\n78,Bo,,2020-01-01\n' }),
    );
    expect(result).toEqual({ importedRows: 2, systemColumnsIgnored: ['id', 'createdAt'] });
    const rows = await rowsOf(owner, table.id);
    expect(rows.data.map((r) => [r.id, r.title, r.score, r.done])).toEqual([
      [1, 'Ana', 5, null],
      [2, 'Bo', null, null],
    ]);
    expect(rows.data[0].createdAt).not.toContain('2020');
    expect(await errorOf(owner.client.post(url, { csv: 'title,nope\na,b\n' }))).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.unknownColumn('nope'),
    });
    expect(await errorOf(owner.client.post(url, { csv: '__proto__\nb\n' }))).toEqual({
      status: 400,
      message: DATA_TABLE_ERRORS.unknownColumn('__proto__'),
    });
    const bad = await errorOf(owner.client.post(url, { csv: 'title,score\nok,1\nbad,x\n' }));
    expect(bad.message).toContain("value 'x' does not match column type 'number'");
    expect((await rowsOf(owner, table.id)).count).toBe(2);
  });

  it('downloads every row as text, with formula cells escaped, and round trips', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(
      owner,
      table.id,
      Array.from({ length: 260 }, (_, i) => ({ title: i === 0 ? '=HYPERLINK("x")' : `t${i}`, score: -i })),
      'count',
    );
    const url = `/rest/data-tables/${table.id}/download-csv`;
    const full = await owner.client.data(owner.client.get(url));
    expect(full.dataTableName).toBe('Tasks');
    const lines = full.csvContent.split('\r\n');
    expect(lines).toHaveLength(261);
    expect(lines[0]).toBe('id,createdAt,updatedAt,title,score,done,due');
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    const bare = await owner.client.data(owner.client.get(`${url}?includeSystemColumns=false`));
    expect(bare.csvContent.split('\r\n')[0]).toBe('title,score,done,due');
    expect(bare.csvContent.split('\r\n')[2]).toBe('t1,-1,,');

    const copy = await makeTable(owner, 'Copy');
    const imported = await owner.client.data(
      owner.client.post(`/rest/data-tables/${copy.id}/import-csv`, { csv: full.csvContent }),
    );
    expect(imported).toEqual({
      importedRows: 260,
      systemColumnsIgnored: ['id', 'createdAt', 'updatedAt'],
    });
  });

  it("answers n8n's too-large text past the upload limit and past the body limit, not Fastify's 413", async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const text = 'File upload error: File too large';
    const big = `title\n${'x'.repeat(2 * 1024 * 1024)}\n`;
    const urls: Array<[string, object]> = [
      ['/rest/data-tables/csv/preview', { csv: big }],
      [`/rest/data-tables/${table.id}/import-csv`, { csv: big }],
      ['/rest/data-tables', { name: 'Big', columns: [], csv: big }],
    ];
    for (const [url, body] of urls) {
      expect(await errorOf(owner.client.post(url, body))).toEqual({ status: 400, message: text });
    }
    // within the body limit but over the space left
    await server.ctx.database.pool.query(
      `update tenants set settings = '{"limits":{"dataTableBytes":5}}'::jsonb where id = $1`,
      [owner.tenant.id],
    );
    const small = 'title\nabcdefghij\n';
    for (const [url, body] of [
      ['/rest/data-tables/csv/preview', { csv: small }],
      [`/rest/data-tables/${table.id}/import-csv`, { csv: small }],
      ['/rest/data-tables', { name: 'Big', columns: [], csv: small }],
    ] as Array<[string, object]>) {
      expect(await errorOf(owner.client.post(url, body))).toEqual({ status: 400, message: text });
    }
    // other routes keep the plain answer
    const other = await owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: [{ title: big }] });
    expect(other.statusCode).toBe(413);
  });
});

describe('dependencies and favorites', () => {
  it('lists the workflows whose nodes name the table, within the tenant', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const other = await makeTable(owner, 'Other');
    const uses = (mode: string, value: string) =>
      node('Table', 'core.dataTable', { dataTableId: { __rl: true, mode, value } });
    const byId = await createWorkflow(owner.client, { name: 'By id', nodes: [uses('list', table.id)] });
    const byName = await createWorkflow(owner.client, { name: 'By name', nodes: [uses('name', 'Tasks')] });
    await createWorkflow(owner.client, { name: 'Other table', nodes: [uses('id', other.id)] });
    await createWorkflow(owner.client, {
      name: 'Other node',
      nodes: [node('Set', 'core.set', { dataTableId: { mode: 'id', value: table.id } })],
    });
    const deps = await owner.client.data(owner.client.get(`/rest/data-tables/${table.id}/dependencies`));
    expect(deps).toEqual([
      { type: 'workflow', id: byId.id, name: 'By id' },
      { type: 'workflow', id: byName.id, name: 'By name' },
    ]);
    expect(
      await owner.client.data(owner.client.get(`/rest/data-tables/${other.id}/dependencies`)),
    ).toHaveLength(1);
  });

  it('takes a table as a favorite, removes the favorite with the table, for every user', async () => {
    const owner = await signup();
    const editor = await member(owner, 'editor');
    const table = await makeTable(owner);
    const body = { resourceType: 'dataTable', resourceId: table.id };
    await owner.client.data(owner.client.post('/rest/favorites', body));
    await editor.data(editor.post('/rest/favorites', body));
    const listed = await owner.client.data(owner.client.get('/rest/favorites'));
    expect(listed[0]).toMatchObject({ resourceId: table.id, name: 'Tasks' });
    await owner.client.data(owner.client.delete(`/rest/data-tables/${table.id}`));
    const { rows } = await server.ctx.database.pool.query(
      'select 1 from user_favorites where resource_id = $1',
      [table.id],
    );
    expect(rows).toEqual([]);
  });

  it('removes the columns and rows with the table', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'a' }]);
    await owner.client.data(owner.client.delete(`/rest/data-tables/${table.id}`));
    expect(await dataOf(table.id)).toEqual([]);
    const { rows } = await server.ctx.database.pool.query(
      'select 1 from data_table_columns where table_id = $1',
      [table.id],
    );
    expect(rows).toEqual([]);
  });
});

describe('fix round: text Postgres refuses, filters, size sort, CSV source, table lock', () => {
  it('answers 400, not 500, for a NUL byte or half a surrogate pair', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    for (const bad of ['a\u0000b', 'a\ud800b']) {
      expect(
        (await errorOf(owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: [{ title: bad }] })))
          .status,
      ).toBe(400);
      expect((await errorOf(owner.client.post('/rest/data-tables', { name: bad, columns: [] }))).status).toBe(
        400,
      );
      // a half pair cannot be URL encoded, so the search holds the NUL only
      if (bad.includes('\u0000')) {
        expect(
          (await errorOf(owner.client.get(`/rest/data-tables/${table.id}/rows?search=%00`))).status,
        ).toBe(400);
      }
      const filter = { type: 'and', filters: [{ columnName: 'title', condition: 'like', value: bad }] };
      expect(
        (
          await errorOf(
            owner.client.get(`/rest/data-tables/${table.id}/rows?${filterQuery(filter).slice(1)}`),
          )
        ).status,
      ).toBe(400);
    }
    // a CSV with a NUL passes the preview and is refused on import
    const csv = 'title\nx\u0000y\n';
    expect(
      (await errorOf(owner.client.post(`/rest/data-tables/${table.id}/import-csv`, { csv }))).status,
    ).toBe(400);
    expect((await rowsOf(owner, table.id)).count).toBe(0);
  });

  it('a filter clause without a condition means eq, and like needs a text value', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await insert(owner, table.id, [{ title: 'a' }, { title: 'b' }]);
    const bare = { type: 'and', filters: [{ columnName: 'title', value: 'b' }] };
    expect((await rowsOf(owner, table.id, filterQuery(bare))).data.map((r) => r.title)).toEqual(['b']);
    const nullLike = { type: 'and', filters: [{ columnName: 'title', condition: 'like', value: null }] };
    expect(
      (
        await errorOf(
          owner.client.get(`/rest/data-tables/${table.id}/rows?${filterQuery(nullLike).slice(1)}`),
        )
      ).status,
    ).toBe(400);
    const numberLike = { type: 'and', filters: [{ columnName: 'title', condition: 'ilike', value: 5 }] };
    expect(
      (
        await errorOf(
          owner.client.get(`/rest/data-tables/${table.id}/rows?${filterQuery(numberLike).slice(1)}`),
        )
      ).status,
    ).toBe(400);
    // no % is "contains", _ is a plain character
    await insert(owner, table.id, [{ title: 'x_y' }, { title: 'xzy' }]);
    const like = (value: string) => ({
      type: 'and',
      filters: [{ columnName: 'title', condition: 'like', value }],
    });
    expect((await rowsOf(owner, table.id, filterQuery(like('x_y')))).data.map((r) => r.title)).toEqual([
      'x_y',
    ]);
    expect((await rowsOf(owner, table.id, filterQuery(like('x%y')))).data.map((r) => r.title)).toEqual([
      'x_y',
      'xzy',
    ]);
  });

  it('sorts the list by size, largest and smallest, with an empty table as 0', async () => {
    const owner = await signup();
    const big = await makeTable(owner, 'Big');
    const small = await makeTable(owner, 'Small');
    await makeTable(owner, 'Empty');
    await insert(
      owner,
      big.id,
      Array.from({ length: 20 }, (_, i) => ({ title: `row ${i} ${'x'.repeat(50)}` })),
    );
    await insert(owner, small.id, [{ title: 'a' }]);
    const names = async (query: string) =>
      (await owner.client.data(owner.client.get(`/rest/data-tables?${query}`))).data.map(
        (t: { name: string }) => t.name,
      );
    expect(await names('sortBy=size:desc')).toEqual(['Big', 'Small', 'Empty']);
    expect(await names('sortBy=size:asc')).toEqual(['Empty', 'Small', 'Big']);
    expect(await names('sortBy=size:desc&take=1&skip=1')).toEqual(['Small']);
    const page = await owner.client.data(
      owner.client.get('/rest/data-tables?sortBy=size:desc&filter=%7B%22name%22%3A%22sma%22%7D'),
    );
    expect(page.count).toBe(1);
  });

  it('creates from CSV by the source column, so a renamed column keeps its data', async () => {
    const owner = await signup();
    const made = await owner.client.data(
      owner.client.post('/rest/data-tables', {
        name: 'Swapped',
        columns: [
          { name: 'b', type: 'string', csvColumnName: 'a' },
          { name: 'x', type: 'string', csvColumnName: 'b' },
          { name: 'c', type: 'string', csvColumnName: 'c' },
        ],
        csv: 'a,b,c\n1,2,3\n',
      }),
    );
    expect((await rowsOf(owner, made.id)).data[0]).toMatchObject({ b: '1', x: '2', c: '3' });
    const missing = await errorOf(
      owner.client.post('/rest/data-tables', {
        name: 'Missing',
        columns: [{ name: 'y', type: 'string', csvColumnName: 'nope' }],
        csv: 'a\n1\n',
      }),
    );
    expect(missing).toEqual({ status: 400, message: "Column 'nope' is not in the CSV file" });
  });

  it('reads the columns under the table lock: a rename that commits first is seen', async () => {
    const owner = await signup();
    const table = await makeTable(owner, 'Locked', [{ name: 'city', type: 'string' }]);
    const client = await server.ctx.database.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from data_tables where id = $1 for update', [table.id]);
      await client.query("update data_table_columns set name = 'town' where table_id = $1", [table.id]);
      const access = server.ctx.dataTables.forProject(
        owner.tenant.id,
        await teamProjectOf(server, owner.tenant.id),
      );
      const pending = access.insertRows(table.id, [{ town: 'Pune' }], 'all');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('commit');
      const [row] = await pending;
      expect(row).toMatchObject({ town: 'Pune' });
      expect(Object.keys((await dataOf(table.id))[0].data)).toEqual(['town']);
    } finally {
      client.release();
    }
  });

  it('a table that goes before the write answers the not-found text', async () => {
    const owner = await signup();
    const table = await makeTable(owner, 'Gone');
    const service = server.ctx.dataTables as unknown as {
      writeRows(tenantId: string, id: string, rows: unknown[]): Promise<unknown>;
    };
    await owner.client.data(owner.client.delete(`/rest/data-tables/${table.id}`));
    await expect(service.writeRows(owner.tenant.id, table.id, [{ title: 'a' }])).rejects.toMatchObject({
      statusCode: 404,
      message: DATA_TABLE_ERRORS.tableIdNotFound(table.id),
    });
  });
});
