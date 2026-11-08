/**
 * The dataset side of the evaluation nodes. Read: the rows of a Data table or a Google Sheet, in order, up to
 * a limit, as the items the Evaluation Trigger gives (`row_number`, and `row_id` for a table). Write: the
 * outputs of one case back into its row, by `row_id` (table) or `row_number` (sheet). Every Google call goes
 * through `sheetsRequest` and its helpers, never a vendor SDK.
 */
import {
  DATA_TABLE_ERRORS,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataObject,
  type DataTableAccess,
  type DataTableCellValue,
  type DataTableColumn,
  type DataTableColumnInput,
  type DataTableFilter,
  type DataTableInfo,
  type DataTableRow,
  type ExecuteContext,
  MAX_EVALUATION_ROWS,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import {
  columnLetter,
  quoteSheet,
  readSheet,
  resolveSheet,
  SHEETS,
  type SheetRef,
  sheetsRequest,
  writeHeaders,
} from '../../apps/google/GoogleSheets.node';
import { locator } from '../../apps/shared';
import { nodeError, resolveTable } from '../data-table/tables';

/** the sources a dataset can come from */
export type DatasetSource = 'dataTable' | 'googleSheets';

/** the credential type each Google authentication picks */
export const GOOGLE_CREDENTIALS = {
  serviceAccount: 'googleApi',
  oAuth2: 'googleSheetsOAuth2Api',
} as const;

const PAGE = 250;

export function datasetSource(ctx: ExecuteContext): DatasetSource {
  const source = String(ctx.getNodeParameter('source', 0, 'dataTable'));
  if (source !== 'dataTable' && source !== 'googleSheets') {
    throw new NodeOperationError(ctx.getNode(), `Unknown source "${source}"`, { parameter: 'source' });
  }
  return source;
}

/** the Google credential type the node's Authentication names (OAuth2 by default) */
export function googleCredential(ctx: ExecuteContext): string {
  return String(ctx.getNodeParameter('authentication', 0, 'oAuth2')) === 'serviceAccount'
    ? GOOGLE_CREDENTIALS.serviceAccount
    : GOOGLE_CREDENTIALS.oAuth2;
}

export function tableAccess(ctx: ExecuteContext): DataTableAccess {
  const access = ctx.helpers.dataTables;
  if (!access) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Attempted to use Data table node but the module is disabled',
    );
  }
  return access;
}

/** the Data Table locator of a dataset, shown when `show` holds */
export function tableLocator(show: Record<string, unknown[]>, description: string): NodeProperty {
  return {
    displayName: 'Data Table',
    name: 'dataTableId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: '' },
    required: true,
    modes: [
      {
        displayName: 'From list',
        name: 'list',
        type: 'list',
        placeholder: 'Choose...',
        typeOptions: {
          searchListMethod: 'tableSearch',
          searchable: true,
          allowNewResource: { label: 'Create a new data table', url: '/data-tables' },
        },
      },
      { displayName: 'By name', name: 'name', type: 'string', placeholder: 'e.g. Customers' },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. 3f2a9c1e' },
    ],
    description,
    displayOptions: { show },
  };
}

