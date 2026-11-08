/**
 * Extract from File: XLSX, XLS and ODS (SheetJS).
 *
 * Guards run before the library parses anything: the input size, the zip's declared sizes (xlsx and
 * ods are zips) and, after a bounded read, the number of cells the sheet spans. The caps come from
 * `helpers.getInstanceLimits()`; they are not node options.
 */
import {
  type DataObject,
  type ExecuteContext,
  type InstanceLimits,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import * as XLSX from 'xlsx';
import { safeKey } from '../../../utils/utilities';
import { readZipDirectory, ZipDirectoryError } from '../../../utils/zip-directory';

export type SpreadsheetOperation = 'xlsx' | 'xls' | 'ods';

const SPREADSHEET_SHOW = { '/operation': ['xlsx', 'xls', 'ods'] };

/** spreadsheet-only fields of the Options collection (shown for xlsx, xls, ods) */
export const spreadsheetOptionFields: NodeProperty[] = [
  {
    displayName: 'Sheet Name',
    name: 'sheetName',
    type: 'string',
    default: '',
    placeholder: 'first sheet',
    description: 'Name of the sheet to read; empty reads the first sheet',
    displayOptions: { show: SPREADSHEET_SHOW },
  },
  {
    displayName: 'Range',
    name: 'range',
    type: 'string',
    default: '',
    placeholder: 'A1:C5',
    description: 'A cell range such as A1:C5, or a number of lines to skip at the top',
    displayOptions: { show: SPREADSHEET_SHOW },
  },
  {
    displayName: 'RAW Data',
    name: 'rawData',
    type: 'boolean',
    default: false,
    description:
      'Whether values are returned as stored: dates stay the stored number, and text input (such as CSV) is not parsed into numbers',
    displayOptions: { show: SPREADSHEET_SHOW },
  },
  {
    displayName: 'Read As String',
    name: 'readAsString',
    type: 'boolean',
    default: false,
    description: 'Whether the file is plain text (for example CSV saved with a spreadsheet extension)',
    displayOptions: { show: SPREADSHEET_SHOW },
  },
];

/** a workbook that cannot or may not be read; the message is for a person */
export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

/** one JSON object per row of the input file of item `itemIndex` */
export async function extractSpreadsheet(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: SpreadsheetOperation,
  options: DataObject,
): Promise<DataObject[]> {
  const limits = ctx.helpers.getInstanceLimits();
  const property = String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data') || 'data');
  const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
  try {
    return spreadsheetRows(bytes, operation, options, limits);
  } catch (error) {
    if (error instanceof SpreadsheetError) {
      throw new NodeOperationError(ctx.getNode(), error.message, { itemIndex });
    }
    throw error;
  }
}

/**
 * One JSON object per row of the workbook `bytes` (the reader behind `extractSpreadsheet`, also used by the
 * Assistant's document reader). Throws `SpreadsheetError`.
 */
export function spreadsheetRows(
  bytes: Uint8Array,
  operation: SpreadsheetOperation,
  options: DataObject,
  limits: Pick<InstanceLimits, 'maxDecompressedBytes' | 'maxArchiveEntries' | 'maxSpreadsheetCells'>,
): DataObject[] {
  const fail = (message: string) => new SpreadsheetError(message);

  if (bytes.byteLength > limits.maxDecompressedBytes) {
    throw fail(`The file is too large: the limit is ${limits.maxDecompressedBytes} bytes`);
  }

  const asString = options.readAsString === true;
  const input: { data: string | Uint8Array; type: 'string' | 'buffer' } = asString
    ? { data: Buffer.from(bytes).toString('utf8'), type: 'string' }
    : { data: bytes, type: 'buffer' };

  if (!asString) checkContainer(bytes, operation, limits, fail);

  const headerRow = options.headerRow !== false;
  const maxRows = Number(options.maxRowCount ?? -1);
  const limitRows = Number.isFinite(maxRows) && maxRows >= 0 ? Math.floor(maxRows) : -1;
  const range = parseRange(options.range, fail);

  const readOptions = {
    ...input,
    raw: options.rawData === true,
    cellDates: options.rawData !== true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
  } as XLSX.ParsingOptions;

  // Always bound the rows the reader parses: either the rows maxRowCount needs, or just past the
  // cell cap (a sheet with more rows than that is over the cap whatever its width). SheetJS keeps
  // the real size in `!fullref` and truncates `!ref` to the rows it read.
  const firstRow = startRow(range) + (headerRow ? 1 : 0);
  const capRows = firstRow + limits.maxSpreadsheetCells + 1;
  const sheetRows = limitRows >= 0 ? Math.min(firstRow + limitRows, capRows) : capRows;

  let book: XLSX.WorkBook;
  let sheetName: string | undefined;
  try {
    const names = XLSX.read(input.data, { ...readOptions, bookSheets: true }).SheetNames;
    const wanted = typeof options.sheetName === 'string' ? options.sheetName.trim() : '';
    sheetName = wanted === '' ? names[0] : findSheet(names, wanted);
    if (sheetName === undefined) {
      throw fail(wanted === '' ? 'The file has no sheets' : `Sheet "${wanted}" was not found in the file`);
    }
    // `sheets` only narrows XLSX parsing; XLS and ODS parse every sheet, so the sheet is picked by name below
    book = XLSX.read(input.data, { ...readOptions, sheets: sheetName, sheetRows });
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    throw fail(
      `The file could not be read as ${operation.toUpperCase()}: it is damaged or not in that format`,
    );
  }

  const picked = findSheet(Object.keys(book.Sheets), sheetName);
  const sheet = picked === undefined ? undefined : book.Sheets[picked];
  if (!sheet?.['!ref']) return [];

  // When maxRowCount bounds the read, only the rows read count (`!ref`). Otherwise the full size
  // counts (`!fullref`), so a sheet over the cap is refused instead of silently cut short.
  const rowCountBinds = limitRows >= 0 && firstRow + limitRows < capRows;
  const ref = rowCountBinds ? sheet['!ref'] : (sheet['!fullref'] ?? sheet['!ref']);
  const cells = spanCells(ref);
  if (cells > limits.maxSpreadsheetCells) {
    throw fail(`The sheet spans ${cells} cells: the limit is ${limits.maxSpreadsheetCells} cells`);
  }

  const fill = options.includeEmptyCells === true;
  const raw = XLSX.utils.sheet_to_json<unknown>(sheet, {
    header: headerRow ? undefined : 1,
    range,
    raw: true,
    rawNumbers: true,
    UTC: true,
    // with header 1 the library default keeps blank rows (as n8n does); with a header row they are left out
    ...(headerRow ? { blankrows: false } : {}),
    ...(fill ? { defval: '' } : {}),
  } as XLSX.Sheet2JSONOpts);

  const wantedRows = limitRows >= 0 ? raw.slice(0, limitRows) : raw;
  return wantedRows.map((entry) => {
    if (!headerRow) {
      // holes (empty cells without includeEmptyCells) become null, as SheetJS arrays give in n8n
      const cellsOfRow = Array.from(entry as unknown[], (v) => (v === undefined ? null : cleanValue(v)));
      return { row: cellsOfRow as DataObject[string] } as DataObject;
    }
    const row: DataObject = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      row[safeKey(key)] = cleanValue(value) as DataObject[string];
    }
    return row;
  });
}

