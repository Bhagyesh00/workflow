/**
 * P4-04 Data Table node against a small in-memory DataTableAccess: parameter reading, output shapes
 * (pairedItem, optimizeBulk, dryRun states), n8n's error texts, the bulk and per-item paths, and the
 * editor-side lookups (listSearch, getColumns).
 */
import { DATA_TABLE_ERRORS, type DataObject, type LoadOptionsContext } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { DataTableNode } from '../src/nodes/core/DataTable.node';
import { FakeTables } from './fake-tables';
import { runNode } from './harness';

const COLUMNS = [
  { name: 'title', type: 'string' as const },
  { name: 'score', type: 'number' as const },
  { name: 'done', type: 'boolean' as const },
  { name: 'due', type: 'date' as const },
];

function setup() {
  const fake = new FakeTables();
  const table = fake.add('Tasks', COLUMNS);
  const run = (parameters: DataObject, input: DataObject[] = [{}], node: DataObject = {}) =>
    runNode(
      'core.dataTable',
      parameters,
      input.map((json) => ({ json })),
      {
        services: { dataTables: fake },
        node: node as never,
      },
    );
  const byId = { __rl: true, mode: 'id', value: table.id };
  const insert = (rows: DataObject[]) =>
    run({ resource: 'row', operation: 'insert', dataTableId: byId, dataMode: 'autoMapInputData' }, rows);
  return { fake, table, run, byId, insert };
}

const cond = (keyName: string, condition: string, keyValue?: unknown) => ({
  conditions: [{ keyName, condition, keyValue }],
});

