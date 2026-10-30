/**
 * Telegram Bot API: messages, chats and callback queries, plus a webhook trigger that registers
 * itself with setWebhook and verifies Telegram's secret token on every delivery.
 *
 * The bot token is part of the URL path, so errors are rebuilt here without the URL to keep
 * the token out of run data and logs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpFullResponse,
  type Item,
  isPlainObject,
  NodeApiError,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type WebhookContext,
  type WebhookLifecycleContext,
  type WebhookResponseData,
} from '@workflow/workflow';
import { parseJsonParameter } from '../../utils/utilities';
import {
  compact,
  forOps,
  type OperationHandler,
  operationProperty,
  requiredId,
  resourceProperty,
  runOperations,
} from './shared';

interface TelegramCredentials extends DataObject {
  accessToken?: string;
  baseUrl?: string;
}

type TelegramContext = Pick<BaseContext, 'getCredentials' | 'helpers' | 'getNode'>;

async function telegramCredentials(
  ctx: TelegramContext,
  itemIndex = 0,
): Promise<{ token: string; baseUrl: string }> {
  const creds = await ctx.getCredentials<TelegramCredentials>('telegramApi', itemIndex);
  const token = String(creds.accessToken ?? '').trim();
  const baseUrl = String(creds.baseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
  if (!token) throw new NodeOperationError(ctx.getNode(), 'The Telegram credential has no access token');
  if (!/^https?:\/\//i.test(baseUrl))
    throw new NodeOperationError(ctx.getNode(), 'The Telegram base URL must be an http(s) URL');
  return { token, baseUrl };
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}

/** Call a Bot API method; returns `result`. */
export async function telegramRequest(
  ctx: TelegramContext,
  method: string,
  body: DataObject = {},
  itemIndex = 0,
  multipart = false,
): Promise<unknown> {
  const { token, baseUrl } = await telegramCredentials(ctx, itemIndex);
  let response: HttpFullResponse<DataObject>;
  try {
    response = (await ctx.helpers.httpRequest({
      method: 'POST',
      url: `${baseUrl}/bot${token}/${method}`,
      body: compact(body),
      bodyType: multipart ? 'multipart' : 'json',
      responseType: 'json',
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as HttpFullResponse<DataObject>;
  } catch (error) {
    const message = redact((error as Error).message ?? String(error), token);
    throw new NodeApiError(ctx.getNode(), message, {
      itemIndex,
      request: { method: 'POST', url: `${baseUrl}/bot[redacted]/${method}` },
    });
  }
  const payload = isPlainObject(response.body) ? response.body : {};
  if (response.statusCode >= 300 || payload.ok !== true) {
    throw new NodeApiError(
      ctx.getNode(),
      redact(String(payload.description ?? `Telegram returned HTTP ${response.statusCode}`), token),
      {
        itemIndex,
        httpCode: payload.error_code ? Number(payload.error_code) : response.statusCode,
        responseBody: {
          ok: false,
          error_code: payload.error_code,
          description: redact(String(payload.description ?? ''), token),
        },
        request: { method: 'POST', url: `${baseUrl}/bot[redacted]/${method}` },
        retryAfterMs:
          Number((payload.parameters as DataObject | undefined)?.retry_after ?? 0) * 1000 || undefined,
      },
    );
  }
  return payload.result;
}

function replyMarkup(ctx: ExecuteContext, i: number, fields: DataObject): unknown {
  if (!fields.reply_markup) return undefined;
  const parsed = parseJsonParameter(ctx, fields.reply_markup, 'Reply Markup', i);
  if (!isPlainObject(parsed))
    throw new NodeOperationError(ctx.getNode(), 'Reply Markup must be a JSON object', { itemIndex: i });
  return parsed;
}

function common(ctx: ExecuteContext, i: number): DataObject {
  const fields = ctx.getNodeParameter('additionalFields', i, {}) as DataObject;
  return {
    parse_mode: fields.parse_mode && fields.parse_mode !== 'none' ? fields.parse_mode : undefined,
    disable_notification: fields.disable_notification,
    message_thread_id: fields.message_thread_id || undefined,
    reply_markup: replyMarkup(ctx, i, fields),
    ...(fields.reply_to_message_id
      ? { reply_parameters: { message_id: Number(fields.reply_to_message_id) } }
      : {}),
    ...(fields.disable_web_page_preview ? { link_preview_options: { is_disabled: true } } : {}),
  };
}

function chatId(ctx: ExecuteContext, i: number): string {
  return requiredId(ctx, 'chatId', i, 'Chat ID');
}

function messageId(ctx: ExecuteContext, i: number): number {
  const id = Number(requiredId(ctx, 'messageId', i, 'Message ID'));
  if (!Number.isInteger(id))
    throw new NodeOperationError(ctx.getNode(), 'Message ID must be a number', { itemIndex: i });
  return id;
}

async function sendFile(
  ctx: ExecuteContext,
  i: number,
  method: 'sendPhoto' | 'sendDocument',
  field: 'photo' | 'document',
) {
  const extra = common(ctx, i);
  const caption = (ctx.getNodeParameter('additionalFields.caption', i, '') as string) || undefined;
  if (ctx.getNodeParameter('binaryData', i, false)) {
    const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
    const meta = ctx.helpers.assertBinaryData(i, property);
    const form: DataObject = {
      chat_id: chatId(ctx, i),
      caption,
      ...extra,
      [field]: {
        data: await ctx.helpers.getBinaryDataBuffer(i, property),
        fileName: meta.fileName ?? `${field}`,
        mimeType: meta.mimeType,
      },
    };
    return telegramRequest(ctx, method, form, i, true);
  }
  const file = requiredId(ctx, 'file', i, 'File URL or ID');
  return telegramRequest(ctx, method, { chat_id: chatId(ctx, i), [field]: file, caption, ...extra }, i);
}

const handlers: Record<string, Record<string, OperationHandler>> = {
  message: {
    async sendMessage(ctx, i) {
      const text = String(ctx.getNodeParameter('text', i, '') ?? '');
      if (!text) throw new NodeOperationError(ctx.getNode(), 'The message text is empty', { itemIndex: i });
      return (await telegramRequest(
        ctx,
        'sendMessage',
        { chat_id: chatId(ctx, i), text, ...common(ctx, i) },
        i,
      )) as DataObject;
    },
    async sendPhoto(ctx, i) {
      return (await sendFile(ctx, i, 'sendPhoto', 'photo')) as DataObject;
    },
    async sendDocument(ctx, i) {
      return (await sendFile(ctx, i, 'sendDocument', 'document')) as DataObject;
    },
    async sendLocation(ctx, i) {
      const latitude = Number(ctx.getNodeParameter('latitude', i, 0));
      const longitude = Number(ctx.getNodeParameter('longitude', i, 0));
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new NodeOperationError(ctx.getNode(), 'Latitude must be within ±90 and longitude within ±180', {
          itemIndex: i,
        });
      }
      return (await telegramRequest(
        ctx,
        'sendLocation',
        { chat_id: chatId(ctx, i), latitude, longitude, ...common(ctx, i) },
        i,
      )) as DataObject;
    },
    async sendChatAction(ctx, i) {
      const ok = await telegramRequest(
        ctx,
        'sendChatAction',
        { chat_id: chatId(ctx, i), action: ctx.getNodeParameter('action', i, 'typing') },
        i,
      );
      return { success: ok === true };
    },
    async editMessageText(ctx, i) {
      const text = String(ctx.getNodeParameter('text', i, '') ?? '');
      const result = await telegramRequest(
        ctx,
        'editMessageText',
        { chat_id: chatId(ctx, i), message_id: messageId(ctx, i), text, ...common(ctx, i) },
        i,
      );
      return isPlainObject(result) ? result : { success: result === true };
    },
    async deleteMessage(ctx, i) {
      const ok = await telegramRequest(
        ctx,
        'deleteMessage',
        { chat_id: chatId(ctx, i), message_id: messageId(ctx, i) },
        i,
      );
      return { success: ok === true };
    },
    async pinChatMessage(ctx, i) {
      const ok = await telegramRequest(
        ctx,
        'pinChatMessage',
        {
          chat_id: chatId(ctx, i),
          message_id: messageId(ctx, i),
          disable_notification:
            ctx.getNodeParameter('additionalFields.disable_notification', i, false) || undefined,
        },
        i,
      );
      return { success: ok === true };
    },
  },
  chat: {
    async get(ctx, i) {
      return (await telegramRequest(ctx, 'getChat', { chat_id: chatId(ctx, i) }, i)) as DataObject;
    },
    async administrators(ctx, i) {
      return (await telegramRequest(
        ctx,
        'getChatAdministrators',
        { chat_id: chatId(ctx, i) },
        i,
      )) as DataObject[];
    },
  },
  callback: {
    async answerQuery(ctx, i) {
      const fields = ctx.getNodeParameter('additionalFields', i, {}) as DataObject;
      const ok = await telegramRequest(
        ctx,
        'answerCallbackQuery',
        {
          callback_query_id: requiredId(ctx, 'queryId', i, 'Query ID'),
          text: fields.text,
          show_alert: fields.show_alert,
          url: fields.url,
          cache_time: fields.cache_time,
        },
        i,
      );
      return { success: ok === true };
    },
  },
};

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const sendOps = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendLocation', 'editMessageText'];

const additionalFields = (operations: string[], extra: NodeProperty[] = []): NodeProperty =>
  forOps(
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      placeholder: 'Add field',
      options: [
        {
          displayName: 'Parse Mode',
          name: 'parse_mode',
          type: 'options',
          default: 'HTML',
          options: [
            { name: 'HTML', value: 'HTML' },
            { name: 'MarkdownV2', value: 'MarkdownV2' },
            { name: 'Markdown (Legacy)', value: 'Markdown' },
            { name: 'None', value: 'none' },
          ],
        },
        {
          displayName: 'Disable Notification',
          name: 'disable_notification',
          type: 'boolean',
          default: false,
        },
        {
          displayName: 'Disable Link Preview',
          name: 'disable_web_page_preview',
          type: 'boolean',
          default: false,
        },
        { displayName: 'Reply To Message ID', name: 'reply_to_message_id', type: 'number', default: 0 },
        {
          displayName: 'Message Thread ID',
          name: 'message_thread_id',
          type: 'number',
          default: 0,
          description: 'Topic of a forum supergroup',
        },
        {
          displayName: 'Reply Markup',
          name: 'reply_markup',
          type: 'json',
          default: '',
          description:
            'Inline or reply keyboard JSON, e.g. {"inline_keyboard": [[{"text": "Yes", "callback_data": "yes"}]]}',
        },
        ...extra,
      ],
    },
    'message',
    operations,
  );

const properties: NodeProperty[] = [
  resourceProperty(
    [
      { name: 'Message', value: 'message' },
      { name: 'Chat', value: 'chat' },
      { name: 'Callback', value: 'callback' },
    ],
    'message',
  ),
  operationProperty(
    'message',
    [
      { name: 'Send Message', value: 'sendMessage', action: 'Send a text message' },
      { name: 'Send Photo', value: 'sendPhoto', action: 'Send a photo' },
      { name: 'Send Document', value: 'sendDocument', action: 'Send a document' },
      { name: 'Send Location', value: 'sendLocation', action: 'Send a location' },
      { name: 'Send Chat Action', value: 'sendChatAction', action: 'Send a chat action' },
      { name: 'Edit Message Text', value: 'editMessageText', action: 'Edit a text message' },
      { name: 'Delete Message', value: 'deleteMessage', action: 'Delete a message' },
      { name: 'Pin Message', value: 'pinChatMessage', action: 'Pin a message' },
    ],
    'sendMessage',
  ),
  operationProperty(
    'chat',
    [
      { name: 'Get', value: 'get', action: 'Get a chat' },
      { name: 'Get Administrators', value: 'administrators', action: 'Get the administrators of a chat' },
    ],
    'get',
  ),
  operationProperty(
    'callback',
    [{ name: 'Answer Query', value: 'answerQuery', action: 'Answer a callback query' }],
    'answerQuery',
  ),
  forOps(
    {
      displayName: 'Chat ID',
      name: 'chatId',
      type: 'string',
      default: '',
      required: true,
      placeholder: '-1001234567890 or @channelusername',
    },
    ['message', 'chat'],
    [...sendOps, 'sendChatAction', 'deleteMessage', 'pinChatMessage', 'get', 'administrators'],
  ),
  forOps(
    { displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true },
    'message',
    ['editMessageText', 'deleteMessage', 'pinChatMessage'],
  ),
  forOps(
    {
      displayName: 'Text',
      name: 'text',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { rows: 3 },
    },
    'message',
    ['sendMessage', 'editMessageText'],
  ),
  forOps(
    {
      displayName: 'Binary File',
      name: 'binaryData',
      type: 'boolean',
      default: false,
      description: 'Whether to upload a binary file of the item',
    },
    'message',
    ['sendPhoto', 'sendDocument'],
  ),
  {
    displayName: 'Input Binary Field',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: {
      show: { resource: ['message'], operation: ['sendPhoto', 'sendDocument'], binaryData: [true] },
    },
  },
  {
    displayName: 'File URL or ID',
    name: 'file',
    type: 'string',
    default: '',
    required: true,
    description: 'An HTTP URL Telegram downloads, or the file_id of a file already on Telegram',
    displayOptions: {
      show: { resource: ['message'], operation: ['sendPhoto', 'sendDocument'], binaryData: [false] },
    },
  },
  forOps(
    {
      displayName: 'Latitude',
      name: 'latitude',
      type: 'number',
      default: 0,
      typeOptions: { numberPrecision: 6 },
    },
    'message',
    'sendLocation',
  ),
  forOps(
    {
      displayName: 'Longitude',
      name: 'longitude',
      type: 'number',
      default: 0,
      typeOptions: { numberPrecision: 6 },
    },
    'message',
    'sendLocation',
  ),
  forOps(
    {
      displayName: 'Action',
      name: 'action',
      type: 'options',
      default: 'typing',
      options: [
        'typing',
        'upload_photo',
        'record_video',
        'upload_video',
        'record_voice',
        'upload_voice',
        'upload_document',
        'find_location',
      ].map((a) => ({ name: a.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), value: a })),
    },
    'message',
    'sendChatAction',
  ),
  additionalFields(['sendMessage', 'sendLocation', 'editMessageText']),
  additionalFields(
    ['sendPhoto', 'sendDocument'],
    [{ displayName: 'Caption', name: 'caption', type: 'string', default: '' }],
  ),
  forOps(
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      placeholder: 'Add field',
      options: [
        {
          displayName: 'Disable Notification',
          name: 'disable_notification',
          type: 'boolean',
          default: false,
        },
      ],
    },
    'message',
    'pinChatMessage',
  ),
  forOps(
    {
      displayName: 'Query ID',
      name: 'queryId',
      type: 'string',
      default: '',
      required: true,
      placeholder: '={{ $json.callback_query.id }}',
    },
    'callback',
    'answerQuery',
  ),
  forOps(
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      placeholder: 'Add field',
      options: [
        { displayName: 'Text', name: 'text', type: 'string', default: '' },
        { displayName: 'Show Alert', name: 'show_alert', type: 'boolean', default: false },
        { displayName: 'URL', name: 'url', type: 'string', default: '' },
        {
          displayName: 'Cache Time',
          name: 'cache_time',
          type: 'number',
          default: 0,
          description: 'Seconds the answer may be cached',
        },
      ],
    },
    'callback',
    'answerQuery',
  ),
];

