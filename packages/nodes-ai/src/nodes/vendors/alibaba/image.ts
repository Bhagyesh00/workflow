/**
 * Qwen Cloud images: Analyze Image (a vision model on the multimodal endpoint) and Generate an Image
 * (Qwen Image and Z-Image on the sync endpoint, Wan 2.6 models as async tasks). Generated links are fetched
 * with `downloadMedia` and no key: they are vendor storage links, not the credential's host.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { downloadMedia, vendorError } from '../shared/api';
import { fileToItem, readBinaryFields, type VendorFile } from '../shared/binary';
import { simplifyProperty } from '../shared/messages';
import {
  contentText,
  DEFAULT_VISION_MODEL,
  MULTIMODAL_PATH,
  modelProperty,
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

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo';

export const GENERATE_MODELS = [
  { name: 'Qwen Image', value: 'qwen-image' },
  { name: 'Qwen Image Max', value: 'qwen-image-max' },
  { name: 'Qwen Image Plus', value: 'qwen-image-plus' },
  { name: 'Wan 2.6 Image', value: 'wan2.6-image' },
  { name: 'Wan 2.6 T2I', value: 'wan2.6-t2i' },
  { name: 'Z-Image Turbo', value: 'z-image-turbo' },
];

const IMAGE_GENERATION_PATH = '/api/v1/services/aigc/image-generation/generation';
/** Wan 2.6 Image edits reference images: one to four */
const MAX_REFERENCES = 4;

const sizeOption = (models: string[], sizes: Array<[string, string]>, fallback: string): NodeProperty => ({
  displayName: 'Size',
  name: 'size',
  type: 'options',
  default: fallback,
  displayOptions: { show: { '/modelId': models } },
  options: sizes.map(([name, value]) => ({ name, value })),
});

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
    default: DEFAULT_IMAGE_MODEL,
    displayOptions: generate,
    options: GENERATE_MODELS,
  },
  {
    displayName: 'Question',
    name: 'question',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'What is in this image?',
    typeOptions: { rows: 4 },
    displayOptions: analyze,
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 4 },
    description: 'What the image should show',
    displayOptions: generate,
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'url',
    options: [
      { name: 'URL', value: 'url' },
      { name: 'Binary Data', value: 'binary' },
    ],
    displayOptions: analyze,
  },
  {
    displayName: 'Image URL',
    name: 'imageUrl',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://example.com/image.jpg',
    description: 'The link of the image. Several links can be separated by commas.',
    displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['url'] } },
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    required: true,
    placeholder: 'e.g. data',
    description:
      'The name of the binary field that holds the image. Several names can be separated by commas.',
    displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['binary'] } },
  },
  { ...simplifyProperty(true), displayOptions: analyze },
  {
    displayName: 'Options',
    name: 'visionOptions',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: analyze,
    options: [
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
        description: 'How random the answer is. Lower values make it more focused.',
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 2000,
        typeOptions: { minValue: 1 },
      },
    ],
  },
  {
    displayName: 'Reference Images',
    name: 'referenceImages',
    type: 'fixedCollection',
    placeholder: 'Add image',
    typeOptions: { multipleValues: true },
    default: { values: [{ inputType: 'url', imageUrl: '', binaryPropertyName: 'data' }] },
    description: 'The images Wan 2.6 Image edits (one to four)',
    displayOptions: { show: { resource: ['image'], operation: ['generate'], modelId: ['wan2.6-image'] } },
    options: [
      {
        displayName: 'Image',
        name: 'values',
        values: [
          {
            displayName: 'Input Type',
            name: 'inputType',
            type: 'options',
            default: 'url',
            options: [
              { name: 'URL', value: 'url' },
              { name: 'Binary Data', value: 'binary' },
            ],
          },
          {
            displayName: 'Image URL',
            name: 'imageUrl',
            type: 'string',
            default: '',
            placeholder: 'https://example.com/image.png',
            displayOptions: { show: { inputType: ['url'] } },
          },
          {
            displayName: 'Input Data Field Name',
            name: 'binaryPropertyName',
            type: 'string',
            default: 'data',
            placeholder: 'e.g. data',
            displayOptions: { show: { inputType: ['binary'] } },
          },
        ],
      },
    ],
  },
  {
    displayName: 'Download Image',
    name: 'downloadImage',
    type: 'boolean',
    default: true,
    description: 'Whether to download the image into a binary field. When off, only its link is returned.',
    displayOptions: generate,
  },
  {
    displayName: 'Options',
    name: 'imageOptions',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: generate,
    options: [
      sizeOption(
        ['z-image-turbo'],
        [
          ['1024x1024', '1024*1024'],
          ['720x1280', '720*1280'],
          ['1280x720', '1280*720'],
        ],
        '1024*1024',
      ),
      sizeOption(
        ['wan2.6-t2i', 'wan2.6-image'],
        [
          ['1104x1472 (3:4)', '1104*1472'],
          ['1280x1280 (1:1)', '1280*1280'],
          ['1472x1104 (4:3)', '1472*1104'],
          ['1696x960 (16:9)', '1696*960'],
          ['960x1696 (9:16)', '960*1696'],
        ],
        '1280*1280',
      ),
      sizeOption(
        ['qwen-image', 'qwen-image-plus', 'qwen-image-max'],
        [
          ['1104x1472 (3:4)', '1104*1472'],
          ['1328x1328 (1:1)', '1328*1328'],
          ['1472x1104 (4:3)', '1472*1104'],
          ['1664x928 (16:9)', '1664*928'],
          ['928x1664 (9:16)', '928*1664'],
        ],
        '1664*928',
      ),
      {
        displayName: 'Prompt Extend',
        name: 'promptExtend',
        type: 'boolean',
        default: false,
        description: 'Whether the service may rewrite the prompt to add detail',
      },
    ],
  },
];

