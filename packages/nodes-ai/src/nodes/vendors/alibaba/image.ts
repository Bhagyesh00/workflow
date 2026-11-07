/**
 * Qwen Cloud images: Analyze Image (a vision model on the multimodal endpoint) and Generate an Image
 * (Qwen Image on the sync endpoint, Wan models as async tasks). Generated links are fetched with
 * `downloadMedia` and no key: they are vendor storage links, not the credential's host.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { vendorError } from '../shared/api';
import { downloadMedia } from '../shared/api';
import { fileToItem, readBinaryFields, type VendorFile } from '../shared/binary';
import {
  contentText,
  DEFAULT_VISION_MODEL,
  modelProperty,
  MULTIMODAL_PATH,
  num,
  pollTiming,
  qwenCall,
  readModel,
  runTask,
} from './text';

const splitList = (value: unknown): string[] =>
  String(value ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

const dataUrl = (file: VendorFile) =>
  `data:${file.mimeType};base64,${Buffer.from(file.bytes).toString('base64')}`;

/** image links (sent to the model as they are) and binary fields (sent inline) as one list */
async function imageSources(
  ctx: ExecuteContext,
  itemIndex: number,
  inputType: string,
  urls: unknown,
  fields: unknown,
): Promise<string[]> {
  if (inputType === 'binary') {
    const files = await readBinaryFields(ctx, itemIndex, String(fields ?? ''));
    return files.map(dataUrl);
  }
  const list = splitList(urls);
  for (const link of list) {
    if (!/^https?:\/\//i.test(link)) {
      throw new NodeOperationError(ctx.getNode(), 'An image link must start with http:// or https://', {
        itemIndex,
      });
    }
  }
  return list;
}

export const GENERATE_MODELS = [
  { name: 'Qwen Image Max', value: 'qwen-image-max' },
  { name: 'Qwen Image Plus', value: 'qwen-image-plus' },
  { name: 'Qwen Image', value: 'qwen-image' },
  { name: 'Wan 2.6 Image', value: 'wan2.6-t2i' },
  { name: 'Wan 2.5 Image', value: 'wan2.5-t2i-preview' },
  { name: 'Wan 2.2 Image Plus', value: 'wan2.2-t2i-plus' },
  { name: 'Wan 2.2 Image Flash', value: 'wan2.2-t2i-flash' },
  { name: 'Wan 2.5 Image Edit', value: 'wan2.5-i2i-preview' },
];

const analyze = { show: { resource: ['image'], operation: ['analyze'] } };
const generate = { show: { resource: ['image'], operation: ['generate'] } };

export const imageProperties: NodeProperty[] = [
  modelProperty({
    resource: 'image',
    operations: ['analyze'],
    searchMethod: 'visionModels',
    defaultModel: DEFAULT_VISION_MODEL,
  }),
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'qwen-image-plus',
    displayOptions: generate,
    options: GENERATE_MODELS,
  },
  {
    displayName: 'Question',
    name: 'question',
    type: 'string',
    default: "What's in this image?",
    typeOptions: { rows: 2 },
    displayOptions: analyze,
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
    description: 'What the image should show',
    displayOptions: generate,
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'url',
    options: [
      { name: 'Image URL(s)', value: 'url' },
      { name: 'Binary File(s)', value: 'binary' },
    ],
    displayOptions: analyze,
  },
  {
    displayName: 'Image URL(s)',
    name: 'imageUrls',
    type: 'string',
    default: '',
    description: 'Comma separated links of the images',
    displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['url'] } },
  },
  {
    displayName: 'Input Data Field Name(s)',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    description: 'Comma separated names of the binary fields that hold the images',
    displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['binary'] } },
  },
  {
    displayName: 'Reference Image URL(s)',
    name: 'referenceUrls',
    type: 'string',
    default: '',
    description: 'Comma separated links of images to edit or use as a guide (Wan and Qwen Image models)',
    displayOptions: generate,
  },
  {
    displayName: 'Reference Binary Field(s)',
    name: 'referenceFields',
    type: 'string',
    default: '',
    description: 'Comma separated names of binary fields that hold reference images',
    displayOptions: generate,
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: analyze,
    options: [
      { displayName: 'Max Tokens', name: 'maxTokens', type: 'number', default: 2000, typeOptions: { minValue: 1 } },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: generate,
    options: [
      {
        displayName: 'Download Image',
        name: 'downloadImage',
        type: 'boolean',
        default: true,
        description: 'Whether to download the image into a binary field instead of only returning its link',
      },
      {
        displayName: 'Negative Prompt',
        name: 'negativePrompt',
        type: 'string',
        default: '',
        description: 'What the image should not show',
      },
      {
        displayName: 'Number of Images',
        name: 'n',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 4 },
      },
      {
        displayName: 'Prompt Extend',
        name: 'promptExtend',
        type: 'boolean',
        default: true,
        description: 'Whether the service may rewrite the prompt to add detail',
      },
      { displayName: 'Seed', name: 'seed', type: 'number', default: 1234 },
      {
        displayName: 'Size',
        name: 'size',
        type: 'string',
        default: '',
        placeholder: '1328*1328',
        description:
          'Width*height in pixels, for example 1328*1328 for Qwen Image or 1280*1280 for Wan. Empty uses the model default.',
      },
    ],
  },
];

