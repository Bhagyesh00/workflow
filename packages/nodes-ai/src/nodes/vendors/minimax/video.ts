/**
 * MiniMax > Video > Text to Video and Image to Video (Hailuo models): create a task, poll
 * `query/video_generation` until it ends, look the file up with `files/retrieve`, and download it from the
 * link in the answer (vendor storage, no key).
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { downloadMedia, vendorError } from '../shared/api';
import { fileToItem, readInputFile } from '../shared/binary';
import { pollUntil } from '../shared/poll';
import { minimaxCall, num, readModel } from './text';

/** Poll timing of the video task; tests shorten the interval. */
export const pollTiming = { intervalMs: 10_000, timeoutMs: 20 * 60 * 1000 };

type Operation = 'textToVideo' | 'imageToVideo';

const when = (operation: Operation, extra: DataObject = {}) => ({
  show: { resource: ['video'], operation: [operation], ...extra },
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const models = (values: string[]) => values.map((v) => ({ name: v, value: v }));

const inputTypeOptions = (withNone: boolean) => [
  ...(withNone ? [{ name: 'None', value: 'none' }] : []),
  { name: 'URL', value: 'url' },
  { name: 'Binary File', value: 'binary' },
];

/** the image inputs of Image to Video besides the first frame: a last frame and a subject reference */
const imageInputOptions: NodeProperty[] = [
  {
    displayName: 'Last Frame Image Input Type',
    name: 'lastFrameInputType',
    type: 'options',
    default: 'none',
    options: inputTypeOptions(true),
    description: 'A last frame makes a first-and-last-frame video. Only some models support it.',
  },
  {
    displayName: 'Last Frame Image URL',
    name: 'lastFrameImageUrl',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/last-frame.jpg',
    displayOptions: { show: { lastFrameInputType: ['url'] } },
  },
  {
    displayName: 'Last Frame Data Field Name',
    name: 'lastFrameBinaryPropertyName',
    type: 'string',
    default: 'lastFrame',
    placeholder: 'e.g. lastFrame',
    displayOptions: { show: { lastFrameInputType: ['binary'] } },
  },
  {
    displayName: 'Subject Reference Input Type',
    name: 'subjectReferenceInputType',
    type: 'options',
    default: 'none',
    options: inputTypeOptions(true),
    description: 'A face photo for the same face across the video. Only MiniMax-Hailuo-2.3 supports it.',
  },
  {
    displayName: 'Subject Reference Image URL',
    name: 'subjectReferenceImageUrl',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/face.jpg',
    displayOptions: { show: { subjectReferenceInputType: ['url'] } },
  },
  {
    displayName: 'Subject Reference Data Field Name',
    name: 'subjectReferenceBinaryPropertyName',
    type: 'string',
    default: 'subjectReference',
    placeholder: 'e.g. subjectReference',
    displayOptions: { show: { subjectReferenceInputType: ['binary'] } },
  },
];

/** the parameters both operations have, shown for one operation */
const sharedProperties = (operation: Operation): NodeProperty[] => [
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: operation === 'textToVideo',
    typeOptions: { rows: 4 },
    placeholder:
      operation === 'textToVideo'
        ? 'e.g. A cat playing with a ball of yarn [Static shot]'
        : 'e.g. The subject smiles and waves at the camera [Zoom in]',
    description:
      operation === 'textToVideo'
        ? 'What the video should show (up to 2000 characters). Camera moves go in [brackets], such as [Push in].'
        : 'What the video should show (optional, up to 2000 characters). Camera moves go in [brackets].',
    displayOptions: when(operation),
  },
  {
    displayName: 'Duration (Seconds)',
    name: 'duration',
    type: 'options',
    default: 6,
    options: [
      { name: '6 Seconds', value: 6 },
      { name: '10 Seconds', value: 10 },
    ],
    displayOptions: when(operation),
  },
  {
    displayName: 'Resolution',
    name: 'resolution',
    type: 'options',
    default: '768P',
    options: [
      ...(operation === 'imageToVideo' ? [{ name: '512P', value: '512P' }] : []),
      { name: '720P', value: '720P' },
      { name: '768P', value: '768P' },
      { name: '1080P', value: '1080P' },
    ],
    displayOptions: when(operation),
  },
  {
    displayName: 'Download Video',
    name: 'downloadVideo',
    type: 'boolean',
    default: true,
    description: 'Whether to download the video into a binary field. When off, only its link is returned.',
    displayOptions: when(operation),
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: when(operation),
    options: [
      { displayName: 'Prompt Optimizer', name: 'promptOptimizer', type: 'boolean', default: true },
      ...(operation === 'imageToVideo' ? imageInputOptions : []),
    ],
  },
];

export const videoProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'MiniMax-Hailuo-2.3',
    displayOptions: when('textToVideo'),
    options: models(['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01']),
  },
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'MiniMax-Hailuo-2.3',
    displayOptions: when('imageToVideo'),
    options: models([
      'I2V-01',
      'I2V-01-Director',
      'I2V-01-live',
      'MiniMax-Hailuo-02',
      'MiniMax-Hailuo-2.3',
      'MiniMax-Hailuo-2.3-Fast',
    ]),
  },
  {
    displayName: 'Image Input Type',
    name: 'imageInputType',
    type: 'options',
    default: 'url',
    options: inputTypeOptions(false),
    displayOptions: when('imageToVideo'),
  },
  {
    displayName: 'Image URL',
    name: 'imageUrl',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://example.com/image.jpg',
    description: 'The first frame of the video',
    displayOptions: when('imageToVideo', { imageInputType: ['url'] }),
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    required: true,
    placeholder: 'e.g. data',
    displayOptions: when('imageToVideo', { imageInputType: ['binary'] }),
  },
  ...sharedProperties('textToVideo'),
  ...sharedProperties('imageToVideo'),
];

