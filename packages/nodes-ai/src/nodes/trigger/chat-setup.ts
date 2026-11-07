/**
 * The Chat Trigger's public surface, shared by the trigger and the Chat node's reply hook so neither can
 * miss a rule: the setup GET (the hosted page), the Origin check with the page and test tokens, the
 * message limits and the upload rules.
 */
import {
  type BinaryData,
  CHAT_PAGE_HEADER,
  CHAT_PAGE_TOKEN_TTL_S,
  CHAT_TEST_HEADER,
  CHAT_TOKEN_KINDS,
  CHAT_TRIGGER_TYPE,
  type ChatPageConfig,
  type ChatTokenKind,
  type DataObject,
  type WebhookContext,
  type WebhookResponseData,
} from '@workflow/workflow';
import { renderChatPage } from './chat-page';

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

/** the Origin a sandboxed page (opaque origin) sends */
const OPAQUE_ORIGIN = 'null';

function headerOf(ctx: WebhookContext, name: string): string | undefined {
  const value = ctx.getHeaderData()[name];
  return Array.isArray(value) ? value[0] : value;
}

/** the Chat Trigger a chat token names: this node when it is one, else the workflow's (the Chat node's reply) */
function chatTriggerName(ctx: WebhookContext): string | undefined {
  const node = ctx.getNode();
  return node.type === CHAT_TRIGGER_TYPE ? node.name : ctx.getChatTrigger()?.name;
}

/** a signed chat token of `kind` for this tenant, workflow and chat trigger */
function holdsChatToken(ctx: WebhookContext, header: string, kind: ChatTokenKind): boolean {
  const token = headerOf(ctx, header);
  if (!token) return false;
  const payload = ctx.verifyFormToken(token);
  return (
    payload !== null &&
    payload.kind === kind &&
    payload.tenantId === ctx.getTenantId() &&
    payload.workflowId === (ctx.getWorkflow().id ?? '') &&
    payload.node === chatTriggerName(ctx)
  );
}

/**
 * The origin to grant: the request's origin (or `*`), undefined for a call without an Origin header, false
 * to refuse. `allowed` is the node's comma list. A test run's valid `x-chat-test-token` grants the caller's
 * origin. The sandboxed hosted page sends `Origin: null`, granted only with a valid `x-chat-page` token;
 * a `null` entry in the list grants nothing, since any sandboxed frame or data: URL sends that origin.
 */
export function chatOriginAllowed(
  ctx: WebhookContext,
  allowed: string,
  origin: string | undefined,
): string | undefined | false {
  const list = allowed.split(',').map(normalizeOrigin).filter(Boolean);
  const any = !list.length || list.includes('*');
  if (!origin) return any ? '*' : undefined; // server-to-server call without an Origin header
  if (ctx.getMode() === 'manual' && holdsChatToken(ctx, CHAT_TEST_HEADER, CHAT_TOKEN_KINDS.test)) {
    return origin;
  }
  if (normalizeOrigin(origin) === OPAQUE_ORIGIN) {
    if (holdsChatToken(ctx, CHAT_PAGE_HEADER, CHAT_TOKEN_KINDS.page)) return OPAQUE_ORIGIN;
    return any ? '*' : false;
  }
  if (any) return origin;
  return list.includes(normalizeOrigin(origin)) ? origin : false;
}

const DEFAULT_TEXTS = {
  title: 'Hi there!',
  subtitle: "Start a chat. We're here to help you 24/7.",
  inputPlaceholder: 'Type your question…',
  getStarted: 'New Conversation',
};

const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

/** the page's configuration from the node's parameters; `loadPreviousSession` is on for memory or manual loads */
function pageConfig(
  ctx: WebhookContext,
  options: DataObject,
  tokens: { pageToken: string; authToken?: string },
): ChatPageConfig {
  const url = ctx.getRequestObject().url ?? '';
  const previous = options.loadPreviousSession;
  return {
    // the page's own path: the bootstrap resolves it against the page, so no Host header is trusted
    webhookUrl: url.split(/[?#]/)[0] ?? '',
    pageToken: tokens.pageToken,
    ...(tokens.authToken ? { authToken: tokens.authToken } : {}),
    title: text(options.title, DEFAULT_TEXTS.title),
    subtitle: text(options.subtitle, DEFAULT_TEXTS.subtitle),
    inputPlaceholder: text(options.inputPlaceholder, DEFAULT_TEXTS.inputPlaceholder),
    getStarted: text(options.getStarted, DEFAULT_TEXTS.getStarted),
    initialMessages: String(ctx.getNodeParameter('initialMessages', 0, DEFAULT_INITIAL_MESSAGES) ?? '')
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean),
    showWelcomeScreen: options.showWelcomeScreen === true,
    loadPreviousSession: previous === true || previous === 'memory' || previous === 'manually',
    allowFileUploads: options.allowFileUploads === true,
    allowedFilesMimeTypes: text(options.allowedFilesMimeTypes, '*'),
    enableStreaming: options.responseMode === 'streaming',
    customCss: text(options.customCss, ''),
  };
}

/**
 * The setup GET. `hostedChat` mode answers the hosted page with a signed page token (tenant, workflow,
 * node, 60 minutes); the page holds that token and, with sign-in, the auth token, so it is never cached.
 * `webhook` (embedded) mode has no page: 404.
 */
export async function handleChatSetup(
  ctx: WebhookContext,
  input: { corsOrigin?: string; authToken?: string },
): Promise<WebhookResponseData> {
  if (ctx.getNodeParameter('mode', 0, 'hostedChat') === 'webhook') {
    return chatResponse(404, { message: 'This chat is not available' }, input.corsOrigin);
  }
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const pageToken = ctx.signFormToken(
    {
      kind: CHAT_TOKEN_KINDS.page,
      tenantId: ctx.getTenantId(),
      workflowId: ctx.getWorkflow().id ?? '',
      node: ctx.getNode().name,
    },
    CHAT_PAGE_TOKEN_TTL_S,
  );
  return {
    webhookResponse: {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: renderChatPage(pageConfig(ctx, options, { pageToken, authToken: input.authToken })),
    },
  };
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
