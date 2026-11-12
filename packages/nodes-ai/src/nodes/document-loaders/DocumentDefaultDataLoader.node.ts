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
import { logAiEvent } from '../../shared/ai-events';
import { getTextSplitter } from '../../shared/ai-inputs';
import {
  type FileTextOptions,
  fileToSources,
  flattenJson,
  itemJsonToSources,
  type LoaderKind,
  parseCsv,
} from '../../shared/file-text';
import { splitRecursively } from '../../shared/text-splitting';
import { collectionList } from '../../shared/utils';

export { flattenJson, parseCsv };

interface Source {
  text: string;
  metadata: DataObject;
}

export const DocumentDefaultDataLoaderNode: NodeType = {
  description: {
    name: 'ai.documentDefaultDataLoader',
    displayName: 'Default Data Loader',
    description:
      'Loads item JSON, or PDF, Docx, EPub, CSV, JSON and text files, as documents for a vector store',
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
          { name: 'Binary', value: 'binary', description: 'Files attached to the item' },
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
        displayName: 'Data Format',
        name: 'loader',
        type: 'options',
        default: 'auto',
        displayOptions: { show: { dataType: ['binary'] } },
        options: [
          { name: 'Detect From MIME Type', value: 'auto' },
          { name: 'CSV', value: 'csvLoader' },
          { name: 'Docx', value: 'docxLoader' },
          { name: 'EPub', value: 'epubLoader' },
          { name: 'JSON', value: 'jsonLoader' },
          { name: 'PDF', value: 'pdfLoader' },
          { name: 'Text', value: 'textLoader' },
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
            displayName: 'CSV Separator',
            name: 'separator',
            type: 'string',
            default: ',',
            description: 'Character between the fields of a CSV row',
            displayOptions: { show: { '/dataType': ['binary'], '/loader': ['auto', 'csvLoader'] } },
          },
          {
            displayName: 'CSV Column',
            name: 'column',
            type: 'string',
            default: '',
            description: 'Read only this column as the document text; every column when empty',
            displayOptions: { show: { '/dataType': ['binary'], '/loader': ['auto', 'csvLoader'] } },
          },
          {
            displayName: 'JSON Pointers',
            name: 'pointers',
            type: 'string',
            default: '',
            placeholder: '/text, /items/0/title',
            description: 'Comma-separated JSON pointers to read; the whole value when empty',
          },
          {
            displayName: 'Split Pages in PDF',
            name: 'splitPages',
            type: 'boolean',
            default: true,
            description: 'Whether each PDF page is its own document',
            displayOptions: { show: { '/dataType': ['binary'], '/loader': ['auto', 'pdfLoader'] } },
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
        logAiEvent(ctx, 'ai.document.processed', { items: items.length, documents: documents.length });
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
    const value =
      ctx.getNodeParameter('jsonMode', index, 'allInputData') === 'expressionData'
        ? ctx.getNodeParameter('jsonData', index, '')
        : item.json;
    return itemJsonToSources(value, pointerList(options.pointers)).map((source) => ({
      text: source.text,
      metadata: { ...base, ...source.metadata },
    }));
  }

  const binaries = item.binary ?? {};
  const keys =
    ctx.getNodeParameter('binaryMode', index, 'allInputData') === 'specificField'
      ? [String(ctx.getNodeParameter('binaryDataKey', index, 'data'))]
      : Object.keys(binaries);
  const fileOptions: FileTextOptions = {
    loader: String(ctx.getNodeParameter('loader', index, 'auto')) as LoaderKind,
    separator: typeof options.separator === 'string' ? options.separator : undefined,
    column: typeof options.column === 'string' ? options.column : undefined,
    pointers: pointerList(options.pointers),
    splitPages: options.splitPages !== false,
  };
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
    const base: DataObject = {
      source: 'blob',
      blobType: binary.mimeType,
      ...(binary.fileName ? { fileName: binary.fileName } : {}),
      ...custom,
    };
    const found = await fileToSources(
      ctx,
      index,
      { bytes, mimeType: binary.mimeType, fileName: binary.fileName },
      fileOptions,
    );
    for (const source of found)
      sources.push({ text: source.text, metadata: { ...base, ...source.metadata } });
  }
  return sources;
}

/** the pointers of the JSON Pointers option, a comma-separated list */
function pointerList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const list = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return list.length > 0 ? list : undefined;
}
