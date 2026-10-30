import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { notionPropertyValue, richText, simplifyPage } from '../src/nodes/apps/Notion.node';
import { contextFor } from './contexts';
import { FakeHttpClient, runNode } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));
const NOTION = 'https://api.notion.com/v1';
const notionCreds = { notionApi: { apiKey: 'ntn_secret' } };
const DB_ID = '0fe2f7de558b471eab07e9d871cdf4a9';

const page = (id: string, title: string, extra: DataObject = {}): DataObject => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${id}`,
  archived: false,
  created_time: '2024-01-01T00:00:00.000Z',
  last_edited_time: '2024-01-02T00:00:00.000Z',
  properties: {
    Name: { type: 'title', title: [{ plain_text: title }] },
    Status: { type: 'status', status: { name: 'Open' } },
    Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
    Count: { type: 'number', number: 3 },
    ...extra,
  },
});

describe('Notion helpers', () => {
  it('builds property values and splits long text', () => {
    expect(notionPropertyValue('number', '4.5')).toEqual({ number: 4.5 });
    expect(notionPropertyValue('checkbox', 'true')).toEqual({ checkbox: true });
    expect(notionPropertyValue('multi_select', 'a, b')).toEqual({
      multi_select: [{ name: 'a' }, { name: 'b' }],
    });
    expect(notionPropertyValue('date', '2024-01-01/2024-01-05')).toEqual({
      date: { start: '2024-01-01', end: '2024-01-05' },
    });
    expect(notionPropertyValue('relation', 'p1,p2')).toEqual({ relation: [{ id: 'p1' }, { id: 'p2' }] });
    expect(notionPropertyValue('select', '')).toEqual({ select: null });
    expect(() => notionPropertyValue('number', 'abc')).toThrow(/not a number/);
    expect(richText('x'.repeat(4500))).toHaveLength(3);
    expect(simplifyPage(page('p1', 'Task'))).toEqual({
      id: 'p1',
      name: 'Task',
      url: 'https://www.notion.so/p1',
      archived: false,
      createdTime: '2024-01-01T00:00:00.000Z',
      lastEditedTime: '2024-01-02T00:00:00.000Z',
      properties: { Name: 'Task', Status: 'Open', Tags: ['a', 'b'], Count: 3 },
    });
  });
});

describe('Notion', () => {
  it('creates a database page with properties and blocks', async () => {
    const http = new FakeHttpClient().on('POST', `${NOTION}/pages`, () => page('p1', 'Write docs'));
    const r = await runNode(
      'app.notion',
      {
        resource: 'databasePage',
        operation: 'create',
        databaseId: { __rl: true, mode: 'url', value: `https://www.notion.so/acme/${DB_ID}?v=1` },
        propertiesUi: {
          propertyValues: [
            { key: 'Name', type: 'title', value: '={{ $json.title }}' },
            { key: 'Count', type: 'number', value: '3' },
          ],
        },
        blockUi: {
          blockValues: [
            { type: 'heading_2', text: 'Notes' },
            { type: 'to_do', text: 'Review', checked: true },
            { type: 'divider' },
          ],
        },
      },
      items({ title: 'Write docs' }),
      { creds: notionCreds, services: { http } },
    );
    expect(r.outputs[0][0]).toMatchObject({ id: 'p1', name: 'Write docs', properties: { Count: 3 } });
    const req = http.requests[0];
    expect(req.headers).toMatchObject({ authorization: 'Bearer ntn_secret', 'notion-version': '2022-06-28' });
    expect(req.body).toEqual({
      parent: { database_id: DB_ID },
      properties: {
        Name: { title: [{ type: 'text', text: { content: 'Write docs' } }] },
        Count: { number: 3 },
      },
      children: [
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: 'Notes' } }] },
        },
        {
          object: 'block',
          type: 'to_do',
          to_do: { rich_text: [{ type: 'text', text: { content: 'Review' } }], checked: true },
        },
        { object: 'block', type: 'divider', divider: {} },
      ],
    });
  });

  it('queries database pages with filters, sorts and pagination', async () => {
    const http = new FakeHttpClient().on('POST', `${NOTION}/databases/${DB_ID}/query`, (req) =>
      (req.body as DataObject).start_cursor
        ? { results: [page('p3', 'C')], has_more: false }
        : { results: [page('p1', 'A'), page('p2', 'B')], has_more: true, next_cursor: 'cur2' },
    );
    const r = await runNode(
      'app.notion',
      {
        resource: 'databasePage',
        operation: 'getAll',
        databaseId: { __rl: true, mode: 'id', value: DB_ID },
        returnAll: true,
        filterType: 'manual',
        matchType: 'or',
        filters: {
          conditions: [
            { key: 'Status', type: 'status', condition: 'equals', value: 'Open' },
            { key: 'Count', type: 'number', condition: 'greater_than', value: '2' },
          ],
        },
        sort: { sortValue: [{ key: 'created_time', direction: 'descending' }] },
      },
      items({}),
      { creds: notionCreds, services: { http } },
    );
    expect(r.outputs[0].map((o) => o.name)).toEqual(['A', 'B', 'C']);
    expect(http.requests[0].body).toEqual({
      filter: {
        or: [
          { property: 'Status', status: { equals: 'Open' } },
          { property: 'Count', number: { greater_than: 2 } },
        ],
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 100,
    });
    expect((http.requests[1].body as DataObject).start_cursor).toBe('cur2');
  });

  it('handles pages, databases, blocks and users', async () => {
    const http = new FakeHttpClient()
      .on('GET', `${NOTION}/pages/`, () => page('p1', 'A'))
      .on('PATCH', `${NOTION}/pages/`, (req) => ({
        ...page('p1', 'A'),
        archived: (req.body as DataObject).archived ?? false,
      }))
      .on('POST', `${NOTION}/pages`, () => page('p9', 'Child'))
      .on('POST', `${NOTION}/search`, (req) =>
        ((req.body as DataObject).filter as DataObject).value === 'database'
          ? {
              results: [
                {
                  object: 'database',
                  id: DB_ID,
                  title: [{ plain_text: 'Tasks' }],
                  properties: { Name: { type: 'title' } },
                },
              ],
              has_more: false,
            }
          : { results: [page('p1', 'Found')], has_more: false },
      )
      .on('GET', `${NOTION}/databases/`, () => ({
        id: DB_ID,
        title: [{ plain_text: 'Tasks' }],
        properties: { Name: { type: 'title' } },
      }))
      .on('PATCH', `${NOTION}/blocks/`, (req) => ({ results: (req.body as DataObject).children }))
      .on('GET', `${NOTION}/blocks/`, () => ({ results: [{ id: 'b1', type: 'paragraph' }], has_more: false }))
      .on('GET', `${NOTION}/users/u1`, () => ({ id: 'u1', name: 'Ada' }))
      .on('GET', `${NOTION}/users`, () => ({ results: [{ id: 'u1' }, { id: 'u2' }], has_more: false }));
    const call = (params: DataObject) =>
      runNode('app.notion', params, items({}), { creds: notionCreds, services: { http } });
    const pageId = { __rl: true, mode: 'id', value: 'p1' };
    expect((await call({ resource: 'page', operation: 'get', pageId })).outputs[0][0]).toMatchObject({
      id: 'p1',
      name: 'A',
    });
    expect((await call({ resource: 'page', operation: 'archive', pageId })).outputs[0][0]).toMatchObject({
      archived: true,
    });
    await call({ resource: 'page', operation: 'create', pageId, title: 'Child' });
    expect(http.requests.at(-1)!.body).toEqual({
      parent: { page_id: 'p1' },
      properties: { title: { title: [{ type: 'text', text: { content: 'Child' } }] } },
    });
    expect(
      (await call({ resource: 'page', operation: 'search', text: 'Fo', returnAll: true })).outputs[0][0].name,
    ).toBe('Found');
    expect(
      (await call({ resource: 'database', operation: 'search', text: 'Ta', returnAll: true })).outputs[0][0],
    ).toMatchObject({ name: 'Tasks', properties: { Name: 'title' } });
    expect((await call({ resource: 'database', operation: 'getAll', limit: 1 })).outputs[0]).toHaveLength(1);
    expect(
      (
        await call({
          resource: 'database',
          operation: 'get',
          databaseId: { __rl: true, mode: 'id', value: DB_ID },
          simple: false,
        })
      ).outputs[0][0].title,
    ).toBeDefined();
    const updated = await call({
      resource: 'databasePage',
      operation: 'update',
      pageId,
      propertiesUi: { propertyValues: [{ key: 'Done', type: 'checkbox', value: 'true' }] },
      options: { rawProperties: '{"Priority": {"select": {"name": "High"}}}' },
    });
    expect(updated.status).toBe('success');
    expect(http.requests.at(-1)!.body).toEqual({
      properties: { Done: { checkbox: true }, Priority: { select: { name: 'High' } } },
    });
    const appended = await call({
      resource: 'block',
      operation: 'append',
      blockId: pageId,
      blockUi: { blockValues: [{ type: 'paragraph', text: 'hi' }] },
    });
    expect(appended.outputs[0]).toHaveLength(1);
    expect(
      (await call({ resource: 'block', operation: 'getAll', blockId: pageId, returnAll: true })).outputs[0],
    ).toEqual([{ id: 'b1', type: 'paragraph' }]);
    expect((await call({ resource: 'user', operation: 'get', userId: 'u1' })).outputs[0]).toEqual([
      { id: 'u1', name: 'Ada' },
    ]);
    expect((await call({ resource: 'user', operation: 'getAll', returnAll: true })).outputs[0]).toHaveLength(
      2,
    );
    const ctx = contextFor('app.notion', {}, { creds: notionCreds, services: { http } });
    const dbs = await ctx.nodeType.methods!.listSearch!.searchDatabases(ctx.loadOptions(), 'Ta');
    expect(dbs.results).toEqual([{ name: 'Tasks', value: DB_ID, url: undefined }]);
  });

  it('reports invalid property values per item', async () => {
    const http = new FakeHttpClient();
    const r = await runNode(
      'app.notion',
      {
        resource: 'databasePage',
        operation: 'create',
        databaseId: { __rl: true, mode: 'id', value: DB_ID },
        propertiesUi: { propertyValues: [{ key: 'Count', type: 'number', value: 'many' }] },
      },
      items({}),
      { creds: notionCreds, services: { http } },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Property "Count": "many" is not a number');
    expect(http.requests).toHaveLength(0);
  });

  it('surfaces Notion API errors with their message', async () => {
    const http = new FakeHttpClient().on('GET', `${NOTION}/pages/`, () => ({
      __status: 404,
      body: {
        object: 'error',
        status: 404,
        code: 'object_not_found',
        message: 'Could not find page with ID: p1.',
      },
    }));
    const r = await runNode(
      'app.notion',
      { resource: 'page', operation: 'get', pageId: { __rl: true, mode: 'id', value: 'p1' } },
      items({}),
      {
        creds: notionCreds,
        services: { http },
      },
    );
    expect(r.error).toMatchObject({ message: 'Could not find page with ID: p1.', code: 'HTTP_404' });
  });
});

