/** Gmail: send, reply, read, search, label and draft messages (Gmail API v1) + polling trigger. */
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpMethod,
  type Item,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type PollContext,
} from '@workflow/workflow';
import {
  SEND_AND_WAIT,
  SEND_AND_WAIT_OPERATION,
  sendAndWaitProperties,
  sendAndWaitWebhooks,
} from '../../../utils/send-and-wait/descriptions';
import { emailHtml, emailText } from '../../../utils/send-and-wait/pages';
import { sendAndWait } from '../../../utils/send-and-wait/wait';
import { sendAndWaitWebhook } from '../../../utils/send-and-wait/webhook';
import { base64Url, fieldList, ItemList } from '../../../utils/utilities';
import {
  compact,
  forOps,
  type OperationHandler,
  operationProperty,
  requiredId,
  resourceProperty,
  returnAllProperties,
  runOperations,
} from '../shared';
import { buildMimeMessage, decodeBase64Url, type MimeAttachment, simplifyGmailMessage } from './mime';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CREDENTIAL = 'gmailOAuth2';

type GoogleContext = Pick<BaseContext, 'helpers'>;

export async function gmailRequest<T = DataObject>(
  ctx: GoogleContext,
  method: HttpMethod,
  path: string,
  body?: DataObject,
  qs?: DataObject,
  itemIndex = 0,
): Promise<T> {
  return (await ctx.helpers.httpRequestWithAuthentication(
    CREDENTIAL,
    {
      method,
      url: `${GMAIL_BASE}${path}`,
      body,
      bodyType: body ? 'json' : undefined,
      qs: qs ? compact(qs) : undefined,
      responseType: 'json',
    },
    itemIndex,
  )) as T;
}

async function attachmentsOf(ctx: ExecuteContext, i: number, properties: unknown): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  for (const property of fieldList(properties)) {
    const meta = ctx.helpers.assertBinaryData(i, property);
    out.push({
      fileName: meta.fileName ?? property,
      mimeType: meta.mimeType,
      data: await ctx.helpers.getBinaryDataBuffer(i, property),
    });
  }
  return out;
}

function bodyFields(ctx: ExecuteContext, i: number): { text?: string; html?: string } {
  const message = String(ctx.getNodeParameter('message', i, '') ?? '');
  return ctx.getNodeParameter('emailType', i, 'html') === 'text' ? { text: message } : { html: message };
}

/** Gmail fills in the account address; a sender name needs the address, so look it up. */
async function senderFrom(ctx: ExecuteContext, i: number, options: DataObject): Promise<string | undefined> {
  if (!options.senderName) return undefined;
  const profile = await gmailRequest(ctx, 'GET', '/profile', undefined, undefined, i);
  return `${String(options.senderName).replace(/[<>"\r\n]/g, '')} <${String(profile.emailAddress)}>`;
}

