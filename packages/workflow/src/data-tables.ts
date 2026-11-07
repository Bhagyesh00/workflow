/**
 * Data tables contract: the types, limits and n8n error texts shared by the server service, the
 * Data Table node and the editor. Storage and validation live in the server (P4-03).
 */

export const DATA_TABLE_COLUMN_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type DataTableColumnType = (typeof DATA_TABLE_COLUMN_TYPES)[number];

/** longest table name, after trimming */
export const DATA_TABLE_NAME_MAX = 128;
/** a letter first, then letters, digits and underscores */
export const DATA_TABLE_COLUMN_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const DATA_TABLE_COLUMN_NAME_MAX = 63;
/** columns every row has; the node and the grid can filter and sort on them */
export const DATA_TABLE_SYSTEM_COLUMNS = ['id', 'createdAt', 'updatedAt'] as const;
/** names a column may not take; n8n compares them lower-cased, so `CreatedAt` is refused too */
export const DATA_TABLE_RESERVED_COLUMNS = [...DATA_TABLE_SYSTEM_COLUMNS, 'dryRunState'] as const;
/** most rows one REST or public API page returns; `getRows` callers page until `skip >= count` */
export const DATA_TABLE_ROWS_TAKE_MAX = 250;

/** n8n's texts, word for word; a lane shows these and never writes its own */
export const DATA_TABLE_ERRORS = {
  tableNameExists: (name: string) => `Data table with name '${name}' already exists in this project`,
  columnNameExists: (column: string, table: string) =>
    `Data table column with name '${column}' already exists in data table '${table}'`,
  columnNameReserved: (column: string) => `Column name "${column}" is reserved as a system column name.`,
  columnNameInvalid:
    'Only alphabetical characters and non-leading numbers and underscores are allowed for column names, and the maximum length is 63 characters.',
  filterEmpty: 'Filter must not be empty',
  filterRequiredForDelete:
    'Filter is required for delete operations to prevent accidental deletion of all data',
  unknownColumn: (column: string) => `unknown column name '${column}'`,
  valueTypeMismatch: (value: unknown, type: string, detail?: string) =>
    `value '${String(value)}' does not match column type '${type}'${detail ? `: ${detail}` : ''}`,
  sizeLimitExceeded: (usedMb: number, limitMb: number) =>
    `Data table size limit exceeded: ${usedMb}MB used, limit is ${limitMb}MB`,
  tableIdNotFound: (id: string) => `Data table with ID '${id}' could not be found in this project`,
  tableIdNotFoundDescription:
    'It may have been deleted, or skipped when the workflow was imported. Choose an existing data table in the node.',
  tableNameNotFound: (name: string) => `Data table with name "${name}" not found`,
  atLeastOneCondition: 'At least one condition is required',
  filterColumnsMissing: (columns: string[]) =>
    `Filter validation failed: Column(s) ${columns.map((c) => `"${c}"`).join(', ')} do not exist in the selected table. This often happens when switching between tables with different schemas. Please update your filter conditions.`,
  orderByColumnMissing: 'Specified column does not exist',
  invalidDate: (value: string, column: string) => `Invalid date string '${value}' for column '${column}'`,
  unexpectedArrayInput: (value: string, row: number) => `unexpected array input '${value}' in row ${row}`,
  noColumnsHint: 'The selected data table has no columns.',
} as const;

// ---- dates: one reader for the server and the Data Table node, so a filter and a stored cell agree ----

export const DATA_TABLE_LATEST_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const DATA_TABLE_EARLIEST_DATE_MS = Date.parse('0000-01-01T00:00:00.000Z');

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const MAIL_DATE =
  /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC|[+-]\d{4})$/;

