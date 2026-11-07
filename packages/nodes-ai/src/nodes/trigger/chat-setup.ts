/**
 * The Chat Trigger's public surface, shared by the trigger and the Chat node's reply hook so neither can
 * miss a rule: the setup GET, the Origin check, the message limits and the upload rules. C0 moved them here
 * from ChatTrigger.node.ts unchanged; lane L2 builds the hosted page and the page and test token Origin rule.
 */
import type { BinaryData, DataObject, WebhookContext, WebhookResponseData } from '@workflow/workflow';

export const MAX_CHAT_INPUT = 100_000;
export const MAX_SESSION_ID = 200;
export const DEFAULT_INITIAL_MESSAGES = 'Hi there!\nHow can I help you today?';

/** a JSON reply with the CORS grant, and the Basic challenge on a 401 */
export function chatResponse(statusCode: number, body: unknown, origin?: string): WebhookResponseData {
  return {
    webhookResponse: {
      statusCode,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        ...(statusCode === 401 ? { 'www-authenticate': 'Basic realm="Chat"' } : {}),
      },
      body,
    },
  };
}

/** origins compare by scheme, host and port: case and trailing slashes do not matter (as on the server) */
const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '').toLowerCase();

/**
 * The origin to grant: the request's origin (or `*`), undefined for a call without an Origin header, false
 * to refuse. `allowed` is the node's comma list. The context is for L2's page and test token rule.
 */
export function chatOriginAllowed(
  _ctx: WebhookContext,
  allowed: string,
  origin: string | undefined,
): string | undefined | false {
  const list = allowed.split(',').map(normalizeOrigin).filter(Boolean);
  if (!list.length || list.includes('*')) return origin ?? '*';
  if (!origin) return undefined; // server-to-server call without an Origin header
  return list.includes(normalizeOrigin(origin)) ? origin : false;
}

/** the setup GET: the chat's public configuration (lane L2: the hosted page in `hostedChat` mode) */
export async function handleChatSetup(
  ctx: WebhookContext,
  input: { corsOrigin?: string; authToken?: string },
): Promise<WebhookResponseData> {
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  return chatResponse(
    200,
    {
      initialMessages: String(ctx.getNodeParameter('initialMessages', 0, DEFAULT_INITIAL_MESSAGES) ?? '')
        .split('\n')
        .map((m) => m.trim())
        .filter(Boolean),
      title: options.title ?? 'Hi there!',
      subtitle: options.subtitle ?? '',
      inputPlaceholder: options.inputPlaceholder ?? '',
      allowFileUploads: Boolean(options.allowFileUploads),
      responseMode: options.responseMode ?? 'lastNode',
    },
    input.corsOrigin,
  );
}

/**
 * The request's uploaded files as binary data `data0`, `data1`, ..., checked against the node's
 * `allowFileUploads` and `allowedFilesMimeTypes` options; a refusal names the status and the message.
 */
export async function readChatFiles(
  ctx: WebhookContext,
  options: DataObject,
): Promise<{ binary: Record<string, BinaryData> } | { status: 400 | 415; message: string }> {
  const binary: Record<string, BinaryData> = {};
  const files = ctx.getRequestObject().files ?? [];
  if (!files.length) return { binary };
  if (!options.allowFileUploads) return { status: 400, message: 'File uploads are not allowed' };
  const allowed = String(options.allowedFilesMimeTypes ?? '*')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const accepts = (mime: string) =>
    !allowed.length ||
    allowed.includes('*') ||
    allowed.some((a) =>
      a.endsWith('/*') ? mime.toLowerCase().startsWith(a.slice(0, -1)) : a === mime.toLowerCase(),
    );
  for (const [i, file] of files.entries()) {
    if (!accepts(file.mimeType)) {
      return { status: 415, message: `Files of type "${file.mimeType}" are not allowed` };
    }
    binary[`data${i}`] = await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType);
  }
  return { binary };
}
