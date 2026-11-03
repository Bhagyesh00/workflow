/** Convert to File and Extract from File: CSV (papaparse), HTML tables, JSON, text and base64. */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { load } from 'cheerio';
import Papa from 'papaparse';
import { errorItem, getField, ItemList, mapItems, safeKey, setField } from '../../utils/utilities';
import { keepSourceMode, keepSourceOption, keptSource } from './extract/keep-source';
import { extractPdf, pdfOptionFields } from './extract/pdf';
import {
  extractSpreadsheet,
  type SpreadsheetOperation,
  spreadsheetOptionFields,
} from './extract/spreadsheet';
import { itemsToHtmlTable } from './markup.nodes';

const SPREADSHEET_OPERATIONS: string[] = ['xlsx', 'xls', 'ods'];

const ENCODINGS = ['utf8', 'utf16le', 'latin1', 'ascii'] as const;
type Encoding = (typeof ENCODINGS)[number];

const encodingOption = {
  displayName: 'Encoding',
  name: 'encoding',
  type: 'options' as const,
  default: 'utf8',
  options: [
    { name: 'UTF-8', value: 'utf8' },
    { name: 'UTF-16 LE', value: 'utf16le' },
    { name: 'Latin-1 (ISO-8859-1)', value: 'latin1' },
    { name: 'ASCII', value: 'ascii' },
  ],
};

function encodingOf(value: unknown): Encoding {
  return ENCODINGS.includes(value as Encoding) ? (value as Encoding) : 'utf8';
}

function cellValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}

function allPaired(items: Item[]) {
  return items.map((_, i) => ({ item: i }));
}

// ---------------------------------------------------------------------------------------------
// Convert to File
// ---------------------------------------------------------------------------------------------