const dataUrl = (bytes: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

function checkLink(ctx: ExecuteContext, itemIndex: number, link: string, what: string): string {
  if (!/^https?:\/\//i.test(link)) {
    throw new NodeOperationError(ctx.getNode(), `The ${what} link must start with http:// or https://`, {
      itemIndex,
    });
  }
  return link;
}

/** an image input: a link (sent as it is) or a binary field (sent inline) */
async function imageInput(
  ctx: ExecuteContext,
  itemIndex: number,
  type: string,
  link: string,
  field: string,
  what: string,
): Promise<string> {
  if (type === 'binary') {
    const file = await readInputFile(ctx, itemIndex, { inputType: 'binary', binaryField: field });
    return dataUrl(file.bytes, file.mimeType);
  }
  return checkLink(ctx, itemIndex, link.trim(), what);
}

async function generateVideo(ctx: ExecuteContext, itemIndex: number, imageToVideo: boolean): Promise<Item> {
  const model = readModel(ctx, itemIndex, 'MiniMax-Hailuo-2.3');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  // the prompt of Image to Video is optional
  if (!prompt && !imageToVideo) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;

  const body: DataObject = { model, ...(prompt ? { prompt } : {}) };
  if (imageToVideo) {
    body.first_frame_image = await imageInput(
      ctx,
      itemIndex,
      String(ctx.getNodeParameter('imageInputType', itemIndex, 'url')),
      String(ctx.getNodeParameter('imageUrl', itemIndex, '')),
      String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
      'image',
    );
    const lastType = String(options.lastFrameInputType ?? 'none');
    if (lastType !== 'none') {
      body.last_frame_image = await imageInput(
        ctx,
        itemIndex,
        lastType,
        String(options.lastFrameImageUrl ?? ''),
        String(options.lastFrameBinaryPropertyName ?? '') || 'lastFrame',
        'last frame',
      );
    }
    const subjectType = String(options.subjectReferenceInputType ?? 'none');
    if (subjectType !== 'none') {
      body.subject_reference = [
        {
          image: await imageInput(
            ctx,
            itemIndex,
            subjectType,
            String(options.subjectReferenceImageUrl ?? ''),
            String(options.subjectReferenceBinaryPropertyName ?? '') || 'subjectReference',
            'subject reference',
          ),
        },
      ];
    }
  }
  const duration = num(ctx.getNodeParameter('duration', itemIndex, 6));
  if (duration !== undefined) body.duration = duration;
  const resolution = ctx.getNodeParameter('resolution', itemIndex, '768P');
  if (typeof resolution === 'string' && resolution) body.resolution = resolution;
  if (options.promptOptimizer !== undefined) body.prompt_optimizer = options.promptOptimizer === true;

  const created = await minimaxCall<{ task_id?: unknown }>(ctx, itemIndex, '/video_generation', {
    method: 'POST',
    body,
  });
  const taskId = typeof created.task_id === 'string' ? created.task_id : '';
  if (!IDENTIFIER.test(taskId)) {
    throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no usable task id', { itemIndex });
  }

  const state = await pollUntil(
    () =>
      minimaxCall<{ status?: unknown; file_id?: unknown }>(ctx, itemIndex, '/query/video_generation', {
        method: 'GET',
        qs: { task_id: taskId },
      }),
    (value) => value.status === 'Success' || value.status === 'Fail',
    {
      intervalMs: pollTiming.intervalMs,
      timeoutMs: pollTiming.timeoutMs,
      signal: ctx.signal,
      timeoutText: 'The video was not ready in time',
    },
  );
  if (state.status === 'Fail') {
    throw new NodeOperationError(ctx.getNode(), 'MiniMax could not generate the video', {
      itemIndex,
      description: 'The task failed on the MiniMax side. Check the prompt and the image, then try again.',
    });
  }
  const fileId = String(state.file_id ?? '');
  if (!IDENTIFIER.test(fileId)) {
    throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no video', { itemIndex });
  }
  const retrieved = await minimaxCall<{ file?: { download_url?: unknown } }>(
    ctx,
    itemIndex,
    '/files/retrieve',
    {
      method: 'GET',
      qs: { file_id: fileId },
    },
  );
  const url = typeof retrieved.file?.download_url === 'string' ? retrieved.file.download_url : '';
  if (!url) throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no video link', { itemIndex });

  const json: DataObject = { videoUrl: url, taskId, fileId };
  if (ctx.getNodeParameter('downloadVideo', itemIndex, true) === false) {
    return { json, pairedItem: { item: itemIndex } };
  }
  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    // the link is vendor storage, not the credential's host: no key goes there
    media = await downloadMedia(ctx, itemIndex, url);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
  const mime = media.mimeType?.startsWith('video/') ? media.mimeType : 'video/mp4';
  return fileToItem(
    ctx,
    itemIndex,
    { bytes: media.bytes, mimeType: mime, fileName: 'video.mp4' },
    'data',
    json,
  );
}

/** Video > Text to Video */
export const videoTextToVideo = (ctx: ExecuteContext, itemIndex: number) =>
  generateVideo(ctx, itemIndex, false);

/** Video > Image to Video */
export const videoImageToVideo = (ctx: ExecuteContext, itemIndex: number) =>
  generateVideo(ctx, itemIndex, true);
