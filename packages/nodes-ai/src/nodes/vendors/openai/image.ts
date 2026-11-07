/** OpenAI image operations: generate, analyze (Responses API with the image and its Detail) and edit. */
import {
  type AiContentPart,
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { openAiResponsesAdapter } from '../../../providers/openai-responses';
import { downloadMedia, vendorError } from '../shared/api';
import { fileToItem, readBinaryFields, readInputFile, type VendorFile } from '../shared/binary';
import { runVendorChat } from '../shared/tool-loop';
import {
  forOperation,
  modelLocator,
  OPENAI_CREDENTIAL,
  OPENAI_ERROR_TEXTS,
  openAiBaseUrl,
  openAiCall,
  readLocator,
} from './text';

const choices = (...values: string[]) => values.map((value) => ({ name: value, value }));

const sizeOption: NodeProperty = {
  displayName: 'Resolution',
  name: 'size',
  type: 'options',
  default: '1024x1024',
  description: 'The size of the image. The sizes a model accepts differ; "auto" is for GPT Image models.',
  options: choices(
    '256x256',
    '512x512',
    '1024x1024',
    '1024x1536',
    '1536x1024',
    '1792x1024',
    '1024x1792',
    'auto',
  ),
};

const generateProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'model',
    type: 'options',
    default: 'dall-e-3',
    options: choices('dall-e-3', 'dall-e-2', 'gpt-image-1'),
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Number of Images',
        name: 'n',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 10 },
        description: 'How many images to make. DALL-E 3 makes one.',
      },
      {
        displayName: 'Quality',
        name: 'quality',
        type: 'options',
        default: 'auto',
        description: '"Standard" and "HD" are for DALL-E 3, "Low", "Medium", "High" and "Auto" for GPT Image',
        options: choices('auto', 'low', 'medium', 'high', 'standard', 'hd'),
      },
      sizeOption,
      {
        displayName: 'Style',
        name: 'style',
        type: 'options',
        default: 'vivid',
        description: 'For DALL-E 3 only',
        options: choices('natural', 'vivid'),
      },
      {
        displayName: 'Return Image URLs',
        name: 'returnImageUrls',
        type: 'boolean',
        default: false,
        description: 'Whether to return links instead of binary files. GPT Image models always return files.',
      },
    ],
  },
];

const analyzeProperties: NodeProperty[] = [
  modelLocator('gpt-5-mini'),
  {
    displayName: 'Text Input',
    name: 'text',
    type: 'string',
    default: "What's in this image?",
    typeOptions: { rows: 2 },
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'url',
    options: [
      { name: 'Image URL(s)', value: 'url' },
      { name: 'Binary File(s)', value: 'base64' },
    ],
  },
  {
    displayName: 'URL(s)',
    name: 'imageUrls',
    type: 'string',
    default: '',
    description: 'Comma separated links of the images',
    displayOptions: { show: { inputType: ['url'] } },
  },
  {
    displayName: 'Input Data Field Name(s)',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    description: 'Comma separated names of the binary fields that hold the images',
    displayOptions: { show: { inputType: ['base64'] } },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Detail',
        name: 'detail',
        type: 'options',
        default: 'auto',
        options: choices('auto', 'low', 'high'),
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 300,
        typeOptions: { minValue: 1 },
      },
    ],
  },
];

const editProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'model',
    type: 'options',
    default: 'gpt-image-1',
    options: choices('gpt-image-1', 'dall-e-2'),
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
  },
  {
    displayName: 'Image(s)',
    name: 'images',
    type: 'string',
    default: 'data',
    description: 'Comma separated names of the binary fields that hold the images to edit',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Number of Images',
        name: 'n',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 10 },
      },
      sizeOption,
      {
        displayName: 'Quality',
        name: 'quality',
        type: 'options',
        default: 'auto',
        options: choices('auto', 'low', 'medium', 'high'),
      },
      {
        displayName: 'Output Format',
        name: 'outputFormat',
        type: 'options',
        default: 'png',
        options: choices('png', 'jpeg', 'webp'),
      },
      {
        displayName: 'Output Compression',
        name: 'outputCompression',
        type: 'number',
        default: 100,
        typeOptions: { minValue: 0, maxValue: 100 },
        description: 'For JPEG and WebP output',
      },
      {
        displayName: 'Background',
        name: 'background',
        type: 'options',
        default: 'auto',
        options: choices('auto', 'transparent', 'opaque'),
      },
      {
        displayName: 'Input Fidelity',
        name: 'inputFidelity',
        type: 'options',
        default: 'low',
        options: choices('low', 'high'),
      },
      {
        displayName: 'Image Mask Field',
        name: 'mask',
        type: 'string',
        default: '',
        description: 'The name of the binary field that holds the mask',
      },
    ],
  },
];

export const imageProperties: NodeProperty[] = [
  ...forOperation('image', 'generate', generateProperties),
  ...forOperation('image', 'analyze', analyzeProperties),
  ...forOperation('image', 'edit', editProperties),
];

