import { randomBytes } from 'node:crypto';
import type { DataObject, Item } from '@workflow/workflow';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  buildUpsert,
  mysqlDialect,
  postgresDialect,
} from '../src/nodes/apps/sql/sql';
import { contextFor } from './contexts';
import { runNode } from './harness';
import { localHttp } from './servers';

const URL = 'postgres://postgres:postgres@127.0.0.1:5432/nodes_test';
const creds = {
  postgres: { host: '127.0.0.1', port: 5432, database: 'nodes_test', user: 'postgres', password: 'postgres' },
};
const schema = `t_${randomBytes(4).toString('hex')}`;
const table = { __rl: true, mode: 'name', value: 'people' };
const schemaRl = { __rl: true, mode: 'name', value: schema };
const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));

let admin: pg.Client;
const rows = async () =>
  (await admin.query(`SELECT id, email, name, age FROM "${schema}".people ORDER BY id`)).rows;
const run = (parameters: DataObject, input: Item[] = [{ json: {} }], node: object = {}) =>
  runNode('app.postgres', { schema: schemaRl, table, ...parameters }, input, {
    creds,
    services: { http: localHttp() },
    node,
  });

beforeAll(async () => {
  admin = new pg.Client(URL);
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
});

beforeEach(async () => {
  await admin.query(`DROP TABLE IF EXISTS "${schema}".people`);
  await admin.query(
    `CREATE TABLE "${schema}".people (id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text, age int, meta jsonb, created timestamptz DEFAULT '2024-01-01T00:00:00Z')`,
  );
});

