/**
 * P5-74 (L11): picked files as the chat body's `attachments` (base64 data, MIME type, file name), checked
 * against `ASSISTANT_ATTACHMENTS` and `ASSISTANT_ATTACHMENT_TYPES` before anything is sent.
 *
 * Until L11: an empty list gives `[]` (so the composer can always call it), any file throws.
 */
import type { AssistantSendMessage } from '@workflow/workflow';

export type AssistantUploadList = NonNullable<AssistantSendMessage['attachments']>;

export async function readAttachments(files: readonly File[]): Promise<AssistantUploadList> {
  if (files.length === 0) return [];
  throw new Error('not implemented (L11)');
}
