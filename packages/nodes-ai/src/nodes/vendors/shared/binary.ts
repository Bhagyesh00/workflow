/**
 * Files in and out of vendor nodes: input binary fields and URLs to bytes (size capped by the instance
 * limits), bytes to an output item.
 */
import { type DataObject, type ExecuteContext, type Item, NodeOperationError } from '@workflow/workflow';
import { downloadMedia } from './api';

export interface VendorFile {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
}

const MB = 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function mimeFromName(fileName: string | undefined): string {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream';
}

/** a malformed percent sequence in a link keeps the raw text */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const megabytes = (bytes: number) => String(Number((bytes / MB).toFixed(1)));

function tooBig(ctx: ExecuteContext, itemIndex: number, name: string, bytes: number, limit: number) {
  return new NodeOperationError(
    ctx.getNode(),
    `The file "${name}" is ${megabytes(bytes)} MB, which exceeds the ${megabytes(limit)} MB limit for sending files to the model`,
    { itemIndex, description: 'Use a smaller file.' },
  );
}

/** The binary fields named in `fields` (comma separated; empty means `data`) of the item. */
export async function readBinaryFields(
  ctx: ExecuteContext,
  itemIndex: number,
  fields: string,
): Promise<VendorFile[]> {
  const names = fields
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) names.push('data');
  const limit = ctx.helpers.getInstanceLimits().maxPassthroughBinaryBytes;
  const item = ctx.getInputData()[itemIndex];
  const files: VendorFile[] = [];
  let total = 0;
  for (const name of [...new Set(names)]) {
    const binary = item?.binary?.[name];
    if (!binary) {
      throw new NodeOperationError(ctx.getNode(), `The item has no binary data in the field "${name}"`, {
        itemIndex,
        description: 'Name a binary field of the input item, such as "data".',
      });
    }
    // the stored size is checked before the bytes are read
    if (typeof binary.fileSize === 'number' && binary.fileSize > limit) {
      throw tooBig(ctx, itemIndex, binary.fileName ?? name, binary.fileSize, limit);
    }
    const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, name);
    if (bytes.byteLength > limit)
      throw tooBig(ctx, itemIndex, binary.fileName ?? name, bytes.byteLength, limit);
    total += bytes.byteLength;
    if (total > limit) {
      throw new NodeOperationError(
        ctx.getNode(),
        `The files total ${megabytes(total)} MB, which exceeds the ${megabytes(limit)} MB limit for sending files to the model`,
        { itemIndex, description: 'Use fewer or smaller files.' },
      );
    }
    files.push({
      bytes,
      mimeType: binary.mimeType || mimeFromName(binary.fileName),
      ...(binary.fileName ? { fileName: binary.fileName } : {}),
    });
  }
  return files;
}

/** One input file, from a URL (guarded, no credential) or a binary field; over `maxBytes` fails. */
export async function readInputFile(
  ctx: ExecuteContext,
  itemIndex: number,
  input: { inputType: 'url' | 'binary'; url?: string; binaryField?: string },
  options?: { maxBytes?: number },
): Promise<VendorFile> {
  const limit = options?.maxBytes ?? ctx.helpers.getInstanceLimits().maxPassthroughBinaryBytes;
  if (input.inputType === 'url') {
    const url = input.url?.trim() ?? '';
    if (!url) throw new NodeOperationError(ctx.getNode(), 'Enter the URL of the file', { itemIndex });
    const { bytes, mimeType } = await downloadMedia(ctx, itemIndex, url, { maxBytes: limit });
    const fileName = safeDecode(new URL(url).pathname.split('/').pop() ?? '') || undefined;
    return {
      bytes,
      mimeType: mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(fileName),
      ...(fileName ? { fileName } : {}),
    };
  }
  const name = input.binaryField?.trim() || 'data';
  const binary = ctx.getInputData()[itemIndex]?.binary?.[name];
  if (!binary) {
    throw new NodeOperationError(ctx.getNode(), `The item has no binary data in the field "${name}"`, {
      itemIndex,
      description: 'Name a binary field of the input item, such as "data".',
    });
  }
  if (typeof binary.fileSize === 'number' && binary.fileSize > limit) {
    throw tooBig(ctx, itemIndex, binary.fileName ?? name, binary.fileSize, limit);
  }
  const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, name);
  if (bytes.byteLength > limit)
    throw tooBig(ctx, itemIndex, binary.fileName ?? name, bytes.byteLength, limit);
  return {
    bytes,
    mimeType: binary.mimeType || mimeFromName(binary.fileName),
    ...(binary.fileName ? { fileName: binary.fileName } : {}),
  };
}

/** An output item holding `file` in the binary field `field`, with `json` and the paired item. */
export async function fileToItem(
  ctx: ExecuteContext,
  itemIndex: number,
  file: VendorFile,
  field: string,
  json: DataObject = {},
): Promise<Item> {
  const binary = await ctx.helpers.prepareBinaryData(file.bytes, file.fileName, file.mimeType);
  return { json, binary: { [field.trim() || 'data']: binary }, pairedItem: { item: itemIndex } };
}
