/**
 * Data tables (P4-03): CSV as JSON text, since /rest takes JSON only. Rows stay arrays of strings while
 * parsing, so a header like `__proto__` is never an object key here.
 */
import {
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataTableCellValue,
  type DataTableColumnInput,
  type DataTableColumnType,
  type DataTableCreateColumn,
  type DataTableRowInput,
} from '@workflow/workflow';
import Papa from 'papaparse';
import { ApiError } from '../http/errors';
import { parseDataTableDate } from './data-table-filter';

/** n8n's answer for a file over the limit (its upload error around multer's text) */
export const CSV_TOO_LARGE_MESSAGE = 'File upload error: File too large';

const INFER_ROWS = 100;
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_TEXT = /^(?:true|false)$/i;
/** Spreadsheets run a cell that starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r\n]/;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string, hasHeaders: boolean): ParsedCsv {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = Papa.parse<string[]>(source, {
    header: false,
    delimiter: ',',
    skipEmptyLines: 'greedy',
  });
  if (parsed.errors.some((error) => error.type === 'Quotes')) {
    throw ApiError.badRequest("Couldn't read the CSV file: a quoted value is not closed");
  }
  const lines = parsed.data;
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
  return parseDataTableDate(value) ? 'date' : 'string';
}

/** Each column takes its type from its first non-empty value in the first 100 rows. */
export function inferColumns(csv: ParsedCsv): DataTableColumnInput[] {
  const sample = csv.rows.slice(0, INFER_ROWS);
  return csv.headers.map((name, index) => {
    const first = sample.map((row) => row[index]?.trim()).find((value) => value);
    return { name, type: first ? inferType(first) : 'string' };
  });
}

export function previewCsv(text: string, hasHeaders: boolean) {
  const csv = parseCsv(text, hasHeaders);
  return { rowCount: csv.rows.length, columnCount: csv.headers.length, columns: inferColumns(csv) };
}

const cellOf = (row: string[], index: number) => {
  const value = row[index];
  return value === undefined || value === '' ? null : value;
};

/**
 * Which CSV column feeds each table column of a new table: the one a column names in `csvColumnName`
 * (n8n's way, so a renamed column keeps its data); else the one of the same name; else (when the caller
 * kept every column and only renamed some) the one at the same place. Any other column could be filled
 * from the wrong data, so it is refused.
 */
export function matchCsvColumns(csv: ParsedCsv, columns: DataTableCreateColumn[]): number[] {
  const explicit = columns.map((column) =>
    column.csvColumnName === undefined ? undefined : csv.headers.indexOf(column.csvColumnName),
  );
  const claimed = new Set(explicit.filter((index) => index !== undefined && index !== -1));
  // a name that another column already claimed through csvColumnName is not a match
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
      throw ApiError.badRequest(`Column '${columns[position].csvColumnName}' is not in the CSV file`);
    }
    if (!positional) {
      throw ApiError.badRequest(`Column '${columns[position].name}' is not in the CSV file`);
    }
    return free.shift() as number;
  });
}

/** Rows for a new table; empty cells are null. */
export function csvRowsForColumns(
  csv: ParsedCsv,
  columns: DataTableColumnInput[],
  sources: number[],
): DataTableRowInput[] {
  return csv.rows.map((row) => {
    const out: DataTableRowInput = {};
    columns.forEach((column, position) => {
      out[column.name] = cellOf(row, sources[position]);
    });
    return out;
  });
}

const SYSTEM_NAMES: readonly string[] = DATA_TABLE_SYSTEM_COLUMNS;

/**
 * Rows for an existing table: system columns are ignored, a column the table lacks stays in the row so
 * that the row check answers `unknownColumn`, and a column the file lacks reads as null.
 */
export function csvRowsForImport(csv: ParsedCsv): {
  rows: DataTableRowInput[];
  systemColumnsIgnored: string[];
} {
  const kept = csv.headers.flatMap((name, index) => (SYSTEM_NAMES.includes(name) ? [] : [{ name, index }]));
  const rows = csv.rows.map((row) => {
    const out: DataTableRowInput = {};
    for (const { name, index } of kept) {
      Object.defineProperty(out, name, {
        value: cellOf(row, index),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  });
  return { rows, systemColumnsIgnored: csv.headers.filter((name) => SYSTEM_NAMES.includes(name)) };
}

/**
 * A quote in front of a text that a spreadsheet would run. Not papaparse's `escapeFormulae`: its pattern
 * misses a formula with a line break in it.
 */
export function escapeCsvFormula(value: DataTableCellValue): DataTableCellValue {
  return typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : value;
}

export function buildCsv(fields: string[], rows: DataTableCellValue[][]): string {
  return Papa.unparse(
    { fields, data: rows.map((row) => row.map(escapeCsvFormula)) },
    { header: true, newline: '\r\n' },
  );
}
