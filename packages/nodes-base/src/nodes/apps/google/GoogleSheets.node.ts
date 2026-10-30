/**
 * Google Sheets: read, append, update and upsert rows by a key column, clear and delete, plus
 * spreadsheet create / list sheets. Rows of several items going to the same sheet are written
 * in one API call to stay inside the Sheets API quota.
 */
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpMethod,
  type Item,
  isResourceLocatorValue,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type ResourceLocatorValue,
} from '@workflow/workflow';
import { errorItem, withItemIndex } from '../../../utils/utilities';
import { compact, forOps, locator, operationProperty, resourceProperty } from '../shared';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const CREDENTIAL = 'googleSheetsOAuth2Api';
const DOC_URL_REGEX = 'https://docs\\.google\\.com/spreadsheets/d/([0-9a-zA-Z_-]+)';

type GoogleContext = Pick<BaseContext, 'helpers'>;

async function sheetsRequest<T = DataObject>(
  ctx: GoogleContext,
  method: HttpMethod,
  url: string,
  body?: DataObject,
  qs?: DataObject,
  itemIndex = 0,
): Promise<T> {
  return (await ctx.helpers.httpRequestWithAuthentication(
    CREDENTIAL,
    {
      method,
      url,
      body,
      bodyType: body ? 'json' : undefined,
      qs: qs ? compact(qs) : undefined,
      responseType: 'json',
    },
    itemIndex,
  )) as T;
}

/** A1 sheet reference: 'My Sheet' with quotes doubled. */
export function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** 1 -> A, 27 -> AA */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A -> 1, AA -> 27 */
export function columnIndex(letters: string): number {
  return letters
    .toUpperCase()
    .split('')
    .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
}