export const TelegramNode: NodeType = {
  description: {
    name: 'app.telegram',
    displayName: 'Telegram',
    description: 'Send and manage messages with a Telegram bot',
    icon: 'simple:telegram',
    iconColor: '#26a5e4',
    group: ['output'],
    version: 1,
    defaults: { name: 'Telegram' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Communication'],
    alias: ['bot', 'chat', 'message', 'notify', 'messenger'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [{ name: 'telegramApi', required: true }],
    properties,
  },
  async execute(ctx) {
    return runOperations(ctx, handlers);
  },
};

// ---------------------------------------------------------------------------------------------
// Telegram Trigger
// ---------------------------------------------------------------------------------------------

const UPDATE_TYPES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'inline_query',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'message_reaction',
];

/**
 * The secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. It is derived from the bot
 * token and the node identity, so registration and verification agree without stored state and
 * another tenant's bot cannot forge deliveries.
 */
export function telegramSecretToken(
  accessToken: string,
  tenantId: string,
  workflowId: string,
  nodeId: string,
): string {
  return createHmac('sha256', accessToken)
    .update(`telegram-webhook:${tenantId}:${workflowId}:${nodeId}`)
    .digest('base64url');
}

async function secretFor(ctx: WebhookLifecycleContext | WebhookContext): Promise<string> {
  const { token } = await telegramCredentials(ctx);
  const node = ctx.getNode();
  return telegramSecretToken(token, ctx.getTenantId(), ctx.getWorkflow().id ?? '', node.webhookId ?? node.id);
}

function allowedUpdates(ctx: BaseContext): string[] {
  const updates = ctx.getNodeParameter('updates', 0, ['message']) as string[];
  return Array.isArray(updates) && !updates.includes('*') ? updates : [];
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** largest photo, or the document / audio / video / voice / video note of a message */
function fileOf(message: DataObject): { fileId: string; fileName?: string; mimeType?: string } | undefined {
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = (message.photo as DataObject[]).reduce((a, b) =>
      Number(b.file_size ?? 0) > Number(a.file_size ?? 0) ? b : a,
    );
    return { fileId: String(largest.file_id), mimeType: 'image/jpeg' };
  }
  for (const key of ['document', 'audio', 'video', 'voice', 'video_note', 'animation']) {
    const file = message[key] as DataObject | undefined;
    if (file?.file_id)
      return {
        fileId: String(file.file_id),
        fileName: file.file_name as string | undefined,
        mimeType: file.mime_type as string | undefined,
      };
  }
  return undefined;
}

export const TelegramTriggerNode: NodeType = {
  description: {
    name: 'app.telegramTrigger',
    displayName: 'Telegram Trigger',
    description: 'Start the workflow when your Telegram bot receives an update',
    icon: 'simple:telegram',
    iconColor: '#26a5e4',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Telegram Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Communication', 'Triggers'],
    alias: ['bot', 'chat', 'message received', 'telegram webhook'],
    credentials: [{ name: 'telegramApi', required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook', responseMode: 'onReceived' }],
    eventTriggerDescription: 'Waiting for your bot to receive a message',
    activationMessage: 'Telegram now sends your bot updates to this workflow.',
    properties: [
      {
        displayName:
          'A bot has only one webhook: activating this workflow replaces any webhook the bot had before.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Trigger On',
        name: 'updates',
        type: 'multiOptions',
        default: ['message'],
        required: true,
        options: [
          { name: '* (All Updates)', value: '*' },
          ...UPDATE_TYPES.map((u) => ({
            name: u.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
            value: u,
          })),
        ],
      },
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        default: {},
        placeholder: 'Add field',
        options: [
          {
            displayName: 'Download Files',
            name: 'download',
            type: 'boolean',
            default: false,
            description:
              'Whether photos, documents, audio and video in messages are downloaded as binary data',
          },
          {
            displayName: 'Restrict to Chat IDs',
            name: 'chatIds',
            type: 'string',
            default: '',
            placeholder: '123456789, -1001234567890',
            description: 'Comma-separated chat IDs; updates from other chats are ignored',
          },
        ],
      },
    ],
  },

  webhookMethods: {
    default: {
      async checkExists(ctx) {
        const info = (await telegramRequest(ctx, 'getWebhookInfo')) as DataObject;
        return info.url === ctx.getNodeWebhookUrl('default');
      },
      async create(ctx) {
        const ok = await telegramRequest(ctx, 'setWebhook', {
          url: ctx.getNodeWebhookUrl('default'),
          allowed_updates: allowedUpdates(ctx),
          secret_token: await secretFor(ctx),
        });
        return ok === true;
      },
      async delete(ctx) {
        try {
          return (await telegramRequest(ctx, 'deleteWebhook')) === true;
        } catch {
          return false;
        }
      },
    },
  },

  async webhook(ctx: WebhookContext): Promise<WebhookResponseData> {
    const header = ctx.getHeaderData()['x-telegram-bot-api-secret-token'];
    const got = Array.isArray(header) ? header[0] : header;
    if (!got || !safeEqual(got, await secretFor(ctx))) {
      return { webhookResponse: { statusCode: 403, body: { message: 'Invalid secret token' } } };
    }
    const update = ctx.getBodyData();
    const allowed = allowedUpdates(ctx);
    if (allowed.length && !allowed.some((type) => type in update)) {
      // acknowledge so Telegram does not retry, but do not start the workflow
      return { webhookResponse: { statusCode: 200, body: { ok: true } } };
    }
    const fields = ctx.getNodeParameter('additionalFields', 0, {}) as DataObject;
    const chatIds = String(fields.chatIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const message = (update.message ??
      update.edited_message ??
      update.channel_post ??
      update.edited_channel_post) as DataObject | undefined;
    const chat = (message?.chat ??
      ((update.callback_query as DataObject | undefined)?.message as DataObject | undefined)?.chat) as
      | DataObject
      | undefined;
    if (chatIds.length && !(chat && chatIds.includes(String(chat.id)))) {
      return { webhookResponse: { statusCode: 200, body: { ok: true } } };
    }
    const item: Item = { json: update, pairedItem: { item: 0 } };
    if (fields.download && message) {
      const file = fileOf(message);
      if (file) {
        const info = (await telegramRequest(ctx, 'getFile', { file_id: file.fileId })) as DataObject;
        const { token, baseUrl } = await telegramCredentials(ctx);
        const filePath = String(info.file_path ?? '');
        if (filePath && !filePath.includes('..')) {
          let data: Uint8Array;
          try {
            data = (await ctx.helpers.httpRequest({
              url: `${baseUrl}/file/bot${token}/${filePath}`,
              method: 'GET',
              responseType: 'arraybuffer',
            })) as Uint8Array;
          } catch (error) {
            throw new NodeApiError(ctx.getNode(), redact((error as Error).message, token), {
              request: { method: 'GET', url: `${baseUrl}/file/bot[redacted]/...` },
            });
          }
          item.binary = {
            data: await ctx.helpers.prepareBinaryData(
              data,
              file.fileName ?? filePath.split('/').pop(),
              file.mimeType,
            ),
          };
        }
      }
    }
    return { workflowData: [[item]] };
  },
};
