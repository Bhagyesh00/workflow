/**
 * Input files for the Agent: images, PDFs and text files of the input item go to the model with the
 * prompt. Every file is checked against the instance cap before it is read or any request is made.
 */
import {
  type AiContentPart,
  type BinaryData,
  type ExecuteContext,
  type Item,
  NodeOperationError,
} from '@workflow/workflow';

export interface PassthroughSettings {
  /** send images as image parts */
  images: boolean;
  /** send PDFs as file parts and text files as text */
  files: boolean;
}

const MB = 1024 * 1024;

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
  'application/javascript',
  'application/x-ndjson',
]);

function isImage(binary: BinaryData): boolean {
  return Boolean(binary.mimeType?.startsWith('image/'));
}

function isPdf(binary: BinaryData): boolean {
  return binary.mimeType === 'application/pdf';
}

function isText(binary: BinaryData): boolean {
  const mime = binary.mimeType ?? '';
  return mime.startsWith('text/') || TEXT_TYPES.has(mime) || mime.endsWith('+json') || mime.endsWith('+xml');
}

function megabytes(bytes: number): string {
  return String(Number((bytes / MB).toFixed(1)));
}

export const PASSTHROUGH_HINT =
  'Use a smaller file, or turn off the binary passthrough options of the agent.';

/**
 * The parts to add after the prompt text. A file over the cap throws before it is read when its size is
 * known, and always before the parts are returned, so no model request is made for it.
 */
export async function binaryParts(
  ctx: ExecuteContext,
  itemIndex: number,
  item: Item,
  settings: PassthroughSettings,
): Promise<AiContentPart[]> {
  const limit = ctx.helpers.getInstanceLimits().maxPassthroughBinaryBytes;
  const parts: AiContentPart[] = [];
  let total = 0;
  const tooBig = (name: string, bytes: number) =>
    new NodeOperationError(
      ctx.getNode(),
      `The file "${name}" is ${megabytes(bytes)} MB, which exceeds the ${megabytes(limit)} MB limit for passing binary data to the model`,
      { itemIndex, description: PASSTHROUGH_HINT },
    );

  for (const [key, binary] of Object.entries(item.binary ?? {})) {
    const image = settings.images && isImage(binary);
    const pdf = settings.files && isPdf(binary);
    const text = settings.files && !image && !pdf && isText(binary);
    if (!image && !pdf && !text) continue;
    const name = binary.fileName ?? key;
    if (typeof binary.fileSize === 'number' && binary.fileSize > limit) throw tooBig(name, binary.fileSize);

    const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, key);
    if (data.byteLength > limit) throw tooBig(name, data.byteLength);
    total += data.byteLength;
    if (total > limit) {
      throw new NodeOperationError(
        ctx.getNode(),
        `The files for the model total ${megabytes(total)} MB, which exceeds the ${megabytes(limit)} MB limit for passing binary data to the model`,
        { itemIndex, description: PASSTHROUGH_HINT },
      );
    }
    if (text) {
      parts.push({ type: 'text', text: `File: ${name}\nContent:\n${Buffer.from(data).toString('utf8')}` });
    } else {
      parts.push({
        type: image ? 'image' : 'file',
        mimeType: binary.mimeType,
        data: Buffer.from(data).toString('base64'),
        ...(image ? {} : { fileName: name }),
      } as AiContentPart);
    }
  }
  return parts;
}