function cell(value: unknown): unknown {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

interface SheetRef {
  spreadsheetId: string;
  title: string;
  sheetId: number;
}

function documentIdFrom(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? (value as ResourceLocatorValue).value : String(value ?? '');
  const fromUrl = new RegExp(DOC_URL_REGEX).exec(raw);
  return (fromUrl?.[1] ?? raw).trim();
}

async function sheetList(ctx: GoogleContext, spreadsheetId: string, itemIndex = 0): Promise<SheetRef[]> {
  const response = await sheetsRequest(
    ctx,
    'GET',
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}`,
    undefined,
    {
      fields: 'sheets.properties',
    },
    itemIndex,
  );
  return ((response.sheets as Array<{ properties: DataObject }>) ?? []).map((s) => ({
    spreadsheetId,
    title: String(s.properties.title),
    sheetId: Number(s.properties.sheetId),
  }));
}

/** Resolve the sheet locator (list/id = gid, name = title, url = gid in the URL). */
async function resolveSheet(
  ctx: ExecuteContext,
  i: number,
  cache: Map<string, Promise<SheetRef[]>>,
): Promise<SheetRef> {
  const spreadsheetId = documentIdFrom(ctx.getNodeParameter('documentId', i));
  if (!spreadsheetId)
    throw new NodeOperationError(ctx.getNode(), 'Select a spreadsheet', {
      itemIndex: i,
      parameter: 'documentId',
    });
  const sheetParam = ctx.getNodeParameter('sheetName', i) as ResourceLocatorValue | string;
  const mode = isResourceLocatorValue(sheetParam) ? sheetParam.mode : 'name';
  let value = String(isResourceLocatorValue(sheetParam) ? sheetParam.value : sheetParam).trim();
  if (mode === 'url') value = /gid=(\d+)/.exec(value)?.[1] ?? '0';
  if (!value)
    throw new NodeOperationError(ctx.getNode(), 'Select a sheet', { itemIndex: i, parameter: 'sheetName' });
  if (!cache.has(spreadsheetId)) cache.set(spreadsheetId, sheetList(ctx, spreadsheetId, i));
  const sheets = await cache.get(spreadsheetId)!;
  const sheet =
    mode === 'name' ? sheets.find((s) => s.title === value) : sheets.find((s) => String(s.sheetId) === value);
  if (!sheet) {
    throw new NodeOperationError(ctx.getNode(), `Sheet "${value}" was not found in the spreadsheet`, {
      itemIndex: i,
      description: `Available sheets: ${sheets.map((s) => s.title).join(', ')}`,
    });
  }
  return sheet;
}

interface SheetData {
  headers: string[];
  /** data rows with their 1-based sheet row numbers */
  rows: Array<{ rowNumber: number; values: unknown[] }>;
}

async function readSheet(
  ctx: ExecuteContext,
  sheet: SheetRef,
  i: number,
  options: DataObject = {},
): Promise<SheetData> {
  const headerRow = Math.max(1, Number(options.headerRow ?? 1));
  const firstDataRow = Math.max(headerRow + 1, Number(options.firstDataRow ?? headerRow + 1));
  const range = options.range
    ? `${quoteSheet(sheet.title)}!${String(options.range)}`
    : quoteSheet(sheet.title);
  const response = await sheetsRequest(
    ctx,
    'GET',
    `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}`,
    undefined,
    {
      valueRenderOption: options.valueRenderMode ?? 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    },
    i,
  );
  const values = (response.values as unknown[][]) ?? [];
  // with a custom range, rows are relative to the range start
  const startRow = Number(/^[A-Za-z]*(\d+)/.exec(String(options.range ?? ''))?.[1] ?? 1);
  const headers = (values[headerRow - startRow] ?? []).map((h) => String(h ?? '').trim());
  const rows: SheetData['rows'] = [];
  values.forEach((row, n) => {
    const rowNumber = n + startRow;
    if (rowNumber >= firstDataRow) rows.push({ rowNumber, values: row });
  });
  return { headers, rows };
}

function rowToJson(headers: string[], row: { rowNumber: number; values: unknown[] }): DataObject {
  const json: DataObject = { row_number: row.rowNumber };
  headers.forEach((h, c) => {
    if (h) json[h] = row.values[c] ?? '';
  });
  return json;
}

function sameValue(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/** Columns and values to write for one item. */
function rowValues(ctx: ExecuteContext, i: number, item: Item): DataObject {
  if (ctx.getNodeParameter('dataMode', i, 'autoMapInputData') === 'defineBelow') {
    const fields = ((ctx.getNodeParameter('fieldsUi', i, {}) as DataObject).values ?? []) as Array<{
      column: string;
      fieldValue: unknown;
    }>;
    return Object.fromEntries(fields.filter((f) => f.column).map((f) => [f.column, f.fieldValue]));
  }
  const { row_number: _ignored, ...json } = item.json;
  return json;
}

/** Headers after adding new columns for unknown fields (when allowed). */
function extendHeaders(
  ctx: ExecuteContext,
  i: number,
  headers: string[],
  data: DataObject,
): { headers: string[]; added: string[] } {
  const extra = Object.keys(data).filter((k) => !headers.includes(k));
  if (!extra.length) return { headers, added: [] };
  const handling = ctx.getNodeParameter('options.handlingExtraData', i, 'insertInNewColumn') as string;
  if (handling === 'error') {
    throw new NodeOperationError(ctx.getNode(), `Columns not in the sheet: ${extra.join(', ')}`, {
      itemIndex: i,
    });
  }
  if (handling === 'ignoreIt') return { headers, added: [] };
  return { headers: [...headers, ...extra], added: extra };
}

async function writeHeaders(
  ctx: ExecuteContext,
  sheet: SheetRef,
  headers: string[],
  headerRow: number,
  i: number,
) {
  const range = `${quoteSheet(sheet.title)}!A${headerRow}:${columnLetter(headers.length)}${headerRow}`;
  await sheetsRequest(
    ctx,
    'PUT',
    `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}`,
    {
      range,
      majorDimension: 'ROWS',
      values: [headers],
    },
    { valueInputOption: 'RAW' },
    i,
  );
}

interface Group {
  sheet: SheetRef;
  entries: Array<{ index: number; item: Item; data: DataObject; key?: unknown }>;
}

/** Append / update / appendOrUpdate: one read and at most one write per call per sheet. */
async function writeRows(ctx: ExecuteContext, operation: string): Promise<Item[]> {
  const items = ctx.getInputData();
  const cache = new Map<string, Promise<SheetRef[]>>();
  const groups = new Map<string, Group>();
  const out: Array<Item | undefined> = new Array(items.length);
  const fail = (error: unknown, index: number) => {
    if (!ctx.continueOnFail()) throw withItemIndex(ctx, error, index);
    out[index] = errorItem(error, index);
  };

  for (let i = 0; i < items.length; i++) {
    try {
      const sheet = await resolveSheet(ctx, i, cache);
      const key = `${sheet.spreadsheetId}|${sheet.sheetId}`;
      const group = groups.get(key) ?? { sheet, entries: [] };
      const data = rowValues(ctx, i, items[i]);
      const entry: Group['entries'][number] = { index: i, item: items[i], data };
      if (operation !== 'append') {
        const column = String(ctx.getNodeParameter('columnToMatchOn', i, '') ?? '');
        if (!column)
          throw new NodeOperationError(ctx.getNode(), 'Select the column to match on', { itemIndex: i });
        entry.key = data[column];
        if (entry.key === undefined || entry.key === '') {
          throw new NodeOperationError(
            ctx.getNode(),
            `The item has no value for the match column "${column}"`,
            { itemIndex: i },
          );
        }
      }
      group.entries.push(entry);
      groups.set(key, group);
    } catch (error) {
      fail(error, i);
    }
  }

  for (const group of groups.values()) {
    const first = group.entries[0].index;
    try {
      const options = ctx.getNodeParameter('options', first, {}) as DataObject;
      const headerRow = Math.max(1, Number(options.headerRow ?? 1));
      const sheetData = await readSheet(ctx, group.sheet, first, { headerRow });
      let headers = sheetData.headers;
      const initialHeaderCount = headers.length;
      for (const entry of group.entries)
        headers = extendHeaders(ctx, entry.index, headers, entry.data).headers;
      if (headers.length !== initialHeaderCount || !initialHeaderCount)
        await writeHeaders(ctx, group.sheet, headers, headerRow, first);

      const toAppend: Group['entries'] = [];
      const updates: Array<{ range: string; values: unknown[][] }> = [];
      const column = operation === 'append' ? '' : String(ctx.getNodeParameter('columnToMatchOn', first, ''));
      const keyIndex = headers.indexOf(column);
      if (operation !== 'append' && keyIndex < 0) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Column "${column}" is not in the header row of the sheet`,
          { itemIndex: first },
        );
      }
      for (const entry of group.entries) {
        if (operation === 'append') {
          toAppend.push(entry);
          continue;
        }
        const matches = sheetData.rows.filter((row) => sameValue(row.values[keyIndex], entry.key));
        if (!matches.length) {
          if (operation === 'appendOrUpdate') toAppend.push(entry);
          else out[entry.index] = { json: { ...entry.data }, pairedItem: { item: entry.index } };
          continue;
        }
        for (const row of matches) {
          // only the provided columns change; others keep their current values
          const values = headers.map((h, c) =>
            h in entry.data ? cell(entry.data[h]) : (row.values[c] ?? null),
          );
          const range = `${quoteSheet(group.sheet.title)}!A${row.rowNumber}:${columnLetter(headers.length)}${row.rowNumber}`;
          updates.push({ range, values: [values] });
        }
        out[entry.index] = {
          json: { ...entry.data, row_number: matches[0].rowNumber },
          pairedItem: { item: entry.index },
        };
      }
      if (updates.length) {
        await sheetsRequest(
          ctx,
          'POST',
          `${SHEETS}/${encodeURIComponent(group.sheet.spreadsheetId)}/values:batchUpdate`,
          {
            valueInputOption: options.cellFormat === 'RAW' ? 'RAW' : 'USER_ENTERED',
            data: updates,
          },
          undefined,
          first,
        );
      }
      if (toAppend.length) {
        const range = `${quoteSheet(group.sheet.title)}!A${headerRow}`;
        const response = await sheetsRequest(
          ctx,
          'POST',
          `${SHEETS}/${encodeURIComponent(group.sheet.spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
          { range, majorDimension: 'ROWS', values: toAppend.map((e) => headers.map((h) => cell(e.data[h]))) },
          {
            valueInputOption: options.cellFormat === 'RAW' ? 'RAW' : 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
          },
          first,
        );
        const updatedRange = String((response.updates as DataObject | undefined)?.updatedRange ?? '');
        const startRow = Number(/![A-Z]+(\d+)/.exec(updatedRange)?.[1] ?? 0);
        toAppend.forEach((entry, n) => {
          out[entry.index] = {
            json: { ...entry.data, ...(startRow ? { row_number: startRow + n } : {}) },
            pairedItem: { item: entry.index },
          };
        });
      }
    } catch (error) {
      if (!ctx.continueOnFail()) throw withItemIndex(ctx, error, first);
      for (const entry of group.entries) out[entry.index] = errorItem(error, entry.index);
    }
  }
  return out.filter((item): item is Item => !!item);
}

async function perItem(
  ctx: ExecuteContext,
  fn: (i: number, cache: Map<string, Promise<SheetRef[]>>) => Promise<DataObject[] | DataObject>,
): Promise<Item[]> {
  const items = ctx.getInputData();
  const cache = new Map<string, Promise<SheetRef[]>>();
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(i, cache);
      for (const json of Array.isArray(result) ? result : [result])
        out.push({ json, pairedItem: { item: i } });
    } catch (error) {
      if (!ctx.continueOnFail()) throw withItemIndex(ctx, error, i);
      out.push(errorItem(error, i));
    }
  }
  return out;
}

const sheetOperations: Record<
  string,
  (
    ctx: ExecuteContext,
    i: number,
    cache: Map<string, Promise<SheetRef[]>>,
  ) => Promise<DataObject[] | DataObject>
> = {
  async read(ctx, i, cache) {
    const sheet = await resolveSheet(ctx, i, cache);
    const options = ctx.getNodeParameter('options', i, {}) as DataObject;
    const data = await readSheet(ctx, sheet, i, {
      headerRow: options.headerRow,
      firstDataRow: options.firstDataRow,
      range: options.range,
      valueRenderMode: options.valueRenderMode,
    });
    let rows = data.rows
      .filter((r) => r.values.some((v) => v !== '' && v !== null && v !== undefined))
      .map((r) => rowToJson(data.headers, r));
    const filters = ((ctx.getNodeParameter('filtersUI', i, {}) as DataObject).values ?? []) as Array<{
      lookupColumn: string;
      lookupValue: unknown;
    }>;
    const active = filters.filter((f) => f.lookupColumn);
    if (active.length) {
      const any = ctx.getNodeParameter('combineFilters', i, 'AND') === 'OR';
      for (const f of active) {
        if (!data.headers.includes(f.lookupColumn)) {
          throw new NodeOperationError(ctx.getNode(), `Column "${f.lookupColumn}" is not in the sheet`, {
            itemIndex: i,
          });
        }
      }
      rows = rows.filter((row) => {
        const test = (f: (typeof active)[number]) => sameValue(row[f.lookupColumn], f.lookupValue);
        return any ? active.some(test) : active.every(test);
      });
    }
    if (options.returnFirstMatch) rows = rows.slice(0, 1);
    return rows;
  },
  async clear(ctx, i, cache) {
    const sheet = await resolveSheet(ctx, i, cache);
    const clear = ctx.getNodeParameter('clear', i, 'wholeSheet') as string;
    let range = quoteSheet(sheet.title);
    if (clear === 'specificRange') range = `${range}!${String(ctx.getNodeParameter('range', i, 'A1:Z1000'))}`;
    else if (ctx.getNodeParameter('keepFirstRow', i, false)) range = `${range}!A2:ZZZ`;
    const response = await sheetsRequest(
      ctx,
      'POST',
      `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
      {},
      undefined,
      i,
    );
    return { spreadsheetId: sheet.spreadsheetId, clearedRange: response.clearedRange };
  },
  async delete(ctx, i, cache) {
    const sheet = await resolveSheet(ctx, i, cache);
    const toDelete = ctx.getNodeParameter('toDelete', i, 'rows') as string;
    const count = Math.max(1, Math.floor(Number(ctx.getNodeParameter('numberToDelete', i, 1))));
    let start: number;
    if (toDelete === 'columns') {
      const letters = String(ctx.getNodeParameter('startColumn', i, 'A')).trim();
      if (!/^[A-Za-z]{1,3}$/.test(letters))
        throw new NodeOperationError(ctx.getNode(), `"${letters}" is not a column letter`, { itemIndex: i });
      start = columnIndex(letters) - 1;
    } else {
      const row = Math.floor(Number(ctx.getNodeParameter('startIndex', i, 2)));
      if (!Number.isFinite(row) || row < 1)
        throw new NodeOperationError(ctx.getNode(), 'Start row must be 1 or more', { itemIndex: i });
      start = row - 1;
    }
    await sheetsRequest(
      ctx,
      'POST',
      `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}:batchUpdate`,
      {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheet.sheetId,
                dimension: toDelete === 'columns' ? 'COLUMNS' : 'ROWS',
                startIndex: start,
                endIndex: start + count,
              },
            },
          },
        ],
      },
      undefined,
      i,
    );
    return { success: true, deleted: toDelete, startIndex: start, count };
  },
};

