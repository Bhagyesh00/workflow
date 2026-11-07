/**
 * Qwen Cloud videos: Text to Video and Image to Video (Wan models) as async tasks on the video synthesis
 * endpoint. The finished video link is vendor storage, fetched with `downloadMedia` and no key.
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
import { num, pollTiming, readModel, runTask } from './text';

const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';

const t2v = { show: { resource: ['video'], operation: ['textToVideo'] } };
const i2v = { show: { resource: ['video'], operation: ['imageToVideo'] } };
const both = { show: { resource: ['video'], operation: ['textToVideo', 'imageToVideo'] } };

const optionList = (operation: 'textToVideo' | 'imageToVideo'): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  placeholder: 'Add option',
  default: {},
  displayOptions: operation === 'textToVideo' ? t2v : i2v,
  options: [
    {
      displayName: 'Audio',
      name: 'audio',
      type: 'boolean',
      default: true,
      description: 'Whether the video gets generated sound',
    },
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
      type: 'number',
      default: 5,
      typeOptions: { minValue: 2, maxValue: 15 },
    },
    { displayName: 'Prompt Extend', name: 'promptExtend', type: 'boolean', default: true },
    {
      displayName: 'Resolution',
      name: 'resolution',
      type: 'options',
      default: '1080P',
      options: [
        { name: '480P', value: '480P' },
        { name: '720P', value: '720P' },
        { name: '1080P', value: '1080P' },
      ],
    },
    {
      displayName: 'Shot Type',
      name: 'shotType',
      type: 'options',
      default: 'single',
      options: [
        { name: 'Single Shot', value: 'single' },
        { name: 'Multiple Shots', value: 'multi' },
      ],
    },
    { displayName: 'Seed', name: 'seed', type: 'number', default: 1234 },
    {
      displayName: 'Audio URL',
      name: 'audioUrl',
      type: 'string',
      default: '',
      description: 'Link of an audio file to use as the sound of the video',
    },
    {
      displayName: 'Audio Binary Field',
      name: 'audioField',
      type: 'string',
      default: '',
      description: 'Binary field with an audio file to use as the sound (sent inline)',
    },
  ],
});

export const videoProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'wan2.6-t2v',
    displayOptions: t2v,
    options: [
      { name: 'Wan 2.6', value: 'wan2.6-t2v' },
      { name: 'Wan 2.5 Preview', value: 'wan2.5-t2v-preview' },
      { name: 'Wan 2.2 Plus', value: 'wan2.2-t2v-plus' },
    ],
  },
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'wan2.6-i2v',
    displayOptions: i2v,
    options: [
      { name: 'Wan 2.6', value: 'wan2.6-i2v' },
      { name: 'Wan 2.5 Preview', value: 'wan2.5-i2v-preview' },
      { name: 'Wan 2.2 Flash', value: 'wan2.2-i2v-flash' },
    ],
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

async function generateVideo(ctx: ExecuteContext, itemIndex: number, imageToVideo: boolean): Promise<Item> {
  const model = readModel(ctx, itemIndex, imageToVideo ? 'wan2.6-i2v' : 'wan2.6-t2v');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;

  const input: DataObject = { prompt };
  if (imageToVideo) {
    const type = String(ctx.getNodeParameter('inputType', itemIndex, 'url'));
    if (type === 'binary') {
      const file = await readInputFile(ctx, itemIndex, {
        inputType: 'binary',
        binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
      });
      input.img_url = dataUrl(file.bytes, file.mimeType);
    } else {
      const link = String(ctx.getNodeParameter('imageUrl', itemIndex, '')).trim();
      if (!/^https?:\/\//i.test(link)) {
        throw new NodeOperationError(ctx.getNode(), 'The image link must start with http:// or https://', {
          itemIndex,
        });
      }
      input.img_url = link;
    }
  }
  const audioUrl = String(options.audioUrl ?? '').trim();
  const audioField = String(options.audioField ?? '').trim();
  if (audioUrl) {
    if (!/^https?:\/\//i.test(audioUrl)) {
      throw new NodeOperationError(ctx.getNode(), 'The audio link must start with http:// or https://', {
        itemIndex,
      });
    }
    input.audio_url = audioUrl;
  } else if (audioField) {
    const file = await readInputFile(ctx, itemIndex, { inputType: 'binary', binaryField: audioField });
    input.audio_url = dataUrl(file.bytes, file.mimeType);
  }

  const parameters: DataObject = {};
  if (typeof options.resolution === 'string') parameters.resolution = options.resolution;
  const duration = num(options.duration);
  if (duration !== undefined) parameters.duration = duration;
  if (typeof options.shotType === 'string') parameters.shot_type = options.shotType;
  if (options.promptExtend !== undefined) parameters.prompt_extend = options.promptExtend === true;
  if (options.audio !== undefined) parameters.audio = options.audio === true;
  const seed = num(options.seed);
  if (seed !== undefined) parameters.seed = seed;

  const output = await runTask(ctx, itemIndex, {
    path: VIDEO_PATH,
    body: { model, input, parameters },
    intervalMs: pollTiming.videoIntervalMs,
    timeoutMs: pollTiming.videoTimeoutMs,
    what: 'video',
  });
  const url = typeof output.video_url === 'string' ? output.video_url : '';
  if (!url) throw new NodeOperationError(ctx.getNode(), 'Qwen Cloud returned no video', { itemIndex });
  const taskId = typeof output.task_id === 'string' ? output.task_id : undefined;
  const json: DataObject = { url, ...(taskId ? { taskId } : {}) };
  if (options.downloadVideo === false) return { json, pairedItem: { item: itemIndex } };
  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    // the link is the vendor's storage, not the credential's host: no key goes there
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