export const ConvertToFileNode: NodeType = {
  description: {
    name: 'core.convertToFile',
    displayName: 'Convert to File',
    description: 'Turn items into a CSV, HTML, JSON, text or binary file',
    icon: 'lucide:file-output',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Convert to File' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['csv', 'export', 'download', 'file', 'base64', 'spreadsheet', 'json file', 'text file'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'csv',
        noDataExpression: true,
        options: [
          { name: 'Convert to CSV', value: 'csv', action: 'Convert to CSV' },
          { name: 'Convert to HTML', value: 'html', action: 'Convert to an HTML table' },
          { name: 'Convert to JSON', value: 'toJson', action: 'Convert to JSON' },
          { name: 'Convert to Text File', value: 'toText', action: 'Convert a text field to a file' },
          { name: 'Move Base64 String to File', value: 'toBinary', action: 'Move a base64 string to a file' },
        ],
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'once',
        displayOptions: { show: { operation: ['toJson'] } },
        options: [
          { name: 'All Items to One File', value: 'once' },
          { name: 'Each Item to a Separate File', value: 'each' },
        ],
      },
      {
        displayName: 'Text Input Field',
        name: 'sourceProperty',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: { show: { operation: ['toText'] } },
      },
      {
        displayName: 'Base64 Input Field',
        name: 'sourceProperty',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: { show: { operation: ['toBinary'] } },
      },
      {
        displayName: 'Put Output File in Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        description: 'Binary property that receives the file',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'File Name',
            name: 'fileName',
            type: 'string',
            default: '',
            placeholder: 'export.csv',
          },
          {
            displayName: 'Delimiter',
            name: 'delimiter',
            type: 'string',
            default: ',',
            displayOptions: { show: { '/operation': ['csv'] } },
          },
          {
            displayName: 'Header Row',
            name: 'headerRow',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/operation': ['csv'] } },
          },
          {
            displayName: 'Format',
            name: 'format',
            type: 'boolean',
            default: false,
            description: 'Whether to pretty-print the JSON',
            displayOptions: { show: { '/operation': ['toJson'] } },
          },
          {
            displayName: 'Add Byte Order Mark (BOM)',
            name: 'addBOM',
            type: 'boolean',
            default: false,
            description: 'Helps Excel detect UTF-8 CSV and text files',
            displayOptions: { show: { '/operation': ['csv', 'toText'] } },
          },
          {
            ...encodingOption,
            displayOptions: { show: { '/operation': ['toText', 'toJson'] } },
          },
          {
            displayName: 'MIME Type',
            name: 'mimeType',
            type: 'string',
            default: '',
            placeholder: 'image/png',
            displayOptions: { show: { '/operation': ['toBinary'] } },
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const operation = ctx.getNodeParameter('operation', 0) as string;
    const property = String(ctx.getNodeParameter('binaryPropertyName', 0, 'data') || 'data');
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const bom = options.addBOM ? '﻿' : '';

    const single = async (data: Uint8Array, fileName: string, mimeType: string): Promise<Item[][]> => [
      [
        {
          json: {},
          binary: { [property]: await ctx.helpers.prepareBinaryData(data, fileName, mimeType) },
          pairedItem: allPaired(items),
        },
      ],
    ];

    if (operation === 'csv') {
      const rows = items.map((item) =>
        Object.fromEntries(Object.entries(item.json).map(([k, v]) => [k, cellValue(v)])),
      );
      const fields: string[] = [];
      for (const row of rows) for (const key of Object.keys(row)) if (!fields.includes(key)) fields.push(key);
      const csv = Papa.unparse(
        { fields, data: rows.map((row) => fields.map((f) => row[f] ?? '')) },
        {
          delimiter: String(options.delimiter || ','),
          header: options.headerRow !== false,
          escapeFormulae: true,
        },
      );
      return single(Buffer.from(bom + csv, 'utf8'), String(options.fileName || 'data.csv'), 'text/csv');
    }
    if (operation === 'html') {
      const html = itemsToHtmlTable(items.map((i) => i.json));
      return single(Buffer.from(html, 'utf8'), String(options.fileName || 'data.html'), 'text/html');
    }
    if (operation === 'toJson' && ctx.getNodeParameter('mode', 0, 'once') === 'once') {
      const text = JSON.stringify(
        items.map((i) => i.json),
        null,
        options.format ? 2 : undefined,
      );
      return single(
        Buffer.from(text, encodingOf(options.encoding)),
        String(options.fileName || 'data.json'),
        'application/json',
      );
    }

    return [
      await mapItems(ctx, async (i, item) => {
        const opts = ctx.getNodeParameter('options', i, {}) as DataObject;
        const prop = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data');
        let data: Uint8Array;
        let fileName: string;
        let mimeType: string;
        if (operation === 'toJson') {
          data = Buffer.from(
            JSON.stringify(item.json, null, opts.format ? 2 : undefined),
            encodingOf(opts.encoding),
          );
          fileName = String(opts.fileName || 'data.json');
          mimeType = 'application/json';
        } else {
          const field = ctx.getNodeParameter('sourceProperty', i, 'data') as string;
          const value = getField(item.json, field);
          if (value === undefined) {
            throw new NodeOperationError(ctx.getNode(), `Item has no field "${field}"`, {
              itemIndex: i,
              parameter: 'sourceProperty',
            });
          }
          if (operation === 'toText') {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            data = Buffer.from((opts.addBOM ? '﻿' : '') + text, encodingOf(opts.encoding));
            fileName = String(opts.fileName || 'file.txt');
            mimeType = 'text/plain';
          } else if (operation === 'toBinary') {
            const text = String(value).replace(/^data:[^;,]*;base64,/, '');
            if (!/^[A-Za-z0-9+/_\-\s]*={0,2}$/.test(text)) {
              throw new NodeOperationError(ctx.getNode(), `Field "${field}" does not contain base64 data`, {
                itemIndex: i,
              });
            }
            data = Buffer.from(text, 'base64');
            fileName = String(opts.fileName || 'file');
            mimeType = String(
              opts.mimeType || /^data:([^;,]*)/.exec(String(value))?.[1] || 'application/octet-stream',
            );
          } else {
            throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
          }
        }
        const json = operation === 'toJson' ? {} : deepCopy(item.json);
        return new ItemList([
          {
            json,
            binary: {
              ...(item.binary ?? {}),
              [prop]: await ctx.helpers.prepareBinaryData(data, fileName, mimeType),
            },
          },
        ]);
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// Extract from File
// ---------------------------------------------------------------------------------------------

/** Read the first table (or the table matching `selector`) of an HTML document into row objects. */
export function htmlTableToRows(html: string, selector = 'table'): DataObject[] {
  const $ = load(html);
  const table = $(selector).first();
  if (!table.length) return [];
  const rows = table.find('tr').toArray();
  if (!rows.length) return [];
  const cells = (row: (typeof rows)[number]) =>
    $(row)
      .children('th, td')
      .toArray()
      .map((c) => $(c).text().replace(/\s+/g, ' ').trim());
  let headers = $(rows[0]).children('th').length ? cells(rows[0]) : [];
  let body = rows;
  if (headers.length) body = rows.slice(1);
  else {
    headers = cells(rows[0]).map((_, i) => `column_${i + 1}`);
  }
  return body.map((row) => {
    const values = cells(row);
    const out: DataObject = {};
    headers.forEach((h, i) => {
      out[safeKey(h || `column_${i + 1}`)] = values[i] ?? '';
    });
    return out;
  });
}

async function readText(
  ctx: ExecuteContext,
  i: number,
  property: string,
  encoding: Encoding,
): Promise<string> {
  const buffer = Buffer.from(await ctx.helpers.getBinaryDataBuffer(i, property));
  return buffer.toString(encoding).replace(/^﻿/, '');
}

export const ExtractFromFileNode: NodeType = {
  description: {
    name: 'core.extractFromFile',
    displayName: 'Extract from File',
    description: 'Read CSV, spreadsheets, PDF, HTML tables, JSON, text or base64 out of binary files',
    icon: 'lucide:file-input',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Extract from File' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: [
      'csv',
      'import',
      'parse',
      'file',
      'base64',
      'read file',
      'spreadsheet',
      'html table',
      'excel',
      'xlsx',
      'pdf',
    ],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'csv',
        noDataExpression: true,
        options: [
          { name: 'Extract From CSV', value: 'csv', action: 'Extract rows from a CSV file' },
          { name: 'Extract From HTML Table', value: 'html', action: 'Extract rows from an HTML table' },
          { name: 'Extract From JSON', value: 'fromJson', action: 'Extract data from a JSON file' },
          { name: 'Extract From ODS', value: 'ods', action: 'Extract rows from an ODS file' },
          { name: 'Extract From PDF', value: 'pdf', action: 'Extract text from a PDF file' },
          { name: 'Extract From Text File', value: 'text', action: 'Extract text from a file' },
          { name: 'Extract From XLS', value: 'xls', action: 'Extract rows from an XLS file' },
          { name: 'Extract From XLSX', value: 'xlsx', action: 'Extract rows from an XLSX file' },
          {
            name: 'Move File to Base64 String',
            value: 'binaryToPropery',
            action: 'Move a file to a base64 string',
          },
        ],
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
      },
      {
        displayName: 'Destination Output Field',
        name: 'destinationKey',
        type: 'string',
        default: 'data',
        displayOptions: { show: { operation: ['fromJson', 'text', 'binaryToPropery'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Delimiter',
            name: 'delimiter',
            type: 'string',
            default: '',
            placeholder: 'auto-detect',
            displayOptions: { show: { '/operation': ['csv'] } },
          },
          {
            displayName: 'Header Row',
            name: 'headerRow',
            type: 'boolean',
            default: true,
            description: 'Whether the first row holds the column names',
            displayOptions: { show: { '/operation': ['csv', ...SPREADSHEET_OPERATIONS] } },
          },
          {
            displayName: 'Starting Line',
            name: 'fromLine',
            type: 'number',
            default: 0,
            description: 'Number of data rows to skip',
            displayOptions: { show: { '/operation': ['csv'] } },
          },
          {
            displayName: 'Max Number of Rows',
            name: 'maxRowCount',
            type: 'number',
            default: -1,
            description: '-1 reads every row',
            displayOptions: { show: { '/operation': ['csv', ...SPREADSHEET_OPERATIONS] } },
          },
          {
            displayName: 'Include Empty Cells',
            name: 'includeEmptyCells',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/operation': ['csv', ...SPREADSHEET_OPERATIONS] } },
          },
          {
            displayName: 'Table Selector',
            name: 'tableSelector',
            type: 'string',
            default: 'table',
            description: 'CSS selector of the table to read; the first match is used',
            displayOptions: { show: { '/operation': ['html'] } },
          },
          keepSourceOption,
          ...spreadsheetOptionFields,
          ...pdfOptionFields,
          {
            ...encodingOption,
            displayOptions: { show: { '/operation': ['csv', 'html', 'fromJson', 'text'] } },
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const operation = ctx.getNodeParameter('operation', 0) as string;
    const out: Item[] = [];
    const items = ctx.getInputData();
    for (let i = 0; i < items.length; i++) {
      try {
        const property = ctx.getNodeParameter('binaryPropertyName', i, 'data') as string;
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const encoding = encodingOf(options.encoding);

        if (operation === 'csv') {
          const text = await readText(ctx, i, property, encoding);
          const header = options.headerRow !== false;
          const parsed = Papa.parse<unknown>(text, {
            header,
            delimiter: options.delimiter ? String(options.delimiter) : '',
            skipEmptyLines: options.includeEmptyCells === false ? 'greedy' : true,
            transformHeader: (h, index) => safeKey(h.trim() || `column_${index + 1}`),
          });
          const fatal = parsed.errors.find((e) => e.type === 'Quotes');
          if (fatal) {
            throw new NodeOperationError(
              ctx.getNode(),
              `The CSV could not be read: ${fatal.message} (row ${fatal.row})`,
              {
                itemIndex: i,
              },
            );
          }
          let rows = parsed.data;
          const from = Math.max(0, Number(options.fromLine ?? 0));
          const max = Number(options.maxRowCount ?? -1);
          rows = rows.slice(from, max >= 0 ? from + max : undefined);
          for (const row of rows) {
            let json: DataObject;
            if (header) {
              json = { ...(row as DataObject) };
              if (options.includeEmptyCells === false) {
                for (const [k, v] of Object.entries(json)) if (v === '') delete json[k];
              }
            } else {
              json = Object.fromEntries((row as string[]).map((v, c) => [`column_${c + 1}`, v]));
            }
            out.push({ json, pairedItem: { item: i } });
          }
          continue;
        }

        if (operation === 'html') {
          const text = await readText(ctx, i, property, encoding);
          for (const json of htmlTableToRows(text, String(options.tableSelector || 'table'))) {
            out.push({ json, pairedItem: { item: i } });
          }
          continue;
        }

        if (SPREADSHEET_OPERATIONS.includes(operation)) {
          const rows = await extractSpreadsheet(ctx, i, operation as SpreadsheetOperation, options);
          for (const json of rows) out.push({ json, pairedItem: { item: i } });
          continue;
        }

        if (operation === 'pdf') {
          out.push({ pairedItem: { item: i }, ...(await extractPdf(ctx, i, options, items[i])) });
          continue;
        }

        const destination = String(ctx.getNodeParameter('destinationKey', i, 'data') || 'data');
        const kept = keptSource(keepSourceMode(options.keepSource), items[i]);
        const json: DataObject = kept.json;
        if (operation === 'fromJson') {
          const text = await readText(ctx, i, property, encoding);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new NodeOperationError(ctx.getNode(), 'The file is not valid JSON', {
              itemIndex: i,
              description: (error as Error).message,
            });
          }
          setField(json, destination, parsed);
        } else if (operation === 'text') {
          setField(json, destination, await readText(ctx, i, property, encoding));
        } else if (operation === 'binaryToPropery') {
          const buffer = await ctx.helpers.getBinaryDataBuffer(i, property);
          setField(json, destination, Buffer.from(buffer).toString('base64'));
        } else {
          throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
        }
        const item: Item = { json, pairedItem: { item: i } };
        if (kept.binary) item.binary = kept.binary;
        out.push(item);
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push(errorItem(error, i));
      }
    }
    return [out];
  },
};
