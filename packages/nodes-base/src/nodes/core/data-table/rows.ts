/**
 * Data Table node, row side: insert (all items of one table in one call), get, update, upsert,
 * delete and the exists checks. A bad item fails the run, or becomes an error item when the node
 * continues on fail.
 */
import {
  DATA_TABLE_ERRORS,
  DATA_TABLE_ROWS_TAKE_MAX,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataObject,
  type DataTableAccess,
  type DataTableInfo,
  type DataTableRow,
  type DataTableRowInput,
  type DataTableRowResult,
  type ExecuteContext,
  type Item,
  NodeOperationError,
} from '@workflow/workflow';
import { buildFilter, columnTypeOf, knownColumn } from './filters';
import { nodeError, resolveTable, type TableCache } from './tables';

const SYSTEM = new Set<string>(DATA_TABLE_SYSTEM_COLUMNS);

type CellValue = DataTableRowInput[string];

/** one cell as the service takes it; arrays and objects are refused */
function cellValue(ctx: ExecuteContext, value: unknown, column: string, rowNumber: number): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const luxon = value as { toJSDate?: () => Date };
    if (typeof luxon.toJSDate === 'function') return luxon.toJSDate();
    throw new NodeOperationError(
      ctx.getNode(),
      DATA_TABLE_ERRORS.unexpectedArrayInput(safeJson(value), rowNumber),
      { itemIndex: rowNumber - 1, description: `Column "${column}" takes a single value` },
    );
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** the columns and values item `i` writes */
function rowData(ctx: ExecuteContext, table: DataTableInfo, i: number, json: DataObject): DataTableRowInput {
  const out: DataTableRowInput = {};
  if (ctx.getNodeParameter('dataMode', i, 'defineBelow') === 'autoMapInputData') {
    const names = new Set(table.columns.map((c) => c.name));
    for (const [key, value] of Object.entries(json)) {
      // id, createdAt and updatedAt are the table's; keys that are no column are not mapped
      if (SYSTEM.has(key) || !names.has(key)) continue;
      out[key] = cellValue(ctx, value, key, i + 1);
    }
    return out;
  }
  const fields = ((ctx.getNodeParameter('fieldsUi', i, {}) as DataObject).fieldValues ?? []) as Array<{
    columnName?: unknown;
    value?: unknown;
  }>;
  for (const field of fields) {
    const name = String(field.columnName ?? '').trim();
    if (!name) continue;
    if (SYSTEM.has(name) || !knownColumn(table, name)) {
      throw new NodeOperationError(ctx.getNode(), DATA_TABLE_ERRORS.unknownColumn(name), {
        itemIndex: i,
        parameter: 'fieldsUi',
      });
    }
    // an empty box in a number, boolean or date column is no value
    const type = columnTypeOf(table, name);
    const empty = field.value === '' && type !== 'string';
    out[name] = empty ? null : cellValue(ctx, field.value, name, i + 1);
  }
  return out;
}

const errorItem = (ctx: ExecuteContext, error: unknown, i: number): Item => ({
  json: { error: nodeError(ctx, error, i).message },
  pairedItem: { item: i },
});

/** rows go out as items of the input row they came from */
const rowItems = (rows: ReadonlyArray<DataTableRowResult | DataTableRow>, i: number): Item[] =>
  rows.map((row) => ({ json: { ...row } as DataObject, pairedItem: { item: i } }));

