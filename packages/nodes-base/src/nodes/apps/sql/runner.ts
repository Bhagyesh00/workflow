/** Operation runner shared by the Postgres and MySQL nodes (driver-agnostic). */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  isPlainObject,
  NodeOperationError,
} from '@workflow/workflow';
import { errorItem, fieldList } from '../../../utils/utilities';
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  buildUpsert,
  type Dialect,
  jsonRow,
  type Query,
  queryReplacements,
  readData,
  readSort,
  readWhere,
  sqlError,
  tableRef,
} from './sql';

export interface SqlResult {
  rows: DataObject[];
  rowCount: number;
  command?: string;
  insertId?: number;
}

export interface SqlClient {
  query(query: Query): Promise<SqlResult>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

function tableOf(ctx: ExecuteContext, dialect: Dialect, i: number, withSchema: boolean): string {
  const table = String(ctx.getNodeParameter('table', i, '', { extractValue: true }) ?? '').trim();
  if (!table)
    throw new NodeOperationError(ctx.getNode(), 'Select a table', { itemIndex: i, parameter: 'table' });
  const schema = withSchema
    ? String(ctx.getNodeParameter('schema', i, 'public', { extractValue: true }) ?? '').trim()
    : '';
  return tableRef(dialect, schema || undefined, table);
}

/** Values bound as parameters: nested objects/arrays become JSON text for MySQL. */
function bindable(dialect: Dialect, data: DataObject): DataObject {
  if (dialect.name !== 'mysql') return data;
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
    ]),
  );
}

async function runItem(
  ctx: ExecuteContext,
  client: SqlClient,
  dialect: Dialect,
  withSchema: boolean,
  i: number,
  item: Item,
): Promise<DataObject[]> {
  const operation = ctx.getNodeParameter('operation', i) as string;
  const options = ctx.getNodeParameter('options', i, {}) as DataObject;
  switch (operation) {
    case 'executeQuery': {
      const text = String(ctx.getNodeParameter('query', i, '') ?? '');
      if (!text.trim()) throw new NodeOperationError(ctx.getNode(), 'The query is empty', { itemIndex: i });
      const values = queryReplacements(options.queryReplacement).map((v) =>
        dialect.name === 'mysql' && v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
      );
      const result = await client.query({ text, values });
      return result.rows.length
        ? result.rows
        : [
            {
              success: true,
              ...(result.command ? { command: result.command } : {}),
              rowCount: result.rowCount,
            },
          ];
    }
    case 'insert': {
      const data = readData(ctx, i, item.json);
      const result = await client.query(
        buildInsert(dialect, tableOf(ctx, dialect, i, withSchema), bindable(dialect, data), {
          returning: true,
          ignoreConflicts: Boolean(options.skipOnConflict),
        }),
      );
      if (dialect.supportsReturning)
        return result.rows.length ? result.rows : [{ success: true, skipped: true }];
      return [
        { ...data, ...(result.insertId ? { insertId: result.insertId } : {}), affectedRows: result.rowCount },
      ];
    }
    case 'update':
    case 'upsert': {
      const data = readData(ctx, i, item.json);
      const column = String(ctx.getNodeParameter('columnToMatchOn', i, '') ?? '');
      if (!column)
        throw new NodeOperationError(ctx.getNode(), 'Select the column to match on', { itemIndex: i });
      const build = operation === 'update' ? buildUpdate : buildUpsert;
      const result = await client.query(
        build(dialect, tableOf(ctx, dialect, i, withSchema), bindable(dialect, data), column, {
          returning: true,
        }),
      );
      if (dialect.supportsReturning) return result.rows;
      return [{ ...data, affectedRows: result.rowCount }];
    }
    case 'deleteTable': {
      const command = ctx.getNodeParameter('deleteCommand', i, 'delete') as 'delete' | 'truncate' | 'drop';
      const { where, combinator } =
        command === 'delete' ? readWhere(ctx, i) : { where: [], combinator: 'AND' as const };
      const result = await client.query(
        buildDelete(dialect, tableOf(ctx, dialect, i, withSchema), command, {
          where,
          combinator,
          cascade: Boolean(options.cascade),
        }),
      );
      return [{ success: true, command, rowCount: result.rowCount }];
    }
    case 'select': {
      const { where, combinator } = readWhere(ctx, i);
      const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
      const result = await client.query(
        buildSelect(dialect, tableOf(ctx, dialect, i, withSchema), {
          columns: fieldList(options.outputColumns),
          where,
          combinator,
          sort: readSort(ctx, i),
          limit: returnAll ? undefined : Number(ctx.getNodeParameter('limit', i, 50)),
        }),
      );
      return result.rows;
    }
    default:
      throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
  }
}

/** Run every item, independently or in one transaction, always releasing the connection. */
export async function runSql(
  ctx: ExecuteContext,
  pool: SqlPool,
  dialect: Dialect,
  withSchema: boolean,
): Promise<Item[][]> {
  const items = ctx.getInputData();
  const transaction = ctx.getNodeParameter('options.queryBatching', 0, 'independently') === 'transaction';
  const out: Item[] = [];
  const client = await pool.connect();
  try {
    if (transaction) {
      await client.query({ text: dialect.name === 'mysql' ? 'START TRANSACTION' : 'BEGIN', values: [] });
      try {
        const results: Item[] = [];
        for (let i = 0; i < items.length; i++) {
          try {
            for (const row of await runItem(ctx, client, dialect, withSchema, i, items[i])) {
              results.push({ json: jsonRow(row), pairedItem: { item: i } });
            }
          } catch (error) {
            throw sqlError(ctx, error, i);
          }
        }
        await client.query({ text: 'COMMIT', values: [] });
        out.push(...results);
      } catch (error) {
        await client.query({ text: 'ROLLBACK', values: [] }).catch(() => undefined);
        if (!ctx.continueOnFail()) throw error;
        // the whole transaction was rolled back, so every item failed
        out.push(...items.map((_, i) => errorItem(error, i)));
      }
      return [out];
    }
    for (let i = 0; i < items.length; i++) {
      try {
        for (const row of await runItem(ctx, client, dialect, withSchema, i, items[i])) {
          out.push({ json: isPlainObject(row) ? jsonRow(row) : { data: row }, pairedItem: { item: i } });
        }
      } catch (error) {
        const wrapped = sqlError(ctx, error, i);
        if (!ctx.continueOnFail()) throw wrapped;
        out.push(errorItem(wrapped, i));
      }
    }
    return [out];
  } finally {
    client.release();
  }
}
