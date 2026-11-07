/** OpenAI video generation: start the job, poll it, then read the file from the credential's host. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { downloadMedia } from '../shared/api';
import { fileToItem, readBinaryFields } from '../shared/binary';
import { pollUntil } from '../shared/poll';
import { forOperation, OPENAI_CREDENTIAL, openAiBaseUrl, openAiCall } from './text';

const choices = (...values: string[]) => values.map((value) => ({ name: value, value }));

/** how often a running job is looked at; tests lower it */
export const videoPoll = { intervalMs: 5000 };

const generateProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'model',
    type: 'options',
    default: 'sora-2',
    options: choices('sora-2', 'sora-2-pro'),
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
    displayName: 'Seconds',
    name: 'seconds',
    type: 'options',
    default: '4',
    description: 'How long the video runs',
    options: choices('4', '8', '12'),
  },
  {
    displayName: 'Size',
    name: 'size',
    type: 'options',
    default: '1280x720',
    options: choices('720x1280', '1280x720', '1024x1792', '1792x1024'),
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Reference Image Field',
        name: 'referenceImage',
        type: 'string',
        default: '',
        description: 'The name of the binary field that holds an image the first frame should match',
      },
      {
        displayName: 'Wait Timeout',
        name: 'waitTimeout',
        type: 'number',
        default: 300,
        typeOptions: { minValue: 5, maxValue: 7200 },
        description: 'Seconds to wait for the video to be ready',
      },
      {
        displayName: 'Output Field Name',
        name: 'outputField',
        type: 'string',
        default: 'data',
        description: 'The name of the binary field the video goes to',
      },
    ],
  },
];

export const videoProperties: NodeProperty[] = forOperation('video', 'generate', generateProperties);

async function generate(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const prompt = String(ctx.getNodeParameter('prompt', itemIndex, ''));
  if (!prompt.trim()) throw new NodeOperationError(ctx.getNode(), 'Enter a prompt', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const body: Record<string, unknown> = {
    model: String(ctx.getNodeParameter('model', itemIndex, 'sora-2')),
    prompt,
    seconds: String(ctx.getNodeParameter('seconds', itemIndex, '4')),
    size: String(ctx.getNodeParameter('size', itemIndex, '1280x720')),
  };
  const referenceField = typeof options.referenceImage === 'string' ? options.referenceImage.trim() : '';
  if (referenceField) {
    const [image] = await readBinaryFields(ctx, itemIndex, referenceField);
    body.input_reference = {
      data: image!.bytes,
      fileName: image!.fileName ?? 'reference.png',
      mimeType: image!.mimeType,
    };
  }
  const started = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/videos`,
    method: 'POST',
    body,
    ...(referenceField ? { bodyType: 'multipart' as const } : {}),
  });
  const id = String(started.id ?? '');
  if (!id) throw new NodeOperationError(ctx.getNode(), 'OpenAI did not return a video ID', { itemIndex });

  const waitSeconds = options.waitTimeout !== undefined ? Number(options.waitTimeout) : 300;
  const finished = await pollUntil(
    () =>
      openAiCall<DataObject>(ctx, itemIndex, {
        url: `${baseUrl}/videos/${encodeURIComponent(id)}`,
        method: 'GET',
      }),
    (video) => ['completed', 'failed', 'cancelled'].includes(String(video.status)),
    {
      intervalMs: videoPoll.intervalMs,
      timeoutMs: waitSeconds * 1000,
      signal: ctx.signal,
      timeoutText: `The video was not ready after ${waitSeconds} seconds. Raise the Wait Timeout option, then look the video up by its ID: ${id}`,
    },
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith('The video was not ready')) {
      throw new NodeOperationError(ctx.getNode(), error.message, { itemIndex });
    }
    throw error;
  });
  if (finished.status !== 'completed') {
    const reason = (finished.error as DataObject | undefined)?.message;
    throw new NodeOperationError(
      ctx.getNode(),
      `The video ${String(finished.status)}${typeof reason === 'string' && reason ? `: ${reason}` : ''}`,
      { itemIndex },
    );
  }

  // the credential goes only to its own https host and never follows a redirect: a gateway may answer with
  // a link to storage, which is fetched again with no key and no custom header
  const content = await downloadMedia(ctx, itemIndex, `${baseUrl}/videos/${encodeURIComponent(id)}/content`, {
    credentialType: OPENAI_CREDENTIAL,
    authHost: new URL(baseUrl).hostname,
  });
  const field =
    typeof options.outputField === 'string' && options.outputField.trim() ? options.outputField : 'data';
  return fileToItem(
    ctx,
    itemIndex,
    { bytes: content.bytes, mimeType: 'video/mp4', fileName: `${id}.mp4` },
    field,
    {
      id,
      status: String(finished.status),
      model: String(finished.model ?? body.model),
      seconds: String(finished.seconds ?? body.seconds),
      size: String(finished.size ?? body.size),
    },
  );
}

export async function executeVideo(ctx: ExecuteContext, itemIndex: number, operation: string): Promise<Item> {
  if (operation !== 'generate') {
    throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
  return generate(ctx, itemIndex);
}
