/**
 * Default Data Loader: turns input items (JSON or text/JSON/CSV files) into documents with
 * metadata, split into chunks, for vector store inserts.
 */
import {
  type AiDocument,
  type AiDocumentLoader,
  type AiTextSplitter,
  type DataObject,
  type Item,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
import { getTextSplitter } from '../../shared/ai-inputs';
import { splitRecursively } from '../../shared/text-splitting';
import { collectionList } from '../../shared/utils';

/** `a.b: value` lines for every leaf; keeps keys so retrieval has context. */
export function flattenJson(value: unknown, prefix = '', depth = 0, lines: string[] = []): string[] {
  if (depth > 32) return lines;
  if (value === null || value === undefined) return lines;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries())
      flattenJson(v, prefix ? `${prefix}[${i}]` : `[${i}]`, depth + 1, lines);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as DataObject))
      flattenJson(v, prefix ? `${prefix}.${k}` : k, depth + 1, lines);
  } else {
    lines.push(prefix ? `${prefix}: ${String(value)}` : String(value));
  }
  return lines;
}

/** RFC 4180 CSV parsing (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

interface Source {
  text: string;
  metadata: DataObject;
}

function csvSources(text: string, delimiter: string, base: DataObject): Source[] {
  const [header, ...rows] = parseCsv(text, delimiter);
  if (!header) return [];
  return rows.map((row, i) => ({
    text: header.map((h, c) => `${h.trim()}: ${row[c] ?? ''}`).join('\n'),
    metadata: { ...base, line: i + 2 },
  }));
}

function jsonSources(text: string, base: DataObject): Source[] {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed.map((entry, i) => ({
      text: flattenJson(entry).join('\n'),
      metadata: { ...base, index: i },
    }));
  }
  return [{ text: flattenJson(parsed).join('\n'), metadata: base }];
}

const TEXT_MIME = /^text\/|^application\/(xml|x-yaml|yaml|x-ndjson|markdown|javascript|x-sh|sql)/;

export const DocumentDefaultDataLoaderNode: NodeType = {
  description: {
    name: 'ai.documentDefaultDataLoader',
    displayName: 'Default Data Loader',
    description: 'Loads item JSON or text, JSON and CSV files as documents for a vector store',
    icon: 'lucide:file-text',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Default Data Loader' },
    inputs:
      "={{ ($parameter.textSplittingMode ?? 'simple') === 'custom' ? [{ type: 'ai_textSplitter', displayName: 'Text Splitter', required: true, maxConnections: 1 }] : [] }}",
    outputs: ['ai_document'],
    outputNames: ['Document'],
    categories: ['AI', 'Document Loaders'],
    alias: ['rag', 'ingest', 'documents', 'csv', 'json'],
    properties: [
      {
        displayName: 'Type of Data',
        name: 'dataType',
        type: 'options',
        default: 'json',
        options: [
          { name: 'JSON', value: 'json', description: 'Text from the item JSON' },
          { name: 'Binary', value: 'binary', description: 'Text, JSON or CSV files attached to the item' },
        ],
      },
      {
        displayName: 'Mode',
        name: 'jsonMode',
        type: 'options',
        default: 'allInputData',
        displayOptions: { show: { dataType: ['json'] } },
        options: [
          { name: 'Load All Input Data', value: 'allInputData', description: 'Every field of the item' },
          {
            name: 'Load Specific Data',
            value: 'expressionData',
            description: 'Text mapped with an expression',
          },
        ],
      },
      {
        displayName: 'Data',
        name: 'jsonData',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 4 },
        displayOptions: { show: { dataType: ['json'], jsonMode: ['expressionData'] } },
      },
      {
        displayName: 'Mode',
        name: 'binaryMode',
        type: 'options',
        default: 'allInputData',
        displayOptions: { show: { dataType: ['binary'] } },
        options: [
          { name: 'Load All Files', value: 'allInputData' },
          { name: 'Load a Specific File', value: 'specificField' },
        ],
      },
      {
        displayName: 'Binary Property',
        name: 'binaryDataKey',
        type: 'string',
        default: 'data',
        displayOptions: { show: { dataType: ['binary'], binaryMode: ['specificField'] } },
      },
      {
        displayName: 'File Type',
        name: 'loader',
        type: 'options',
        default: 'auto',
        displayOptions: { show: { dataType: ['binary'] } },
        options: [
          { name: 'Detect From MIME Type', value: 'auto' },
          { name: 'Text', value: 'textLoader' },
          { name: 'JSON', value: 'jsonLoader' },
          { name: 'CSV', value: 'csvLoader' },
        ],
      },
      {
        displayName: 'Text Splitting',
        name: 'textSplittingMode',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simple', value: 'simple', description: 'Chunks of 1000 characters with 200 overlap' },
          { name: 'Custom', value: 'custom', description: 'Use the connected text splitter' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'fixedCollection',
            default: {},
            typeOptions: { multipleValues: true },
            description: 'Stored with every document; usable as a filter when retrieving',
            options: [
              {
                displayName: 'Field',
                name: 'metadataValues',
                values: [
                  { displayName: 'Name', name: 'name', type: 'string', default: '' },
                  { displayName: 'Value', name: 'value', type: 'string', default: '' },
                ],
              },
            ],
          },
          {
            displayName: 'CSV Delimiter',
            name: 'csvDelimiter',
            type: 'string',
            default: ',',
          },
        ],
      },
    ],
  },

  async supplyData(ctx, itemIndex) {
    const splitter =
      ctx.getNodeParameter('textSplittingMode', itemIndex, 'simple') === 'custom'
        ? await getTextSplitter(ctx, itemIndex, true)
        : undefined;
    const loader: AiDocumentLoader = {
      kind: 'documentLoader',
      async load(items) {
        const all = ctx.getInputData();
        const documents: AiDocument[] = [];
        for (const [position, item] of items.entries()) {
          const index = all.indexOf(item as Item) >= 0 ? all.indexOf(item as Item) : position;
          const sources = await loadSources(ctx, index, item as Item);
          for (const source of sources) {
            const chunks = await split(source.text, splitter);
            for (const [n, chunk] of chunks.entries()) {
              documents.push({
                pageContent: chunk,
                metadata: chunks.length > 1 ? { ...source.metadata, chunk: n } : { ...source.metadata },
              });
            }
          }
        }
        ctx.logSubNodeRun({ items: items.length }, { documents: documents.length });
        return documents;
      },
    };
    return { response: loader };
  },
};

async function split(text: string, splitter: AiTextSplitter | undefined): Promise<string[]> {
  if (!text.trim()) return [];
  return splitter ? splitter.split(text) : splitRecursively(text, { chunkSize: 1000, chunkOverlap: 200 });
}

async function loadSources(ctx: SupplyDataContext, index: number, item: Item): Promise<Source[]> {
  const options = ctx.getNodeParameter('options', index, {}) as DataObject;
  const custom: DataObject = {};
  for (const entry of collectionList<{ name: string; value: unknown }>(options.metadata, 'metadataValues')) {
    if (entry.name) custom[entry.name] = entry.value;
  }
  const dataType = ctx.getNodeParameter('dataType', index, 'json');
  if (dataType === 'json') {
    const base = { source: 'json', ...custom };
    if (ctx.getNodeParameter('jsonMode', index, 'allInputData') === 'expressionData') {
      const value = ctx.getNodeParameter('jsonData', index, '');
      const text = typeof value === 'string' ? value : flattenJson(value).join('\n');
      return [{ text, metadata: base }];
    }
    return [{ text: flattenJson(item.json).join('\n'), metadata: base }];
  }

  const binaries = item.binary ?? {};
  const keys =
    ctx.getNodeParameter('binaryMode', index, 'allInputData') === 'specificField'
      ? [String(ctx.getNodeParameter('binaryDataKey', index, 'data'))]
      : Object.keys(binaries);
  const loaderType = String(ctx.getNodeParameter('loader', index, 'auto'));
  const sources: Source[] = [];
  for (const key of keys) {
    const binary = binaries[key];
    if (!binary) {
      throw new NodeOperationError(ctx.getNode(), `The item has no binary property "${key}"`, {
        itemIndex: index,
      });
    }
    const bytes = binary.id
      ? await ctx.helpers.getBinaryDataBuffer(index, key)
      : Buffer.from(binary.data ?? '', 'base64');
    const text = new TextDecoder().decode(bytes);
    const base: DataObject = {
      source: 'blob',
      blobType: binary.mimeType,
      ...(binary.fileName ? { fileName: binary.fileName } : {}),
      ...custom,
    };
    const mime = binary.mimeType ?? '';
    const type =
      loaderType !== 'auto'
        ? loaderType
        : /json/.test(mime)
          ? 'jsonLoader'
          : /csv/.test(mime)
            ? 'csvLoader'
            : TEXT_MIME.test(mime)
              ? 'textLoader'
              : undefined;
    if (!type) {
      throw new NodeOperationError(ctx.getNode(), `Files of type "${mime}" cannot be loaded as text`, {
        itemIndex: index,
        description:
          'Convert the file to text first (for example with an extract-from-file step), or pick a File Type.',
      });
    }
    try {
      if (type === 'jsonLoader') sources.push(...jsonSources(text, base));
      else if (type === 'csvLoader')
        sources.push(...csvSources(text, String(options.csvDelimiter ?? ',') || ',', base));
      else sources.push({ text, metadata: base });
    } catch (error) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Could not read "${binary.fileName ?? key}": ${(error as Error).message}`,
        {
          itemIndex: index,
        },
      );
    }
  }
  return sources;
}
