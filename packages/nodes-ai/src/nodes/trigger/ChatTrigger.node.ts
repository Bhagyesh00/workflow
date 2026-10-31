/**
 * Chat Trigger: a POST webhook receiving `{ sessionId, chatInput, metadata? }` and starting the
 * workflow with one item `{ sessionId, action: 'sendMessage', chatInput }`. A GET on the same
 * path returns the public chat configuration (initial messages, labels) for chat widgets.
 *
 * Public ingress rules (security S7): strict body validation with size limits, optional basic
 * auth (constant-time comparison), an Origin allow-list, and no access to anything but the
 * request itself.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type DataObject,
  type Item,
  isPlainObject,
  type NodeType,
  type WebhookContext,
  type WebhookResponseData,
} from '@workflow/workflow';

const MAX_CHAT_INPUT = 100_000;
const MAX_SESSION_ID = 200;
const MAX_METADATA_BYTES = 16_384;
const DEFAULT_INITIAL_MESSAGES = 'Hi there!\nHow can I help you today?';

function safeEqual(a: string, b: string): boolean {
  // hash first so lengths match and the comparison time does not depend on the secret
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function headerValue(ctx: WebhookContext, name: string): string | undefined {
  const v = ctx.getHeaderData()[name];
  return Array.isArray(v) ? v[0] : v;
}

/** origins compare by scheme, host and port: case and trailing slashes do not matter (as on the server) */
const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '').toLowerCase();

function allowedOrigin(allowed: string, origin: string | undefined): string | undefined | false {
  const list = allowed.split(',').map(normalizeOrigin).filter(Boolean);
  if (!list.length || list.includes('*')) return origin ?? '*';
  if (!origin) return undefined; // server-to-server call without an Origin header
  return list.includes(normalizeOrigin(origin)) ? origin : false;
}