/** the sheet called `name`: exact first, then ignoring case (SheetJS compares names that way) */
function findSheet(names: string[], name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (names.includes(name)) return name;
  const lower = name.toLowerCase();
  return names.find((n) => n.toLowerCase() === lower);
}

function spanCells(ref: string): number {
  const span = XLSX.utils.decode_range(ref);
  return (span.e.r - span.s.r + 1) * (span.e.c - span.s.c + 1);
}

/** Date cells become ISO strings (UTC); an invalid date becomes null */
function cleanValue(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}

/** a number of lines to skip, or an A1 range; anything else is a clear error */
function parseRange(value: unknown, fail: (m: string) => Error): number | string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Math.max(0, Math.floor(value));
  const text = String(value).trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^[A-Za-z]{1,3}\d+(:[A-Za-z]{1,3}\d+)?$/.test(text)) {
    throw fail(`The range "${text}" is not valid: use a range such as A1:C5 or a number of lines to skip`);
  }
  return text.toUpperCase();
}

/** zero-based first row of the range, to bound how many rows the reader parses */
function startRow(range: number | string | undefined): number {
  if (range === undefined) return 0;
  if (typeof range === 'number') return range;
  return XLSX.utils.decode_range(range.includes(':') ? range : `${range}:${range}`).s.r;
}

function checkContainer(
  bytes: Uint8Array,
  operation: SpreadsheetOperation,
  limits: { maxDecompressedBytes: number; maxArchiveEntries: number },
  fail: (message: string) => Error,
): void {
  if (operation === 'xls') {
    const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
    // a bare BIFF stream starts with a BOF record (0x0009 .. 0x0809)
    const biff = bytes[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(bytes[1] ?? -1);
    if (!ole && !biff) throw fail('The file is not an XLS workbook');
    return;
  }
  let declared = 0;
  try {
    for (const entry of readZipDirectory(bytes, { maxEntries: limits.maxArchiveEntries })) {
      declared += entry.declaredSize;
      if (declared > limits.maxDecompressedBytes) break;
    }
  } catch (error) {
    if (error instanceof ZipDirectoryError) {
      throw fail(`The file is not a valid ${operation.toUpperCase()} workbook: ${error.message}`);
    }
    throw error;
  }
  if (declared > limits.maxDecompressedBytes) {
    throw fail(`The workbook unpacks to more than the limit of ${limits.maxDecompressedBytes} bytes`);
  }
}