describe('row insert', () => {
  it('maps input fields to columns, ignores system columns and unknown keys, and returns the rows', async () => {
    const { run, byId } = setup();
    const r = await run(
      { resource: 'row', operation: 'insert', dataTableId: byId, dataMode: 'autoMapInputData' },
      [
        { title: 'a', score: 1, id: 99, createdAt: 'x', extra: 'ignored' },
        { title: 'b', score: 2 },
      ],
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toMatchObject([
      { id: 1, title: 'a', score: 1, done: null },
      { id: 2, title: 'b', score: 2 },
    ]);
    expect(r.items[0]!.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('sends all items of one table in one call', async () => {
    const { run, byId, fake } = setup();
    await run({ resource: 'row', operation: 'insert', dataTableId: byId, dataMode: 'autoMapInputData' }, [
      { title: 'a' },
      { title: 'b' },
      { title: 'c' },
    ]);
    expect(fake.calls.filter((c) => c.startsWith('insertRows'))).toEqual(['insertRows:3']);
  });

  it('optimizeBulk returns one item with the count', async () => {
    const { run, byId } = setup();
    const r = await run(
      {
        resource: 'row',
        operation: 'insert',
        dataTableId: byId,
        dataMode: 'autoMapInputData',
        options: { optimizeBulk: true },
      },
      [{ title: 'a' }, { title: 'b' }],
    );
    expect(r.outputs[0]).toEqual([{ success: true, insertedRows: 2 }]);
    expect(r.items[0]![0]!.pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('defineBelow takes the listed columns; an empty number box is null', async () => {
    const { run, byId } = setup();
    const r = await run({
      resource: 'row',
      operation: 'insert',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: {
        fieldValues: [
          { columnName: 'title', value: 'x' },
          { columnName: 'score', value: '' },
          { columnName: 'due', value: '2026-03-04T00:00:00.000Z' },
        ],
      },
    });
    expect(r.outputs[0]![0]).toMatchObject({ title: 'x', score: null, due: '2026-03-04T00:00:00.000Z' });
  });

  it("refuses arrays and objects with n8n's text, and unknown or system columns", async () => {
    const { run, byId } = setup();
    const arr = await run(
      { resource: 'row', operation: 'insert', dataTableId: byId, dataMode: 'autoMapInputData' },
      [{ title: ['a'] }],
    );
    expect(arr.status).toBe('error');
    expect(arr.error?.message).toBe(DATA_TABLE_ERRORS.unexpectedArrayInput('["a"]', 1));
    const unknown = await run({
      resource: 'row',
      operation: 'insert',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: { fieldValues: [{ columnName: 'nope', value: '1' }] },
    });
    expect(unknown.error?.message).toBe(DATA_TABLE_ERRORS.unknownColumn('nope'));
    const system = await run({
      resource: 'row',
      operation: 'insert',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: { fieldValues: [{ columnName: 'id', value: '1' }] },
    });
    expect(system.error?.message).toBe(DATA_TABLE_ERRORS.unknownColumn('id'));
  });

  it('continue on fail turns the error into an item', async () => {
    const { run, byId } = setup();
    const r = await run(
      { resource: 'row', operation: 'insert', dataTableId: byId, dataMode: 'autoMapInputData' },
      [{ title: 'ok' }, { title: { a: 1 } }],
      { onError: 'continueRegularOutput' },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]![0]).toMatchObject({ title: 'ok' });
    expect(r.outputs[0]![1]).toEqual({ error: DATA_TABLE_ERRORS.unexpectedArrayInput('{"a":1}', 2) });
  });
});

describe('table lookup', () => {
  it('finds a table by exact name and never by a part of it', async () => {
    const { run, fake } = setup();
    fake.add('Tasks archive', COLUMNS);
    const base = { resource: 'row', operation: 'get', returnAll: true };
    const ok = await run({ ...base, dataTableId: { __rl: true, mode: 'name', value: 'Tasks' } });
    expect(ok.status).toBe('success');
    const miss = await run({ ...base, dataTableId: { __rl: true, mode: 'name', value: 'task' } });
    expect(miss.error?.message).toBe(DATA_TABLE_ERRORS.tableNameNotFound('task'));
  });

  it("answers an unknown id with n8n's text and description", async () => {
    const { run } = setup();
    const r = await run({
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'zzz' },
    });
    expect(r.error?.message).toBe(DATA_TABLE_ERRORS.tableIdNotFound('zzz'));
    expect((r.error as { description?: string }).description).toBe(
      DATA_TABLE_ERRORS.tableIdNotFoundDescription,
    );
  });

  it('asks for a table when the locator is empty', async () => {
    const { run } = setup();
    const r = await run({
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'list', value: '' },
    });
    expect(r.error?.message).toBe('Select a data table');
  });

  it('looks a table up once for many items and passes a per-item table id through', async () => {
    const { run, fake, insert, table } = setup();
    await insert([{ title: 'a' }, { title: 'b' }]);
    fake.calls.length = 0;
    await run({ resource: 'row', operation: 'get', returnAll: true, dataTableId: '={{ $json.t }}' }, [
      { t: table.id },
      { t: table.id },
      { t: table.id },
    ]);
    expect(fake.calls.filter((c) => c === 'getTable')).toHaveLength(1);
  });
});

describe('row get', () => {
  const seed = async () => {
    const s = setup();
    await s.insert([
      { title: 'a', score: 1, done: true },
      { title: 'b', score: 2, done: false },
      { title: 'c', score: 3, done: true },
    ]);
    return s;
  };

  it('limits per input row (default 50) and returns all on request', async () => {
    const { run, byId } = await seed();
    const limited = await run(
      { resource: 'row', operation: 'get', dataTableId: byId, returnAll: false, limit: 2 },
      [{}, {}],
    );
    expect(limited.outputs[0]).toHaveLength(4);
    expect(limited.items[0]!.map((i) => i.pairedItem)).toEqual([
      { item: 0 },
      { item: 0 },
      { item: 1 },
      { item: 1 },
    ]);
    const all = await run({ resource: 'row', operation: 'get', dataTableId: byId, returnAll: true });
    expect(all.outputs[0]).toHaveLength(3);
  });

  it('pages past the service cap until the count', async () => {
    const { run, byId, insert, fake } = setup();
    await insert(Array.from({ length: 600 }, (_, n) => ({ title: `r${n}` })));
    fake.calls.length = 0;
    const r = await run({ resource: 'row', operation: 'get', dataTableId: byId, returnAll: true });
    expect(r.outputs[0]).toHaveLength(600);
    expect(fake.calls).toContain('getRows:250:500');
  });

  it('filters: any condition by default, all conditions on request; types are converted', async () => {
    const { run, byId } = await seed();
    const two = {
      conditions: [
        { keyName: 'score', condition: 'gte', keyValue: '2' },
        { keyName: 'done', condition: 'isTrue' },
      ],
    };
    const any = await run({
      resource: 'row',
      operation: 'get',
      dataTableId: byId,
      returnAll: true,
      filters: two,
    });
    expect(any.outputs[0]!.map((r) => r.title)).toEqual(['a', 'b', 'c']);
    const all = await run({
      resource: 'row',
      operation: 'get',
      dataTableId: byId,
      returnAll: true,
      matchType: 'allConditions',
      filters: two,
    });
    expect(all.outputs[0]!.map((r) => r.title)).toEqual(['c']);
  });

  it('orders by a column in the chosen direction and refuses an unknown column', async () => {
    const { run, byId } = await seed();
    const base = { resource: 'row', operation: 'get', dataTableId: byId, returnAll: true, orderBy: true };
    const desc = await run({ ...base, orderByColumn: 'score', orderByDirection: 'DESC' });
    expect(desc.outputs[0]!.map((r) => r.score)).toEqual([3, 2, 1]);
    const asc = await run({ ...base, orderByColumn: 'score', orderByDirection: 'ASC' });
    expect(asc.outputs[0]!.map((r) => r.score)).toEqual([1, 2, 3]);
    const bad = await run({ ...base, orderByColumn: 'nope' });
    expect(bad.error?.message).toBe(DATA_TABLE_ERRORS.orderByColumnMissing);
  });

  it('names columns missing from the table and an invalid date or number', async () => {
    const { run, byId } = await seed();
    const base = { resource: 'row', operation: 'get', dataTableId: byId, returnAll: true };
    const missing = await run({ ...base, filters: cond('ghost', 'eq', 1) });
    expect(missing.error?.message).toBe(DATA_TABLE_ERRORS.filterColumnsMissing(['ghost']));
    const date = await run({ ...base, filters: cond('due', 'eq', 'not a date') });
    expect(date.error?.message).toBe(DATA_TABLE_ERRORS.invalidDate('not a date', 'due'));
    const num = await run({ ...base, filters: cond('score', 'gt', 'abc') });
    expect(num.error?.message).toContain("does not match column type 'number'");
  });
});

describe('row update, upsert, delete', () => {
  it('update needs a condition and returns the updated rows', async () => {
    const { run, byId, insert } = setup();
    await insert([
      { title: 'a', score: 1 },
      { title: 'b', score: 2 },
    ]);
    const base = {
      resource: 'row',
      operation: 'update',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: { fieldValues: [{ columnName: 'score', value: '9' }] },
    };
    const none = await run(base);
    expect(none.error?.message).toBe(DATA_TABLE_ERRORS.atLeastOneCondition);
    const ok = await run({ ...base, filters: cond('title', 'eq', 'a') });
    expect(ok.outputs[0]).toMatchObject([{ title: 'a', score: 9 }]);
  });

  it('dryRun returns before and after rows and changes nothing', async () => {
    const { run, byId, insert } = setup();
    await insert([{ title: 'a', score: 1 }]);
    const r = await run({
      resource: 'row',
      operation: 'update',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: { fieldValues: [{ columnName: 'score', value: '5' }] },
      filters: cond('title', 'eq', 'a'),
      options: { dryRun: true },
    });
    expect(r.outputs[0]!.map((x) => [x.dryRunState, x.score])).toEqual([
      ['before', 1],
      ['after', 5],
    ]);
    const check = await run({ resource: 'row', operation: 'get', dataTableId: byId, returnAll: true });
    expect(check.outputs[0]![0]!.score).toBe(1);
  });

  it('upsert updates a match and inserts when there is none', async () => {
    const { run, byId } = setup();
    const params = (title: string, score: string) => ({
      resource: 'row',
      operation: 'upsert',
      dataTableId: byId,
      dataMode: 'defineBelow',
      fieldsUi: {
        fieldValues: [
          { columnName: 'title', value: title },
          { columnName: 'score', value: score },
        ],
      },
      filters: cond('title', 'eq', title),
    });
    expect((await run(params('a', '1'))).outputs[0]).toMatchObject([{ id: 1, title: 'a', score: 1 }]);
    expect((await run(params('a', '2'))).outputs[0]).toMatchObject([{ id: 1, score: 2 }]);
    const all = await run({ resource: 'row', operation: 'get', dataTableId: byId, returnAll: true });
    expect(all.outputs[0]).toHaveLength(1);
  });

  it('delete needs a condition, returns the deleted rows, and dryRun keeps them', async () => {
    const { run, byId, insert } = setup();
    await insert([{ title: 'a' }, { title: 'b' }]);
    const base = { resource: 'row', operation: 'deleteRows', dataTableId: byId };
    expect((await run(base)).error?.message).toBe(DATA_TABLE_ERRORS.atLeastOneCondition);
    const dry = await run({ ...base, filters: cond('title', 'eq', 'a'), options: { dryRun: true } });
    expect(dry.outputs[0]).toMatchObject([{ title: 'a', dryRunState: 'before' }]);
    const real = await run({ ...base, filters: cond('title', 'eq', 'a') });
    expect(real.outputs[0]).toMatchObject([{ title: 'a' }]);
    const left = await run({ resource: 'row', operation: 'get', dataTableId: byId, returnAll: true });
    expect(left.outputs[0]!.map((r) => r.title)).toEqual(['b']);
  });
});

describe('row exists checks', () => {
  it('pass the input item through when the row does (not) exist', async () => {
    const { run, byId, insert } = setup();
    await insert([{ title: 'a' }]);
    const input = [{ k: 'a' }, { k: 'zz' }];
    const filters = { conditions: [{ keyName: 'title', condition: 'eq', keyValue: '={{ $json.k }}' }] };
    const yes = await run({ resource: 'row', operation: 'rowExists', dataTableId: byId, filters }, input);
    expect(yes.outputs[0]).toEqual([{ k: 'a' }]);
    expect(yes.items[0]![0]!.pairedItem).toEqual({ item: 0 });
    const no = await run({ resource: 'row', operation: 'rowNotExists', dataTableId: byId, filters }, input);
    expect(no.outputs[0]).toEqual([{ k: 'zz' }]);
    expect(no.items[0]![0]!.pairedItem).toEqual({ item: 1 });
    const none = await run({ resource: 'row', operation: 'rowExists', dataTableId: byId }, input);
    expect(none.error?.message).toBe(DATA_TABLE_ERRORS.atLeastOneCondition);
  });
});

describe('table operations', () => {
  it('create reuses an existing table by default and fails when told not to', async () => {
    const { run, fake } = setup();
    const params = (reuse: boolean) => ({
      resource: 'table',
      operation: 'create',
      tableName: 'Tasks',
      columns: { column: [{ name: 'x', type: 'number' }] },
      options: { createIfNotExists: reuse },
    });
    const same = await run(params(true));
    expect(same.outputs[0]![0]).toMatchObject({ name: 'Tasks' });
    expect(fake.tables.size).toBe(1);
    const dup = await run(params(false));
    expect(dup.error?.message).toBe(DATA_TABLE_ERRORS.tableNameExists('Tasks'));
    const fresh = await run({ ...params(true), tableName: 'Other' });
    expect(fresh.outputs[0]![0]).toMatchObject({ name: 'Other', columns: [{ name: 'x', type: 'number' }] });
    expect(fake.tables.size).toBe(2);
  });

  it('lists, renames, clears and deletes', async () => {
    const { run, byId, table, fake, insert } = setup();
    fake.add('Another', COLUMNS);
    const list = await run({ resource: 'table', operation: 'list', returnAll: true });
    expect(list.outputs[0]!.map((t) => t.name)).toEqual(['Another', 'Tasks']);
    const limited = await run({ resource: 'table', operation: 'list', returnAll: false, limit: 1 });
    expect(limited.outputs[0]).toHaveLength(1);
    const named = await run({
      resource: 'table',
      operation: 'list',
      returnAll: true,
      options: { filterName: 'tas' },
    });
    expect(named.outputs[0]!.map((t) => t.name)).toEqual(['Tasks']);

    expect(
      (await run({ resource: 'table', operation: 'update', dataTableId: byId, newName: 'Todo' })).outputs[0],
    ).toEqual([{ success: true, name: 'Todo' }]);
    await insert([{ title: 'a' }, { title: 'b' }]);
    expect((await run({ resource: 'table', operation: 'clear', dataTableId: byId })).outputs[0]).toEqual([
      { success: true, deletedCount: 2 },
    ]);
    expect(
      (await run({ resource: 'table', operation: 'deleteTable', dataTableId: byId })).outputs[0],
    ).toEqual([{ success: true, deletedTableId: table.id }]);
    expect(fake.tables.has(table.id)).toBe(false);
  });
});

describe('editor lookups', () => {
  const loadCtx = (fake: FakeTables, current: Record<string, unknown> = {}) =>
    ({
      helpers: { dataTables: fake },
      getCurrentNodeParameter: (name: string) => current[name],
    }) as unknown as LoadOptionsContext;

  it('tableSearch lists tables by name with a link and pages', async () => {
    const fake = new FakeTables();
    for (let n = 0; n < 60; n++) fake.add(`T${String(n).padStart(2, '0')}`, COLUMNS);
    const search = DataTableNode.methods!.listSearch!.tableSearch!;
    const first = await search(loadCtx(fake), '');
    expect(first.results).toHaveLength(50);
    expect(first.results[0]).toEqual({ name: 'T00', value: 't1', url: '/data-tables/t1' });
    expect(first.paginationToken).toBe('50');
    const second = await search(loadCtx(fake), '', first.paginationToken);
    expect(second.results).toHaveLength(10);
    expect(second.paginationToken).toBeUndefined();
    expect((await search(loadCtx(fake), 'T5')).results.map((r) => r.name)).toContain('T55');
  });

  it('getColumns offers the columns and the system columns, getWritableColumns only the columns', async () => {
    const fake = new FakeTables();
    const table = fake.add('Tasks', COLUMNS);
    const { getColumns, getWritableColumns } = DataTableNode.methods!.loadOptions!;
    const ctx = loadCtx(fake, { dataTableId: { __rl: true, mode: 'id', value: table.id } });
    expect((await getColumns!(ctx)).map((o) => o.value)).toEqual([
      'title',
      'score',
      'done',
      'due',
      'id',
      'createdAt',
      'updatedAt',
    ]);
    expect((await getWritableColumns!(ctx)).map((o) => o.value)).toEqual(['title', 'score', 'done', 'due']);
    const byName = loadCtx(fake, { dataTableId: { __rl: true, mode: 'name', value: 'Tasks' } });
    expect(await getWritableColumns!(byName)).toHaveLength(4);
    expect(await getColumns!(loadCtx(fake, {}))).toEqual([]);
  });

  it('declares the create-new link, the tool flag and the exact by-name mode', () => {
    const d = DataTableNode.description;
    expect(d.usableAsTool).toBe(true);
    const locator = d.properties.find((p) => p.name === 'dataTableId')!;
    expect(locator.modes!.find((m) => m.name === 'list')!.typeOptions!.allowNewResource).toEqual({
      label: 'Create a new data table',
      url: '/data-tables',
    });
  });
});

describe('without data tables', () => {
  it('fails with a clear message when the run has no data table access', async () => {
    const r = await runNode('core.dataTable', { resource: 'table', operation: 'list' });
    expect(r.error?.message).toBe('Data tables are not available in this run');
  });
});

describe('FakeTables.addColumn (DataTableAccess.addColumn)', () => {
  it('adds a column at the end, fills existing rows with null and refuses a taken name', async () => {
    const { fake, table, insert } = setup();
    await insert([{ title: 'a' }]);
    const column = await fake.addColumn(table.id, { name: 'output', type: 'string' });
    expect(column).toMatchObject({ name: 'output', type: 'string', position: COLUMNS.length });
    expect((await fake.listColumns(table.id)).map((c) => c.name)).toEqual([
      ...COLUMNS.map((c) => c.name),
      'output',
    ]);
    expect((await fake.getRows(table.id)).data[0]).toMatchObject({ title: 'a', output: null });
    await expect(fake.addColumn(table.id, { name: 'output', type: 'number' })).rejects.toThrow(
      DATA_TABLE_ERRORS.columnNameExists('output', 'Tasks'),
    );
    await expect(fake.addColumn('missing', { name: 'x', type: 'string' })).rejects.toThrow(
      DATA_TABLE_ERRORS.tableIdNotFound('missing'),
    );
    expect(fake.calls).toContain('addColumn:output');
  });
});
