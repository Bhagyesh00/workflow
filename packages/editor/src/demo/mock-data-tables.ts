/**
 * Demo routes for data tables, registered by the MockBackend constructor, with the server's rules
 * (services/data-tables.ts, data-table-filter.ts, data-table-csv.ts): name and column rules, reserved
 * names, filters, sort, search, paging, CSV, limits. `dataTableName`, `searchDataTables` and
 * `simulateDataTableNode` have no backend argument, so the state lives here and
 * registerDataTableRoutes starts it fresh.
 */
import {
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_COLUMN_NAME_RE,
  DATA_TABLE_ERRORS,
  DATA_TABLE_NAME_MAX,
  DATA_TABLE_RESERVED_COLUMNS,
  DATA_TABLE_ROWS_TAKE_MAX,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataTableCellValue,
  type DataTableColumn,
  type DataTableColumnInput,
  type DataTableColumnType,
  type DataTableFilter,
  type DataTableFilterClause,
  type DataTableInfo,
  type DataTableRow,
  ExpressionEvaluator,
  type Item,
  isExpression,
  isResourceLocatorValue,
  type ListSearchResult,
  type WorkflowNode,
} from '@workflow/workflow';
import type { DataTableCsvPreview, DataTableDependency, DataTableLimits } from '../api/types';
import { buildExpressionContext } from '../lib/expression-context';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

interface StoredTable extends DataTableInfo {
  tenantId: string;
  rows: DataTableRow[];
  nextRowId: number;
}

const MEGABYTE = 1024 * 1024;
/** the server's defaults: DATA_TABLES_MAX_SIZE_BYTES and 80% for the warning */
const MAX_BYTES = 200 * MEGABYTE;
const WARNING_BYTES = Math.floor(MAX_BYTES * 0.8);
const CSV_TOO_LARGE = 'File upload error: File too large';
const DATA_EMPTY = 'Data columns must not be empty';
const INFER_ROWS = 100;
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_TEXT = /^(?:true|false)$/i;
const FORMULA_START = /^[=+\-@\t\r\n]/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const MAIL_DATE =
  /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC|[+-]\d{4})$/;
const TRUE_WORDS = new Set(['true', '1', 't', 'yes']);
const FALSE_WORDS = new Set(['false', '0', 'f', 'no']);
const SYSTEM_TYPES = new Map<string, DataTableColumnType>([
  ['id', 'number'],
  ['createdAt', 'date'],
  ['updatedAt', 'date'],
]);

const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
const conflict = (message: string) => new HttpError(409, 'conflict', message);
const notFound = (message: string) => new HttpError(404, 'not_found', message);

let currentBackend: MockBackend | undefined;
let tables: StoredTable[] = [];
const evaluator = new ExpressionEvaluator({ timeoutMs: 500, maxSteps: 500_000 });

/** the signed-in workspace; none when signed out */
function currentTenantId(): string | undefined {
  try {
    return currentBackend?.auth().tenant.id;
  } catch {
    return undefined;
  }
}

const tablesOf = (tenantId: string | undefined) => tables.filter((table) => table.tenantId === tenantId);

function tableOf(tenantId: string | undefined, id: string): StoredTable {
  const table = tablesOf(tenantId).find((t) => t.id === id);
  if (!table) throw notFound(DATA_TABLE_ERRORS.tableIdNotFound(id));
  return table;
}

function toInfo(table: StoredTable): DataTableInfo {
  const { id, name, columns, createdAt, updatedAt } = table;
  return copy({ id, name, columns, createdAt, updatedAt });
}

function parseTableName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > DATA_TABLE_NAME_MAX) {
    throw badRequest(`A data table name has 1 to ${DATA_TABLE_NAME_MAX} characters`);
  }
  return name;
}

function assertColumnName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !DATA_TABLE_COLUMN_NAME_RE.test(name) ||
    name.length > DATA_TABLE_COLUMN_NAME_MAX
  ) {
    throw badRequest(DATA_TABLE_ERRORS.columnNameInvalid);
  }
  const reserved: readonly string[] = DATA_TABLE_RESERVED_COLUMNS;
  const lower = name.toLowerCase();
  // the server refuses these two as well: they would reach Object.prototype
  if (reserved.some((r) => r.toLowerCase() === lower) || lower === 'constructor' || lower === 'prototype') {
    throw badRequest(DATA_TABLE_ERRORS.columnNameReserved(name));
  }
}

