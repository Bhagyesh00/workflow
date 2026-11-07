/**
 * MiniMax > Audio > Text to Speech: `t2a_v2`. The reply holds the audio as hex (decoded here) or as a link
 * (vendor storage, fetched with `downloadMedia` and no key).
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

const shown = { show: { resource: ['audio'], operation: ['textToSpeech'] } };

const FORMATS: Record<string, { mime: string; ext: string }> = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav' },
  flac: { mime: 'audio/flac', ext: 'flac' },
  pcm: { mime: 'audio/L16', ext: 'pcm' },
};

export const speechProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: 'speech-2.8-hd',
    displayOptions: shown,
    options: [
      'speech-2.8-hd',
      'speech-2.8-turbo',
      'speech-2.6-hd',
      'speech-2.6-turbo',
      'speech-02-hd',
      'speech-02-turbo',
    ].map((v) => ({ name: v, value: v })),
  },
  {
    displayName: 'Text',
    name: 'text',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
    description: 'The text to speak (up to 10000 characters)',
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
        displayName: 'Download Audio',
        name: 'downloadAudio',
        type: 'boolean',
        default: true,
        description: 'Whether to put the audio into a binary field instead of only returning a link to it',
      },
      {
        displayName: 'Emotion',
        name: 'emotion',
        type: 'options',
        default: 'happy',
        options: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'].map(
          (v) => ({ name: v.charAt(0).toUpperCase() + v.slice(1), value: v }),
        ),
      },
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'mp3',
        options: Object.keys(FORMATS).map((v) => ({ name: v.toUpperCase(), value: v })),
      },
      {
        displayName: 'Language Boost',
        name: 'languageBoost',
        type: 'string',
        default: '',
        placeholder: 'English',
        description: 'A language to favour, such as English, Chinese or auto',
      },
      {
        displayName: 'Pitch',
        name: 'pitch',
        type: 'number',
        default: 0,
        typeOptions: { minValue: -12, maxValue: 12 },
      },
      {
        displayName: 'Speed',
        name: 'speed',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0.5, maxValue: 2, numberPrecision: 2 },
      },
      {
        displayName: 'Voice ID',
        name: 'voiceId',
        type: 'string',
        default: 'English_Graceful_Lady',
      },
      {
        displayName: 'Volume',
        name: 'volume',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0.1, maxValue: 10, numberPrecision: 2 },
      },
    ],
  },
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Audio > Text to Speech */
export async function speechTextToSpeech(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const model = readModel(ctx, itemIndex, 'speech-2.8-hd');
  const text = String(ctx.getNodeParameter('text', itemIndex, '')).trim();
  if (!text) throw new NodeOperationError(ctx.getNode(), 'Enter the text to speak', { itemIndex });
  if (text.length > 10_000) {
    throw new NodeOperationError(ctx.getNode(), 'The text is longer than 10000 characters', { itemIndex });
  }
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const format = typeof options.format === 'string' && FORMATS[options.format] ? options.format : 'mp3';
  const download = options.downloadAudio !== false;

  const voice: DataObject = {
    voice_id: String(options.voiceId ?? '').trim() || 'English_Graceful_Lady',
  };
  const speed = num(options.speed);
  if (speed !== undefined) voice.speed = clamp(speed, 0.5, 2);
  const volume = num(options.volume);
  if (volume !== undefined) voice.vol = clamp(volume, 0.1, 10);
  const pitch = num(options.pitch);
  if (pitch !== undefined) voice.pitch = Math.round(clamp(pitch, -12, 12));
  if (typeof options.emotion === 'string' && options.emotion) voice.emotion = options.emotion;

  const body: DataObject = {
    model,
    text,
    stream: false,
    voice_setting: voice,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
    // without a download the call asks for a link, so no audio bytes pass through this node
    output_format: download ? 'hex' : 'url',
  };
  const boost = String(options.languageBoost ?? '').trim();
  if (boost) body.language_boost = boost;

  const reply = await minimaxCall<{ data?: { audio?: unknown } }>(ctx, itemIndex, '/t2a_v2', {
    method: 'POST',
    body,
  });
  const audio = typeof reply.data?.audio === 'string' ? reply.data.audio.trim() : '';
  if (!audio) throw new NodeOperationError(ctx.getNode(), 'MiniMax returned no audio', { itemIndex });
  const paired = { item: itemIndex };
  const isLink = /^https?:\/\//i.test(audio);
  if (!download) {
    if (!isLink) {
      throw new NodeOperationError(ctx.getNode(), 'MiniMax returned audio data instead of a link', { itemIndex });
    }
    return { json: { url: audio }, pairedItem: paired };
  }

  const { mime, ext } = FORMATS[format]!;
  const json: DataObject = isLink ? { url: audio } : {};
  let bytes: Uint8Array;
  if (isLink) {
    try {
      bytes = (await downloadMedia(ctx, itemIndex, audio)).bytes;
    } catch (error) {
      throw vendorError(ctx, error, itemIndex);
    }
  } else {
    if (audio.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(audio)) {
      throw new NodeOperationError(ctx.getNode(), 'MiniMax returned audio that is not valid hex', { itemIndex });
    }
    bytes = new Uint8Array(Buffer.from(audio, 'hex'));
  }
  return fileToItem(ctx, itemIndex, { bytes, mimeType: mime, fileName: `speech.${ext}` }, 'data', json);
}