/** Image > Analyze Image */
export async function imageAnalyze(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const model = readModel(ctx, itemIndex, DEFAULT_VISION_MODEL);
  const options = ctx.getNodeParameter('visionOptions', itemIndex, {}) as DataObject;
  const sources = await imageSources(
    ctx,
    itemIndex,
    String(ctx.getNodeParameter('inputType', itemIndex, 'url')),
    ctx.getNodeParameter('imageUrl', itemIndex, ''),
    ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data'),
  );
  if (!sources.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one image', { itemIndex });
  }
  const question = String(ctx.getNodeParameter('question', itemIndex, '')).trim() || "What's in this image?";
  const parameters: DataObject = {};
  const temperature = num(options.temperature);
  const maxTokens = num(options.maxTokens);
  if (temperature !== undefined) parameters.temperature = temperature;
  if (maxTokens !== undefined) parameters.max_tokens = maxTokens;
  const response = await qwenCall<{
    output?: { choices?: Array<{ message?: { content?: unknown } }> };
    usage?: unknown;
  }>(ctx, itemIndex, MULTIMODAL_PATH, {
    method: 'POST',
    body: {
      model,
      input: {
        messages: [{ role: 'user', content: [...sources.map((image) => ({ image })), { text: question }] }],
      },
      parameters,
    },
  });
  const content = contentText(response.output?.choices?.[0]?.message?.content);
  const json: DataObject =
    ctx.getNodeParameter('simplify', itemIndex, true) === false
      ? { content, model, usage: response.usage, fullResponse: response as DataObject }
      : { content };
  return { json, pairedItem: { item: itemIndex } };
}

/** the first image link in a finished task or sync answer */
function firstImageLink(output: DataObject | undefined): string {
  const choices = (output?.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? [];
  const content = choices[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const image = (part as { image?: unknown } | null)?.image;
      if (typeof image === 'string' && image) return image;
    }
  }
  for (const entry of (output?.results as Array<{ url?: unknown }> | undefined) ?? []) {
    if (typeof entry?.url === 'string' && entry.url) return entry.url;
  }
  return '';
}