/** Image > Analyze Image */
export async function imageAnalyze(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const model = readModel(ctx, itemIndex, DEFAULT_VISION_MODEL);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const sources = await imageSources(
    ctx,
    itemIndex,
    String(ctx.getNodeParameter('inputType', itemIndex, 'url')),
    ctx.getNodeParameter('imageUrls', itemIndex, ''),
    ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data'),
  );
  if (!sources.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one image', { itemIndex });
  }
  const question = String(ctx.getNodeParameter('question', itemIndex, "What's in this image?"));
  const parameters: DataObject = {};
  const temperature = num(options.temperature);
  const maxTokens = num(options.maxTokens);
  if (temperature !== undefined) parameters.temperature = temperature;
  if (maxTokens !== undefined) parameters.max_tokens = maxTokens;
  const response = await qwenCall<{ output?: { choices?: Array<{ message?: { content?: unknown } }> } }>(
    ctx,
    itemIndex,
    MULTIMODAL_PATH,
    {
      method: 'POST',
      body: {
        model,
        input: {
          messages: [{ role: 'user', content: [...sources.map((image) => ({ image })), { text: question }] }],
        },
        parameters,
      },
    },
  );
  const text = contentText(response.output?.choices?.[0]?.message?.content);
  return { json: { text }, pairedItem: { item: itemIndex } };
}

/** the image links in a finished task or sync answer */
function imageLinks(output: DataObject | undefined): string[] {
  const links: string[] = [];
  for (const entry of (output?.results as Array<{ url?: unknown }> | undefined) ?? []) {
    if (typeof entry?.url === 'string') links.push(entry.url);
  }
  const choices = (output?.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? [];
  for (const choice of choices) {
    const content = choice.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const image = (part as { image?: unknown } | null)?.image;
      if (typeof image === 'string') links.push(image);
    }
  }
  return links;
}

function extensionOf(mimeType: string | undefined): { mime: string; ext: string } {
  const mime = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/png';
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  return { mime, ext: ext === 'jpeg' ? 'jpg' : ext };
}

/** Image > Generate an Image */
export async function imageGenerate(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const model = readModel(ctx, itemIndex, 'qwen-image-plus');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const references = [
    ...(await imageSources(ctx, itemIndex, 'url', ctx.getNodeParameter('referenceUrls', itemIndex, ''), '')),
    ...(String(ctx.getNodeParameter('referenceFields', itemIndex, '')).trim()
      ? await imageSources(
          ctx,
          itemIndex,
          'binary',
          '',
          ctx.getNodeParameter('referenceFields', itemIndex, ''),
        )
      : []),
  ];
  const size = String(options.size ?? '').trim();
  if (size && !/^\d{2,5}\*\d{2,5}$/.test(size)) {
    throw new NodeOperationError(ctx.getNode(), 'The size must be width*height, for example 1280*1280', {
      itemIndex,
    });
  }
  const n = num(options.n);
  const negative = String(options.negativePrompt ?? '').trim();
  const seed = num(options.seed);
  const parameters: DataObject = {};
  if (size) parameters.size = size;
  if (n !== undefined) parameters.n = n;
  if (options.promptExtend !== undefined) parameters.prompt_extend = options.promptExtend === true;
  if (seed !== undefined) parameters.seed = seed;

  const messageBody = {
    model,
    input: {
      messages: [{ role: 'user', content: [...references.map((image) => ({ image })), { text: prompt }] }],
      ...(negative ? { negative_prompt: negative } : {}),
    },
    parameters,
  };
  const task = (path: string, body: DataObject) =>
    runTask(ctx, itemIndex, {
      path,
      body,
      intervalMs: pollTiming.imageIntervalMs,
      timeoutMs: pollTiming.imageTimeoutMs,
      what: 'image',
    });

  let output: DataObject;
  if (/^qwen-image/.test(model)) {
    const sync = await qwenCall<{ output?: DataObject }>(ctx, itemIndex, MULTIMODAL_PATH, {
      method: 'POST',
      body: messageBody,
    });
    output = sync.output ?? {};
  } else if (/^wan2\.6/.test(model)) {
    output = await task('/api/v1/services/aigc/image-generation/generation', messageBody);
  } else if (references.length) {
    output = await task('/api/v1/services/aigc/image2image/image-synthesis', {
      model,
      input: { prompt, images: references, ...(negative ? { negative_prompt: negative } : {}) },
      parameters,
    });
  } else {
    output = await task('/api/v1/services/aigc/text2image/image-synthesis', {
      model,
      input: { prompt, ...(negative ? { negative_prompt: negative } : {}) },
      parameters,
    });
  }

  const links = imageLinks(output);
  if (!links.length) {
    throw new NodeOperationError(ctx.getNode(), 'Qwen Cloud returned no image', { itemIndex });
  }
  const taskId = typeof output.task_id === 'string' ? output.task_id : undefined;
  const items: Item[] = [];
  for (const [index, url] of links.entries()) {
    const json: DataObject = { url, ...(taskId ? { taskId } : {}) };
    if (options.downloadImage === false) {
      items.push({ json, pairedItem: { item: itemIndex } });
      continue;
    }
    let media: Awaited<ReturnType<typeof downloadMedia>>;
    try {
      // the link is the vendor's storage, not the credential's host: no key goes there
      media = await downloadMedia(ctx, itemIndex, url);
    } catch (error) {
      throw vendorError(ctx, error, itemIndex);
    }
    const { mime, ext } = extensionOf(media.mimeType);
    items.push(
      await fileToItem(ctx, itemIndex, { bytes: media.bytes, mimeType: mime, fileName: `image-${index + 1}.${ext}` }, 'data', json),
    );
  }
  return items;
}