afterAll(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

describe('SQL builders', () => {
  it('quote identifiers and bind every value', () => {
    expect(buildInsert(postgresDialect, '"t"', { 'we"ird': 1, b: "x'); DROP TABLE t;--" })).toEqual({
      text: 'INSERT INTO "t" ("we""ird", "b") VALUES ($1, $2)',
      values: [1, "x'); DROP TABLE t;--"],
    });
    expect(buildInsert(mysqlDialect, '`t`', { 'a`b': 1 }, { ignoreConflicts: true }).text).toBe(
      'INSERT IGNORE INTO `t` (`a``b`) VALUES (?)',
    );
    expect(buildUpdate(postgresDialect, '"t"', { id: 1, a: 2 }, 'id', { returning: true }).text).toBe(
      'UPDATE "t" SET "a" = $1 WHERE "id" = $2 RETURNING *',
    );
    expect(buildUpsert(mysqlDialect, '`t`', { id: 1, a: 2 }, 'id').text).toBe(
      'INSERT INTO `t` (`id`, `a`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `a` = VALUES(`a`)',
    );
    expect(
      buildSelect(postgresDialect, '"t"', {
        where: [
          { column: 'a', condition: '>', value: 1 },
          { column: 'b', condition: 'IS NULL' },
        ],
        combinator: 'OR',
        sort: [{ column: 'a', direction: 'DESC' }],
        limit: 5,
      }),
    ).toEqual({
      text: 'SELECT * FROM "t" WHERE "a" > $1 OR "b" IS NULL ORDER BY "a" DESC LIMIT 5',
      values: [1],
    });
    expect(() => buildDelete(postgresDialect, '"t"', 'delete')).toThrow(/Add at least one condition/);
    expect(() =>
      buildSelect(postgresDialect, '"t"', {
        where: [{ column: 'a', condition: '; DROP' as never, value: 1 }],
      }),
    ).toThrow(/Unsupported condition/);
    expect(() => postgresDialect.quote('')).toThrow(/empty/);
  });
});

describe('Postgres', () => {
  it('inserts rows from item fields and returns them', async () => {
    const r = await run(
      { operation: 'insert' },
      items(
        { email: 'ada@x.io', name: 'Ada', age: 36, meta: { vip: true } },
        { email: 'bob@x.io', name: 'Bob' },
      ),
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toMatchObject([
      { email: 'ada@x.io', name: 'Ada', age: 36, meta: { vip: true }, created: '2024-01-01T00:00:00.000Z' },
      { email: 'bob@x.io', name: 'Bob', age: null },
    ]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
    expect(await rows()).toHaveLength(2);
  });

  it('stores hostile strings as values, never as SQL', async () => {
    const evil = "x'); DROP TABLE people; --";
    const r = await run(
      {
        operation: 'insert',
        dataMode: 'defineBelow',
        valuesToSend: {
          values: [
            { column: 'email', value: evil },
            { column: 'name', value: '={{ $json.n }}' },
          ],
        },
      },
      items({ n: 'Robert' }),
    );
    expect(r.status).toBe('success');
    expect(await rows()).toMatchObject([{ email: evil, name: 'Robert' }]);
  });

  it('updates and upserts by a match column', async () => {
    await run({ operation: 'insert' }, items({ email: 'ada@x.io', name: 'Ada', age: 1 }));
    const updated = await run(
      { operation: 'update', columnToMatchOn: 'email' },
      items({ email: 'ada@x.io', age: 37 }),
    );
    expect(updated.outputs[0]).toMatchObject([{ email: 'ada@x.io', name: 'Ada', age: 37 }]);
    const upserted = await run(
      { operation: 'upsert', columnToMatchOn: 'email' },
      items({ email: 'ada@x.io', name: 'Ada L.' }, { email: 'cy@x.io', name: 'Cy' }),
    );
    expect(upserted.outputs[0]).toHaveLength(2);
    expect(await rows()).toMatchObject([
      { email: 'ada@x.io', name: 'Ada L.', age: 37 },
      { email: 'cy@x.io', name: 'Cy' },
    ]);
  });

  it('selects with conditions, sorting, limits and output columns', async () => {
    await run(
      { operation: 'insert' },
      items({ email: 'a@x', age: 30 }, { email: 'b@x', age: 40 }, { email: 'c@x', age: 50 }),
    );
    const r = await run({
      operation: 'select',
      where: { values: [{ column: 'age', condition: '>=', value: '40' }] },
      sort: { values: [{ column: 'age', direction: 'DESC' }] },
      limit: 1,
      options: { outputColumns: 'email, age' },
    });
    expect(r.outputs[0]).toEqual([{ email: 'c@x', age: 50 }]);
    const all = await run({
      operation: 'select',
      returnAll: true,
      where: { values: [{ column: 'name', condition: 'IS NULL' }] },
    });
    expect(all.outputs[0]).toHaveLength(3);
  });

  it('executes parameterised queries, one per item', async () => {
    await run({ operation: 'insert' }, items({ email: 'a@x', age: 30 }, { email: 'b@x', age: 40 }));
    const r = await run(
      {
        operation: 'executeQuery',
        query: `SELECT email FROM "${schema}".people WHERE age > $1 AND email LIKE $2`,
        options: { queryReplacement: '={{ [$json.min, "%@x"] }}' },
      },
      items({ min: 35 }, { min: 10 }),
    );
    expect(r.outputs[0]).toEqual([{ email: 'b@x' }, { email: 'a@x' }, { email: 'b@x' }]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 1 }]);
    const ddl = await run({ operation: 'executeQuery', query: `UPDATE "${schema}".people SET age = 1` });
    expect(ddl.outputs[0]).toEqual([{ success: true, command: 'UPDATE', rowCount: 2 }]);
  });

  it('deletes rows with conditions and truncates', async () => {
    await run({ operation: 'insert' }, items({ email: 'a@x', age: 30 }, { email: 'b@x', age: 40 }));
    const deleted = await run({
      operation: 'deleteTable',
      where: { values: [{ column: 'age', condition: '<', value: 35 }] },
    });
    expect(deleted.outputs[0]).toEqual([{ success: true, command: 'delete', rowCount: 1 }]);
    const refused = await run({ operation: 'deleteTable' });
    expect(refused.status).toBe('error');
    expect(refused.error?.message).toMatch(/Add at least one condition/);
    await run({ operation: 'deleteTable', deleteCommand: 'truncate' });
    expect(await rows()).toEqual([]);
  });

  it('rolls back every item in transaction mode', async () => {
    const r = await run(
      { operation: 'insert', options: { queryBatching: 'transaction' } },
      items({ email: 'a@x' }, { email: 'a@x' }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/duplicate key/);
    expect(await rows()).toEqual([]);
  });

  it('isolates failing items when continuing on fail', async () => {
    const r = await run(
      { operation: 'insert' },
      items({ email: 'a@x' }, { email: 'a@x' }, { email: 'b@x' }),
      {
        onError: 'continueRegularOutput',
      },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0].map((o) => o.email ?? o.error)).toEqual([
      'a@x',
      expect.stringMatching(/duplicate key/),
      'b@x',
    ]);
    expect(await rows()).toHaveLength(2);
  });

  it('is blocked from loopback hosts by the default SSRF policy', async () => {
    const r = await runNode(
      'app.postgres',
      { operation: 'select', schema: schemaRl, table },
      [{ json: {} }],
      { creds },
    );
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SSRF_BLOCKED');
  });

  it('lists schemas, tables and columns for the editor', async () => {
    const ctx = contextFor(
      'app.postgres',
      { schema: schemaRl, table },
      { creds, services: { http: localHttp() } },
    );
    const methods = ctx.nodeType.methods!;
    const schemas = await methods.listSearch!.searchSchemas(ctx.loadOptions(), schema);
    expect(schemas.results).toEqual([{ name: schema, value: schema }]);
    const tables = await methods.listSearch!.searchTables(ctx.loadOptions(), 'peo');
    expect(tables.results).toEqual([{ name: 'people', value: 'people' }]);
    const columns = await methods.loadOptions!.getColumns(ctx.loadOptions());
    expect(columns.map((c) => c.value)).toEqual(['id', 'email', 'name', 'age', 'meta', 'created']);
  });
});