function assertUniqueName(tenantId: string | undefined, name: string, except?: string): void {
  if (tablesOf(tenantId).some((t) => t.name === name && t.id !== except)) {
    throw conflict(DATA_TABLE_ERRORS.tableNameExists(name));
  }
}

// ---- cells ----

function parseIsoDate(match: RegExpExecArray): Date | undefined {
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone = 'Z'] = match;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Date would carry 02-31 over to March
  if (day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return undefined;
  const offset = /^[zZ]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseDate(text: string): Date | undefined {
  const trimmed = text.trim();
  const iso = ISO_DATE.exec(trimmed);
  if (iso) return parseIsoDate(iso);
  if (!MAIL_DATE.test(trimmed)) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function mismatch(value: unknown, type: DataTableColumnType, expected: string): HttpError {
  return badRequest(
    DATA_TABLE_ERRORS.valueTypeMismatch(
      value,
      type,
      `the value expects ${expected} but we got '${String(value)}'`,
    ),
  );
}

function coerce(value: unknown, type: DataTableColumnType): DataTableCellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'string':
      return String(value);
    case 'number': {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(number)) throw mismatch(value, type, 'a number');
      return number;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const word = String(value).trim().toLowerCase();
      if (!TRUE_WORDS.has(word) && !FALSE_WORDS.has(word)) throw mismatch(value, type, 'a boolean');
      return TRUE_WORDS.has(word);
    }
    case 'date': {
      const date = typeof value === 'string' ? parseDate(value) : undefined;
      if (!date) throw mismatch(value, type, 'a date');
      return date.toISOString();
    }
  }
}

function toCells(table: StoredTable, row: Record<string, unknown>): Record<string, DataTableCellValue> {
  const types = new Map(table.columns.map((column) => [column.name, column.type]));
  const cells: Record<string, DataTableCellValue> = {};
  for (const key of Object.keys(row)) {
    const type = types.get(key);
    if (!type) throw badRequest(DATA_TABLE_ERRORS.unknownColumn(key));
    cells[key] = coerce(row[key], type);
  }
  return cells;
}

function insert(table: StoredTable, rows: Array<Record<string, unknown>>): DataTableRow[] {
  const stored = rows.map((row) => toCells(table, row));
  assertQuota(table.tenantId);
  const at = now();
  const inserted = stored.map((cells) => {
    const row: DataTableRow = { id: table.nextRowId, createdAt: at, updatedAt: at };
    table.nextRowId += 1;
    for (const column of table.columns) row[column.name] = cells[column.name] ?? null;
    return row;
  });
  table.rows.push(...inserted);
  return inserted;
}

// ---- filter, search, sort ----

function typeOf(table: StoredTable, name: string): DataTableColumnType {
  const type = SYSTEM_TYPES.get(name) ?? table.columns.find((c) => c.name === name)?.type;
  if (!type) throw badRequest(DATA_TABLE_ERRORS.unknownColumn(name));
  return type;
}

const textOf = (value: DataTableCellValue | undefined) =>
  value === null || value === undefined ? null : String(value);

function likeRegex(pattern: string, flags: string): RegExp {
  const parts = pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = pattern.includes('%') ? `^${parts.join('[\\s\\S]*')}$` : parts[0];
  return new RegExp(body, flags);
}

function matchesClause(table: StoredTable, row: DataTableRow, clause: DataTableFilterClause): boolean {
  const type = typeOf(table, clause.columnName);
  const cell = Object.hasOwn(row, clause.columnName) ? row[clause.columnName] : null;
  const text = textOf(cell);
  const { condition } = clause;
  if (condition === 'isEmpty') return text === null || text === '';
  if (condition === 'isNotEmpty') return text !== null && text !== '';
  const input = clause.value ?? null;
  if ((condition === 'like' || condition === 'ilike') && typeof input !== 'string') {
    throw badRequest(DATA_TABLE_ERRORS.valueTypeMismatch(input, 'string', `${condition} needs a text value`));
  }
  if (input === null) {
    if (condition === 'eq') return text === null;
    return condition === 'neq' && text !== null;
  }
  if (condition === 'like' || condition === 'ilike') {
    if (text === null) return false;
    return likeRegex(input as string, condition === 'ilike' ? 'i' : '').test(text);
  }
  const value = coerce(input, type) as string | number | boolean;
  if (condition === 'neq') return cell === null || cell !== value;
  if (cell === null) return false;
  switch (condition) {
    case 'eq':
      return cell === value;
    case 'gt':
      return cell > value;
    case 'gte':
      return cell >= value;
    case 'lt':
      return cell < value;
    case 'lte':
      return cell <= value;
  }
}