describe('Airtable', () => {
  const AIRTABLE = 'https://api.airtable.com/v0';
  const creds = { airtableTokenApi: { accessToken: 'pat123' } };
  const base = { __rl: true, mode: 'url', value: 'https://airtable.com/appABC123/tblXYZ789/viw1' };
  const table = { __rl: true, mode: 'url', value: 'https://airtable.com/appABC123/tblXYZ789/viw1' };
  const record = (id: string, fields: DataObject) => ({
    id,
    createdTime: '2024-01-01T00:00:00.000Z',
    fields,
  });

  it('lists and searches records with sorting, fields and offset pagination', async () => {
    const http = new FakeHttpClient().on('GET', `${AIRTABLE}/appABC123/tblXYZ789`, (req) =>
      new URL(req.url).searchParams.get('offset')
        ? { records: [record('rec3', { Name: 'C' })] }
        : { records: [record('rec1', { Name: 'A' }), record('rec2', { Name: 'B' })], offset: 'o2' },
    );
    const r = await runNode(
      'app.airtable',
      {
        resource: 'record',
        operation: 'search',
        base,
        table,
        filterByFormula: "{Status} = 'Open'",
        returnAll: true,
        sort: { property: [{ field: 'Name', direction: 'desc' }] },
        options: { fields: 'Name, Status', view: 'Grid' },
      },
      items({}),
      { creds, services: { http } },
    );
    expect(r.outputs[0]).toEqual([
      { Name: 'A', id: 'rec1', createdTime: '2024-01-01T00:00:00.000Z' },
      { Name: 'B', id: 'rec2', createdTime: '2024-01-01T00:00:00.000Z' },
      { Name: 'C', id: 'rec3', createdTime: '2024-01-01T00:00:00.000Z' },
    ]);
    const url = new URL(http.requests[0].url);
    expect(url.searchParams.get('filterByFormula')).toBe("{Status} = 'Open'");
    expect(url.searchParams.getAll('fields[]')).toEqual(['Name', 'Status']);
    expect(url.searchParams.get('sort[0][field]')).toBe('Name');
    expect(url.searchParams.get('sort[0][direction]')).toBe('desc');
    expect(http.requests[0].headers.authorization).toBe('Bearer pat123');
  });

  it('creates, updates, upserts, gets and deletes records', async () => {
    const http = new FakeHttpClient()
      .on('POST', `${AIRTABLE}/appABC123/tblXYZ789`, (req) => ({
        records: [record('recN', ((req.body as DataObject).records as DataObject[])[0].fields as DataObject)],
      }))
      .on('PATCH', `${AIRTABLE}/appABC123/tblXYZ789`, (req) => ({
        records: ((req.body as DataObject).records as DataObject[]).map((r) =>
          record(String(r.id ?? 'recU'), r.fields as DataObject),
        ),
      }))
      .on('GET', `${AIRTABLE}/appABC123/tblXYZ789/rec1`, () => record('rec1', { Name: 'A' }))
      .on('DELETE', `${AIRTABLE}/appABC123/tblXYZ789/rec1`, () => ({ id: 'rec1', deleted: true }));
    const call = (params: DataObject, input = items({})) =>
      runNode('app.airtable', { resource: 'record', base, table, ...params }, input, {
        creds,
        services: { http },
      });
    const created = await call(
      { operation: 'create', options: { typecast: true, ignoreFields: 'internal' } },
      items({ Name: 'New', internal: 1, id: 'x' }),
    );
    expect(created.outputs[0]).toEqual([
      { Name: 'New', id: 'recN', createdTime: '2024-01-01T00:00:00.000Z' },
    ]);
    expect(http.requests[0].body).toEqual({ records: [{ fields: { Name: 'New' } }], typecast: true });
    await call(
      {
        operation: 'update',
        dataMode: 'defineBelow',
        fieldsUi: { fieldValues: [{ fieldName: 'Status', fieldValue: 'Done' }] },
      },
      items({ id: 'rec1' }),
    );
    expect(http.requests[1].body).toEqual({
      records: [{ id: 'rec1', fields: { Status: 'Done' } }],
      typecast: false,
    });
    await call({ operation: 'upsert', fieldsToMergeOn: 'Email' }, items({ Email: 'a@x', Name: 'A' }));
    expect(http.requests[2].body).toEqual({
      performUpsert: { fieldsToMergeOn: ['Email'] },
      records: [{ fields: { Email: 'a@x', Name: 'A' } }],
      typecast: false,
    });
    expect((await call({ operation: 'get', id: 'rec1' })).outputs[0]).toEqual([
      { Name: 'A', id: 'rec1', createdTime: '2024-01-01T00:00:00.000Z' },
    ]);
    expect((await call({ operation: 'delete', id: 'rec1' })).outputs[0]).toEqual([
      { id: 'rec1', deleted: true },
    ]);
    const missing = await call(
      { operation: 'upsert', fieldsToMergeOn: 'Email' },
      items({ Name: 'no email' }),
    );
    expect(missing.error?.message).toMatch(/no value for "Email"/);
  });

  it('lists bases and schemas and searches for the locator', async () => {
    const http = new FakeHttpClient()
      .on('GET', `${AIRTABLE}/meta/bases/appABC123/tables`, () => ({
        tables: [
          { id: 'tbl1', name: 'Leads' },
          { id: 'tbl2', name: 'Deals' },
        ],
      }))
      .on('GET', `${AIRTABLE}/meta/bases`, (req) =>
        new URL(req.url).searchParams.get('offset')
          ? { bases: [{ id: 'app2', name: 'Two' }] }
          : { bases: [{ id: 'app1', name: 'One' }], offset: 'b2' },
      );
    const bases = await runNode(
      'app.airtable',
      { resource: 'base', operation: 'list', returnAll: true },
      items({}),
      { creds, services: { http } },
    );
    expect(bases.outputs[0]).toEqual([
      { id: 'app1', name: 'One' },
      { id: 'app2', name: 'Two' },
    ]);
    const schema = await runNode('app.airtable', { resource: 'base', operation: 'schema', base }, items({}), {
      creds,
      services: { http },
    });
    expect(schema.outputs[0]).toHaveLength(2);
    const ctx = contextFor(
      'app.airtable',
      { base: { __rl: true, mode: 'id', value: 'appABC123' } },
      { creds, services: { http } },
    );
    const tables = await ctx.nodeType.methods!.listSearch!.searchTables(ctx.loadOptions(), 'lea');
    expect(tables.results).toEqual([
      { name: 'Leads', value: 'tbl1', url: 'https://airtable.com/appABC123/tbl1' },
    ]);
    const found = await ctx.nodeType.methods!.listSearch!.searchBases(ctx.loadOptions());
    expect(found).toEqual({
      results: [{ name: 'One', value: 'app1', url: 'https://airtable.com/app1' }],
      paginationToken: 'b2',
    });
  });

  it('surfaces API errors and continues on fail', async () => {
    const http = new FakeHttpClient().on('GET', AIRTABLE, () => ({
      __status: 422,
      body: { error: { type: 'INVALID_FILTER', message: 'Invalid formula' } },
    }));
    const r = await runNode(
      'app.airtable',
      { resource: 'record', operation: 'search', base, table, filterByFormula: '{' },
      items({}, {}),
      {
        creds,
        services: { http },
        node: { onError: 'continueRegularOutput' },
      },
    );
    expect(r.outputs[0]).toEqual([{ error: 'Invalid formula' }, { error: 'Invalid formula' }]);
  });
});
