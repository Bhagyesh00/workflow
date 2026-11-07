/**
 * The `chatReply` POST of Respond to Chat (P5-58): the person's next chat message, sent to the resume URL
 * of a run that waits at the node. The server has checked the signature of the URL before this runs.
 *
 * The message follows the Chat Trigger's own rules: the same limits (`MAX_CHAT_INPUT`, `MAX_SESSION_ID`) and
 * the same upload options, read from `ctx.getChatTrigger()`. Only `sessionId`, `chatInput` and the files reach
 * the output item: a caller cannot pass `approved` or `data`, which decide a human review. A text reply to an
 * approval is not an approval (`data.approved = false`, as n8n's newest version); the agent of a review reads
 * the text as the person's feedback.
 */
import { SEND_AND_WAIT } from '@workflow/nodes-base/utils/send-and-wait';
import {
  type DataObject,
  type Item,
  isPlainObject,
  type WebhookContext,
  type WebhookResponseData,
} from '@workflow/workflow';
import { MAX_CHAT_INPUT, MAX_SESSION_ID, readChatFiles } from './chat-setup';

const problem = (statusCode: number, message: string): WebhookResponseData => ({
  webhookResponse: {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { message },
  },
});

/** the options of the workflow's Chat Trigger (upload rules); none when the trigger is gone */
function triggerOptions(ctx: WebhookContext): DataObject {
  const options = ctx.getChatTrigger()?.parameters.options;
  return isPlainObject(options) ? options : {};
}

export async function chatReply(ctx: WebhookContext): Promise<WebhookResponseData> {
  if (ctx.getNodeParameter('operation', 0, '') !== SEND_AND_WAIT) {
    return problem(404, 'This execution is not waiting for a response');
  }
  const body = ctx.getRequestObject().body;
  if (!isPlainObject(body)) return problem(400, 'The request body must be a JSON object');
  const { sessionId, chatInput } = body;
  if (
    sessionId !== undefined &&
    (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > MAX_SESSION_ID)
  ) {
    return problem(400, `"sessionId" must be a non-empty string of at most ${MAX_SESSION_ID} characters`);
  }
  if (typeof chatInput !== 'string' || !chatInput.trim()) {
    return problem(400, '"chatInput" must be a non-empty string');
  }
  if (chatInput.length > MAX_CHAT_INPUT) {
    return problem(413, `"chatInput" is longer than ${MAX_CHAT_INPUT} characters`);
  }
  const uploads = await readChatFiles(ctx, triggerOptions(ctx));
  if ('status' in uploads) return problem(uploads.status, uploads.message);

  const json: DataObject = {
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    chatInput,
  };
  // a typed answer to Approve / Decline buttons approves nothing
  if (ctx.getNodeParameter('responseType', 0, 'approval') === 'approval') json.data = { approved: false };
  const item: Item = { json };
  if (Object.keys(uploads.binary).length) item.binary = uploads.binary;
  return { workflowData: [[item]] };
}