/** Turn a full Gmail message into an item, optionally downloading attachments as binary data. */
export async function messageToItem(
  ctx: GoogleContext,
  message: DataObject,
  options: { simple: boolean; downloadAttachments: boolean; prefix: string },
  itemIndex = 0,
): Promise<Item> {
  const simple = simplifyGmailMessage(message);
  const item: Item = { json: options.simple ? simple : message };
  if (options.downloadAttachments && simple.attachments.length) {
    item.binary = {};
    for (const [n, attachment] of simple.attachments.entries()) {
      const data = await gmailRequest<{ data: string }>(
        ctx,
        'GET',
        `/messages/${encodeURIComponent(String(message.id))}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
        undefined,
        undefined,
        itemIndex,
      );
      item.binary[`${options.prefix}${n}`] = await ctx.helpers.prepareBinaryData(
        decodeBase64Url(data.data),
        attachment.fileName,
        attachment.mimeType,
      );
    }
  }
  return item;
}

function readOptions(ctx: ExecuteContext, i: number) {
  const options = ctx.getNodeParameter('options', i, {}) as DataObject;
  return {
    simple: ctx.getNodeParameter('simple', i, true) !== false,
    downloadAttachments: Boolean(options.downloadAttachments),
    prefix: String(options.dataPropertyAttachmentsPrefixName || 'attachment_'),
  };
}

/** Gmail search query from the node's filter fields. */
export function buildQuery(filters: DataObject): string {
  const parts: string[] = [];
  if (filters.q) parts.push(String(filters.q));
  if (filters.sender) parts.push(`from:${String(filters.sender)}`);
  if (filters.readStatus === 'unread') parts.push('is:unread');
  if (filters.readStatus === 'read') parts.push('is:read');
  const seconds = (value: unknown) => {
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  };
  if (filters.receivedAfter && seconds(filters.receivedAfter) !== undefined)
    parts.push(`after:${seconds(filters.receivedAfter)}`);
  if (filters.receivedBefore && seconds(filters.receivedBefore) !== undefined)
    parts.push(`before:${seconds(filters.receivedBefore)}`);
  return parts.join(' ');
}

/** List message ids (newest first) with page tokens until `limit`. */
export async function listMessageIds(
  ctx: GoogleContext,
  filters: DataObject,
  limit: number,
  itemIndex = 0,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await gmailRequest(
      ctx,
      'GET',
      '/messages',
      undefined,
      {
        q: buildQuery(filters) || undefined,
        labelIds: Array.isArray(filters.labelIds) && filters.labelIds.length ? filters.labelIds : undefined,
        includeSpamTrash: filters.includeSpamTrash ? true : undefined,
        maxResults: Math.min(500, Number.isFinite(limit) ? limit : 500),
        pageToken,
      },
      itemIndex,
    );
    ids.push(...((response.messages as Array<{ id: string }> | undefined) ?? []).map((m) => m.id));
    pageToken = response.nextPageToken as string | undefined;
    if (ids.length >= limit || !pageToken) break;
  }
  return Number.isFinite(limit) ? ids.slice(0, limit) : ids;
}

function labelIdsParam(ctx: ExecuteContext, i: number): string[] {
  const labels = ctx.getNodeParameter('labelIds', i, []);
  const list = fieldList(labels);
  if (!list.length)
    throw new NodeOperationError(ctx.getNode(), 'Select at least one label', { itemIndex: i });
  return list;
}

function messageId(ctx: ExecuteContext, i: number): string {
  return encodeURIComponent(requiredId(ctx, 'messageId', i, 'Message ID'));
}

const handlers: Record<string, Record<string, OperationHandler>> = {
  message: {
    async send(ctx, i) {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const to = String(ctx.getNodeParameter('sendTo', i, '') ?? '').trim();
      if (!to) throw new NodeOperationError(ctx.getNode(), 'Add at least one recipient', { itemIndex: i });
      const raw = buildMimeMessage({
        from: await senderFrom(ctx, i, options),
        to,
        cc: options.ccList as string | undefined,
        bcc: options.bccList as string | undefined,
        replyTo: options.replyTo as string | undefined,
        subject: String(ctx.getNodeParameter('subject', i, '') ?? ''),
        ...bodyFields(ctx, i),
        attachments: await attachmentsOf(ctx, i, options.attachments),
      });
      return gmailRequest(ctx, 'POST', '/messages/send', { raw: base64Url(raw) }, undefined, i);
    },
    async reply(ctx, i) {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const id = messageId(ctx, i);
      const original = await gmailRequest(
        ctx,
        'GET',
        `/messages/${id}`,
        undefined,
        {
          format: 'metadata',
          metadataHeaders: ['Subject', 'Message-ID', 'From', 'Reply-To', 'References', 'To', 'Cc'],
        },
        i,
      );
      const info = simplifyGmailMessage(original);
      const subject = String(info.subject ?? '');
      const headers = ((original.payload as DataObject | undefined)?.headers ?? []) as Array<{
        name: string;
        value: string;
      }>;
      const priorRefs = headers.find((h) => h.name.toLowerCase() === 'references')?.value;
      let to = String(info.replyTo ?? info.from ?? '');
      if (options.replyToSenderOnly === false && info.to) to = `${to}, ${String(info.to)}`;
      const raw = buildMimeMessage({
        from: await senderFrom(ctx, i, options),
        to,
        cc: options.ccList as string | undefined,
        bcc: options.bccList as string | undefined,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        inReplyTo: info.messageId as string | undefined,
        references: [priorRefs, info.messageId].filter(Boolean).join(' ') || undefined,
        ...bodyFields(ctx, i),
        attachments: await attachmentsOf(ctx, i, options.attachments),
      });
      return gmailRequest(
        ctx,
        'POST',
        '/messages/send',
        { raw: base64Url(raw), threadId: original.threadId },
        undefined,
        i,
      );
    },
    async get(ctx, i) {
      const message = await gmailRequest(
        ctx,
        'GET',
        `/messages/${messageId(ctx, i)}`,
        undefined,
        { format: 'full' },
        i,
      );
      return new ItemList([await messageToItem(ctx, message, readOptions(ctx, i), i)]);
    },
    async getAll(ctx, i) {
      const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
      const limit = returnAll ? Number.POSITIVE_INFINITY : Number(ctx.getNodeParameter('limit', i, 50));
      const filters = ctx.getNodeParameter('filters', i, {}) as DataObject;
      const ids = await listMessageIds(ctx, filters, limit, i);
      const options = readOptions(ctx, i);
      const items: Item[] = [];
      for (const id of ids) {
        const message = await gmailRequest(
          ctx,
          'GET',
          `/messages/${encodeURIComponent(id)}`,
          undefined,
          {
            format: options.simple || options.downloadAttachments ? 'full' : 'raw',
          },
          i,
        );
        items.push(await messageToItem(ctx, message, options, i));
      }
      return new ItemList(items);
    },
    async delete(ctx, i) {
      const id = messageId(ctx, i);
      await gmailRequest(ctx, 'DELETE', `/messages/${id}`, undefined, undefined, i);
      return { success: true, id: decodeURIComponent(id) };
    },
    async markRead(ctx, i) {
      return gmailRequest(
        ctx,
        'POST',
        `/messages/${messageId(ctx, i)}/modify`,
        { removeLabelIds: ['UNREAD'] },
        undefined,
        i,
      );
    },
    async markUnread(ctx, i) {
      return gmailRequest(
        ctx,
        'POST',
        `/messages/${messageId(ctx, i)}/modify`,
        { addLabelIds: ['UNREAD'] },
        undefined,
        i,
      );
    },
    async addLabels(ctx, i) {
      return gmailRequest(
        ctx,
        'POST',
        `/messages/${messageId(ctx, i)}/modify`,
        { addLabelIds: labelIdsParam(ctx, i) },
        undefined,
        i,
      );
    },
    async removeLabels(ctx, i) {
      return gmailRequest(
        ctx,
        'POST',
        `/messages/${messageId(ctx, i)}/modify`,
        { removeLabelIds: labelIdsParam(ctx, i) },
        undefined,
        i,
      );
    },
  },
  draft: {
    async create(ctx, i) {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const raw = buildMimeMessage({
        from: await senderFrom(ctx, i, options),
        to: options.sendTo as string | undefined,
        cc: options.ccList as string | undefined,
        bcc: options.bccList as string | undefined,
        replyTo: options.replyTo as string | undefined,
        subject: String(ctx.getNodeParameter('subject', i, '') ?? ''),
        ...bodyFields(ctx, i),
        attachments: await attachmentsOf(ctx, i, options.attachments),
      });
      return gmailRequest(
        ctx,
        'POST',
        '/drafts',
        { message: compact({ raw: base64Url(raw), threadId: options.threadId }) },
        undefined,
        i,
      );
    },
    async get(ctx, i) {
      const draft = await gmailRequest(
        ctx,
        'GET',
        `/drafts/${encodeURIComponent(requiredId(ctx, 'draftId', i, 'Draft ID'))}`,
        undefined,
        {
          format: 'full',
        },
        i,
      );
      const item = await messageToItem(ctx, (draft.message ?? {}) as DataObject, readOptions(ctx, i), i);
      return new ItemList([{ ...item, json: { draftId: draft.id, ...item.json } }]);
    },
    async delete(ctx, i) {
      const id = requiredId(ctx, 'draftId', i, 'Draft ID');
      await gmailRequest(ctx, 'DELETE', `/drafts/${encodeURIComponent(id)}`, undefined, undefined, i);
      return { success: true, id };
    },
  },
  label: {
    async getAll(ctx, i) {
      const response = await gmailRequest(ctx, 'GET', '/labels', undefined, undefined, i);
      const labels = (response.labels as DataObject[]) ?? [];
      const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
      return returnAll ? labels : labels.slice(0, Number(ctx.getNodeParameter('limit', i, 50)));
    },
    async create(ctx, i) {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      return gmailRequest(
        ctx,
        'POST',
        '/labels',
        compact({
          name: requiredId(ctx, 'name', i, 'Label name'),
          labelListVisibility: options.labelListVisibility ?? 'labelShow',
          messageListVisibility: options.messageListVisibility ?? 'show',
        }),
        undefined,
        i,
      );
    },
  },
};

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const emailTypeProperty: NodeProperty = {
  displayName: 'Email Type',
  name: 'emailType',
  type: 'options',
  default: 'html',
  options: [
    { name: 'HTML', value: 'html' },
    { name: 'Text', value: 'text' },
  ],
};

const messageProperty: NodeProperty = {
  displayName: 'Message',
  name: 'message',
  type: 'string',
  default: '',
  typeOptions: { rows: 5 },
};

const composeOptions = (extra: NodeProperty[] = []): NodeProperty['options'] => [
  {
    displayName: 'Attachments',
    name: 'attachments',
    type: 'string',
    default: '',
    placeholder: 'data, invoice',
    description: 'Comma-separated binary properties of the item to attach',
  },
  { displayName: 'CC', name: 'ccList', type: 'string', default: '', placeholder: 'info@example.com' },
  { displayName: 'BCC', name: 'bccList', type: 'string', default: '' },
  {
    displayName: 'Sender Name',
    name: 'senderName',
    type: 'string',
    default: '',
    placeholder: 'Ada Lovelace',
  },
  ...extra,
];

const labelIdsProperty: NodeProperty = {
  displayName: 'Label Names or IDs',
  name: 'labelIds',
  type: 'multiOptions',
  default: [],
  typeOptions: { loadOptionsMethod: 'getLabels' },
  description: 'Choose from the list, or specify IDs using an expression',
};

export const gmailFilterOptions: NodeProperty[] = [
  { ...labelIdsProperty, description: 'Only messages with all of these labels' },
  {
    displayName: 'Search',
    name: 'q',
    type: 'string',
    default: '',
    placeholder: 'has:attachment subject:invoice',
    description: 'Gmail search syntax',
  },
  {
    displayName: 'Read Status',
    name: 'readStatus',
    type: 'options',
    default: 'both',
    options: [
      { name: 'Unread and Read', value: 'both' },
      { name: 'Unread Only', value: 'unread' },
      { name: 'Read Only', value: 'read' },
    ],
  },
  { displayName: 'Sender', name: 'sender', type: 'string', default: '', placeholder: 'billing@example.com' },
  { displayName: 'Include Spam and Trash', name: 'includeSpamTrash', type: 'boolean', default: false },
];

export const gmailReadOptions: NodeProperty[] = [
  {
    displayName: 'Download Attachments',
    name: 'downloadAttachments',
    type: 'boolean',
    default: false,
  },
  {
    displayName: 'Attachment Prefix',
    name: 'dataPropertyAttachmentsPrefixName',
    type: 'string',
    default: 'attachment_',
    description: 'Attachments are stored as attachment_0, attachment_1, ...',
  },
];

const properties: NodeProperty[] = [
  resourceProperty(
    [
      { name: 'Message', value: 'message' },
      { name: 'Draft', value: 'draft' },
      { name: 'Label', value: 'label' },
    ],
    'message',
  ),
  operationProperty(
    'message',
    [
      { name: 'Send', value: 'send', action: 'Send a message' },
      SEND_AND_WAIT_OPERATION,
      { name: 'Reply', value: 'reply', action: 'Reply to a message' },
      { name: 'Get', value: 'get', action: 'Get a message' },
      { name: 'Get Many', value: 'getAll', action: 'Get many messages' },
      { name: 'Delete', value: 'delete', action: 'Delete a message' },
      { name: 'Mark as Read', value: 'markRead', action: 'Mark a message as read' },
      { name: 'Mark as Unread', value: 'markUnread', action: 'Mark a message as unread' },
      { name: 'Add Labels', value: 'addLabels', action: 'Add labels to a message' },
      { name: 'Remove Labels', value: 'removeLabels', action: 'Remove labels from a message' },
    ],
    'send',
  ),
  operationProperty(
    'draft',
    [
      { name: 'Create', value: 'create', action: 'Create a draft' },
      { name: 'Get', value: 'get', action: 'Get a draft' },
      { name: 'Delete', value: 'delete', action: 'Delete a draft' },
    ],
    'create',
  ),
  operationProperty(
    'label',
    [
      { name: 'Get Many', value: 'getAll', action: 'Get many labels' },
      { name: 'Create', value: 'create', action: 'Create a label' },
    ],
    'getAll',
  ),
  forOps(
    { displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true },
    'message',
    ['reply', 'get', 'delete', 'markRead', 'markUnread', 'addLabels', 'removeLabels'],
  ),
  forOps(
    {
      displayName: 'To',
      name: 'sendTo',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'info@example.com',
    },
    'message',
    ['send', SEND_AND_WAIT],
  ),
  forOps(
    { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
    ['message', 'draft'],
    ['send', 'create', SEND_AND_WAIT],
  ),
  ...sendAndWaitProperties({ resource: ['message'], operation: [SEND_AND_WAIT] }),
  forOps(emailTypeProperty, ['message', 'draft'], ['send', 'reply', 'create']),
  forOps(messageProperty, ['message', 'draft'], ['send', 'reply', 'create']),
  forOps({ ...labelIdsProperty, required: true }, 'message', ['addLabels', 'removeLabels']),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: composeOptions([{ displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' }]),
    },
    'message',
    'send',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: composeOptions([
        {
          displayName: 'Reply to Sender Only',
          name: 'replyToSenderOnly',
          type: 'boolean',
          default: true,
          description: 'Whether to reply only to the sender instead of everyone on the message',
        },
      ]),
    },
    'message',
    'reply',
  ),
  forOps(
    {
      displayName: 'Simplify',
      name: 'simple',
      type: 'boolean',
      default: true,
      description: 'Whether to return sender, subject, text and HTML instead of the raw API response',
    },
    ['message', 'draft'],
    ['get', 'getAll'],
  ),
  ...returnAllProperties('message', 'getAll'),
  forOps(
    {
      displayName: 'Filters',
      name: 'filters',
      type: 'collection',
      default: {},
      placeholder: 'Add filter',
      options: [
        ...gmailFilterOptions,
        { displayName: 'Received After', name: 'receivedAfter', type: 'dateTime', default: '' },
        { displayName: 'Received Before', name: 'receivedBefore', type: 'dateTime', default: '' },
      ],
    },
    'message',
    'getAll',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: gmailReadOptions,
    },
    ['message', 'draft'],
    ['get', 'getAll'],
  ),
  forOps({ displayName: 'Draft ID', name: 'draftId', type: 'string', default: '', required: true }, 'draft', [
    'get',
    'delete',
  ]),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: composeOptions([
        { displayName: 'To', name: 'sendTo', type: 'string', default: '' },
        { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
        {
          displayName: 'Thread ID',
          name: 'threadId',
          type: 'string',
          default: '',
          description: 'Create the draft as a reply in this thread',
        },
      ]),
    },
    'draft',
    'create',
  ),
  ...returnAllProperties('label', 'getAll'),
  forOps(
    {
      displayName: 'Name',
      name: 'name',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'invoices',
    },
    'label',
    'create',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Label List Visibility',
          name: 'labelListVisibility',
          type: 'options',
          default: 'labelShow',
          options: [
            { name: 'Show', value: 'labelShow' },
            { name: 'Show If Unread', value: 'labelShowIfUnread' },
            { name: 'Hide', value: 'labelHide' },
          ],
        },
        {
          displayName: 'Message List Visibility',
          name: 'messageListVisibility',
          type: 'options',
          default: 'show',
          options: [
            { name: 'Show', value: 'show' },
            { name: 'Hide', value: 'hide' },
          ],
        },
      ],
    },
    'label',
    'create',
  ),
];

export async function loadGmailLabels(ctx: LoadOptionsContext) {
  const response = await gmailRequest(ctx, 'GET', '/labels');
  return ((response.labels as DataObject[]) ?? [])
    .map((l) => ({ name: String(l.name), value: String(l.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const GmailNode: NodeType = {
  description: {
    name: 'app.gmail',
    displayName: 'Gmail',
    description: 'Send, read, search and organise Gmail messages, drafts and labels',
    icon: 'simple:gmail',
    iconColor: '#ea4335',
    group: ['output'],
    version: 1,
    defaults: { name: 'Gmail' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Communication'],
    alias: ['email', 'google mail', 'inbox', 'mail'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [{ name: 'gmailOAuth2', required: true }],
    webhooks: sendAndWaitWebhooks,
    properties,
  },
  async execute(ctx) {
    if (
      ctx.getNodeParameter('resource', 0, 'message') === 'message' &&
      ctx.getNodeParameter('operation', 0, 'send') === SEND_AND_WAIT
    ) {
      return sendAndWait(ctx, async ({ message, buttons }) => {
        const to = String(ctx.getNodeParameter('sendTo', 0, '') ?? '').trim();
        if (!to) throw new NodeOperationError(ctx.getNode(), 'Add at least one recipient');
        const raw = buildMimeMessage({
          to,
          subject: String(ctx.getNodeParameter('subject', 0, '') ?? ''),
          text: emailText(message, buttons),
          html: emailHtml(message, buttons),
        });
        await gmailRequest(ctx, 'POST', '/messages/send', { raw: base64Url(raw) }, undefined, 0);
      });
    }
    return runOperations(ctx, handlers);
  },
  webhook: sendAndWaitWebhook,
  methods: { loadOptions: { getLabels: loadGmailLabels } },
};

// ---------------------------------------------------------------------------------------------
// Gmail Trigger (polling)
// ---------------------------------------------------------------------------------------------

interface GmailPollState {
  lastTimeChecked?: number;
  possibleDuplicates?: string[];
}

export const GmailTriggerNode: NodeType = {
  description: {
    name: 'app.gmailTrigger',
    displayName: 'Gmail Trigger',
    description: 'Start the workflow when new emails arrive in Gmail',
    icon: 'simple:gmail',
    iconColor: '#ea4335',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Gmail Trigger' },
    inputs: [],
    outputs: ['main'],
    polling: true,
    categories: ['Communication', 'Triggers'],
    alias: ['email', 'inbox', 'new email', 'mail received'],
    credentials: [{ name: 'gmailOAuth2', required: true }],
    eventTriggerDescription: 'Waiting for a new email in Gmail',
    properties: [
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        default: 'messageReceived',
        options: [{ name: 'Message Received', value: 'messageReceived' }],
      },
      {
        displayName: 'Simplify',
        name: 'simple',
        type: 'boolean',
        default: true,
        description: 'Whether to return sender, subject, text and HTML instead of the raw API response',
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        default: {},
        placeholder: 'Add filter',
        options: gmailFilterOptions,
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: gmailReadOptions,
      },
    ],
  },

  async poll(ctx: PollContext) {
    const state = ctx.getWorkflowStaticData('node') as GmailPollState;
    const now = Math.floor(Date.now() / 1000);
    const manual = ctx.getMode() === 'manual';
    const filters = { ...(ctx.getNodeParameter('filters', 0, {}) as DataObject) };
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const readOptions = {
      simple: ctx.getNodeParameter('simple', 0, true) !== false,
      downloadAttachments: Boolean(options.downloadAttachments),
      prefix: String(options.dataPropertyAttachmentsPrefixName || 'attachment_'),
    };
    const since = state.lastTimeChecked ?? now;
    if (!manual) filters.receivedAfter = (since - 1) * 1000;

    // a manual test shows the latest matching email; activation polls everything since the last check
    const ids = await listMessageIds(ctx, filters, manual ? 1 : 500);
    const duplicates = new Set(state.possibleDuplicates ?? []);
    const items: Item[] = [];
    let newest = since;
    const newestIds: string[] = [];
    for (const id of ids) {
      if (!manual && duplicates.has(id)) continue;
      const message = await gmailRequest(ctx, 'GET', `/messages/${encodeURIComponent(id)}`, undefined, {
        format: 'full',
      });
      const received = Math.floor(Number(message.internalDate ?? 0) / 1000);
      if (!manual && received < since) continue;
      if (received > newest) {
        newest = received;
        newestIds.length = 0;
      }
      if (received === newest) newestIds.push(id);
      items.push(await messageToItem(ctx, message, readOptions));
    }
    if (!manual) {
      state.lastTimeChecked = Math.max(newest, since);
      // ids received in the newest second are kept so the next poll (after:<second>) skips them
      state.possibleDuplicates = newest === since ? [...duplicates, ...newestIds] : newestIds;
    }
    if (!items.length) return null;
    // oldest first, like a mailbox timeline
    items.reverse();
    return [items.map((item, i) => ({ ...item, pairedItem: { item: i } }))];
  },
  methods: { loadOptions: { getLabels: loadGmailLabels } },
};