/** the Document and Sheet locators of a Google Sheets dataset, shown when `show` holds */
export function sheetLocators(show: Record<string, unknown[]>): NodeProperty[] {
  return [
    {
      ...locator('documentId', 'Document', {
        urlRegex: 'https://docs\\.google\\.com/spreadsheets/d/([0-9a-zA-Z_-]+)',
        urlPlaceholder: 'https://docs.google.com/spreadsheets/d/1abc.../edit',
        idPlaceholder: '1qpyC0XzvTcKT6EISywY8qYcvF9ZpOT6hEbW3sxK3s_8',
      }),
      displayOptions: { show },
    },
    {
      displayName: 'Sheet',
      name: 'sheetName',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'name', value: '' },
      required: true,
      modes: [
        { displayName: 'By Name', name: 'name', type: 'string', placeholder: 'Sheet1' },
        { displayName: 'By ID (gid)', name: 'id', type: 'string', placeholder: '0' },
        {
          displayName: 'By URL',
          name: 'url',
          type: 'string',
          placeholder: 'https://docs.google.com/spreadsheets/d/1abc.../edit#gid=0',
          extractValue: { type: 'regex', regex: 'gid=(\\d+)' },
        },
      ],
      displayOptions: { show },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------------------------

/** one dataset row: the item json and its place in the dataset */
export interface DatasetRow {
  /** `row_id` of a table row; the sheet row number of a sheet row. The order and the "after" test go by it. */
  key: number;
  json: DataObject;
}

/** the most rows to read: the node's limit when set, never more than the hard cap */
export function rowLimit(ctx: ExecuteContext): number {
  if (!ctx.getNodeParameter('limitRows', 0, false)) return MAX_EVALUATION_ROWS;
  const asked = Number(ctx.getNodeParameter('maxRows', 0, 10));
  if (!Number.isFinite(asked) || asked < 1) return 1;
  return Math.min(Math.floor(asked), MAX_EVALUATION_ROWS);
}

/** the rows of a table that match `filter`, oldest id first, up to `cap` */
export async function readTableRows(
  access: DataTableAccess,
  tableId: string,
  filter: DataTableFilter | undefined,
  cap: number,
): Promise<DataTableRow[]> {
  const rows: DataTableRow[] = [];
  while (rows.length < cap) {
    const page = await access.getRows(tableId, {
      filter,
      take: Math.min(PAGE, cap - rows.length),
      skip: rows.length,
      sortBy: { column: 'id', direction: 'asc' },
    });
    rows.push(...page.data);
    if (!page.data.length || rows.length >= page.count) break;
  }
  return rows.slice(0, cap);
}

/** a table row as the trigger's item: the position, the id and the columns of the table */
export function tableRowJson(table: DataTableInfo, row: DataTableRow, position: number): DataObject {
  const json: DataObject = { row_number: position, row_id: row.id };
  for (const column of table.columns) json[column.name] = row[column.name] ?? null;
  // a column named row_number or row_id never replaces the row's own keys
  json.row_number = position;
  json.row_id = row.id;
  return json;
}

/** the rows of the table the node names, filtered when Filter Rows is on */
export async function tableDataset(
  ctx: ExecuteContext,
  buildFilter: (table: DataTableInfo) => DataTableFilter | undefined,
): Promise<DatasetRow[]> {
  const access = tableAccess(ctx);
  try {
    const table = await resolveTable(ctx, access, new Map(), 0);
    const filter = ctx.getNodeParameter('filterRows', 0, false) ? buildFilter(table) : undefined;
    const rows = await readTableRows(access, table.id, filter, rowLimit(ctx));
    return rows.map((row, n) => ({ key: row.id, json: tableRowJson(table, row, n + 1) }));
  } catch (error) {
    throw nodeError(ctx, error);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/** the rows of the sheet the node names, filtered by the lookup columns when Filter Rows is on */
export async function sheetDataset(ctx: ExecuteContext): Promise<DatasetRow[]> {
  const credential = googleCredential(ctx);
  const sheet = await resolveSheet(ctx, 0, new Map(), credential);
  const data = await readSheet(ctx, sheet, 0, {}, credential);
  let rows = data.rows
    .filter((row) => row.values.some((v) => v !== '' && v !== null && v !== undefined))
    .map((row): DatasetRow => {
      const json: DataObject = { row_number: row.rowNumber };
      data.headers.forEach((header, c) => {
        if (header) json[header] = row.values[c] ?? '';
      });
      json.row_number = row.rowNumber;
      return { key: row.rowNumber, json };
    });
  if (ctx.getNodeParameter('filterRows', 0, false)) {
    const filters = ((ctx.getNodeParameter('filtersUI', 0, {}) as DataObject).values ?? []) as Array<{
      lookupColumn?: string;
      lookupValue?: unknown;
    }>;
    const active = filters.filter((f) => f.lookupColumn);
    const missing = active.find((f) => !data.headers.includes(String(f.lookupColumn)));
    if (missing) {
      throw new NodeOperationError(ctx.getNode(), `Column "${missing.lookupColumn}" is not in the sheet`);
    }
    if (active.length) {
      const any = ctx.getNodeParameter('combineFilters', 0, 'AND') === 'OR';
      rows = rows.filter((row) => {
        const test = (f: (typeof active)[number]) =>
          sameValue(row.json[String(f.lookupColumn)], f.lookupValue);
        return any ? active.some(test) : active.every(test);
      });
    }
  }
  return rows.slice(0, rowLimit(ctx));
}

// ---------------------------------------------------------------------------------------------
// write back
// ---------------------------------------------------------------------------------------------

/** a value for a cell: objects are written as JSON text, a text column gets text */
export function toCell(value: unknown, type?: DataTableColumn['type']): DataTableCellValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (type === 'string' && typeof value !== 'string') return String(value);
  return value as DataTableCellValue;
}

/** the column type a new output column gets: the type of its value, text for anything else */
export function columnTypeFor(value: unknown): DataTableColumnInput['type'] {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Makes sure the table has a column for every output, adding the missing ones with the type of the value. When
 * a column cannot be added because another case added it first, the columns are listed again once.
 */
async function ensureColumns(
  access: DataTableAccess,
  table: DataTableInfo,
  outputs: DataObject,
): Promise<DataTableColumn[]> {
  let columns = await access.listColumns(table.id);
  for (const [name, value] of Object.entries(outputs)) {
    if ((DATA_TABLE_SYSTEM_COLUMNS as readonly string[]).includes(name)) {
      throw new Error(DATA_TABLE_ERRORS.columnNameReserved(name));
    }
    if (columns.some((c) => c.name === name)) continue;
    try {
      columns = [...columns, await access.addColumn(table.id, { name, type: columnTypeFor(value) })];
    } catch (error) {
      columns = await access.listColumns(table.id);
      if (!columns.some((c) => c.name === name)) throw error;
    }
  }
  return columns;
}

/** writes the outputs into the table row `rowId` */
export async function writeTableOutputs(
  ctx: ExecuteContext,
  outputs: DataObject,
  rowId: number,
): Promise<void> {
  const access = tableAccess(ctx);
  try {
    const table = await resolveTable(ctx, access, new Map(), 0);
    const columns = await ensureColumns(access, table, outputs);
    const data = Object.fromEntries(
      Object.entries(outputs).map(([name, value]) => [
        name,
        toCell(value, columns.find((c) => c.name === name)?.type),
      ]),
    );
    const changed = await access.updateRows(table.id, {
      filter: { type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: rowId }] },
      data,
    });
    if (!changed.length) {
      throw new NodeOperationError(
        ctx.getNode(),
        `The dataset row ${rowId} is not in the data table any more`,
      );
    }
  } catch (error) {
    throw nodeError(ctx, error);
  }
}

function sheetCell(value: unknown): unknown {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** writes the outputs into the sheet row `rowNumber`: new header columns first, then the cells, RAW */
export async function writeSheetOutputs(
  ctx: ExecuteContext,
  outputs: DataObject,
  rowNumber: number,
): Promise<void> {
  const credential = googleCredential(ctx);
  const sheet: SheetRef = await resolveSheet(ctx, 0, new Map(), credential);
  const header = await readSheet(ctx, sheet, 0, { range: '1:1' }, credential);
  let headers = header.headers;
  const added = Object.keys(outputs).filter((name) => !headers.includes(name));
  if (added.length) {
    headers = [...headers, ...added];
    await writeHeaders(ctx, sheet, headers, 1, 0, credential);
  }
  const data = Object.entries(outputs).map(([name, value]) => ({
    range: `${quoteSheet(sheet.title)}!${columnLetter(headers.indexOf(name) + 1)}${rowNumber}`,
    values: [[sheetCell(value)]],
  }));
  await sheetsRequest(
    ctx,
    'POST',
    `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values:batchUpdate`,
    { valueInputOption: 'RAW', data },
    undefined,
    0,
    credential,
  );
}
