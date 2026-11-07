/**
 * Google Gemini media: analyze images, audio, video and documents, generate and edit images, generate
 * and download videos. Files up to 18 MB travel inline; a bigger one goes through the Files API first.
 * Video links come from the server, so they are downloaded with `downloadMedia` (the key only on the
 * credential's own host).
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { downloadMedia } from '../shared/api';
import { fileToItem, readBinaryFields, readInputFile, type VendorFile } from '../shared/binary';
import { uploadFile, waitForFile } from './files';
import {
  GEMINI_CREDENTIAL,
  geminiAuthHost,
  geminiCall,
  modelPath,
  pollTiming,
  readModelId,
  replyItems,
  waitForOperation,
} from './operations';

/** the largest file sent inside the request; bigger ones are uploaded first */
export const INLINE_LIMIT = 18 * 1024 * 1024;

export const DEFAULT_IMAGE_ANALYZE_MODEL = 'gemini-2.5-flash';
export const DEFAULT_IMAGE_GENERATE_MODEL = 'imagen-4.0-generate-001';
export const DEFAULT_IMAGE_EDIT_MODEL = 'gemini-2.5-flash-image';
export const DEFAULT_VIDEO_MODEL = 'veo-3.0-generate-001';

type Part = DataObject;

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

interface ReplyBody {
  candidates?: Array<{ content?: { parts?: unknown } }>;
}

/** the parts of the first candidate of a generateContent reply; a reply of another shape has none */
function firstParts(body: unknown): Part[] {
  const parts = (body as ReplyBody | null | undefined)?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? (parts as Part[]) : [];
}

/** the text of a generateContent reply (thought parts left out) */
export function replyText(body: unknown): string {
  return firstParts(body)
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('');
}

/** the images in a generateContent reply */
export function replyImages(body: unknown): Array<{ bytes: Uint8Array; mimeType: string }> {
  const images: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  for (const part of firstParts(body)) {
    const inline = (part.inlineData ?? part.inline_data) as
      | { data?: unknown; mimeType?: unknown; mime_type?: unknown }
      | undefined;
    if (inline?.data) {
      images.push({
        bytes: new Uint8Array(Buffer.from(String(inline.data), 'base64')),
        mimeType: String(inline.mimeType ?? inline.mime_type ?? 'image/png'),
      });
    }
  }
  return images;
}

/** a file item as n8n gives it: the file in the binary field and its details (without the data) as json */
async function mediaItem(
  ctx: ExecuteContext,
  itemIndex: number,
  file: VendorFile,
  field: string,
): Promise<Item> {
  const item = await fileToItem(ctx, itemIndex, file, field);
  const { data: _data, ...details } = Object.values(item.binary ?? {})[0] ?? {};
  return { ...item, json: details };
}

/** `models/<id>:generateContent` */
export async function generateContent(
  ctx: ExecuteContext,
  itemIndex: number,
  model: string,
  body: DataObject,
): Promise<DataObject> {
  return geminiCall(ctx, itemIndex, `${modelPath(model)}:generateContent`, { method: 'POST', body });
}

/** one file as a request part: inline, or uploaded to the Files API when it is large */
async function filePart(ctx: ExecuteContext, itemIndex: number, file: VendorFile): Promise<Part> {
  if (file.bytes.byteLength <= INLINE_LIMIT) {
    return { inlineData: { mimeType: file.mimeType, data: Buffer.from(file.bytes).toString('base64') } };
  }
  const uploaded = await waitForFile(ctx, itemIndex, await uploadFile(ctx, itemIndex, file));
  return { fileData: { mimeType: uploaded.mimeType ?? file.mimeType, fileUri: uploaded.uri } };
}

