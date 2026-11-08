/**
 * Files sent with a chat message (P5-74, lane L11): n8n's limits and allow list
 * (`ASSISTANT_ATTACHMENTS`, `ASSISTANT_ATTACHMENT_TYPES`), stored through `executions.binaryStore` with
 * the thread id as the execution id, images to the model as image parts. C0 stub with the final
 * signatures: any file is refused, an empty list passes and gives `[]`.
 */
import type { AiImagePart, AssistantSendMessage } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import { ApiError } from '../../http/errors';
import type { StoredAttachment } from './types';

export type AssistantUpload = NonNullable<AssistantSendMessage['attachments']>[number];

/** checks count, sizes, declared type and extension; throws a 400 with n8n's text (C0: any file refused) */
export function validateAttachments(list: AssistantUpload[] | undefined): void {
  if (list && list.length > 0) throw ApiError.badRequest('Files are not supported yet');
}

/** stores each file under the thread; the refs plus `binary` (C0: `[]` for an empty list) */
export async function storeAttachments(
  _ctx: ServerContext,
  _tenantId: string,
  _threadId: string,
  list: AssistantUpload[],
): Promise<StoredAttachment[]> {
  if (list.length === 0) return [];
  throw new Error('not implemented (L11)');
}

/** the image attachments as image parts for `runAgent`'s `attachments` (C0: `[]` for an empty list) */
export async function attachmentImages(
  _ctx: ServerContext,
  _tenantId: string,
  list: StoredAttachment[],
): Promise<AiImagePart[]> {
  if (list.length === 0) return [];
  throw new Error('not implemented (L11)');
}
