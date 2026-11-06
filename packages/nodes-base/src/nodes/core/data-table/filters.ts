/**
 * Data Table node, filters: the "conditions" the row operations read, turned into the service's
 * filter. Values are converted to the column's type here so a bad date or number names its column.
 */
import {
  DATA_TABLE_ERRORS,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataObject,
  type DataTableColumnType,
  type DataTableFilter,
  type DataTableFilterClause,
  type DataTableFilterCondition,
  type DataTableInfo,
  type DataTableInputValue,
  type ExecuteContext,
  NodeOperationError,
} from '@workflow/workflow';

/** the conditions the editor offers; isTrue and isFalse are eq with true and false */
export const FILTER_CONDITIONS = [
  'eq',
  'neq',
  'like',
  'ilike',
  'gt',
  'gte',
  'lt',
  'lte',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
] as const;

export function columnTypeOf(table: DataTableInfo, name: string): DataTableColumnType | undefined {
  if (name === 'id') return 'number';
  if (name === 'createdAt' || name === 'updatedAt') return 'date';
  return table.columns.find((c) => c.name === name)?.type;
}

export function knownColumn(table: DataTableInfo, name: string): boolean {
  return (
    (DATA_TABLE_SYSTEM_COLUMNS as readonly string[]).includes(name) ||
    table.columns.some((c) => c.name === name)
  );
}

/** a typed value for a filter; null stays null */
export function typedValue(
  ctx: ExecuteContext,
  value: unknown,
  type: DataTableColumnType,
  column: string,
  itemIndex: number,
): DataTableInputValue {
  if (value === null || value === undefined) return null;
  const fail = (message: string) =>
    new NodeOperationError(ctx.getNode(), message, { itemIndex, parameter: 'filters' });
  switch (type) {
    case 'number': {
      if (typeof value === 'string' && !value.trim()) return null;
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) throw fail(DATA_TABLE_ERRORS.valueTypeMismatch(value, type));
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw fail(DATA_TABLE_ERRORS.valueTypeMismatch(value, type));
    }
    case 'date': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw fail(DATA_TABLE_ERRORS.invalidDate(String(value), column));
      return date;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

interface RawCondition {
  keyName?: unknown;
  condition?: unknown;
  keyValue?: unknown;
}

/**
 * The filter of item `i`. With `required`, no condition is an error (update, upsert, delete,
 * exists); Get may have none.
 */
export function buildFilter(
  ctx: ExecuteContext,
  table: DataTableInfo,
  i: number,
  required: boolean,
): DataTableFilter | undefined {
  const group = ctx.getNodeParameter('filters', i, {}) as DataObject;
  const raw = (Array.isArray(group.conditions) ? group.conditions : []) as RawCondition[];
  const conditions = raw.filter((c) => String(c.keyName ?? '').trim());
  if (!conditions.length) {
    if (required) {
      throw new NodeOperationError(ctx.getNode(), DATA_TABLE_ERRORS.atLeastOneCondition, {
        itemIndex: i,
        parameter: 'filters',
      });
    }
    return undefined;
  }
  const missing = [
    ...new Set(conditions.map((c) => String(c.keyName)).filter((name) => !knownColumn(table, name))),
  ];
  if (missing.length) {
    throw new NodeOperationError(ctx.getNode(), DATA_TABLE_ERRORS.filterColumnsMissing(missing), {
      itemIndex: i,
      parameter: 'filters',
    });
  }
  const filters = conditions.map((c): DataTableFilterClause => {
    const columnName = String(c.keyName);
    const condition = String(c.condition ?? 'eq');
    if (condition === 'isEmpty' || condition === 'isNotEmpty') return { columnName, condition };
    if (condition === 'isTrue' || condition === 'isFalse') {
      return { columnName, condition: 'eq', value: condition === 'isTrue' };
    }
    if (!(FILTER_CONDITIONS as readonly string[]).includes(condition)) {
      throw new NodeOperationError(ctx.getNode(), `Unknown condition "${condition}"`, {
        itemIndex: i,
        parameter: 'filters',
      });
    }
    // like and ilike match text: the service adds the wildcards
    const value =
      condition === 'like' || condition === 'ilike'
        ? c.keyValue === null || c.keyValue === undefined
          ? ''
          : String(c.keyValue)
        : typedValue(ctx, c.keyValue, columnTypeOf(table, columnName) ?? 'string', columnName, i);
    return { columnName, condition: condition as DataTableFilterCondition, value };
  });
  const all = ctx.getNodeParameter('matchType', i, 'anyCondition') === 'allConditions';
  return { type: all ? 'and' : 'or', filters };
}