function extensionOf(mimeType: string | undefined): { mime: string; ext: string } {
  const mime = mimeType?.startsWith('image/') ? mimeType : 'image/png';
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  return { mime, ext: ext === 'jpeg' ? 'jpg' : ext };
}

/** the reference images of Wan 2.6 Image: links go to the service as they are, binary files inline */
async function referenceSources(ctx: ExecuteContext, itemIndex: number): Promise<string[]> {
  const collection = ctx.getNodeParameter('referenceImages', itemIndex, {}) as {
    values?: Array<{ inputType?: string; imageUrl?: string; binaryPropertyName?: string }>;
  };
  const sources: string[] = [];
  for (const entry of collection.values ?? []) {
    if (entry.inputType === 'binary') {
      sources.push(...(await imageSources(ctx, itemIndex, 'binary', '', entry.binaryPropertyName || 'data')));
    } else if (String(entry.imageUrl ?? '').trim()) {
      sources.push(...(await imageSources(ctx, itemIndex, 'url', entry.imageUrl, '')));
    }
  }
  return sources;
}

/** Image > Generate an Image */
export async function imageGenerate(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const model = readModel(ctx, itemIndex, DEFAULT_IMAGE_MODEL);
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('imageOptions', itemIndex, {}) as DataObject;
  const wan = /^wan2\.6/.test(model);
  const edit = model === 'wan2.6-image';
  const references = edit ? await referenceSources(ctx, itemIndex) : [];
  if (edit && (references.length < 1 || references.length > MAX_REFERENCES)) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Add 1 to ${MAX_REFERENCES} reference images, or use a Wan t2i model for text only`,
      { itemIndex },
    );
  }
  const size = String(options.size ?? '').trim() || (wan ? '1280*1280' : '');
  if (size && !/^\d{2,5}\*\d{2,5}$/.test(size)) {
    throw new NodeOperationError(ctx.getNode(), 'The size must be width*height, for example 1280*1280', {
      itemIndex,
    });
  }
  const parameters: DataObject = { prompt_extend: options.promptExtend === true };
  if (wan) parameters.n = 1;
  if (size) parameters.size = size;
  const body = {
    model,
    input: {
      messages: [{ role: 'user', content: [{ text: prompt }, ...references.map((image) => ({ image }))] }],
    },
    parameters,
  };

  let output: DataObject;
  let usage: unknown;
  if (wan) {
    ({ output, usage } = await runTask(ctx, itemIndex, {
      path: IMAGE_GENERATION_PATH,
      body,
      intervalMs: pollTiming.imageIntervalMs,
      timeoutMs: pollTiming.imageTimeoutMs,
      what: 'image',
    }));
  } else {
    const sync = await qwenCall<{ output?: DataObject; usage?: unknown }>(ctx, itemIndex, MULTIMODAL_PATH, {
      method: 'POST',
      body,
    });
    output = sync.output ?? {};
    usage = sync.usage;
  }

  const imageUrl = firstImageLink(output);
  if (!imageUrl) throw new NodeOperationError(ctx.getNode(), 'Qwen Cloud returned no image', { itemIndex });
  const json: DataObject = { model, imageUrl, usage };
  if (ctx.getNodeParameter('downloadImage', itemIndex, true) === false) {
    return { json, pairedItem: { item: itemIndex } };
  }
  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    // the link is the vendor's storage, not the credential's host: no key goes there
    media = await downloadMedia(ctx, itemIndex, imageUrl);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
  const { mime, ext } = extensionOf(media.mimeType);
  return fileToItem(
    ctx,
    itemIndex,
    { bytes: media.bytes, mimeType: mime, fileName: `image.${ext}` },
    'data',
    json,
  );
}
