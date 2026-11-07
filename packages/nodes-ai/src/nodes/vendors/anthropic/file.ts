/** Anthropic file operations on the Files API (beta header `files-api-2025-04-14`): upload, get, list, delete. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { readInputFile } from '../shared/binary';
import { anthropicBaseUrl, anthropicCall, FILES_BETA, forOperation, readLocator } from './message';

const fileLocator: NodeProperty = {
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
    { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. file_011CNha8iCJcU1wXNR6q4V8w' },
  ],
};

export const fileProperties: NodeProperty[] = [
  ...forOperation('file', 'upload', [
    {
      displayName: 'Input Type',
      name: 'inputType',
      type: 'options',
      default: 'binary',
      options: [
        { name: 'Binary File', value: 'binary' },
        { name: 'File URL', value: 'url' },
      ],
    },
    {
      displayName: 'URL',
      name: 'url',
      type: 'string',
      default: '',
      displayOptions: { show: { inputType: ['url'] } },
    },
    {
      displayName: 'Input Data Field Name',
      name: 'binaryPropertyName',
      type: 'string',
      default: 'data',
      displayOptions: { show: { inputType: ['binary'] } },
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
          description: 'The name stored with the file. Defaults to the name of the input file.',
        },
      ],
    },
  ]),
  ...forOperation('file', 'get', [fileLocator]),
  ...forOperation('file', 'list', [
    { displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false },
    {
      displayName: 'Limit',
      name: 'limit',
      type: 'number',
      default: 50,
      typeOptions: { minValue: 1, maxValue: 1000 },
      displayOptions: { show: { returnAll: [false] } },
    },
  ]),
  ...forOperation('file', 'deleteFile', [fileLocator]),
];

async function upload(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const inputType = ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url' ? 'url' : 'binary';
  const file = await readInputFile(ctx, itemIndex, {
    inputType,
    url: String(ctx.getNodeParameter('url', itemIndex, '')),
    binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  });
  const given = typeof options.fileName === 'string' ? options.fileName.trim() : '';
  const response = await anthropicCall<DataObject>(
    ctx,
    itemIndex,
    {
      url: `${baseUrl}/v1/files`,
      method: 'POST',
      body: {
        file: { data: file.bytes, fileName: given || file.fileName || 'file', mimeType: file.mimeType },
      },
      bodyType: 'multipart',
      timeout: 300_000,
    },
    [FILES_BETA],
  );
  return { json: response };
}

async function get(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const id = readLocator(ctx, itemIndex, 'fileId', 'file');
  const response = await anthropicCall<DataObject>(
    ctx,
    itemIndex,
    { url: `${baseUrl}/v1/files/${encodeURIComponent(id)}`, method: 'GET' },
    [FILES_BETA],
  );
  return { json: response };
}

async function list(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const all = ctx.getNodeParameter('returnAll', itemIndex, false) === true;
  const limit = all
    ? Number.POSITIVE_INFINITY
    : Math.min(1000, Math.max(1, Math.floor(Number(ctx.getNodeParameter('limit', itemIndex, 50)))));
  const files: DataObject[] = [];
  let after: string | undefined;
  while (files.length < limit) {
    const page = await anthropicCall<{ data?: DataObject[]; has_more?: boolean; last_id?: string }>(
      ctx,
      itemIndex,
      {
        url: `${baseUrl}/v1/files`,
        method: 'GET',
        qs: {
          limit: Math.min(1000, Number.isFinite(limit) ? limit - files.length : 1000),
          ...(after ? { after_id: after } : {}),
        },
      },
      [FILES_BETA],
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
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const id = readLocator(ctx, itemIndex, 'fileId', 'file');
  const response = await anthropicCall<DataObject>(
    ctx,
    itemIndex,
    { url: `${baseUrl}/v1/files/${encodeURIComponent(id)}`, method: 'DELETE' },
    [FILES_BETA],
  );
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
    case 'get':
      return get(ctx, itemIndex);
    case 'list':
      return list(ctx, itemIndex);
    case 'deleteFile':
      return deleteFile(ctx, itemIndex);
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