async function insertRows(
  ctx: ExecuteContext,
  access: DataTableAccess,
  cache: TableCache,
  items: Item[],
): Promise<Item[]> {
  const optimizeBulk = Boolean(ctx.getNodeParameter('options.optimizeBulk', 0, false));
  const slots: Item[][] = items.map(() => []);
  const groups = new Map<string, { table: DataTableInfo; indexes: number[]; rows: DataTableRowInput[] }>();
  for (let i = 0; i < items.length; i++) {
    try {
      const table = await resolveTable(ctx, access, cache, i);
      const group = groups.get(table.id) ?? { table, indexes: [], rows: [] };
      group.rows.push(rowData(ctx, table, i, items[i]!.json));
      group.indexes.push(i);
      groups.set(table.id, group);
    } catch (error) {
      if (!ctx.continueOnFail()) throw nodeError(ctx, error, i);
      slots[i] = [errorItem(ctx, error, i)];
    }
  }
  for (const { table, indexes, rows } of groups.values()) {
    try {
      if (optimizeBulk) {
        const done = await access.insertRows(table.id, rows, 'count');
        slots[indexes[0]!] = [
          {
            json: { success: done.success, insertedRows: done.insertedRows },
            pairedItem: indexes.map((item) => ({ item })),
          },
        ];
      } else {
        const inserted = await access.insertRows(table.id, rows, 'all');
        indexes.forEach((item, n) => {
          const row = inserted[n];
          slots[item] = row ? rowItems([row], item) : [];
        });
      }
    } catch (error) {
      if (!ctx.continueOnFail()) throw nodeError(ctx, error, indexes[0]);
      for (const item of indexes) slots[item] = [errorItem(ctx, error, item)];
    }
  }
  return slots.flat();
}

async function getRows(
  ctx: ExecuteContext,
  access: DataTableAccess,
  table: DataTableInfo,
  i: number,
): Promise<Item[]> {
  const returnAll = Boolean(ctx.getNodeParameter('returnAll', i, false));
  const limit = returnAll
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(Number(ctx.getNodeParameter('limit', i, 50))));
  const filter = buildFilter(ctx, table, i, false);
  let sortBy: { column: string; direction: 'asc' | 'desc' } | undefined;
  if (ctx.getNodeParameter('orderBy', i, false)) {
    const column = String(ctx.getNodeParameter('orderByColumn', i, 'createdAt'));
    if (!knownColumn(table, column)) {
      throw new NodeOperationError(ctx.getNode(), DATA_TABLE_ERRORS.orderByColumnMissing, {
        itemIndex: i,
        parameter: 'orderByColumn',
      });
    }
    sortBy = {
      column,
      direction: ctx.getNodeParameter('orderByDirection', i, 'DESC') === 'ASC' ? 'asc' : 'desc',
    };
  }
  const out: Item[] = [];
  let skip = 0;
  // the service caps a page, so ask for what is left and page until the count or the limit
  while (out.length < limit) {
    const take = Math.min(DATA_TABLE_ROWS_TAKE_MAX, limit - out.length);
    const page = await access.getRows(table.id, { filter, take, skip, sortBy });
    out.push(...rowItems(page.data, i));
    skip += page.data.length;
    if (!page.data.length || skip >= page.count) break;
  }
  return out;
}

/** every row operation except insert, one input item at a time */
export async function runRowOperation(
  ctx: ExecuteContext,
  access: DataTableAccess,
  cache: TableCache,
  operation: string,
  items: Item[],
): Promise<Item[]> {
  if (operation === 'insert') return insertRows(ctx, access, cache, items);
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const table = await resolveTable(ctx, access, cache, i);
      const dryRun = Boolean(ctx.getNodeParameter('options.dryRun', i, false));
      switch (operation) {
        case 'get':
          out.push(...(await getRows(ctx, access, table, i)));
          break;
        case 'update':
        case 'upsert': {
          const filter = buildFilter(ctx, table, i, true)!;
          const change = { filter, data: rowData(ctx, table, i, items[i]!.json) };
          const rows =
            operation === 'update'
              ? await access.updateRows(table.id, change, { dryRun })
              : await access.upsertRow(table.id, change, { dryRun });
          out.push(...rowItems(rows, i));
          break;
        }
        case 'deleteRows': {
          const filter = buildFilter(ctx, table, i, true)!;
          out.push(...rowItems(await access.deleteRows(table.id, filter, { dryRun }), i));
          break;
        }
        case 'rowExists':
        case 'rowNotExists': {
          const exists = await access.rowsExist(table.id, buildFilter(ctx, table, i, true)!);
          if (exists === (operation === 'rowExists')) out.push({ ...items[i]!, pairedItem: { item: i } });
          break;
        }
        default:
          throw new NodeOperationError(ctx.getNode(), `Unknown row operation "${operation}"`, {
            itemIndex: i,
          });
      }
    } catch (error) {
      if (!ctx.continueOnFail()) throw nodeError(ctx, error, i);
      out.push(errorItem(ctx, error, i));
    }
  }
  return out;
}