function matching(table: StoredTable, filter: DataTableFilter | undefined): DataTableRow[] {
  if (!filter?.filters.length) return table.rows;
  // an unknown column is refused even on an empty table
  for (const clause of filter.filters) typeOf(table, clause.columnName);
  const test = (row: DataTableRow) => (clause: DataTableFilterClause) => matchesClause(table, row, clause);
  return table.rows.filter((row) =>
    filter.type === 'or' ? filter.filters.some(test(row)) : filter.filters.every(test(row)),
  );
}

function searched(table: StoredTable, rows: DataTableRow[], search: string | undefined): DataTableRow[] {
  if (!search?.trim()) return rows;
  const pattern = likeRegex(search, 'i');
  return rows.filter((row) =>
    table.columns.some((column) => {
      const text = textOf(row[column.name]);
      return text !== null && pattern.test(text);
    }),
  );
}

/** `column:direction` */
function parseSort(raw: string | undefined): { column: string; direction: string } | undefined {
  if (!raw) return undefined;
  const at = raw.lastIndexOf(':');
  return { column: raw.slice(0, Math.max(at, 0)), direction: raw.slice(at + 1) };
}

/** as Postgres: nulls last going up and first going down, ties by id */
function sorted(table: StoredTable, rows: DataTableRow[], raw: string | undefined): DataTableRow[] {
  const sort = parseSort(raw);
  if (!sort) return rows;
  typeOf(table, sort.column);
  const sign = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a[sort.column] ?? null;
    const right = b[sort.column] ?? null;
    if (left === right) return a.id - b.id;
    if (left === null) return sign;
    if (right === null) return -sign;
    return (left < right ? -1 : 1) * sign;
  });
}

const parseSkip = (raw: string | undefined) => Math.max(Number(raw) || 0, 0);
const parseTake = (raw: string | undefined) =>
  Math.min(Math.max(Number(raw) || 10, 1), DATA_TABLE_ROWS_TAKE_MAX);

function parseFilter(raw: string | undefined): DataTableFilter | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DataTableFilter>;
    return { type: parsed.type === 'or' ? 'or' : 'and', filters: parsed.filters ?? [] };
  } catch {
    throw badRequest('Must be valid JSON');
  }
}

// ---- writes ----

function updateMatching(table: StoredTable, filter: DataTableFilter, data: Record<string, unknown>) {
  const cells = toCells(table, data);
  assertQuota(table.tenantId);
  const at = now();
  const changed = matching(table, filter);
  for (const row of changed) {
    Object.assign(row, cells);
    row.updatedAt = at;
  }
  return changed;
}

function deleteMatching(table: StoredTable, filter: DataTableFilter): DataTableRow[] {
  const removed = matching(table, filter);
  const gone = new Set(removed);
  table.rows = table.rows.filter((row) => !gone.has(row));
  return removed;
}

function renumber(table: StoredTable): void {
  table.columns.forEach((column, position) => {
    column.position = position;
  });
}

function addColumn(table: StoredTable, name: string, type: DataTableColumnType, index?: number) {
  const at = now();
  const column: DataTableColumn = { id: newId(), name, type, position: 0, createdAt: at, updatedAt: at };
  const place = Math.min(index ?? table.columns.length, table.columns.length);
  table.columns.splice(place, 0, column);
  renumber(table);
  for (const row of table.rows) row[name] = null;
  table.updatedAt = at;
  return column;
}

function columnOf(table: StoredTable, id: string): DataTableColumn {
  const column = table.columns.find((c) => c.id === id);
  if (!column) throw notFound('Column not found');
  return column;
}

// ---- size ----