const spreadsheetOperations: typeof sheetOperations = {
  async create(ctx, i) {
    const title = String(ctx.getNodeParameter('title', i, '') ?? '').trim();
    if (!title) throw new NodeOperationError(ctx.getNode(), 'Enter a title', { itemIndex: i });
    const sheets = ((ctx.getNodeParameter('sheetsUi', i, {}) as DataObject).sheetValues ?? []) as Array<{
      title: string;
    }>;
    const options = ctx.getNodeParameter('options', i, {}) as DataObject;
    return sheetsRequest(
      ctx,
      'POST',
      SHEETS,
      {
        properties: compact({ title, locale: options.locale }),
        ...(sheets.length
          ? { sheets: sheets.filter((s) => s.title).map((s) => ({ properties: { title: s.title } })) }
          : {}),
      },
      undefined,
      i,
    );
  },
  async listSheets(ctx, i) {
    const spreadsheetId = documentIdFrom(ctx.getNodeParameter('documentId', i));
    if (!spreadsheetId) throw new NodeOperationError(ctx.getNode(), 'Select a spreadsheet', { itemIndex: i });
    const response = await sheetsRequest(
      ctx,
      'GET',
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}`,
      undefined,
      {
        fields: 'sheets.properties',
      },
      i,
    );
    return ((response.sheets as Array<{ properties: DataObject }>) ?? []).map((s) => s.properties);
  },
};

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const documentLocator = locator('documentId', 'Document', {
  searchListMethod: 'searchSpreadsheets',
  urlRegex: DOC_URL_REGEX,
  urlPlaceholder: 'https://docs.google.com/spreadsheets/d/1abc.../edit',
  idPlaceholder: '1qpyC0XzvTcKT6EISywY8qYcvF9ZpOT6hEbW3sxK3s_8',
});

const sheetLocator: NodeProperty = {
  displayName: 'Sheet',
  name: 'sheetName',
  type: 'resourceLocator',
  default: { __rl: true, mode: 'list', value: '' },
  required: true,
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      placeholder: 'Select a sheet...',
      typeOptions: { searchListMethod: 'searchSheets', searchable: true },
    },
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
};

const writeOps = ['append', 'update', 'appendOrUpdate'];

const properties: NodeProperty[] = [
  resourceProperty(
    [
      { name: 'Sheet Within Document', value: 'sheet' },
      { name: 'Document', value: 'spreadsheet' },
    ],
    'sheet',
  ),
  operationProperty(
    'sheet',
    [
      { name: 'Get Row(s)', value: 'read', action: 'Get row(s) in sheet' },
      { name: 'Append Row', value: 'append', action: 'Append row in sheet' },
      { name: 'Update Row', value: 'update', action: 'Update row in sheet' },
      { name: 'Append or Update Row', value: 'appendOrUpdate', action: 'Append or update row in sheet' },
      { name: 'Clear', value: 'clear', action: 'Clear sheet' },
      { name: 'Delete Rows or Columns', value: 'delete', action: 'Delete rows or columns from sheet' },
    ],
    'read',
  ),
  operationProperty(
    'spreadsheet',
    [
      { name: 'Create', value: 'create', action: 'Create spreadsheet' },
      { name: 'Get Sheets', value: 'listSheets', action: 'Get the sheets of a spreadsheet' },
    ],
    'create',
  ),
  forOps(documentLocator, 'sheet', ['read', ...writeOps, 'clear', 'delete']),
  forOps(documentLocator, 'spreadsheet', 'listSheets'),
  forOps(sheetLocator, 'sheet', ['read', ...writeOps, 'clear', 'delete']),
  // read
  forOps(
    {
      displayName: 'Filters',
      name: 'filtersUI',
      type: 'fixedCollection',
      default: { values: [] },
      placeholder: 'Add filter',
      typeOptions: { multipleValues: true },
      options: [
        {
          displayName: 'Filter',
          name: 'values',
          values: [
            {
              displayName: 'Column',
              name: 'lookupColumn',
              type: 'options',
              default: '',
              typeOptions: {
                loadOptionsMethod: 'getSheetColumns',
                loadOptionsDependsOn: ['sheetName.value'],
              },
            },
            { displayName: 'Value', name: 'lookupValue', type: 'string', default: '' },
          ],
        },
      ],
    },
    'sheet',
    'read',
  ),
  forOps(
    {
      displayName: 'Combine Filters',
      name: 'combineFilters',
      type: 'options',
      default: 'AND',
      options: [
        { name: 'AND', value: 'AND', description: 'Rows matching every filter' },
        { name: 'OR', value: 'OR', description: 'Rows matching any filter' },
      ],
    },
    'sheet',
    'read',
  ),
  // write
  forOps(
    {
      displayName: 'Mapping Column Mode',
      name: 'dataMode',
      type: 'options',
      default: 'autoMapInputData',
      options: [
        {
          name: 'Map Each Column Automatically',
          value: 'autoMapInputData',
          description: 'Item fields with the same name as a column header',
        },
        { name: 'Map Each Column Manually', value: 'defineBelow' },
      ],
    },
    'sheet',
    writeOps,
  ),
  forOps(
    {
      displayName: 'Column to Match On',
      name: 'columnToMatchOn',
      type: 'options',
      default: '',
      required: true,
      typeOptions: { loadOptionsMethod: 'getSheetColumns', loadOptionsDependsOn: ['sheetName.value'] },
      description: 'Rows whose value in this column equals the item value are updated',
    },
    'sheet',
    ['update', 'appendOrUpdate'],
  ),
  {
    displayName: 'Values to Send',
    name: 'fieldsUi',
    type: 'fixedCollection',
    default: { values: [] },
    placeholder: 'Add field',
    typeOptions: { multipleValues: true },
    displayOptions: { show: { resource: ['sheet'], operation: writeOps, dataMode: ['defineBelow'] } },
    options: [
      {
        displayName: 'Field',
        name: 'values',
        values: [
          {
            displayName: 'Column',
            name: 'column',
            type: 'options',
            default: '',
            typeOptions: { loadOptionsMethod: 'getSheetColumns', loadOptionsDependsOn: ['sheetName.value'] },
          },
          { displayName: 'Value', name: 'fieldValue', type: 'string', default: '' },
        ],
      },
    ],
  },
  // clear
  forOps(
    {
      displayName: 'Clear',
      name: 'clear',
      type: 'options',
      default: 'wholeSheet',
      options: [
        { name: 'Whole Sheet', value: 'wholeSheet' },
        { name: 'Specific Range', value: 'specificRange' },
      ],
    },
    'sheet',
    'clear',
  ),
  {
    displayName: 'Keep First Row',
    name: 'keepFirstRow',
    type: 'boolean',
    default: false,
    displayOptions: { show: { resource: ['sheet'], operation: ['clear'], clear: ['wholeSheet'] } },
  },
  {
    displayName: 'Range',
    name: 'range',
    type: 'string',
    default: 'A1:F2',
    placeholder: 'A1:F2',
    displayOptions: { show: { resource: ['sheet'], operation: ['clear'], clear: ['specificRange'] } },
  },
  // delete
  forOps(
    {
      displayName: 'To Delete',
      name: 'toDelete',
      type: 'options',
      default: 'rows',
      options: [
        { name: 'Rows', value: 'rows' },
        { name: 'Columns', value: 'columns' },
      ],
    },
    'sheet',
    'delete',
  ),
  {
    displayName: 'Start Row Number',
    name: 'startIndex',
    type: 'number',
    default: 2,
    typeOptions: { minValue: 1 },
    displayOptions: { show: { resource: ['sheet'], operation: ['delete'], toDelete: ['rows'] } },
  },
  {
    displayName: 'Start Column',
    name: 'startColumn',
    type: 'string',
    default: 'A',
    displayOptions: { show: { resource: ['sheet'], operation: ['delete'], toDelete: ['columns'] } },
  },
  forOps(
    {
      displayName: 'Number to Delete',
      name: 'numberToDelete',
      type: 'number',
      default: 1,
      typeOptions: { minValue: 1 },
    },
    'sheet',
    'delete',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Header Row',
          name: 'headerRow',
          type: 'number',
          default: 1,
          typeOptions: { minValue: 1 },
        },
        {
          displayName: 'First Data Row',
          name: 'firstDataRow',
          type: 'number',
          default: 2,
          typeOptions: { minValue: 2 },
        },
        {
          displayName: 'Range',
          name: 'range',
          type: 'string',
          default: '',
          placeholder: 'A1:Z500',
          description: 'Only read this range',
        },
        { displayName: 'Return Only First Match', name: 'returnFirstMatch', type: 'boolean', default: false },
        {
          displayName: 'Output Formatting',
          name: 'valueRenderMode',
          type: 'options',
          default: 'UNFORMATTED_VALUE',
          options: [
            { name: 'Values (Unformatted)', value: 'UNFORMATTED_VALUE' },
            { name: 'Values (Formatted)', value: 'FORMATTED_VALUE' },
            { name: 'Formulas', value: 'FORMULA' },
          ],
        },
      ],
    },
    'sheet',
    'read',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Header Row',
          name: 'headerRow',
          type: 'number',
          default: 1,
          typeOptions: { minValue: 1 },
        },
        {
          displayName: 'Cell Format',
          name: 'cellFormat',
          type: 'options',
          default: 'USER_ENTERED',
          options: [
            { name: 'Let Google Sheets Format', value: 'USER_ENTERED' },
            { name: 'Use Format From the Workflow (Raw)', value: 'RAW' },
          ],
        },
        {
          displayName: 'Fields Not in the Sheet',
          name: 'handlingExtraData',
          type: 'options',
          default: 'insertInNewColumn',
          options: [
            { name: 'Insert in New Column(s)', value: 'insertInNewColumn' },
            { name: 'Ignore Them', value: 'ignoreIt' },
            { name: 'Error', value: 'error' },
          ],
        },
      ],
    },
    'sheet',
    writeOps,
  ),
  // spreadsheet
  forOps(
    { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
    'spreadsheet',
    'create',
  ),
  forOps(
    {
      displayName: 'Sheets',
      name: 'sheetsUi',
      type: 'fixedCollection',
      default: { sheetValues: [] },
      placeholder: 'Add sheet',
      typeOptions: { multipleValues: true },
      options: [
        {
          displayName: 'Sheet',
          name: 'sheetValues',
          values: [{ displayName: 'Title', name: 'title', type: 'string', default: '' }],
        },
      ],
    },
    'spreadsheet',
    'create',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [{ displayName: 'Locale', name: 'locale', type: 'string', default: '', placeholder: 'en_US' }],
    },
    'spreadsheet',
    'create',
  ),
];

function currentDocumentId(ctx: LoadOptionsContext): string {
  return documentIdFrom(ctx.getCurrentNodeParameter('documentId'));
}

export const GoogleSheetsNode: NodeType = {
  description: {
    name: 'app.googleSheets',
    displayName: 'Google Sheets',
    description: 'Read, append and update rows in Google Sheets',
    icon: 'simple:googlesheets',
    iconColor: '#34a853',
    group: ['input', 'output'],
    version: 1,
    defaults: { name: 'Google Sheets' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Productivity'],
    alias: ['spreadsheet', 'sheet', 'google', 'csv', 'table', 'rows', 'excel'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [{ name: 'googleSheetsOAuth2Api', required: true }],
    properties,
  },

  async execute(ctx) {
    const resource = ctx.getNodeParameter('resource', 0) as string;
    const operation = ctx.getNodeParameter('operation', 0) as string;
    if (resource === 'sheet' && writeOps.includes(operation)) return [await writeRows(ctx, operation)];
    const handler = (resource === 'sheet' ? sheetOperations : spreadsheetOperations)[operation];
    if (!handler)
      throw new NodeOperationError(ctx.getNode(), `Unsupported operation "${operation}" for "${resource}"`);
    return [await perItem(ctx, (i, cache) => handler(ctx, i, cache))];
  },

  methods: {
    listSearch: {
      async searchSpreadsheets(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const term = (filter ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const q = [
          "mimeType='application/vnd.google-apps.spreadsheet'",
          'trashed=false',
          ...(term ? [`name contains '${term}'`] : []),
        ];
        const response = await sheetsRequest(ctx, 'GET', DRIVE, undefined, {
          q: q.join(' and '),
          fields: 'nextPageToken,files(id,name,webViewLink)',
          orderBy: 'modifiedByMeTime desc,name',
          pageSize: 100,
          pageToken: paginationToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        return {
          results: ((response.files as DataObject[]) ?? []).map((f) => ({
            name: String(f.name),
            value: String(f.id),
            url: f.webViewLink as string | undefined,
          })),
          paginationToken: response.nextPageToken as string | undefined,
        };
      },
      async searchSheets(ctx, filter): Promise<ListSearchResult> {
        const spreadsheetId = currentDocumentId(ctx);
        if (!spreadsheetId) return { results: [] };
        const sheets = await sheetList(ctx, spreadsheetId);
        const term = (filter ?? '').toLowerCase();
        return {
          results: sheets
            .filter((s) => !term || s.title.toLowerCase().includes(term))
            .map((s) => ({
              name: s.title,
              value: String(s.sheetId),
              url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${s.sheetId}`,
            })),
        };
      },
    },
    loadOptions: {
      async getSheetColumns(ctx) {
        const spreadsheetId = currentDocumentId(ctx);
        const sheetParam = ctx.getCurrentNodeParameter('sheetName') as ResourceLocatorValue | undefined;
        if (!spreadsheetId || !sheetParam?.value) return [];
        const sheets = await sheetList(ctx, spreadsheetId);
        const sheet =
          sheetParam.mode === 'name'
            ? sheets.find((s) => s.title === sheetParam.value)
            : sheets.find((s) => String(s.sheetId) === String(sheetParam.value));
        if (!sheet) return [];
        const range = `${quoteSheet(sheet.title)}!1:1`;
        const response = await sheetsRequest(
          ctx,
          'GET',
          `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        );
        const headers = ((response.values as unknown[][]) ?? [])[0] ?? [];
        return headers
          .filter((h) => String(h ?? '').trim())
          .map((h) => ({ name: String(h), value: String(h) }));
      },
    },
  },
};