function parseIsoDate(match: RegExpExecArray): Date | undefined {
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone = 'Z'] = match;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Date would carry 02-31 over to March
  if (day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return undefined;
  const offset = /^[zZ]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * ISO 8601, SQL style and RFC 2822 dates; no zone means UTC. Not Date.parse alone: its fallback takes
 * "Room 5" as a date, and CSV type detection relies on this.
 */
export function parseDataTableDate(text: string): Date | undefined {
  const trimmed = text.trim();
  const iso = ISO_DATE.exec(trimmed);
  let date: Date | undefined;
  if (iso) date = parseIsoDate(iso);
  else if (MAIL_DATE.test(trimmed)) date = new Date(trimmed);
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const time = date.getTime();
  return time < DATA_TABLE_EARLIEST_DATE_MS || time > DATA_TABLE_LATEST_DATE_MS ? undefined : date;
}

export const DATA_TABLE_FILTER_CONDITIONS = [
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
] as const;
export type DataTableFilterCondition = (typeof DATA_TABLE_FILTER_CONDITIONS)[number];

/** a stored cell as it comes back: dates are ISO strings in UTC, a missing value is null */
export type DataTableCellValue = string | number | boolean | null;
/** a cell going in; values are coerced to the column's type ("5" to 5), `Date` to a date column */
export type DataTableInputValue = DataTableCellValue | Date;
export type DataTableRowInput = Record<string, DataTableInputValue>;

export interface DataTableFilterClause {
  columnName: string;
  condition: DataTableFilterCondition;
  /** not read by isEmpty and isNotEmpty */
  value?: DataTableInputValue;
}

export interface DataTableFilter {
  type: 'and' | 'or';
  filters: DataTableFilterClause[];
}

export interface DataTableColumnInput {
  name: string;
  type: DataTableColumnType;
}

/** a column of a new table; `csvColumnName` is the header of the CSV column that fills it */
export interface DataTableCreateColumn extends DataTableColumnInput {
  csvColumnName?: string;
}

export interface DataTableColumn extends DataTableColumnInput {
  id: string;
  /** order in the table, from 0 */
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface DataTableInfo {
  id: string;
  name: string;
  columns: DataTableColumn[];
  createdAt: string;
  updatedAt: string;
}

export interface DataTableRow {
  id: number;
  createdAt: string;
  updatedAt: string;
  [column: string]: DataTableCellValue;
}

/** a row of a dry run: how a matched row looks before and after the change */
export interface DataTableDryRunRow extends DataTableRow {
  dryRunState: 'before' | 'after';
}

/** what update, upsert and delete return: the changed rows, or before/after rows on a dry run */
export type DataTableRowResult = DataTableRow | DataTableDryRunRow;

export interface DataTableDryRunOption {
  dryRun?: boolean;
}

export type DataTableInsertReturnType = 'all' | 'id' | 'count';
export type DataTableInsertResult<T extends DataTableInsertReturnType> = T extends 'all'
  ? DataTableRow[]
  : T extends 'id'
    ? Array<{ id: number }>
    : { success: true; insertedRows: number };

export type DataTableSortDirection = 'asc' | 'desc';

export interface DataTableListQuery {
  /** case-insensitive part of the name */
  name?: string;
  sortBy?: { column: 'name' | 'createdAt' | 'updatedAt' | 'size'; direction: DataTableSortDirection };
  take?: number;
  skip?: number;
}

export interface DataTableRowsQuery {
  filter?: DataTableFilter;
  take?: number;
  skip?: number;
  /** ties and the default order go by `id` ascending */
  sortBy?: { column: string; direction: DataTableSortDirection };
  /** matches any column cast to text, case-insensitively */
  search?: string;
}

/** one page plus the total that match */
export interface DataTablePage<T> {
  count: number;
  data: T[];
}

export interface DataTableChange {
  filter: DataTableFilter;
  data: DataTableRowInput;
}

/**
 * The tables of one tenant, as a node sees them (`ctx.helpers.dataTables`). An instance is bound to
 * its tenant; a table id of another tenant behaves like an id that does not exist. `getTable` answers
 * null for a missing table, every other method throws `tableIdNotFound`.
 */
export interface DataTableAccess {
  listTables(query?: DataTableListQuery): Promise<DataTablePage<DataTableInfo>>;
  /** by id, or by exact name */
  getTable(ref: { id: string } | { name: string }): Promise<DataTableInfo | null>;
  /** `reuseExisting` answers the table of that name instead of `tableNameExists` */
  createTable(input: {
    name: string;
    columns: DataTableColumnInput[];
    reuseExisting?: boolean;
  }): Promise<DataTableInfo>;
  renameTable(id: string, name: string): Promise<DataTableInfo>;
  deleteTable(id: string): Promise<void>;
  /** removes every row and keeps the columns */
  clearTable(id: string): Promise<{ deletedCount: number }>;
  listColumns(id: string): Promise<DataTableColumn[]>;
  /** adds one column at the end (the Evaluation node writes outputs back into new columns) */
  addColumn(id: string, column: DataTableColumnInput): Promise<DataTableColumn>;
  insertRows<T extends DataTableInsertReturnType>(
    id: string,
    rows: DataTableRowInput[],
    returnType: T,
  ): Promise<DataTableInsertResult<T>>;
  getRows(id: string, query?: DataTableRowsQuery): Promise<DataTablePage<DataTableRow>>;
  /** an empty filter throws `filterEmpty` */
  updateRows(
    id: string,
    change: DataTableChange,
    options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]>;
  /** updates the matching rows; when none match, inserts one row built from `data` */
  upsertRow(
    id: string,
    change: DataTableChange,
    options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]>;
  /** an empty filter throws `filterRequiredForDelete` */
  deleteRows(
    id: string,
    filter: DataTableFilter,
    options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]>;
  rowsExist(id: string, filter: DataTableFilter): Promise<boolean>;
}
