/** OpenAI file operations: upload, list and delete. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { trimSlash } from '../../../shared/chat-model';
import { readBinaryFields } from '../shared/binary';
import {
  forOperation,
  OPENAI_CREDENTIAL,
  OPENAI_DEFAULT_BASE_URL,
  openAiBaseUrl,
  openAiCall,
  readLocator,
} from './text';

const PURPOSES = ['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'].map((value) => ({
  name: value,
  value,
}));

const uploadProperties: NodeProperty[] = [
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    description: 'The name of the binary field that holds the file',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Purpose',
        name: 'purpose',
        type: 'options',
        default: 'user_data',
        description: 'What the file is for',
        options: PURPOSES,
      },
    ],
  },
];

const listProperties: NodeProperty[] = [
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    displayOptions: { show: { returnAll: [false] } },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Purpose',
        name: 'purpose',
        type: 'options',
        default: 'any',
        description: 'Only files for this purpose',
        options: [{ name: 'Any', value: 'any' }, ...PURPOSES],
      },
    ],
  },
];

const deleteProperties: NodeProperty[] = [
  {
    displayName: 'File',
    name: 'fileId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: '' },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a file...',
        typeOptions: { searchListMethod: 'fileSearch', searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. file-abc123' },
    ],
  },
];

export const fileProperties: NodeProperty[] = [
  ...forOperation('file', 'upload', uploadProperties),
  ...forOperation('file', 'list', listProperties),
  ...forOperation('file', 'deleteFile', deleteProperties),
];

/** the file list search of the node */
export async function searchFiles(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const credentials = await ctx.getCredentials(OPENAI_CREDENTIAL);
  const base = trimSlash(String(credentials.baseUrl || OPENAI_DEFAULT_BASE_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication(OPENAI_CREDENTIAL, {
    url: `${base}/files`,
    qs: { limit: 100 },
  })) as { data?: Array<{ id?: string; filename?: string }> };
  const needle = filter?.trim().toLowerCase() ?? '';
  const results: ListSearchResult['results'] = [];
  for (const file of response.data ?? []) {
    if (!file?.id) continue;
    const name = file.filename ? `${file.filename} (${file.id})` : file.id;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    results.push({ name, value: file.id });
  }
  return { results };
}

async function upload(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const [file] = await readBinaryFields(
    ctx,
    itemIndex,
    String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  );
  if (!file) throw new NodeOperationError(ctx.getNode(), 'The item has no file', { itemIndex });
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/files`,
    method: 'POST',
    body: {
      file: { data: file.bytes, fileName: file.fileName ?? 'file', mimeType: file.mimeType },
      purpose: String(options.purpose ?? 'user_data'),
    },
    bodyType: 'multipart',
    timeout: 300_000,
  });
  return { json: response };
}

async function list(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const all = ctx.getNodeParameter('returnAll', itemIndex, false) === true;
  const limit = all
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Number(ctx.getNodeParameter('limit', itemIndex, 50)));
  const purpose = options.purpose && options.purpose !== 'any' ? String(options.purpose) : undefined;
  const files: DataObject[] = [];
  let after: string | undefined;
  while (files.length < limit) {
    const page = await openAiCall<{ data?: DataObject[]; has_more?: boolean; last_id?: string }>(
      ctx,
      itemIndex,
      {
        url: `${baseUrl}/files`,
        method: 'GET',
        qs: {
          limit: Math.min(100, Number.isFinite(limit) ? limit - files.length : 100),
          ...(purpose ? { purpose } : {}),
          ...(after ? { after } : {}),
        },
      },
    );
    const data = page.data ?? [];
    files.push(...data);
    const last = page.last_id ?? (data[data.length - 1]?.id as string | undefined);
    if (!page.has_more || !last || data.length === 0) break;
    after = last;
  }
  return files.slice(0, limit).map((file) => ({ json: file }));
}

async function deleteFile(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const id = readLocator(ctx, itemIndex, 'fileId', 'file');
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/files/${encodeURIComponent(id)}`,
    method: 'DELETE',
  });
  return { json: response };
}

export async function executeFile(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: string,
): Promise<Item | Item[]> {
  switch (operation) {
    case 'upload':
      return upload(ctx, itemIndex);
    case 'list':
      return list(ctx, itemIndex);
    case 'deleteFile':
      return deleteFile(ctx, itemIndex);
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
