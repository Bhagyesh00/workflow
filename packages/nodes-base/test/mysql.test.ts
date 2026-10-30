import type { AddressInfo } from 'node:net';
import type { DataObject, Item } from '@workflow/workflow';
import mysql from 'mysql2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contextFor } from './contexts';
import { runNode } from './harness';
import { localHttp } from './servers';

/**
 * A MySQL wire-protocol server (mysql2's server side) that records every query the node sends
 * and answers from `respond`. The real mysql2 client escapes bound values, so the recorded SQL
 * shows exactly what a MySQL server would receive.
 */
const queries: string[] = [];
let respond: (sql: string) => {
  rows?: DataObject[];
  affectedRows?: number;
  insertId?: number;
  error?: string;
} = () => ({ affectedRows: 0 });
let server: ReturnType<typeof mysql.createServer>;
let port = 0;

function columnsOf(rows: DataObject[]) {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return names.map((name) => ({
    catalog: 'def',
    schema: 'shop',
    table: 't',
    orgTable: 't',
    name,
    orgName: name,
    characterSet: 33,
    columnLength: 384,
    columnType: 253,
    flags: 0,
    decimals: 0,
  }));
}

beforeAll(async () => {
  server = mysql.createServer((conn: any) => {
    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.36-fake',
      connectionId: 1,
      statusFlags: 2,
      characterSet: 8,
      capabilityFlags: 0xffffff,
      authCallback: (_params: unknown, cb: (err: Error | null) => void) => cb(null),
    });
    conn.on('query', (sql: string) => {
      queries.push(sql);
      const answer = respond(sql);
      if (answer.error) return conn.writeError({ code: 1062, message: answer.error });
      if (answer.rows) {
        return conn.writeTextResult(
          answer.rows.map((r) =>
            Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)])),
          ),
          columnsOf(answer.rows),
        );
      }
      conn.writeOk({ affectedRows: answer.affectedRows ?? 0, insertId: answer.insertId ?? 0 });
    });
    conn.on('error', () => undefined);
  }) as never;
  await new Promise<void>((resolve) => (server as any).listen(0, '127.0.0.1', resolve));
  port = ((server as any)._server.address() as AddressInfo).port;
});

afterAll(() => {
  (server as any).close();
});

beforeEach(() => {
  queries.length = 0;
  respond = () => ({ affectedRows: 1 });
});

const creds = () => ({ mySql: { host: '127.0.0.1', port, database: 'shop', user: 'app', password: 'pw' } });
const table = { __rl: true, mode: 'name', value: 'people' };
const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));
const run = (parameters: DataObject, input: Item[] = [{ json: {} }], node: object = {}) =>
  runNode('app.mySql', { table, ...parameters }, input, {
    creds: creds(),
    services: { http: localHttp() },
    node,
  });
const userQueries = () => queries.filter((q) => !/^SELECT @@|^SET /i.test(q));

