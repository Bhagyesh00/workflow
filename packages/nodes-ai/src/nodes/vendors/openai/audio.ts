/** OpenAI audio operations: generate speech, transcribe and translate a recording. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { fileToItem, readBinaryFields } from '../shared/binary';
import { bytesOf, forOperation, openAiBaseUrl, openAiCall } from './text';

const choices = (...values: string[]) => values.map((value) => ({ name: value, value }));

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

const inputField: NodeProperty = {
  displayName: 'Input Data Field Name',
  name: 'binaryPropertyName',
  type: 'string',
  default: 'data',
  description: 'The name of the binary field that holds the recording',
};

const generateProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'model',
    type: 'options',
    default: 'tts-1',
    options: choices('tts-1', 'tts-1-hd'),
  },
  {
    displayName: 'Text Input',
    name: 'input',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { rows: 3 },
  },
  {
    displayName: 'Voice',
    name: 'voice',
    type: 'options',
    default: 'alloy',
    options: choices('alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'),
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Response Format',
        name: 'response_format',
        type: 'options',
        default: 'mp3',
        options: choices('mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'),
      },
      {
        displayName: 'Audio Speed',
        name: 'speed',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0.25, maxValue: 4, numberPrecision: 2 },
      },
      {
        displayName: 'Put Output in Field',
        name: 'binaryPropertyOutput',
        type: 'string',
        default: 'data',
        description: 'The name of the binary field the audio goes to',
      },
    ],
  },
];

const transcribeProperties: NodeProperty[] = [
  inputField,
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Language of the Audio File',
        name: 'language',
        type: 'string',
        default: '',
        description: 'The ISO-639-1 code of the language, such as "en". It improves accuracy and speed.',
      },
      {
        displayName: 'Output Randomness (Temperature)',
        name: 'temperature',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 1 },
      },
    ],
  },
];

const translateProperties: NodeProperty[] = [
  inputField,
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Output Randomness (Temperature)',
        name: 'temperature',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 1 },
      },
    ],
  },
];

export const audioProperties: NodeProperty[] = [
  ...forOperation('audio', 'generate', generateProperties),
  ...forOperation('audio', 'transcribe', transcribeProperties),
  ...forOperation('audio', 'translate', translateProperties),
];

async function generate(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const input = String(ctx.getNodeParameter('input', itemIndex, ''));
  if (!input.trim()) throw new NodeOperationError(ctx.getNode(), 'Enter the text to speak', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const format = String(options.response_format ?? 'mp3');
  const body: DataObject = {
    model: String(ctx.getNodeParameter('model', itemIndex, 'tts-1')),
    input,
    voice: String(ctx.getNodeParameter('voice', itemIndex, 'alloy')),
    response_format: format,
  };
  if (options.speed !== undefined) body.speed = Number(options.speed);
  const reply = await openAiCall<unknown>(ctx, itemIndex, {
    url: `${baseUrl}/audio/speech`,
    method: 'POST',
    body,
    responseType: 'arraybuffer',
    timeout: 300_000,
  });
  const field = typeof options.binaryPropertyOutput === 'string' ? options.binaryPropertyOutput : 'data';
  return fileToItem(
    ctx,
    itemIndex,
    { bytes: bytesOf(reply), mimeType: MIME_BY_FORMAT[format] ?? 'audio/mpeg', fileName: `speech.${format}` },
    field,
  );
}

async function transcribe(
  ctx: ExecuteContext,
  itemIndex: number,
  endpoint: 'transcriptions' | 'translations',
): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const [file] = await readBinaryFields(
    ctx,
    itemIndex,
    String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  );
  if (!file) throw new NodeOperationError(ctx.getNode(), 'The item has no recording', { itemIndex });
  // the multipart encoder takes the file part as { data, fileName, mimeType }
  const body: Record<string, unknown> = {
    file: { data: file.bytes, fileName: file.fileName ?? 'audio', mimeType: file.mimeType },
    model: 'whisper-1',
  };
  if (endpoint === 'transcriptions' && typeof options.language === 'string' && options.language.trim()) {
    body.language = options.language.trim();
  }
  if (options.temperature !== undefined) body.temperature = Number(options.temperature);
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/audio/${endpoint}`,
    method: 'POST',
    body,
    bodyType: 'multipart',
    timeout: 300_000,
  });
  return { json: response };
}

export async function executeAudio(ctx: ExecuteContext, itemIndex: number, operation: string): Promise<Item> {
  switch (operation) {
    case 'generate':
      return generate(ctx, itemIndex);
    case 'transcribe':
      return transcribe(ctx, itemIndex, 'transcriptions');
    case 'translate':
      return transcribe(ctx, itemIndex, 'translations');
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
