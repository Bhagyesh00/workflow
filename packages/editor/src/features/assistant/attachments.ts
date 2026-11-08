/**
 * P5-74 (L11): picked files as the chat body's `attachments` (base64 data, MIME type, file name), checked
 * against `ASSISTANT_ATTACHMENTS` and `ASSISTANT_ATTACHMENT_TYPES` before anything is sent. The server
 * checks the same limits again; this is so a person sees the problem before the message goes.
 */
import {
  ASSISTANT_ATTACHMENT_TYPES,
  ASSISTANT_ATTACHMENTS,
  type AssistantSendMessage,
} from '@workflow/workflow';

export type AssistantUploadList = NonNullable<AssistantSendMessage['attachments']>;

const MB = 1024 * 1024;

/** the length of `size` bytes as base64 */
const base64Length = (size: number) => 4 * Math.ceil(size / 3);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** the allowed MIME type that carries a file name's extension, if any */
function typeOfExtension(name: string): string | undefined {
  const ext = extensionOf(name);
  return Object.entries(ASSISTANT_ATTACHMENT_TYPES).find(([, extensions]) => extensions.includes(ext))?.[0];
}

/** the MIME type to send: the browser's when it is allowed for the extension, else the extension's own */
export function attachmentMimeType(file: Pick<File, 'name' | 'type'>): string | undefined {
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = extensionOf(file.name);
  if (declared && ASSISTANT_ATTACHMENT_TYPES[declared]?.includes(ext)) return declared;
  return typeOfExtension(file.name);
}

const megabytes = (bytes: number) => `${Math.round((bytes / MB) * 10) / 10} MB`;

/** the largest file in bytes (the limit is on its base64 text) */
export const ATTACHMENT_FILE_BYTES = Math.floor((ASSISTANT_ATTACHMENTS.fileBase64Bytes * 3) / 4);
export const ATTACHMENT_TOTAL_BYTES = Math.floor((ASSISTANT_ATTACHMENTS.totalBase64Bytes * 3) / 4);

/** the first problem with `files` as a sentence for a person, or null when they can go */
export function attachmentProblem(files: readonly Pick<File, 'name' | 'size' | 'type'>[]): string | null {
  if (files.length > ASSISTANT_ATTACHMENTS.maxPerMessage) {
    return `You can attach at most ${ASSISTANT_ATTACHMENTS.maxPerMessage} files to one message`;
  }
  let total = 0;
  for (const file of files) {
    if (!attachmentMimeType(file)) {
      return `"${file.name}" is a type of file that cannot be attached`;
    }
    if (base64Length(file.size) > ASSISTANT_ATTACHMENTS.fileBase64Bytes) {
      return `"${file.name}" is too large: a file can be at most ${megabytes(ATTACHMENT_FILE_BYTES)}`;
    }
    total += base64Length(file.size);
  }
  if (total > ASSISTANT_ATTACHMENTS.totalBase64Bytes) {
    return `The files are too large together: one message can carry at most ${megabytes(ATTACHMENT_TOTAL_BYTES)}`;
  }
  return null;
}

/** the file's bytes as base64 (no `data:` prefix) */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** the chat body's `attachments` for `files`; throws an Error with the text to show when a file cannot go */
export async function readAttachments(files: readonly File[]): Promise<AssistantUploadList> {
  if (files.length === 0) return [];
  const problem = attachmentProblem(files);
  if (problem) throw new Error(problem);
  const list: AssistantUploadList = [];
  for (const file of files) {
    list.push({
      data: await readBase64(file),
      mimeType: attachmentMimeType(file) as string,
      fileName: file.name,
    });
  }
  return list;
}