const sizeOf = (table: StoredTable) => new TextEncoder().encode(JSON.stringify(table.rows)).length;
const usedBytes = (tenantId: string | undefined) =>
  tablesOf(tenantId).reduce((sum, table) => sum + sizeOf(table), 0);

function assertQuota(tenantId: string | undefined): void {
  const used = usedBytes(tenantId);
  if (used >= MAX_BYTES) {
    throw badRequest(
      DATA_TABLE_ERRORS.sizeLimitExceeded(Math.ceil(used / MEGABYTE), Math.round(MAX_BYTES / MEGABYTE)),
    );
  }
}

function assertCsvFits(tenantId: string | undefined, csv: string): void {
  if (new TextEncoder().encode(csv).length > MAX_BYTES - usedBytes(tenantId)) {
    throw badRequest(CSV_TOO_LARGE);
  }
}

function limitsOf(tenantId: string | undefined): DataTableLimits {
  const totalBytes = usedBytes(tenantId);
  const status = totalBytes >= MAX_BYTES ? 'error' : totalBytes >= WARNING_BYTES ? 'warn' : 'ok';
  return {
    totalBytes,
    maxBytes: MAX_BYTES,
    warningBytes: WARNING_BYTES,
    quotaStatus: status,
    uploadMaxFileSize: Math.max(MAX_BYTES - totalBytes, 0),
    dataTables: Object.fromEntries(
      tablesOf(tenantId).map((table) => [
        table.id,
        { id: table.id, name: table.name, sizeBytes: sizeOf(table) },
      ]),
    ),
  };
}

// ---- CSV ----

interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** RFC 4180 with a comma; rows stay arrays, so a header like `__proto__` is never an object key */
function splitCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines: string[][] = [];
  let line: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === ',') {
      line.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      line.push(cell);
      lines.push(line);
      line = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw badRequest("Couldn't read the CSV file: a quoted value is not closed");
  if (cell || line.length) {
    line.push(cell);
    lines.push(line);
  }
  return lines.filter((l) => l.some((value) => value.trim()));
}

function parseCsv(text: string, hasHeaders: boolean): ParsedCsv {
  const lines = splitCsv(text);
  const first = lines[0] ?? [];
  const width = lines.reduce((widest, line) => Math.max(widest, line.length), 0);
  const headers = Array.from({ length: hasHeaders ? first.length : width }, (_, i) => {
    const name = hasHeaders ? first[i].trim() : '';
    return name || `Column_${i + 1}`;
  });
  return { headers, rows: hasHeaders ? lines.slice(1) : lines };
}

function inferType(value: string): DataTableColumnType {
  if (NUMBER_TEXT.test(value) && Number.isFinite(Number(value))) return 'number';
  if (BOOLEAN_TEXT.test(value)) return 'boolean';
  return parseDate(value) ? 'date' : 'string';
}

function inferColumns(csv: ParsedCsv): DataTableColumnInput[] {
  const sample = csv.rows.slice(0, INFER_ROWS);
  return csv.headers.map((name, index) => {
    const first = sample.map((row) => row[index]?.trim()).find((value) => value);
    return { name, type: first ? inferType(first) : 'string' };
  });
}

function previewCsv(text: string, hasHeaders: boolean): DataTableCsvPreview {
  const csv = parseCsv(text, hasHeaders);
  return { rowCount: csv.rows.length, columnCount: csv.headers.length, columns: inferColumns(csv) };
}

const cellOf = (row: string[], index: number) => {
  const value = row[index];
  return value === undefined || value === '' ? null : value;
};

type CreateColumn = DataTableColumnInput & { csvColumnName?: string };

/** which CSV column feeds each table column: its csvColumnName, else same name, else same place when every column was kept */
function matchCsvColumns(csv: ParsedCsv, columns: CreateColumn[]): number[] {
  const explicit = columns.map((column) =>
    column.csvColumnName === undefined ? undefined : csv.headers.indexOf(column.csvColumnName),
  );
  const claimed = new Set(explicit.filter((index) => index !== undefined && index !== -1));
  const byName = columns.map((column, position) => {
    if (explicit[position] !== undefined) return explicit[position];
    const index = csv.headers.indexOf(column.name);
    return claimed.has(index) ? -1 : index;
  }) as number[];
  for (const index of byName) if (index !== -1) claimed.add(index);
  const free = csv.headers.map((_, index) => index).filter((index) => !claimed.has(index));
  const positional = columns.length === csv.headers.length;
  return byName.map((index, position) => {
    if (index !== -1) return index;
    if (columns[position].csvColumnName !== undefined) {
      throw badRequest(`Column '${columns[position].csvColumnName}' is not in the CSV file`);
    }
    if (!positional) throw badRequest(`Column '${columns[position].name}' is not in the CSV file`);
    return free.shift() as number;
  });
}