const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/** the files of a media operation: links and binary fields */
async function readFiles(ctx: ExecuteContext, itemIndex: number): Promise<VendorFile[]> {
  const files: VendorFile[] = [];
  if (ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url') {
    const urls = asString(ctx.getNodeParameter('url', itemIndex, ''))
      .split(/[,\n]/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (!urls.length) throw new NodeOperationError(ctx.getNode(), 'Enter the URL of the file', { itemIndex });
    for (const url of urls) files.push(await readInputFile(ctx, itemIndex, { inputType: 'url', url }));
  } else {
    files.push(
      ...(await readBinaryFields(
        ctx,
        itemIndex,
        asString(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
      )),
    );
  }
  return files;
}

interface AnalyzeKind {
  resource: 'image' | 'audio' | 'video' | 'document';
  /** a mime prefix or exact type the file must have, for a clear error */
  accepts: (mimeType: string) => boolean;
  noun: string;
  withYoutube?: boolean;
}

const KINDS: Record<string, AnalyzeKind> = {
  image: { resource: 'image', accepts: (m) => m.startsWith('image/'), noun: 'an image' },
  audio: { resource: 'audio', accepts: (m) => m.startsWith('audio/'), noun: 'audio' },
  video: { resource: 'video', accepts: (m) => m.startsWith('video/'), noun: 'a video', withYoutube: true },
  document: {
    resource: 'document',
    accepts: (m) => m === 'application/pdf' || m.startsWith('text/') || m === 'application/json',
    noun: 'a document',
  },
};

/** Analyze (or transcribe) a file with a prompt: the shared body of the media analyze operations */
async function analyze(
  ctx: ExecuteContext,
  itemIndex: number,
  kind: AnalyzeKind,
  prompt: string,
  defaultModel: string,
): Promise<Item[]> {
  const model = readModelId(ctx, itemIndex, defaultModel);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const parts: Part[] = [];
  const url = asString(ctx.getNodeParameter('url', itemIndex, '')).trim();
  const isLink = ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url';
  let youtube = false;
  if (kind.withYoutube && isLink) {
    try {
      youtube = YOUTUBE.has(new URL(url).hostname.toLowerCase());
    } catch {
      youtube = false;
    }
  }
  if (youtube) {
    // Gemini reads a public YouTube link itself
    parts.push({ fileData: { fileUri: url } });
  } else {
    for (const file of await readFiles(ctx, itemIndex)) {
      if (!kind.accepts(file.mimeType) && file.mimeType !== 'application/octet-stream') {
        throw new NodeOperationError(ctx.getNode(), `The file is ${file.mimeType}, not ${kind.noun}`, {
          itemIndex,
        });
      }
      parts.push(await filePart(ctx, itemIndex, file));
    }
  }
  parts.push({ text: prompt });
  const generationConfig: DataObject = {};
  const maxTokens = Number(options.maxOutputTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
  const reply = await generateContent(ctx, itemIndex, model, {
    contents: [{ role: 'user', parts }],
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  });
  return replyItems(reply, itemIndex, ctx.getNodeParameter('simplify', itemIndex, true) !== false);
}

export const imageAnalyze = (ctx: ExecuteContext, i: number) =>
  analyze(
    ctx,
    i,
    KINDS.image!,
    asString(ctx.getNodeParameter('prompt', i, '')) || 'What is in this image?',
    DEFAULT_IMAGE_ANALYZE_MODEL,
  );

export const documentAnalyze = (ctx: ExecuteContext, i: number) =>
  analyze(
    ctx,
    i,
    KINDS.document!,
    asString(ctx.getNodeParameter('prompt', i, '')) || 'Summarize this document.',
    DEFAULT_IMAGE_ANALYZE_MODEL,
  );

export const videoAnalyze = (ctx: ExecuteContext, i: number) =>
  analyze(
    ctx,
    i,
    KINDS.video!,
    asString(ctx.getNodeParameter('prompt', i, '')) || 'Describe this video.',
    DEFAULT_IMAGE_ANALYZE_MODEL,
  );

export const audioAnalyze = (ctx: ExecuteContext, i: number) =>
  analyze(
    ctx,
    i,
    KINDS.audio!,
    asString(ctx.getNodeParameter('prompt', i, '')) || 'Describe this audio.',
    DEFAULT_IMAGE_ANALYZE_MODEL,
  );

export function audioTranscribe(ctx: ExecuteContext, i: number): Promise<Item[]> {
  const options = ctx.getNodeParameter('options', i, {}) as DataObject;
  const start = asString(options.startTime).trim();
  const end = asString(options.endTime).trim();
  const range = start || end ? ` from ${start || 'the start'} to ${end || 'the end'}` : '';
  return analyze(
    ctx,
    i,
    KINDS.audio!,
    `Generate a transcript of the speech${range}. Return only the spoken words.`,
    DEFAULT_IMAGE_ANALYZE_MODEL,
  );
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

/** Image > Generate (Imagen `predict`): one item per picture */
export async function imageGenerate(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const model = readModelId(ctx, itemIndex, DEFAULT_IMAGE_GENERATE_MODEL);
  const prompt = asString(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const field = asString(options.binaryPropertyOutput).trim() || 'data';
  const reply = (await geminiCall(ctx, itemIndex, `${modelPath(model)}:predict`, {
    method: 'POST',
    body: {
      instances: [{ prompt }],
      parameters: { sampleCount: clamp(options.numberOfImages, 1, 4, 1) },
    },
  })) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
  const items: Item[] = [];
  for (const p of reply.predictions ?? []) {
    if (!p.bytesBase64Encoded) continue;
    items.push(
      await mediaItem(
        ctx,
        itemIndex,
        {
          bytes: new Uint8Array(Buffer.from(p.bytesBase64Encoded, 'base64')),
          mimeType: p.mimeType || 'image/png',
          fileName: 'image.png',
        },
        field,
      ),
    );
  }
  if (!items.length) {
    throw new NodeOperationError(ctx.getNode(), 'The model returned no image', {
      itemIndex,
      description: 'The prompt may have been blocked. Try a different prompt.',
    });
  }
  return items;
}

/** Image > Edit (an image model on `generateContent`): one item per picture */
export async function imageEdit(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const model = readModelId(ctx, itemIndex, DEFAULT_IMAGE_EDIT_MODEL);
  const prompt = asString(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const field = asString(options.binaryPropertyOutput).trim() || 'edited';
  const files = await readBinaryFields(
    ctx,
    itemIndex,
    asString(ctx.getNodeParameter('images', itemIndex, 'data')),
  );
  const parts: Part[] = [{ text: prompt }];
  for (const file of files) {
    if (!file.mimeType.startsWith('image/')) {
      throw new NodeOperationError(ctx.getNode(), `The file is ${file.mimeType}, not an image`, {
        itemIndex,
      });
    }
    parts.push({ inlineData: { mimeType: file.mimeType, data: Buffer.from(file.bytes).toString('base64') } });
  }
  const reply = await generateContent(ctx, itemIndex, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  const text = replyText(reply);
  const items: Item[] = [];
  for (const image of replyImages(reply)) {
    items.push(await mediaItem(ctx, itemIndex, { ...image, fileName: 'edited.png' }, field));
  }
  if (!items.length) {
    throw new NodeOperationError(ctx.getNode(), 'The model returned no image', {
      itemIndex,
      description: text || 'The request may have been blocked. Try a different prompt.',
    });
  }
  return items;
}

interface VeoResponse {
  generateVideoResponse?: {
    generatedSamples?: Array<{ video?: { uri?: string } }>;
    raiMediaFilteredReasons?: string[];
  };
}

/** Video > Generate (Veo): start the job, wait for it, then return the videos or their links */
export async function videoGenerate(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const model = readModelId(ctx, itemIndex, DEFAULT_VIDEO_MODEL);
  const prompt = asString(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const parameters: DataObject = {
    sampleCount: clamp(options.sampleCount, 1, 4, 1),
    durationSeconds: clamp(options.durationSeconds, 5, 8, 8),
    aspectRatio: asString(options.aspectRatio) || '16:9',
  };
  if (asString(options.personGeneration)) parameters.personGeneration = options.personGeneration;
  const started = (await geminiCall(ctx, itemIndex, `${modelPath(model)}:predictLongRunning`, {
    method: 'POST',
    body: { instances: [{ prompt }], parameters },
  })) as DataObject;
  const finished = await waitForOperation(ctx, itemIndex, started, {
    intervalMs: pollTiming.videoIntervalMs,
    timeoutMs: pollTiming.videoTimeoutMs,
    timeoutText: 'The video took too long to generate',
  });
  const response = (finished.response ?? {}) as VeoResponse;
  const uris = (response.generateVideoResponse?.generatedSamples ?? [])
    .map((s) => s.video?.uri)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (!uris.length) {
    const why = response.generateVideoResponse?.raiMediaFilteredReasons?.join(' ');
    throw new NodeOperationError(ctx.getNode(), 'The model returned no video', {
      itemIndex,
      description: why || 'The prompt may have been blocked. Try a different prompt.',
    });
  }
  if (asString(options.returnAs) === 'url') {
    return uris.map((uri) => ({ json: { url: uri }, pairedItem: { item: itemIndex } }));
  }
  const field = asString(options.binaryPropertyOutput).trim() || 'data';
  const items: Item[] = [];
  for (const uri of uris) items.push(await fetchVideo(ctx, itemIndex, uri, field));
  return items;
}

/** download a video link: the key goes only when the link is on the credential's host */
async function fetchVideo(ctx: ExecuteContext, itemIndex: number, uri: string, field: string): Promise<Item> {
  const file = await downloadMedia(ctx, itemIndex, uri, {
    credentialType: GEMINI_CREDENTIAL,
    authHost: await geminiAuthHost(ctx, itemIndex),
  });
  return mediaItem(
    ctx,
    itemIndex,
    {
      bytes: file.bytes,
      mimeType: file.mimeType?.startsWith('video/') ? file.mimeType : 'video/mp4',
      fileName: 'video.mp4',
    },
    field,
  );
}

/** Video > Download */
export async function videoDownload(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const url = asString(ctx.getNodeParameter('url', itemIndex, '')).trim();
  if (!url) throw new NodeOperationError(ctx.getNode(), 'Enter the URL of the video', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  return fetchVideo(ctx, itemIndex, url, asString(options.binaryPropertyOutput).trim() || 'data');
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

const when = (resource: string, operation: string, extra: Record<string, unknown> = {}) => ({
  show: { resource: [resource], operation: [operation], ...extra },
});

const promptProperty = (resource: string, operation: string, placeholder: string): NodeProperty => ({
  displayName: 'Prompt',
  name: 'prompt',
  type: 'string',
  default: '',
  placeholder,
  typeOptions: { rows: 3 },
  displayOptions: when(resource, operation),
});

/** Input Type / URL / binary field for the operations that read files */
function inputProperties(resource: string, operations: string[], plural: boolean): NodeProperty[] {
  const show = { resource: [resource], operation: operations };
  return [
    {
      displayName: 'Input Type',
      name: 'inputType',
      type: 'options',
      default: 'binary',
      displayOptions: { show },
      options: [
        { name: 'Binary File(s)', value: 'binary' },
        { name: 'URL(s)', value: 'url' },
      ],
    },
    {
      displayName: plural ? 'URL(s)' : 'URL',
      name: 'url',
      type: 'string',
      default: '',
      placeholder: plural
        ? 'https://example.com/a.png, https://example.com/b.png'
        : 'https://example.com/file',
      ...(plural ? { description: 'One or more links, separated by commas' } : {}),
      displayOptions: { show: { ...show, inputType: ['url'] } },
    },
    {
      displayName: 'Input Data Field Name(s)',
      name: 'binaryPropertyName',
      type: 'string',
      default: 'data',
      description:
        'The names of the binary fields of the input item that hold the files, separated by commas',
      displayOptions: { show: { ...show, inputType: ['binary'] } },
    },
  ];
}

const simplifyOutput = (resource: string, operations: string[]): NodeProperty => ({
  displayName: 'Simplify Output',
  name: 'simplify',
  type: 'boolean',
  default: true,
  description: 'Whether to return a simplified version of the response instead of the raw data',
  displayOptions: { show: { resource: [resource], operation: operations } },
});

const outputField = (defaultValue: string): NodeProperty => ({
  displayName: 'Put Output in Field',
  name: 'binaryPropertyOutput',
  type: 'string',
  default: defaultValue,
  description: 'The name of the output field that holds the file',
});

const maxTokensOption = (defaultValue?: number): NodeProperty => ({
  displayName: 'Max Tokens',
  name: 'maxOutputTokens',
  type: 'number',
  default: defaultValue ?? 1024,
  typeOptions: { minValue: 1 },
  description: 'The most tokens the answer may have',
});

const optionsCollection = (resource: string, operation: string, options: NodeProperty[]): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  displayOptions: when(resource, operation),
  options,
});

/** the parameters of the Image, Audio, Video and Document resources (models come from the node) */
export const mediaProperties: NodeProperty[] = [
  // image
  promptProperty('image', 'analyze', "What's in this image?"),
  ...inputProperties('image', ['analyze'], true),
  simplifyOutput('image', ['analyze']),
  optionsCollection('image', 'analyze', [maxTokensOption(300)]),
  promptProperty('image', 'generate', 'A watercolor lighthouse at dawn'),
  optionsCollection('image', 'generate', [
    {
      displayName: 'Number of Images',
      name: 'numberOfImages',
      type: 'number',
      default: 1,
      typeOptions: { minValue: 1, maxValue: 4 },
    },
    outputField('data'),
  ]),
  promptProperty('image', 'edit', 'Make the sky purple'),
  {
    displayName: 'Images',
    name: 'images',
    type: 'string',
    default: 'data',
    description: 'The names of the binary fields of the input item that hold the images, separated by commas',
    displayOptions: when('image', 'edit'),
  },
  optionsCollection('image', 'edit', [outputField('edited')]),
  // audio
  ...inputProperties('audio', ['transcribe', 'analyze'], true),
  promptProperty('audio', 'analyze', 'What is said in this recording?'),
  simplifyOutput('audio', ['transcribe', 'analyze']),
  optionsCollection('audio', 'transcribe', [
    { displayName: 'Start Time', name: 'startTime', type: 'string', default: '', placeholder: '00:30' },
    { displayName: 'End Time', name: 'endTime', type: 'string', default: '', placeholder: '02:15' },
  ]),
  optionsCollection('audio', 'analyze', [maxTokensOption()]),
  // video
  ...inputProperties('video', ['analyze'], false),
  promptProperty('video', 'analyze', 'Describe what happens'),
  simplifyOutput('video', ['analyze']),
  optionsCollection('video', 'analyze', [maxTokensOption()]),
  promptProperty('video', 'generate', 'A paper boat crossing a puddle'),
  optionsCollection('video', 'generate', [
    {
      displayName: 'Return As',
      name: 'returnAs',
      type: 'options',
      default: 'video',
      options: [
        { name: 'Video', value: 'video' },
        { name: 'URL', value: 'url' },
      ],
      description: 'A URL needs the API key to download, so it is only a link',
    },
    {
      displayName: 'Number of Videos',
      name: 'sampleCount',
      type: 'number',
      default: 1,
      typeOptions: { minValue: 1, maxValue: 4 },
    },
    {
      displayName: 'Duration in Seconds',
      name: 'durationSeconds',
      type: 'number',
      default: 8,
      typeOptions: { minValue: 5, maxValue: 8 },
    },
    {
      displayName: 'Aspect Ratio',
      name: 'aspectRatio',
      type: 'options',
      default: '16:9',
      options: [
        { name: '16:9', value: '16:9' },
        { name: '9:16', value: '9:16' },
      ],
    },
    {
      displayName: 'Person Generation',
      name: 'personGeneration',
      type: 'options',
      default: '',
      options: [
        { name: 'Model Default', value: '' },
        { name: "Don't Allow", value: 'dont_allow' },
        { name: 'Allow Adults', value: 'allow_adult' },
        { name: 'Allow All', value: 'allow_all' },
      ],
    },
    outputField('data'),
  ]),
  {
    displayName: 'URL',
    name: 'url',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media',
    description: 'The link of a generated video',
    displayOptions: when('video', 'download'),
  },
  optionsCollection('video', 'download', [outputField('data')]),
  // document
  ...inputProperties('document', ['analyze'], true),
  promptProperty('document', 'analyze', 'Summarize this document'),
  simplifyOutput('document', ['analyze']),
  optionsCollection('document', 'analyze', [maxTokensOption()]),
];