function respond(statusCode: number, body: unknown, origin?: string): WebhookResponseData {
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

export const ChatTriggerNode: NodeType = {
  description: {
    name: 'ai.chatTrigger',
    displayName: 'Chat Trigger',
    description: 'Starts the workflow when a chat message is received',
    icon: 'lucide:message-circle',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When chat message received' },
    inputs: [],
    outputs: ['main'],
    categories: ['AI', 'Triggers'],
    alias: ['chat', 'chatbot', 'message', 'conversation'],
    eventTriggerDescription: 'Waiting for you to send a chat message',
    activationMessage: 'You can now send messages to the chat URL.',
    credentials: [
      {
        name: 'httpBasicAuth',
        required: true,
        displayOptions: { show: { public: [true], authentication: ['basicAuth'] } },
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        path: 'chat',
        responseMode: "={{ $parameter.options?.responseMode ?? 'lastNode' }}",
        responseData: 'firstEntryJson',
      },
      { name: 'setup', httpMethod: 'GET', path: 'chat', ndvHideUrl: true },
    ],
    properties: [
      {
        displayName: 'Make Chat Publicly Available',
        name: 'public',
        type: 'boolean',
        default: false,
        description:
          'Whether the chat URL works outside the editor. When off, only test messages from the editor are accepted.',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        displayOptions: { show: { public: [true] } },
        options: [
          { name: 'None', value: 'none', description: 'Anyone with the URL can chat' },
          { name: 'Basic Auth', value: 'basicAuth' },
        ],
      },
      {
        displayName: 'Initial Message(s)',
        name: 'initialMessages',
        type: 'string',
        default: DEFAULT_INITIAL_MESSAGES,
        typeOptions: { rows: 3 },
        description: 'Shown when a chat opens; one message per line',
        displayOptions: { show: { public: [true] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Allowed Origins (CORS)',
            name: 'allowedOrigins',
            type: 'string',
            default: '*',
            description: 'Comma-separated origins allowed to call the chat from a browser, or * for any',
          },
          {
            displayName: 'Response Mode',
            name: 'responseMode',
            type: 'options',
            default: 'lastNode',
            options: [
              {
                name: 'When Last Node Finishes',
                value: 'lastNode',
                description: 'Answer with the output of the last node',
              },
              {
                name: 'Streaming',
                value: 'streaming',
                description: 'Stream the answer while it is generated (agents with streaming on)',
              },
            ],
          },
          { displayName: 'Allow File Uploads', name: 'allowFileUploads', type: 'boolean', default: false },
          {
            displayName: 'Allowed File MIME Types',
            name: 'allowedFilesMimeTypes',
            type: 'string',
            default: '*',
            placeholder: 'image/*, text/plain',
            description: 'Comma-separated MIME types; * allows any',
          },
          { displayName: 'Title', name: 'title', type: 'string', default: 'Hi there!' },
          {
            displayName: 'Subtitle',
            name: 'subtitle',
            type: 'string',
            default: "Start a chat. We're here to help you 24/7.",
          },
          {
            displayName: 'Input Placeholder',
            name: 'inputPlaceholder',
            type: 'string',
            default: 'Type your question…',
          },
        ],
      },
    ],
  },

  async webhook(ctx) {
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const isPublic = Boolean(ctx.getNodeParameter('public', 0, false));
    const origin = allowedOrigin(String(options.allowedOrigins ?? '*'), headerValue(ctx, 'origin'));
    if (origin === false) return respond(403, { message: 'Origin not allowed' });
    const corsOrigin = origin ?? undefined;
    if (!isPublic && ctx.getMode() !== 'manual')
      return respond(404, { message: 'This chat is not available' }, corsOrigin);

    if (isPublic && ctx.getNodeParameter('authentication', 0, 'none') === 'basicAuth') {
      const creds = await ctx.getCredentials('httpBasicAuth');
      const auth = headerValue(ctx, 'authorization') ?? '';
      const decoded = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
      const sep = decoded.indexOf(':');
      const userOk = sep >= 0 && safeEqual(decoded.slice(0, sep), String(creds.user ?? ''));
      const passOk = sep >= 0 && safeEqual(decoded.slice(sep + 1), String(creds.password ?? ''));
      if (!userOk || !passOk) return respond(401, { message: 'Authorization is required' }, corsOrigin);
    }

    if (ctx.getWebhookName() === 'setup') {
      return respond(
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
        corsOrigin,
      );
    }

    const body = ctx.getRequestObject().body;
    if (!isPlainObject(body))
      return respond(400, { message: 'The request body must be a JSON object' }, corsOrigin);
    const action = body.action ?? 'sendMessage';
    if (action === 'loadPreviousSession') return respond(200, { data: [] }, corsOrigin);
    if (action !== 'sendMessage')
      return respond(400, { message: `Unknown action "${String(action)}"` }, corsOrigin);
    const { sessionId, chatInput, metadata } = body;
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > MAX_SESSION_ID) {
      return respond(
        400,
        { message: `"sessionId" must be a non-empty string of at most ${MAX_SESSION_ID} characters` },
        corsOrigin,
      );
    }
    if (typeof chatInput !== 'string' || !chatInput.trim()) {
      return respond(400, { message: '"chatInput" must be a non-empty string' }, corsOrigin);
    }
    if (chatInput.length > MAX_CHAT_INPUT) {
      return respond(413, { message: `"chatInput" is longer than ${MAX_CHAT_INPUT} characters` }, corsOrigin);
    }
    if (
      metadata !== undefined &&
      (!isPlainObject(metadata) || JSON.stringify(metadata).length > MAX_METADATA_BYTES)
    ) {
      return respond(
        400,
        { message: `"metadata" must be an object of at most ${MAX_METADATA_BYTES} bytes` },
        corsOrigin,
      );
    }

    const item: Item = {
      json: {
        sessionId,
        action: 'sendMessage',
        chatInput,
        ...(metadata !== undefined ? { metadata: metadata as DataObject } : {}),
      },
    };
    const files = ctx.getRequestObject().files ?? [];
    if (files.length) {
      if (!options.allowFileUploads)
        return respond(400, { message: 'File uploads are not allowed' }, corsOrigin);
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
      item.binary = {};
      for (const [i, file] of files.entries()) {
        if (!accepts(file.mimeType)) {
          return respond(415, { message: `Files of type "${file.mimeType}" are not allowed` }, corsOrigin);
        }
        item.binary[`data${i}`] = await ctx.helpers.prepareBinaryData(
          file.data,
          file.fileName,
          file.mimeType,
        );
      }
    }
    return { workflowData: [[item]] };
  },
};
