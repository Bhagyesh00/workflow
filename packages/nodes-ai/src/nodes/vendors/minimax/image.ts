/**
 * MiniMax > Image > Generate an Image: `image_generation` with image-01. The image links in the reply are
 * vendor storage, fetched with `downloadMedia` and no key.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { downloadMedia, vendorError } from '../shared/api';
import { fileToItem } from '../shared/binary';
import { minimaxCall, num, readModel } from './text';

const shown = { show: { resource: ['image'], operation: ['generate'] } };

export const imageProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'image-01',
    displayOptions: shown,
    options: [
      { name: 'Image-01', value: 'image-01' },
      { name: 'Image-01 Live', value: 'image-01-live' },
    ],
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
    description: 'What the image should show',
    displayOptions: shown,
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: shown,
    options: [
      {
        displayName: 'Aspect Ratio',
        name: 'aspectRatio',
        type: 'options',
        default: '1:1',
        options: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].map((v) => ({ name: v, value: v })),
      },
      {
        displayName: 'Download Image',
        name: 'downloadImage',
        type: 'boolean',
        default: true,
        description: 'Whether to download the images into binary fields instead of only returning their links',
      },
      {
        displayName: 'Number of Images',
        name: 'n',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 9 },
      },
      { displayName: 'Prompt Optimizer', name: 'promptOptimizer', type: 'boolean', default: false },
      { displayName: 'Seed', name: 'seed', type: 'number', default: 0 },
    ],
  },
];

function extensionOf(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

/** Image > Generate an Image */
export async function imageGenerate(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const model = readModel(ctx, itemIndex, 'image-01');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;

  const body: DataObject = { model, prompt, response_format: 'url' };
  if (typeof options.aspectRatio === 'string') body.aspect_ratio = options.aspectRatio;
  const n = num(options.n);
  if (n !== undefined) body.n = Math.min(9, Math.max(1, Math.floor(n)));
  if (options.promptOptimizer !== undefined) body.prompt_optimizer = options.promptOptimizer === true;
  const seed = num(options.seed);
  if (seed !== undefined && seed !== 0) body.seed = seed;

  const reply = await minimaxCall<{ data?: { image_urls?: unknown }; id?: unknown }>(
    ctx,
    itemIndex,
    '/image_generation',
    { method: 'POST', body },
  );
  const urls = Array.isArray(reply.data?.image_urls)
    ? (reply.data.image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && u !== '')
    : [];
  if (!urls.length) throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no image', { itemIndex });

  const items: Item[] = [];
  for (const [index, url] of urls.entries()) {
    const json: DataObject = { url, ...(typeof reply.id === 'string' ? { id: reply.id } : {}) };
    if (options.downloadImage === false) {
      items.push({ json, pairedItem: { item: itemIndex } });
      continue;
    }
    let media: Awaited<ReturnType<typeof downloadMedia>>;
    try {
      // the link is vendor storage, not the credential's host: no key goes there
      media = await downloadMedia(ctx, itemIndex, url);
    } catch (error) {
      throw vendorError(ctx, error, itemIndex);
    }
    const mime = media.mimeType?.startsWith('image/') ? media.mimeType : 'image/jpeg';
    items.push(
      await fileToItem(
        ctx,
        itemIndex,
        { bytes: media.bytes, mimeType: mime, fileName: `image-${index + 1}.${extensionOf(mime)}` },
        'data',
        json,
      ),
    );
  }
  return items;
}
