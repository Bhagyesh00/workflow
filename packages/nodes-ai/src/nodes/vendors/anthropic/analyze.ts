/**
 * Anthropic image.analyze and document.analyze: one user turn with the file and a question. The file is a
 * URL (downloaded through the guard), a binary field, or a link `<base>/v1/files/<id>`, which goes as a
 * Files API id without a download.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { readInputFile } from '../shared/binary';
import { simplifyProperty } from '../shared/messages';
import {
  anthropicBaseUrl,
  anthropicCall,
  FILES_BETA,
  forOperation,
  modelLocator,
  readLocator,
  replyItem,
} from './message';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function analyzeFor(resource: 'image' | 'document'): NodeProperty[] {
  const label = resource === 'image' ? 'image' : 'document';
  return forOperation(resource, 'analyze', [
    modelLocator(),
    {
      displayName: 'Text Input',
      name: 'text',
      type: 'string',
      default: `What's in this ${label}?`,
      typeOptions: { rows: 2 },
    },
    {
      displayName: 'Input Type',
      name: 'inputType',
      type: 'options',
      default: 'url',
      options: [
        { name: resource === 'image' ? 'Image URL' : 'Document URL', value: 'url' },
        { name: 'Binary File', value: 'binary' },
      ],
    },
    {
      displayName: 'URL',
      name: 'url',
      type: 'string',
      default: '',
      displayOptions: { show: { inputType: ['url'] } },
      placeholder: `https://example.com/${resource === 'image' ? 'photo.png' : 'report.pdf'}`,
      description:
        'A link, or a link of the form <base URL>/v1/files/<id> to use a file uploaded to Anthropic',
    },
    {
      displayName: 'Input Data Field Name',
      name: 'binaryPropertyName',
      type: 'string',
      default: 'data',
      displayOptions: { show: { inputType: ['binary'] } },
    },
    simplifyProperty(true),
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Maximum Number of Tokens',
          name: 'maxTokens',
          type: 'number',
          default: 1024,
          typeOptions: { minValue: 1 },
        },
      ],
    },
  ]);
}

export const analyzeProperties: NodeProperty[] = [...analyzeFor('image'), ...analyzeFor('document')];

/** the id in `<base>/v1/files/<id>`, or undefined for any other link */
export function filesApiId(url: string, baseUrl: string): string | undefined {
  const prefix = `${baseUrl}/v1/files/`;
  if (!url.startsWith(prefix)) return undefined;
  const id = url.slice(prefix.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

async function fileBlock(
  ctx: ExecuteContext,
  itemIndex: number,
  resource: 'image' | 'document',
  baseUrl: string,
): Promise<{ block: DataObject; usesFilesApi: boolean }> {
  const inputType = ctx.getNodeParameter('inputType', itemIndex, 'url') === 'binary' ? 'binary' : 'url';
  const url = String(ctx.getNodeParameter('url', itemIndex, '')).trim();
  if (inputType === 'url') {
    const fileId = filesApiId(url, baseUrl);
    if (fileId)
      return { block: { type: resource, source: { type: 'file', file_id: fileId } }, usesFilesApi: true };
  }
  const file = await readInputFile(ctx, itemIndex, {
    inputType,
    url,
    binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  });
  const mime = file.mimeType.toLowerCase();
  if (resource === 'image') {
    if (!IMAGE_TYPES.has(mime)) {
      throw new NodeOperationError(ctx.getNode(), `The file type "${mime}" is not an image Claude reads`, {
        itemIndex,
        description: 'Use a JPEG, PNG, GIF or WebP image.',
      });
    }
    return {
      block: {
        type: 'image',
        source: { type: 'base64', media_type: mime, data: Buffer.from(file.bytes).toString('base64') },
      },
      usesFilesApi: false,
    };
  }
  if (mime === 'application/pdf') {
    return {
      block: {
        type: 'document',
        source: { type: 'base64', media_type: mime, data: Buffer.from(file.bytes).toString('base64') },
      },
      usesFilesApi: false,
    };
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return {
      block: {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: Buffer.from(file.bytes).toString('utf8') },
      },
      usesFilesApi: false,
    };
  }
  throw new NodeOperationError(ctx.getNode(), `The file type "${mime}" is not a document Claude reads`, {
    itemIndex,
    description: 'Use a PDF or a text file.',
  });
}

export async function executeAnalyze(
  ctx: ExecuteContext,
  itemIndex: number,
  resource: 'image' | 'document',
  operation: string,
): Promise<Item> {
  if (operation !== 'analyze') {
    throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const { block, usesFilesApi } = await fileBlock(ctx, itemIndex, resource, baseUrl);
  const text = String(ctx.getNodeParameter('text', itemIndex, '')).trim();
  const reply = await anthropicCall<DataObject>(
    ctx,
    itemIndex,
    {
      url: `${baseUrl}/v1/messages`,
      method: 'POST',
      body: {
        model: readLocator(ctx, itemIndex, 'modelId', 'model'),
        max_tokens: Math.max(1, Math.floor(Number(options.maxTokens ?? 1024))),
        messages: [{ role: 'user', content: [block, ...(text ? [{ type: 'text', text }] : [])] }],
      },
    },
    usesFilesApi ? [FILES_BETA] : [],
  );
  return replyItem(ctx.getNodeParameter('simplify', itemIndex, true) === true, reply);
}
