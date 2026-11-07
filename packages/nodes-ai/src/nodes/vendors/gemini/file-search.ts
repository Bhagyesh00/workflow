/** Google Gemini file search stores: create, delete, list and upload a file into a store. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { readInputFile } from '../shared/binary';
import { resumableUpload } from './files';
import { geminiCall, pollTiming, waitForOperation } from './operations';

const show = (operation: string, extra: Record<string, unknown> = {}) => ({
  show: { resource: ['fileSearch'], operation: [operation], ...extra },
});

const storeNameProperty = (operation: string): NodeProperty => ({
  displayName: 'File Search Store Name',
  name: 'storeName',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'fileSearchStores/my-store-abc123',
  description: 'The name Gemini gave the store, such as fileSearchStores/my-store-abc123',
  displayOptions: show(operation),
});

/** the parameters of the File Search resource */
export const fileSearchProperties: NodeProperty[] = [
  {
    displayName: 'Display Name',
    name: 'storeDisplayName',
    type: 'string',
    default: '',
    required: true,
    description: 'A name for the new store',
    displayOptions: show('createStore'),
  },
  storeNameProperty('deleteStore'),
  {
    displayName: 'Force Delete',
    name: 'force',
    type: 'boolean',
    default: false,
    description: 'Whether to delete the store together with the documents in it',
    displayOptions: show('deleteStore'),
  },
  {
    displayName: 'Page Size',
    name: 'pageSize',
    type: 'number',
    default: 10,
    typeOptions: { minValue: 1, maxValue: 20 },
    description: 'How many stores to return at most',
    displayOptions: show('listStores'),
  },
  {
    displayName: 'Page Token',
    name: 'pageToken',
    type: 'string',
    default: '',
    description: 'The nextPageToken of an earlier list, to get the next page',
    displayOptions: show('listStores'),
  },
  storeNameProperty('uploadToStore'),
  {
    displayName: 'File Display Name',
    name: 'fileDisplayName',
    type: 'string',
    default: '',
    description: 'The name Gemini shows for the document. Empty uses the file name.',
    displayOptions: show('uploadToStore'),
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'binary',
    displayOptions: show('uploadToStore'),
    options: [
      { name: 'Binary File', value: 'binary' },
      { name: 'URL', value: 'url' },
    ],
  },
  {
    displayName: 'URL',
    name: 'url',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/file.pdf',
    displayOptions: show('uploadToStore', { inputType: ['url'] }),
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    description: 'The name of the binary field of the input item that holds the file',
    displayOptions: show('uploadToStore', { inputType: ['binary'] }),
  },
];

const STORE = /^(?:fileSearchStores\/)?([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/** `fileSearchStores/<id>` from a full name or a bare id */
export function normalizeStoreName(ctx: ExecuteContext, itemIndex: number, value: unknown): string {
  const match = STORE.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) {
    throw new NodeOperationError(ctx.getNode(), 'The file search store name is not valid', {
      itemIndex,
      description: 'Use the name Gemini returned, such as fileSearchStores/my-store-abc123.',
    });
  }
  return `fileSearchStores/${match[1]}`;
}

const out = (itemIndex: number, json: DataObject): Item => ({ json, pairedItem: { item: itemIndex } });

/** File Search > Create */
export async function createStore(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const displayName = String(ctx.getNodeParameter('storeDisplayName', itemIndex, '')).trim();
  if (!displayName) {
    throw new NodeOperationError(ctx.getNode(), 'Enter a display name for the store', { itemIndex });
  }
  const store = await geminiCall(ctx, itemIndex, '/v1beta/fileSearchStores', {
    method: 'POST',
    body: { displayName },
  });
  return out(itemIndex, store);
}

/** File Search > Delete */
export async function deleteStore(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const name = normalizeStoreName(ctx, itemIndex, ctx.getNodeParameter('storeName', itemIndex, ''));
  const force = ctx.getNodeParameter('force', itemIndex, false) === true;
  await geminiCall(ctx, itemIndex, `/v1beta/${name}`, { method: 'DELETE', qs: { force } });
  return out(itemIndex, { success: true, name });
}

/** File Search > List */
export async function listStores(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const pageSize = Number(ctx.getNodeParameter('pageSize', itemIndex, 10));
  const pageToken = String(ctx.getNodeParameter('pageToken', itemIndex, '')).trim();
  const reply = await geminiCall(ctx, itemIndex, '/v1beta/fileSearchStores', {
    qs: { pageSize: Math.min(20, Math.max(1, pageSize || 10)), ...(pageToken ? { pageToken } : {}) },
  });
  return out(itemIndex, reply);
}

/** File Search > Upload to a store: the import runs on the server, so wait for it */
export async function uploadToStore(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const name = normalizeStoreName(ctx, itemIndex, ctx.getNodeParameter('storeName', itemIndex, ''));
  const file = await readInputFile(ctx, itemIndex, {
    inputType: ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url' ? 'url' : 'binary',
    url: String(ctx.getNodeParameter('url', itemIndex, '')),
    binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  });
  const displayName = String(ctx.getNodeParameter('fileDisplayName', itemIndex, '')).trim();
  const started = await resumableUpload(
    ctx,
    itemIndex,
    `/upload/v1beta/${name}:uploadToFileSearchStore`,
    { displayName: displayName || file.fileName || 'file', mimeType: file.mimeType },
    file,
  );
  const finished = await waitForOperation(ctx, itemIndex, started, {
    intervalMs: pollTiming.importIntervalMs,
    timeoutMs: pollTiming.importTimeoutMs,
    timeoutText: 'The file took too long to import into the store',
  });
  return out(itemIndex, { ...finished, store: name } as DataObject);
}
