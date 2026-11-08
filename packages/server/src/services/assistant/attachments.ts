/**
 * Files sent with a chat message (P5-74, lane L11): n8n's limits and allow list
 * (`ASSISTANT_ATTACHMENTS`, `ASSISTANT_ATTACHMENT_TYPES`), stored through `executions.binaryStore` with
 * the thread id as the execution id (so `removeBinaryData(tenant, thread)` removes them with the thread),
 * images to the model as image parts. The messages DTO shows refs only (file name, type, size); the
 * stored `binary` never leaves the server.
 */
import {
  type AiImagePart,
  ASSISTANT_ATTACHMENT_TYPES,
  ASSISTANT_ATTACHMENTS,
  type AssistantSendMessage,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import { ApiError } from '../../http/errors';
import type { StoredAttachment } from './types';

export type AssistantUpload = NonNullable<AssistantSendMessage['attachments']>[number];

const MB = 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const FILE_NAME_CHARS = 200;

/** the leading bytes a file of this MIME type starts with (types with no fixed start are not listed) */
const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  'application/pdf': (h) => h.subarray(0, 4).toString('latin1') === '%PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'image/png': (h) => h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  'image/gif': (h) => h.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP',
};

function isZip(head: Buffer): boolean {
  return head[0] === 0x50 && head[1] === 0x4b;
}

/** the MIME type without parameters, lower case */
function baseType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** the file name without a folder part or control characters, cut to a sane length */
function cleanName(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (fileName.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, FILE_NAME_CHARS);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

const sizeText = (bytes: number) => `${Math.round((bytes / MB) * 10) / 10} MB`;

/** true for an image attachment (the model sees it directly; `parse_file` does not read it) */
export function isImageAttachment(file: { mimeType: string }): boolean {
  return baseType(file.mimeType).startsWith('image/');
}

/** checks count, sizes, declared type and extension; throws a 400 with the text a person can act on */
export function validateAttachments(list: AssistantUpload[] | undefined): void {
  if (!list || list.length === 0) return;
  const limits = ASSISTANT_ATTACHMENTS;
  if (list.length > limits.maxPerMessage) {
    throw ApiError.badRequest(`You can attach at most ${limits.maxPerMessage} files to one message`);
  }
  let total = 0;
  for (const file of list) {
    const name = cleanName(file.fileName);
    if (!name) throw ApiError.badRequest('Every file needs a name');
    if (file.data.length > limits.fileBase64Bytes) {
      // the limit is on the base64 text; the file itself is about three quarters of it
      throw ApiError.badRequest(
        `"${name}" is too large: a file can be at most ${sizeText((limits.fileBase64Bytes * 3) / 4)}`,
      );
    }
    total += file.data.length;
    if (total > limits.totalBase64Bytes) {
      throw ApiError.badRequest(
        `The files are too large together: one message can carry at most ${sizeText((limits.totalBase64Bytes * 3) / 4)}`,
      );
    }
    const type = baseType(file.mimeType);
    const extensions = ASSISTANT_ATTACHMENT_TYPES[type];
    if (!extensions) {
      throw ApiError.badRequest(`"${name}" is a type of file that cannot be attached (${type || 'unknown'})`);
    }
    if (!extensions.includes(extensionOf(name))) {
      throw ApiError.badRequest(
        `"${name}" does not look like a ${type} file: use the extension ${extensions.join(' or ')}`,
      );
    }
    if (!BASE64.test(file.data)) throw ApiError.badRequest(`"${name}" could not be read: its data is not base64`);
    const check = SIGNATURES[type];
    if (check && !check(Buffer.from(file.data.slice(0, 24), 'base64'))) {
      throw ApiError.badRequest(`"${name}" is not a real ${type} file`);
    }
  }
}

/** stores each file under the thread; the refs plus `binary` */
export async function storeAttachments(
  ctx: ServerContext,
  tenantId: string,
  threadId: string,
  list: AssistantUpload[],
): Promise<StoredAttachment[]> {
  if (list.length === 0) return [];
  validateAttachments(list);
  const store = ctx.executions.binaryStore(tenantId);
  const stored: StoredAttachment[] = [];
  for (const file of list) {
    const bytes = Buffer.from(file.data, 'base64');
    const fileName = cleanName(file.fileName);
    const mimeType = baseType(file.mimeType);
    const binary = await store.store(bytes, { fileName, mimeType, executionId: threadId });
    stored.push({ fileName, mimeType, size: bytes.byteLength, binary });
  }
  return stored;
}

/** the image attachments as image parts for `runAgent`'s `attachments` */
export async function attachmentImages(
  ctx: ServerContext,
  tenantId: string,
  list: StoredAttachment[],
): Promise<AiImagePart[]> {
  const images = list.filter(isImageAttachment);
  if (images.length === 0) return [];
  const store = ctx.executions.binaryStore(tenantId);
  const parts: AiImagePart[] = [];
  for (const file of images) {
    const bytes = await store.getBuffer(file.binary);
    parts.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: baseType(file.mimeType) });
  }
  return parts;
}