describe('MySQL', () => {
  it('inserts with backtick-quoted identifiers and escaped values', async () => {
    respond = () => ({ affectedRows: 1, insertId: 7 });
    const r = await run(
      { operation: 'insert' },
      items({ email: "o'hara@x.io", 'odd`col': 1, meta: { a: 1 } }),
    );
    expect(r.status).toBe('success');
    expect(userQueries()).toEqual([
      "INSERT INTO `people` (`email`, `odd``col`, `meta`) VALUES ('o\\'hara@x.io', 1, '{\\\"a\\\":1}')",
    ]);
    expect(r.outputs[0]).toEqual([
      { email: "o'hara@x.io", 'odd`col': 1, meta: { a: 1 }, insertId: 7, affectedRows: 1 },
    ]);
  });

  it('updates, upserts, deletes and selects', async () => {
    await run({ operation: 'update', columnToMatchOn: 'id' }, items({ id: 3, name: 'Ada' }));
    await run({ operation: 'upsert', columnToMatchOn: 'email' }, items({ email: 'a@x', name: 'A' }));
    await run({
      operation: 'deleteTable',
      where: { values: [{ column: 'age', condition: '<', value: 18 }] },
    });
    respond = (sql) => (sql.startsWith('SELECT') ? { rows: [{ id: 1, email: 'a@x' }] } : { affectedRows: 0 });
    const selected = await run({
      operation: 'select',
      where: { values: [{ column: 'email', condition: 'LIKE', value: '%@x' }] },
      sort: { values: [{ column: 'id', direction: 'DESC' }] },
      limit: 10,
    });
    expect(userQueries()).toEqual([
      "UPDATE `people` SET `name` = 'Ada' WHERE `id` = 3",
      "INSERT INTO `people` (`email`, `name`) VALUES ('a@x', 'A') ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)",
      'DELETE FROM `people` WHERE `age` < 18',
      "SELECT * FROM `people` WHERE `email` LIKE '%@x' ORDER BY `id` DESC LIMIT 10",
    ]);
    expect(selected.outputs[0]).toEqual([{ id: '1', email: 'a@x' }]);
  });

  it('runs queries with bound parameters', async () => {
    respond = () => ({ rows: [{ n: 2 }] });
    const r = await run(
      {
        operation: 'executeQuery',
        query: 'SELECT COUNT(*) AS n FROM people WHERE name = ? AND age > ?',
        options: { queryReplacement: '={{ [$json.name, 21] }}' },
      },
      items({ name: "x' OR '1'='1" }),
    );
    expect(userQueries()).toEqual([
      "SELECT COUNT(*) AS n FROM people WHERE name = 'x\\' OR \\'1\\'=\\'1' AND age > 21",
    ]);
    expect(r.outputs[0]).toEqual([{ n: '2' }]);
  });

  it('commits or rolls back transactions', async () => {
    respond = (sql) => (sql.includes("'dup'") ? { error: "Duplicate entry 'dup'" } : { affectedRows: 1 });
    const failed = await run(
      { operation: 'insert', options: { queryBatching: 'transaction' } },
      items({ email: 'ok' }, { email: 'dup' }),
    );
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toMatch(/Duplicate entry/);
    expect(userQueries()).toEqual([
      'START TRANSACTION',
      "INSERT INTO `people` (`email`) VALUES ('ok')",
      "INSERT INTO `people` (`email`) VALUES ('dup')",
      'ROLLBACK',
    ]);
    queries.length = 0;
    const ok = await run(
      { operation: 'insert', options: { queryBatching: 'transaction' } },
      items({ email: 'a' }),
    );
    expect(ok.status).toBe('success');
    expect(userQueries().at(-1)).toBe('COMMIT');
  });

  it('is blocked from loopback hosts by the default SSRF policy', async () => {
    const r = await runNode('app.mySql', { operation: 'select', table }, [{ json: {} }], { creds: creds() });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SSRF_BLOCKED');
    expect(queries).toEqual([]);
  });

  it('lists tables and columns for the editor', async () => {
    respond = (sql) =>
      /information_schema\.tables/.test(sql)
        ? { rows: [{ name: 'people' }] }
        : {
            rows: [
              { name: 'id', type: 'int' },
              { name: 'email', type: 'varchar' },
            ],
          };
    const ctx = contextFor('app.mySql', { table }, { creds: creds(), services: { http: localHttp() } });
    const tables = await ctx.nodeType.methods!.listSearch!.searchTables(ctx.loadOptions(), 'peo');
    expect(tables.results).toEqual([{ name: 'people', value: 'people' }]);
    const columns = await ctx.nodeType.methods!.loadOptions!.getColumns(ctx.loadOptions());
    expect(columns).toEqual([
      { name: 'id', value: 'id', description: 'Type: int' },
      { name: 'email', value: 'email', description: 'Type: varchar' },
    ]);
  });
});