function csvCell(value: DataTableCellValue | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const safe = typeof value === 'string' && FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// ---- routes ----

export function registerDataTableRoutes(backend: MockBackend): void {
  currentBackend = backend;
  tables = [];
  const reader = () => backend.auth().tenant.id;
  const writer = () => backend.requireRole('editor').tenant.id;

  backend.on('GET', '/data-tables', ({ query }) => {
    const tenantId = reader();
    const name = parseFilterName(query.filter);
    const sort = parseSort(query.sortBy);
    const sign = sort?.direction === 'asc' ? 1 : -1;
    const list = tablesOf(tenantId)
      .filter((t) => !name || t.name.toLowerCase().includes(name.toLowerCase()))
      .sort((a, b) => {
        if (!sort) return b.updatedAt.localeCompare(a.updatedAt);
        if (sort.column === 'size') return (sizeOf(a) - sizeOf(b)) * sign;
        const key = sort.column as 'name' | 'createdAt' | 'updatedAt';
        return a[key].localeCompare(b[key]) * sign;
      });
    const skip = parseSkip(query.skip);
    return { count: list.length, data: list.slice(skip, skip + parseTake(query.take)).map(toInfo) };
  });

  backend.on('GET', '/data-tables/limits', () => limitsOf(reader()));

  backend.on('POST', '/data-tables', ({ body }) => {
    const tenantId = writer();
    const name = parseTableName(body.name);
    assertUniqueName(tenantId, name);
    const input = (body.columns ?? []) as CreateColumn[];
    const csvText = typeof body.csv === 'string' ? body.csv : undefined;
    if (csvText !== undefined) assertCsvFits(tenantId, csvText);
    const csv = csvText === undefined ? undefined : parseCsv(csvText, body.hasHeaders !== false);
    const columns = csv && !input.length ? inferColumns(csv) : input;
    if (csv && !columns.length) throw badRequest('The CSV file has no columns');
    const seen = new Set<string>();
    for (const column of columns) {
      assertColumnName(column.name);
      if (seen.has(column.name)) throw conflict(DATA_TABLE_ERRORS.columnNameExists(column.name, name));
      seen.add(column.name);
    }
    const at = now();
    const table: StoredTable = {
      id: newId(),
      tenantId,
      name,
      columns: [],
      rows: [],
      nextRowId: 1,
      createdAt: at,
      updatedAt: at,
    };
    for (const column of columns) addColumn(table, column.name, column.type);
    if (csv) {
      const sources = matchCsvColumns(csv, columns);
      insert(
        table,
        csv.rows.map((row) =>
          Object.fromEntries(columns.map((column, i) => [column.name, cellOf(row, sources[i])])),
        ),
      );
    }
    tables.push(table);
    return toInfo(table);
  });

  backend.on('POST', '/data-tables/csv/preview', ({ body }) => {
    const tenantId = writer();
    const csv = String(body.csv ?? '');
    assertCsvFits(tenantId, csv);
    return previewCsv(csv, body.hasHeaders !== false);
  });

  backend.on('GET', '/data-tables/:id', ({ params }) => toInfo(tableOf(reader(), params[0])));

  backend.on('PATCH', '/data-tables/:id', ({ params, body }) => {
    const tenantId = writer();
    const table = tableOf(tenantId, params[0]);
    const name = parseTableName(body.name);
    assertUniqueName(tenantId, name, table.id);
    table.name = name;
    table.updatedAt = now();
    return toInfo(table);
  });

  backend.on('DELETE', '/data-tables/:id', ({ params }) => {
    const table = tableOf(writer(), params[0]);
    tables = tables.filter((t) => t !== table);
    return { ok: true };
  });

  backend.on('GET', '/data-tables/:id/dependencies', ({ params }) => {
    const tenantId = reader();
    const table = tableOf(tenantId, params[0]);
    const uses = (node: WorkflowNode) => {
      const ref = node.parameters?.dataTableId;
      if (node.type !== 'core.dataTable' || !isResourceLocatorValue(ref)) return false;
      return ref.mode === 'name' ? ref.value === table.name : ref.value === table.id;
    };
    return backend.workflows
      .filter((w) => w.tenantId === tenantId && !w.isArchived && w.nodes.some(uses))
      .map((w): DataTableDependency => ({ type: 'workflow', id: w.id, name: w.name }));
  });

  backend.on('GET', '/data-tables/:id/columns', ({ params }) => copy(tableOf(reader(), params[0]).columns));

  backend.on('POST', '/data-tables/:id/columns', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    assertColumnName(body.name);
    if (table.columns.some((c) => c.name === body.name)) {
      throw conflict(DATA_TABLE_ERRORS.columnNameExists(body.name, table.name));
    }
    return copy(
      addColumn(table, body.name, body.type as DataTableColumnType, body.index as number | undefined),
    );
  });

  backend.on('DELETE', '/data-tables/:id/columns/:columnId', ({ params }) => {
    const table = tableOf(writer(), params[0]);
    const column = columnOf(table, params[1]);
    table.columns = table.columns.filter((c) => c !== column);
    renumber(table);
    for (const row of table.rows) delete row[column.name];
    table.updatedAt = now();
    return { ok: true };
  });

  backend.on('PATCH', '/data-tables/:id/columns/:columnId/move', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    const column = columnOf(table, params[1]);
    const target = Math.min(Math.max(Number(body.targetIndex) || 0, 0), table.columns.length - 1);
    table.columns = table.columns.filter((c) => c !== column);
    table.columns.splice(target, 0, column);
    renumber(table);
    column.updatedAt = now();
    return copy(column);
  });

  backend.on('PATCH', '/data-tables/:id/columns/:columnId/rename', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    const column = columnOf(table, params[1]);
    assertColumnName(body.name);
    const name = body.name;
    if (table.columns.some((c) => c.name === name && c !== column)) {
      throw conflict(DATA_TABLE_ERRORS.columnNameExists(name, table.name));
    }
    for (const row of table.rows) {
      const value = row[column.name];
      delete row[column.name];
      row[name] = value;
    }
    column.name = name;
    column.updatedAt = now();
    return copy(column);
  });

  backend.on('GET', '/data-tables/:id/rows', ({ params, query }) => {
    const table = tableOf(reader(), params[0]);
    const found = sorted(
      table,
      searched(table, matching(table, parseFilter(query.filter)), query.search),
      query.sortBy,
    );
    const skip = parseSkip(query.skip);
    return { count: found.length, data: copy(found.slice(skip, skip + parseTake(query.take))) };
  });

  backend.on('POST', '/data-tables/:id/insert', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    const inserted = insert(table, (body.data ?? []) as Array<Record<string, unknown>>);
    if (body.returnType === 'all') return copy(inserted);
    if (body.returnType === 'id') return inserted.map((row) => ({ id: row.id }));
    return { success: true, insertedRows: inserted.length };
  });

  backend.on('POST', '/data-tables/:id/upsert', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    const { filter, data } = parseChange(body);
    const changed = matching(table, filter).length
      ? updateMatching(table, filter, data)
      : insert(table, [data]);
    return body.returnData ? copy(changed) : true;
  });

  backend.on('PATCH', '/data-tables/:id/rows', ({ params, body }) => {
    const table = tableOf(writer(), params[0]);
    const { filter, data } = parseChange(body);
    const changed = updateMatching(table, filter, data);
    return body.returnData ? copy(changed) : true;
  });

  backend.on('DELETE', '/data-tables/:id/rows/clear', ({ params }) => {
    const table = tableOf(writer(), params[0]);
    const deletedCount = table.rows.length;
    table.rows = [];
    return { deletedCount };
  });

  backend.on('DELETE', '/data-tables/:id/rows', ({ params, query }) => {
    const table = tableOf(writer(), params[0]);
    const filter = parseFilter(query.filter);
    if (!filter?.filters.length) throw badRequest(DATA_TABLE_ERRORS.filterRequiredForDelete);
    const removed = deleteMatching(table, filter);
    return query.returnData === 'true' ? copy(removed) : true;
  });

  backend.on('GET', '/data-tables/:id/download-csv', ({ params, query }) => {
    const table = tableOf(reader(), params[0]);
    const fields = [
      ...(query.includeSystemColumns === 'false' ? [] : DATA_TABLE_SYSTEM_COLUMNS),
      ...table.columns.map((column) => column.name),
    ];
    const lines = table.rows.map((row) => fields.map((field) => csvCell(row[field])).join(','));
    return { csvContent: [fields.join(','), ...lines].join('\r\n'), dataTableName: table.name };
  });

  backend.on('POST', '/data-tables/:id/import-csv', ({ params, body }) => {
    const tenantId = writer();
    const table = tableOf(tenantId, params[0]);
    const text = String(body.csv ?? '');
    assertCsvFits(tenantId, text);
    const csv = parseCsv(text, true);
    const system: readonly string[] = DATA_TABLE_SYSTEM_COLUMNS;
    const kept = csv.headers.flatMap((name, index) => (system.includes(name) ? [] : [{ name, index }]));
    insert(
      table,
      csv.rows.map((row) => Object.fromEntries(kept.map(({ name, index }) => [name, cellOf(row, index)]))),
    );
    return {
      importedRows: csv.rows.length,
      systemColumnsIgnored: csv.headers.filter((name) => system.includes(name)),
    };
  });
}

