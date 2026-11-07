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
import { simplifyProperty } from '../shared/messages';
import { num, pollTiming, readModel, runTask } from './text';

const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';

type Operation = 'textToVideo' | 'imageToVideo';

const when = (operation: Operation, extra: DataObject = {}) => ({
  show: { resource: ['video'], operation: [operation], ...extra },
});

/** the options collection of one operation (n8n names them `videoOptions` and `imageToVideoOptions`) */
const optionList = (operation: Operation): NodeProperty => ({
  displayName: 'Options',
  name: operation === 'textToVideo' ? 'videoOptions' : 'imageToVideoOptions',
  type: 'collection',
  placeholder: 'Add option',
  default: {},
  displayOptions: when(operation),
  options: [
    {
      displayName: 'Prompt Extend',
      name: 'promptExtend',
      type: 'boolean',
      default: false,
      description: 'Whether the service may rewrite the prompt to add detail',
    },
    {
      displayName: 'Audio',
      name: 'audio',
      type: 'boolean',
      default: true,
      description: 'Whether the video gets generated sound',
    },
    {
      displayName: 'Audio Input Type',
      name: 'audioInputType',
      type: 'options',
      default: 'url',
      options: [
        { name: 'Audio URL', value: 'url' },
        { name: 'Binary File', value: 'binary' },
      ],
    },
    {
      displayName: 'Audio URL',
      name: 'audioUrl',
      type: 'string',
      default: '',
      placeholder: 'https://example.com/audio.mp3',
      description: 'Link of an audio file to use as the sound of the video',
      displayOptions: { show: { audioInputType: ['url'] } },
    },
    {
      displayName: 'Audio Data Field Name',
      name: 'audioBinaryPropertyName',
      type: 'string',
      default: 'audio',
      placeholder: 'e.g. audio',
      description: 'The name of the binary field with an audio file to use as the sound (sent inline)',
      displayOptions: { show: { audioInputType: ['binary'] } },
    },
  ],
});

/** the parameters both operations share, shown for one operation */
const sharedProperties = (operation: Operation): NodeProperty[] => [
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 4 },
    placeholder:
      operation === 'textToVideo' ? 'A cat playing with a ball of yarn' : 'A small cat running on the grass',
    description: 'What the video should show',
    displayOptions: when(operation),
  },
  {
    displayName: 'Resolution',
    name: 'resolution',
    type: 'options',
    default: '1080P',
    options: [
      { name: '720P', value: '720P' },
      { name: '1080P', value: '1080P' },
    ],
    displayOptions: when(operation),
  },
  {
    displayName: 'Duration (Seconds)',
    name: 'duration',
    type: 'number',
    default: 5,
    typeOptions: { minValue: 2, maxValue: 15 },
    displayOptions: when(operation),
  },
  {
    displayName: 'Shot Type',
    name: 'shotType',
    type: 'options',
    default: 'single',
    options: [
      { name: 'Single', value: 'single' },
      { name: 'Multi', value: 'multi' },
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
  { ...simplifyProperty(true), displayOptions: when(operation) },
  optionList(operation),
];

export const videoProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'wan2.6-t2v',
    displayOptions: when('textToVideo'),
    options: [{ name: 'Wan 2.6 Text-to-Video', value: 'wan2.6-t2v' }],
  },
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'wan2.6-i2v-flash',
    displayOptions: when('imageToVideo'),
    options: [
      { name: 'Wan 2.6 Image-to-Video Flash', value: 'wan2.6-i2v-flash' },
      { name: 'Wan 2.6 Image-to-Video', value: 'wan2.6-i2v' },
    ],
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
    displayOptions: when('imageToVideo'),
  },
  {
    displayName: 'Image URL',
    name: 'imgUrl',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://example.com/image.png',
    displayOptions: when('imageToVideo', { inputType: ['url'] }),
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    required: true,
    placeholder: 'e.g. data',
    displayOptions: when('imageToVideo', { inputType: ['binary'] }),
  },
  ...sharedProperties('textToVideo'),
  ...sharedProperties('imageToVideo'),
];

const dataUrl = (bytes: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

async function generateVideo(ctx: ExecuteContext, itemIndex: number, imageToVideo: boolean): Promise<Item> {
  const operation: Operation = imageToVideo ? 'imageToVideo' : 'textToVideo';
  const model = readModel(ctx, itemIndex, imageToVideo ? 'wan2.6-i2v-flash' : 'wan2.6-t2v');
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, '')).trim();
  if (!prompt) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter(
    operation === 'textToVideo' ? 'videoOptions' : 'imageToVideoOptions',
    itemIndex,
    {},
  ) as DataObject;

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
      const link = String(ctx.getNodeParameter('imgUrl', itemIndex, '')).trim();
      if (!/^https?:\/\//i.test(link)) {
        throw new NodeOperationError(ctx.getNode(), 'The image link must start with http:// or https://', {
          itemIndex,
        });
      }
      input.img_url = link;
    }
  }
  if (options.audioInputType === 'binary') {
    const file = await readInputFile(ctx, itemIndex, {
      inputType: 'binary',
      binaryField: String(options.audioBinaryPropertyName ?? '').trim() || 'audio',
    });
    input.audio_url = dataUrl(file.bytes, file.mimeType);
  } else {
    const audioUrl = String(options.audioUrl ?? '').trim();
    if (audioUrl) {
      if (!/^https?:\/\//i.test(audioUrl)) {
        throw new NodeOperationError(ctx.getNode(), 'The audio link must start with http:// or https://', {
          itemIndex,
        });
      }
      input.audio_url = audioUrl;
    }
  }

  const parameters: DataObject = {
    resolution: String(ctx.getNodeParameter('resolution', itemIndex, '1080P')),
    duration: num(ctx.getNodeParameter('duration', itemIndex, 5)) ?? 5,
    shot_type: String(ctx.getNodeParameter('shotType', itemIndex, 'single')),
  };
  if (options.promptExtend !== undefined) parameters.prompt_extend = options.promptExtend === true;
  if (options.audio !== undefined) parameters.audio = options.audio === true;

  const { output, usage } = await runTask(ctx, itemIndex, {
    path: VIDEO_PATH,
    body: { model, input, parameters },
    intervalMs: pollTiming.videoIntervalMs,
    timeoutMs: pollTiming.videoTimeoutMs,
    what: 'video',
  });
  const videoUrl = typeof output.video_url === 'string' ? output.video_url : '';
  if (!videoUrl) throw new NodeOperationError(ctx.getNode(), 'Qwen Cloud returned no video', { itemIndex });
  const json: DataObject =
    ctx.getNodeParameter('simplify', itemIndex, true) === false
      ? {
          videoUrl,
          model,
          taskId: output.task_id,
          usage,
          taskStatus: output.task_status,
          submitTime: output.submit_time,
          endTime: output.end_time,
        }
      : { videoUrl };
  if (ctx.getNodeParameter('downloadVideo', itemIndex, true) === false) {
    return { json, pairedItem: { item: itemIndex } };
  }
  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    // the link is the vendor's storage, not the credential's host: no key goes there
    media = await downloadMedia(ctx, itemIndex, videoUrl);
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
