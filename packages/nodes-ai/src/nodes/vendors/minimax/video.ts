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

const t2v = { show: { resource: ['video'], operation: ['textToVideo'] } };
const i2v = { show: { resource: ['video'], operation: ['imageToVideo'] } };
const both = { show: { resource: ['video'], operation: ['textToVideo', 'imageToVideo'] } };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const optionList = (operation: 'textToVideo' | 'imageToVideo'): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  placeholder: 'Add option',
  default: {},
  displayOptions: operation === 'textToVideo' ? t2v : i2v,
  options: [
    {
      displayName: 'Download Video',
      name: 'downloadVideo',
      type: 'boolean',
      default: true,
      description: 'Whether to download the video into a binary field instead of only returning its link',
    },
    {
      displayName: 'Duration (Seconds)',
      name: 'duration',
      type: 'options',
      default: 6,
      options: [
        { name: '6', value: 6 },
        { name: '10', value: 10 },
      ],
    },
    ...(operation === 'imageToVideo'
      ? ([
          {
            displayName: 'Last Frame URL',
            name: 'lastFrameUrl',
            type: 'string',
            default: '',
            description: 'Link of an image the video should end on (models that support it)',
          },
          {
            displayName: 'Last Frame Binary Field',
            name: 'lastFrameField',
            type: 'string',
            default: '',
            description: 'Binary field with the image the video should end on',
          },
        ] as NodeProperty[])
      : []),
    { displayName: 'Prompt Optimizer', name: 'promptOptimizer', type: 'boolean', default: true },
    {
      displayName: 'Resolution',
      name: 'resolution',
      type: 'options',
      default: '768P',
      options: [
        { name: '768P', value: '768P' },
        { name: '1080P', value: '1080P' },
      ],
    },
  ],
});

const models = (values: string[]) => values.map((v) => ({ name: v, value: v }));

export const videoProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'MiniMax-Hailuo-2.3',
    displayOptions: t2v,
    options: models(['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01']),
  },
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'MiniMax-Hailuo-2.3',
    displayOptions: i2v,
    options: models([
      'MiniMax-Hailuo-2.3',
      'MiniMax-Hailuo-2.3-Fast',
      'MiniMax-Hailuo-02',
      'I2V-01-Director',
      'I2V-01-live',
      'I2V-01',
    ]),
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
    description: 'What the video should show',
    displayOptions: both,
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'url',
    options: [
      { name: 'Image URL', value: 'url' },
      { name: 'Binary File', value: 'binary' },
    ],
    displayOptions: i2v,
  },
  {
    displayName: 'Image URL',
    name: 'imageUrl',
    type: 'string',
    default: '',
    description: 'The first frame of the video',
    displayOptions: { show: { resource: ['video'], operation: ['imageToVideo'], inputType: ['url'] } },
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: { show: { resource: ['video'], operation: ['imageToVideo'], inputType: ['binary'] } },
  },
  optionList('textToVideo'),
  optionList('imageToVideo'),
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

async function generateVideo(ctx: ExecuteContext, itemIndex: number, imageToVideo: boolean): Promise<Item> {
  const model = readModel(ctx, itemIndex, 'MiniMax-Hailuo-2.3');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;

  const body: DataObject = { model, prompt };
  if (imageToVideo) {
    const type = String(ctx.getNodeParameter('inputType', itemIndex, 'url'));
    if (type === 'binary') {
      const file = await readInputFile(ctx, itemIndex, {
        inputType: 'binary',
        binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
      });
      body.first_frame_image = dataUrl(file.bytes, file.mimeType);
    } else {
      body.first_frame_image = checkLink(
        ctx,
        itemIndex,
        String(ctx.getNodeParameter('imageUrl', itemIndex, '')).trim(),
        'image',
      );
    }
    const lastUrl = String(options.lastFrameUrl ?? '').trim();
    const lastField = String(options.lastFrameField ?? '').trim();
    if (lastUrl) {
      body.last_frame_image = checkLink(ctx, itemIndex, lastUrl, 'last frame');
    } else if (lastField) {
      const file = await readInputFile(ctx, itemIndex, { inputType: 'binary', binaryField: lastField });
      body.last_frame_image = dataUrl(file.bytes, file.mimeType);
    }
  }
  const duration = num(options.duration);
  if (duration !== undefined) body.duration = duration;
  if (typeof options.resolution === 'string') body.resolution = options.resolution;
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
  const retrieved = await minimaxCall<{ file?: { download_url?: unknown } }>(ctx, itemIndex, '/files/retrieve', {
    method: 'GET',
    qs: { file_id: fileId },
  });
  const url = typeof retrieved.file?.download_url === 'string' ? retrieved.file.download_url : '';
  if (!url) throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no video link', { itemIndex });

  const json: DataObject = { url, taskId, fileId };
  if (options.downloadVideo === false) return { json, pairedItem: { item: itemIndex } };
  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    // the link is vendor storage, not the credential's host: no key goes there
    media = await downloadMedia(ctx, itemIndex, url);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
  const mime = media.mimeType?.startsWith('video/') ? media.mimeType : 'video/mp4';
  return fileToItem(ctx, itemIndex, { bytes: media.bytes, mimeType: mime, fileName: 'video.mp4' }, 'data', json);
}

/** Video > Text to Video */
export const videoTextToVideo = (ctx: ExecuteContext, itemIndex: number) => generateVideo(ctx, itemIndex, false);

/** Video > Image to Video */
export const videoImageToVideo = (ctx: ExecuteContext, itemIndex: number) => generateVideo(ctx, itemIndex, true);
