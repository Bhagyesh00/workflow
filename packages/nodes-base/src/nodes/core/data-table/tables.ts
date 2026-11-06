/**
 * Data Table node, table side: finding the table a node points at (exact by name, never "contains"),
 * the table operations, and the one place that turns a service error into a node error.
 */
import {
  DATA_TABLE_ERRORS,
  type DataObject,
  type DataTableAccess,
  type DataTableColumnInput,
  type DataTableInfo,
  type DataTableListQuery,
  type ExecuteContext,
  type Item,
  NodeOperationError,
} from '@workflow/workflow';

/** tables the node already looked up in this run, so per-item expressions cost one lookup per table */
export type TableCache = Map<string, DataTableInfo>;

export function rlParts(value: unknown): { mode: string; value: string } {
  if (value && typeof value === 'object' && 'value' in (value as object)) {
    const rl = value as { mode?: unknown; value?: unknown };
    return { mode: String(rl.mode ?? 'id'), value: String(rl.value ?? '').trim() };
  }
  return { mode: 'id', value: String(value ?? '').trim() };
}

export function dataTableAccess(ctx: ExecuteContext): DataTableAccess {
  const access = ctx.helpers.dataTables;
  if (!access) throw new NodeOperationError(ctx.getNode(), 'Data tables are not available in this run');
  return access;
}

/** a service error becomes a node error with the service's text (n8n's texts) and description */
export function nodeError(ctx: ExecuteContext, error: unknown, itemIndex?: number): NodeOperationError {
  if (error instanceof NodeOperationError) return error;
  const e = error as { message?: string; details?: { description?: unknown } };
  const description = typeof e.details?.description === 'string' ? e.details.description : undefined;
  return new NodeOperationError(ctx.getNode(), e.message ?? 'Data table request failed', {
    itemIndex,
    description,
    cause: error,
  });
}

/** the table the `dataTableId` locator names for item `i` */
export async function resolveTable(
  ctx: ExecuteContext,
  access: DataTableAccess,
  cache: TableCache,
  i: number,
): Promise<DataTableInfo> {
  const { mode, value } = rlParts(ctx.getNodeParameter('dataTableId', i, ''));
  if (!value) {
    throw new NodeOperationError(ctx.getNode(), 'Select a data table', {
      itemIndex: i,
      parameter: 'dataTableId',
    });
  }
  const byName = mode === 'name';
  const key = `${byName ? 'name' : 'id'}:${value}`;
  const known = cache.get(key);
  if (known) return known;
  const table = await access.getTable(byName ? { name: value } : { id: value });
  if (!table) {
    throw new NodeOperationError(
      ctx.getNode(),
      byName ? DATA_TABLE_ERRORS.tableNameNotFound(value) : DATA_TABLE_ERRORS.tableIdNotFound(value),
      {
        itemIndex: i,
        description: byName ? undefined : DATA_TABLE_ERRORS.tableIdNotFoundDescription,
        parameter: 'dataTableId',
      },
    );
  }
  cache.set(key, table);
  return table;
}

const tableJson = (table: DataTableInfo): DataObject => ({
  id: table.id,
  name: table.name,
  columns: table.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
  createdAt: table.createdAt,
  updatedAt: table.updatedAt,
});

function columnsParam(ctx: ExecuteContext, i: number): DataTableColumnInput[] {
  const raw = (ctx.getNodeParameter('columns', i, {}) as DataObject).column;
  const list = Array.isArray(raw) ? (raw as Array<{ name?: unknown; type?: unknown }>) : [];
  return list
    .filter((c) => String(c.name ?? '').trim())
    .map((c) => ({
      name: String(c.name).trim(),
      type: String(c.type || 'string') as DataTableColumnInput['type'],
    }));
}

function dropFromCache(cache: TableCache, table: DataTableInfo) {
  for (const [key, value] of cache) if (value.id === table.id) cache.delete(key);
}

/** one table operation for item `i`; returns the items it produces */
export async function runTableOperation(
  ctx: ExecuteContext,
  access: DataTableAccess,
  cache: TableCache,
  operation: string,
  i: number,
): Promise<Item[]> {
  const paired = { item: i };
  switch (operation) {
    case 'create': {
      const name = String(ctx.getNodeParameter('tableName', i, '')).trim();
      if (!name) {
        throw new NodeOperationError(ctx.getNode(), 'Enter a name for the data table', {
          itemIndex: i,
          parameter: 'tableName',
        });
      }
      const reuseExisting = Boolean(ctx.getNodeParameter('options.createIfNotExists', i, true));
      const table = await access.createTable({ name, columns: columnsParam(ctx, i), reuseExisting });
      return [{ json: tableJson(table), pairedItem: paired }];
    }
    case 'list': {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const returnAll = Boolean(ctx.getNodeParameter('returnAll', i, true));
      const limit = returnAll
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)));
      const name = String(options.filterName ?? '').trim();
      const query: DataTableListQuery = {
        name: name || undefined,
        sortBy: options.sortField
          ? {
              column: options.sortField as 'name' | 'createdAt' | 'updatedAt',
              direction: options.sortDirection === 'desc' ? 'desc' : 'asc',
            }
          : undefined,
      };
      const out: Item[] = [];
      let skip = 0;
      while (out.length < limit) {
        const page = await access.listTables({ ...query, take: 250, skip });
        for (const table of page.data) {
          if (out.length < limit) out.push({ json: tableJson(table), pairedItem: paired });
        }
        skip += page.data.length;
        if (!page.data.length || skip >= page.count) break;
      }
      return out;
    }
    case 'deleteTable': {
      const table = await resolveTable(ctx, access, cache, i);
      await access.deleteTable(table.id);
      dropFromCache(cache, table);
      return [{ json: { success: true, deletedTableId: table.id }, pairedItem: paired }];
    }
    case 'update': {
      const table = await resolveTable(ctx, access, cache, i);
      const newName = String(ctx.getNodeParameter('newName', i, '')).trim();
      if (!newName) {
        throw new NodeOperationError(ctx.getNode(), 'Enter the new name', {
          itemIndex: i,
          parameter: 'newName',
        });
      }
      const renamed = await access.renameTable(table.id, newName);
      dropFromCache(cache, table);
      return [{ json: { success: true, name: renamed.name }, pairedItem: paired }];
    }
    case 'clear': {
      const table = await resolveTable(ctx, access, cache, i);
      const { deletedCount } = await access.clearTable(table.id);
      return [{ json: { success: true, deletedCount }, pairedItem: paired }];
    }
    default:
      throw new NodeOperationError(ctx.getNode(), `Unknown table operation "${operation}"`, {
        itemIndex: i,
      });
  }
}