const MIME_BY_FORMAT: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The images of an images reply as items: files (b64 or downloaded), or links when asked. */
async function imageItems(
  ctx: ExecuteContext,
  itemIndex: number,
  response: DataObject,
  returnUrls: boolean,
): Promise<Item[]> {
  const format = String(response.output_format ?? 'png');
  const mimeType = MIME_BY_FORMAT[format] ?? 'image/png';
  const entries = (response.data as DataObject[] | undefined) ?? [];
  if (!entries.length) {
    throw new NodeOperationError(ctx.getNode(), 'OpenAI returned no image', { itemIndex });
  }
  const items: Item[] = [];
  let count = 0;
  for (const entry of entries) {
    const json: DataObject = entry.revised_prompt ? { revised_prompt: entry.revised_prompt } : {};
    if (returnUrls && typeof entry.url === 'string') {
      items.push({ json: { ...json, url: entry.url } });
      continue;
    }
    count++;
    let file: VendorFile;
    if (typeof entry.b64_json === 'string') {
      file = {
        bytes: Uint8Array.from(Buffer.from(entry.b64_json, 'base64')),
        mimeType,
        fileName: `image-${count}.${format}`,
      };
    } else if (typeof entry.url === 'string') {
      // the link is the vendor's storage, not the credential's host: it is fetched without the key
      const media = await downloadMedia(ctx, itemIndex, entry.url);
      file = { bytes: media.bytes, mimeType: media.mimeType ?? mimeType, fileName: `image-${count}.png` };
    } else {
      throw new NodeOperationError(ctx.getNode(), 'OpenAI returned an image without data', { itemIndex });
    }
    items.push(await fileToItem(ctx, itemIndex, file, 'data', json));
  }
  return items;
}

async function generate(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const model = String(ctx.getNodeParameter('model', itemIndex, 'dall-e-3'));
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, ''));
  if (!prompt.trim()) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const gptImage = model.startsWith('gpt-image');
  const returnUrls = options.returnImageUrls === true && !gptImage;
  const body: DataObject = { model, prompt };
  if (options.n !== undefined) body.n = Number(options.n);
  if (options.quality && options.quality !== 'auto') body.quality = options.quality;
  if (options.size && options.size !== 'auto') body.size = options.size;
  if (options.style && model === 'dall-e-3') body.style = options.style;
  // GPT Image models take no response format: they always answer with base64
  if (!gptImage) body.response_format = returnUrls ? 'url' : 'b64_json';
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/images/generations`,
    method: 'POST',
    body,
    timeout: 300_000,
  });
  return imageItems(ctx, itemIndex, response, returnUrls);
}

async function analyze(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const model = readLocator(ctx, itemIndex, 'modelId', 'model');
  const text = String(ctx.getNodeParameter('text', itemIndex, "What's in this image?"));
  const inputType = ctx.getNodeParameter('inputType', itemIndex, 'url');
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const detail = (['low', 'high'].includes(String(options.detail)) ? options.detail : 'auto') as
    | 'auto'
    | 'low'
    | 'high';

  let files: VendorFile[];
  if (inputType === 'base64') {
    files = await readBinaryFields(
      ctx,
      itemIndex,
      String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
    );
  } else {
    const urls = String(ctx.getNodeParameter('imageUrls', itemIndex, ''))
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (!urls.length) throw new NodeOperationError(ctx.getNode(), 'Enter the URL of an image', { itemIndex });
    files = [];
    for (const url of urls) files.push(await readInputFile(ctx, itemIndex, { inputType: 'url', url }));
  }
  const parts: AiContentPart[] = [
    { type: 'text', text },
    ...files.map(
      (file): AiContentPart => ({
        type: 'image',
        mimeType: file.mimeType.startsWith('image/') ? file.mimeType : 'image/png',
        data: Buffer.from(file.bytes).toString('base64'),
        detail,
      }),
    ),
  ];
  const adapter = openAiResponsesAdapter({
    baseUrl,
    model,
    credentialType: OPENAI_CREDENTIAL,
    maxTokens: options.maxTokens !== undefined ? Number(options.maxTokens) : 300,
  });
  try {
    const result = await runVendorChat(ctx, itemIndex, adapter, {
      messages: [{ role: 'user', content: parts }],
      maxIterations: 1,
      useTools: false,
    });
    const raw = (result.raw ?? {}) as DataObject;
    return {
      json: { text: result.text, ...(raw.model ? { model: raw.model } : {}) } as DataObject,
    };
  } catch (error) {
    throw vendorError(ctx, error, itemIndex, OPENAI_ERROR_TEXTS);
  }
}

async function edit(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const model = String(ctx.getNodeParameter('model', itemIndex, 'gpt-image-1'));
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, ''));
  if (!prompt.trim()) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const images = await readBinaryFields(
    ctx,
    itemIndex,
    String(ctx.getNodeParameter('images', itemIndex, 'data')),
  );
  const body: Record<string, unknown> = {
    model,
    prompt,
    'image[]': images.map((file, index) => ({
      data: file.bytes,
      fileName: file.fileName ?? `image-${index + 1}.png`,
      mimeType: file.mimeType,
    })),
  };
  const maskField = typeof options.mask === 'string' ? options.mask.trim() : '';
  if (maskField) {
    const [mask] = await readBinaryFields(ctx, itemIndex, maskField);
    body.mask = { data: mask!.bytes, fileName: mask!.fileName ?? 'mask.png', mimeType: mask!.mimeType };
  }
  if (options.n !== undefined) body.n = Number(options.n);
  if (options.size && options.size !== 'auto') body.size = options.size;
  if (options.quality && options.quality !== 'auto') body.quality = options.quality;
  if (options.outputFormat) body.output_format = options.outputFormat;
  if (options.outputCompression !== undefined) body.output_compression = Number(options.outputCompression);
  if (options.background && options.background !== 'auto') body.background = options.background;
  if (options.inputFidelity) body.input_fidelity = options.inputFidelity;
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/images/edits`,
    method: 'POST',
    body,
    bodyType: 'multipart',
    timeout: 300_000,
  });
  return imageItems(ctx, itemIndex, response, false);
}

export async function executeImage(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: string,
): Promise<Item | Item[]> {
  switch (operation) {
    case 'generate':
      return generate(ctx, itemIndex);
    case 'analyze':
      return analyze(ctx, itemIndex);
    case 'edit':
      return edit(ctx, itemIndex);
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