function parseFilterName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { name?: string }).name;
  } catch {
    throw badRequest('Must be valid JSON');
  }
}

function parseChange(body: Record<string, unknown>) {
  const filter = (body.filter ?? { type: 'and', filters: [] }) as DataTableFilter;
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (!filter.filters?.length) throw badRequest(DATA_TABLE_ERRORS.filterEmpty);
  if (!Object.keys(data).length) throw badRequest(DATA_EMPTY);
  return { filter, data };
}

/** the name of a table of the signed-in workspace, undefined when there is none */
export function dataTableName(id: string): string | undefined {
  return tablesOf(currentTenantId()).find((table) => table.id === id)?.name;
}

/** the list mode of the Data Table node's locator (method `tableSearch`) */
export function searchDataTables(filter: string): ListSearchResult {
  const term = filter.toLowerCase();
  return {
    results: tablesOf(currentTenantId())
      .filter((table) => table.name.toLowerCase().includes(term))
      .map((table) => ({ name: table.name, value: table.id, url: `/data-tables/${table.id}` })),
  };
}

// ---- the demo run ----

type FilterConditionParameter = { keyName?: string; condition?: string; keyValue?: unknown };

/** what a Data Table node does in the demo run: its row operations on the tables above */
export function simulateDataTableNode(node: WorkflowNode, items: Item[]): Item[][] {
  const parameters = node.parameters ?? {};
  const operation = (parameters.operation as string | undefined) ?? 'insert';
  const tenantId = currentTenantId();
  const output: Item[] = [];

  const resolve = (value: unknown, itemIndex: number): unknown => {
    if (!isExpression(value)) return value;
    const context = buildExpressionContext({
      workflow: { name: 'Demo', active: false, nodes: [node], connections: {} },
      runData: {},
      nodeName: node.name,
    });
    return evaluator.evaluate(value, { ...context, connectionInputData: items, itemIndex });
  };

  const tableFor = (itemIndex: number): StoredTable => {
    const ref = parameters.dataTableId;
    const mode = isResourceLocatorValue(ref) ? ref.mode : 'id';
    const value = String(resolve(isResourceLocatorValue(ref) ? ref.value : ref, itemIndex) ?? '');
    if (mode !== 'name') return tableOf(tenantId, value);
    const table = tablesOf(tenantId).find((t) => t.name === value);
    if (!table) throw new Error(DATA_TABLE_ERRORS.tableNameNotFound(value));
    return table;
  };

  const rowData = (table: StoredTable, item: Item, itemIndex: number): Record<string, unknown> => {
    if (parameters.dataMode === 'autoMapInputData') {
      // as on a real server: item fields that are no column, and the system columns, are not mapped
      const names = new Set(table.columns.map((column) => column.name));
      return Object.fromEntries(Object.entries(item.json).filter(([key]) => names.has(key)));
    }
    const ui = parameters.fieldsUi as { fieldValues?: Array<{ columnName: string; value: unknown }> };
    const data: Record<string, unknown> = {};
    for (const { columnName, value } of ui?.fieldValues ?? []) {
      data[columnName] = resolve(value, itemIndex);
    }
    return data;
  };

  const filterFor = (itemIndex: number): DataTableFilter => {
    const ui = parameters.filters as { conditions?: FilterConditionParameter[] } | undefined;
    const filters = (ui?.conditions ?? []).map((c) => ({
      columnName: String(c.keyName ?? ''),
      condition: (c.condition ?? 'eq') as DataTableFilterClause['condition'],
      value: resolve(c.keyValue, itemIndex) as DataTableCellValue,
    }));
    // an unset match type is "any", as in the node
    return { type: parameters.matchType === 'allConditions' ? 'and' : 'or', filters };
  };

  const required = (filter: DataTableFilter) => {
    if (!filter.filters.length) throw new Error(DATA_TABLE_ERRORS.atLeastOneCondition);
    return filter;
  };

  const dryRun = Boolean((parameters.options as { dryRun?: unknown } | undefined)?.dryRun);
  const emptyRow = (table: StoredTable, state: 'before' | 'after') =>
    ({
      ...Object.fromEntries(
        [...SYSTEM_TYPES.keys(), ...table.columns.map((c) => c.name)].map((n) => [n, null]),
      ),
      dryRunState: state,
    }) as unknown as DataTableRow;
  /** before and after of each matched row; nothing is written */
  const dryPairs = (rows: DataTableRow[], patch: Record<string, DataTableCellValue>) =>
    rows.flatMap((row) => [
      { ...row, dryRunState: 'before' } as unknown as DataTableRow,
      { ...row, ...patch, updatedAt: now(), dryRunState: 'after' } as unknown as DataTableRow,
    ]);

  items.forEach((item, itemIndex) => {
    const table = tableFor(itemIndex);
    const push = (rows: DataTableRow[]) =>
      output.push(...rows.map((row) => ({ json: copy(row), pairedItem: { item: itemIndex } })));
    switch (operation) {
      case 'insert':
        push(insert(table, [rowData(table, item, itemIndex)]));
        break;
      case 'get': {
        const rows = matching(table, filterFor(itemIndex));
        const column = String(parameters.orderByColumn ?? 'createdAt');
        const ordered = parameters.orderBy
          ? sorted(table, rows, `${column}:${parameters.orderByDirection === 'ASC' ? 'asc' : 'desc'}`)
          : rows;
        push(parameters.returnAll ? ordered : ordered.slice(0, Number(parameters.limit ?? 50)));
        break;
      }
      case 'update': {
        const filter = required(filterFor(itemIndex));
        const data = rowData(table, item, itemIndex);
        push(
          dryRun
            ? dryPairs(matching(table, filter), toCells(table, data))
            : updateMatching(table, filter, data),
        );
        break;
      }
      case 'upsert': {
        const filter = required(filterFor(itemIndex));
        const data = rowData(table, item, itemIndex);
        const found = matching(table, filter);
        if (dryRun) {
          push(
            found.length
              ? dryPairs(found, toCells(table, data))
              : [
                  emptyRow(table, 'before'),
                  { ...emptyRow(table, 'after'), ...toCells(table, data), id: 0 } as unknown as DataTableRow,
                ],
          );
        } else {
          push(found.length ? updateMatching(table, filter, data) : insert(table, [data]));
        }
        break;
      }
      case 'deleteRows': {
        const filter = required(filterFor(itemIndex));
        push(
          dryRun
            ? matching(table, filter).flatMap((row) => [
                { ...row, dryRunState: 'before' } as unknown as DataTableRow,
                emptyRow(table, 'after'),
              ])
            : deleteMatching(table, filter),
        );
        break;
      }
      case 'rowExists':
      case 'rowNotExists': {
        const exists = matching(table, required(filterFor(itemIndex))).length > 0;
        if (exists === (operation === 'rowExists'))
          output.push({ ...copy(item), pairedItem: { item: itemIndex } });
        break;
      }
      default:
        throw new Error(`The demo has no Data Table operation "${operation}"`);
    }
  });
  return [output];
}
