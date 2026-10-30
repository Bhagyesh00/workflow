/** Slack: messages, channels, users, files and reactions through the Slack Web API. */
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpMethod,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeApiError,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { fieldList, parseJsonParameter } from '../../utils/utilities';
import {
  compact,
  forOps,
  locator,
  type OperationHandler,
  operationProperty,
  requiredId,
  resourceProperty,
  returnAllProperties,
  runOperations,
} from './shared';

const BASE_URL = 'https://slack.com/api';

const SLACK_ERRORS: Record<string, string> = {
  not_in_channel: 'The app is not a member of this channel. Invite it with /invite @your-app first.',
  channel_not_found: 'The channel was not found or the app cannot see it.',
  invalid_auth: 'The Slack token is invalid. Reconnect the credential.',
  missing_scope: 'The Slack token is missing a scope this operation needs.',
  not_allowed_token_type: 'This operation needs a user token (xoxp-), not a bot token.',
  message_not_found: 'The message was not found.',
  ratelimited: 'Slack rate limit reached. Enable "Retry on fail" with exponential backoff.',
  name_taken: 'A channel with this name already exists.',
  already_reacted: 'The reaction is already on this message.',
};

type SlackContext = Pick<BaseContext, 'helpers' | 'getNode'>;

/** Call a Slack Web API method; Slack reports errors as `{ ok: false }` with HTTP 200. */
export async function slackRequest(
  ctx: SlackContext,
  credentialType: string,
  method: HttpMethod,
  endpoint: string,
  body?: DataObject,
  qs?: DataObject,
  itemIndex = 0,
): Promise<DataObject> {
  const response = (await ctx.helpers.httpRequestWithAuthentication(
    credentialType,
    {
      method,
      url: `${BASE_URL}/${endpoint}`,
      qs: qs ? compact(qs) : undefined,
      body: body ? compact(body) : undefined,
      bodyType: body ? 'json' : undefined,
      headers: body ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
      responseType: 'json',
    },
    itemIndex,
  )) as DataObject;
  if (response?.ok !== true) {
    const code = String(response?.error ?? 'unknown_error');
    throw new NodeApiError(ctx.getNode(), SLACK_ERRORS[code] ?? `Slack error: ${code}`, {
      itemIndex,
      description: `Slack API "${endpoint}" returned "${code}"`,
      responseBody: response,
      code: `SLACK_${code.toUpperCase()}`,
    });
  }
  return response;
}

function credentialType(ctx: ExecuteContext, i: number): string {
  return ctx.getNodeParameter('authentication', i, 'accessToken') === 'oAuth2'
    ? 'slackOAuth2Api'
    : 'slackApi';
}

/** Cursor pagination over `response_metadata.next_cursor`. */
async function slackPaginate(
  ctx: ExecuteContext,
  i: number,
  endpoint: string,
  key: string,
  qs: DataObject,
  limit: number,
): Promise<DataObject[]> {
  const out: DataObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = await slackRequest(
      ctx,
      credentialType(ctx, i),
      'GET',
      endpoint,
      undefined,
      { ...qs, cursor, limit: Math.min(200, Number.isFinite(limit) ? limit : 200) },
      i,
    );
    out.push(...((response[key] as DataObject[]) ?? []));
    cursor = (response.response_metadata as DataObject | undefined)?.next_cursor as string | undefined;
    if (out.length >= limit || !cursor) break;
  }
  return out.slice(0, Number.isFinite(limit) ? limit : undefined);
}

function limitOf(ctx: ExecuteContext, i: number): number {
  return ctx.getNodeParameter('returnAll', i, false)
    ? Number.POSITIVE_INFINITY
    : Number(ctx.getNodeParameter('limit', i, 50));
}

function blocksOf(ctx: ExecuteContext, i: number): unknown {
  const raw = ctx.getNodeParameter('blocksUi', i, '');
  if (raw === '' || raw === undefined) return undefined;
  const parsed = parseJsonParameter(ctx, raw, 'Blocks', i);
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as DataObject).blocks)
  ) {
    return (parsed as DataObject).blocks;
  }
  if (parsed !== undefined && !Array.isArray(parsed)) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Blocks must be a JSON array (or an object with a "blocks" array)',
      {
        itemIndex: i,
      },
    );
  }
  return parsed;
}

function messageTarget(ctx: ExecuteContext, i: number): string {
  return ctx.getNodeParameter('select', i, 'channel') === 'user'
    ? requiredId(ctx, 'user', i, 'User')
    : requiredId(ctx, 'channelId', i, 'Channel');
}

const handlers: Record<string, Record<string, OperationHandler>> = {
  message: {
    async send(ctx, i) {
      const options = ctx.getNodeParameter('otherOptions', i, {}) as DataObject;
      const text = String(ctx.getNodeParameter('text', i, '') ?? '');
      const blocks =
        ctx.getNodeParameter('messageType', i, 'text') === 'block' ? blocksOf(ctx, i) : undefined;
      if (!text && !blocks)
        throw new NodeOperationError(ctx.getNode(), 'Enter a message text or blocks', { itemIndex: i });
      return slackRequest(
        ctx,
        credentialType(ctx, i),
        'POST',
        'chat.postMessage',
        {
          channel: messageTarget(ctx, i),
          text,
          blocks,
          thread_ts: options.thread_ts,
          reply_broadcast: options.reply_broadcast,
          mrkdwn: options.mrkdwn,
          unfurl_links: options.unfurl_links,
          unfurl_media: options.unfurl_media,
          link_names: options.link_names,
        },
        undefined,
        i,
      );
    },
    async update(ctx, i) {
      const text = String(ctx.getNodeParameter('text', i, '') ?? '');
      const blocks =
        ctx.getNodeParameter('messageType', i, 'text') === 'block' ? blocksOf(ctx, i) : undefined;
      return slackRequest(
        ctx,
        credentialType(ctx, i),
        'POST',
        'chat.update',
        {
          channel: requiredId(ctx, 'channelId', i, 'Channel'),
          ts: requiredId(ctx, 'ts', i, 'Message timestamp'),
          text,
          blocks,
        },
        undefined,
        i,
      );
    },
    async delete(ctx, i) {
      return slackRequest(
        ctx,
        credentialType(ctx, i),
        'POST',
        'chat.delete',
        {
          channel: requiredId(ctx, 'channelId', i, 'Channel'),
          ts: requiredId(ctx, 'ts', i, 'Message timestamp'),
        },
        undefined,
        i,
      );
    },
    async getPermalink(ctx, i) {
      return slackRequest(
        ctx,
        credentialType(ctx, i),
        'GET',
        'chat.getPermalink',
        undefined,
        {
          channel: requiredId(ctx, 'channelId', i, 'Channel'),
          message_ts: requiredId(ctx, 'ts', i, 'Message timestamp'),
        },
        i,
      );
    },
    async search(ctx, i) {
      const query = requiredId(ctx, 'query', i, 'Search query');
      const limit = limitOf(ctx, i);
      const sort = ctx.getNodeParameter('sort', i, 'timestamp') as string;
      const sortDir = ctx.getNodeParameter('sortDirection', i, 'desc') as string;
      const out: DataObject[] = [];
      for (let page = 1; page <= 100; page++) {
        const response = await slackRequest(
          ctx,
          credentialType(ctx, i),
          'GET',
          'search.messages',
          undefined,
          {
            query,
            sort,
            sort_dir: sortDir,
            count: 100,
            page,
          },
          i,
        );
        const messages = (response.messages as DataObject | undefined) ?? {};
        out.push(...((messages.matches as DataObject[]) ?? []));
        const paging = (messages.paging as DataObject | undefined) ?? {};
        if (out.length >= limit || page >= Number(paging.pages ?? 1)) break;
      }
      return out.slice(0, Number.isFinite(limit) ? limit : undefined);
    },
  },
  channel: {
    async list(ctx, i) {
      const filters = ctx.getNodeParameter('filters', i, {}) as DataObject;
      const types =
        Array.isArray(filters.types) && filters.types.length ? filters.types.join(',') : 'public_channel';
      return slackPaginate(
        ctx,
        i,
        'conversations.list',
        'channels',
        { types, exclude_archived: filters.excludeArchived ?? true },
        limitOf(ctx, i),
      );
    },
    async create(ctx, i) {
      const name = requiredId(ctx, 'channelName', i, 'Channel name').replace(/^#/, '');
      const response = await slackRequest(
        ctx,
        credentialType(ctx, i),
        'POST',
        'conversations.create',
        { name, is_private: ctx.getNodeParameter('isPrivate', i, false) as boolean },
        undefined,
        i,
      );
      return response.channel as DataObject;
    },
    async history(ctx, i) {
      const filters = ctx.getNodeParameter('filters', i, {}) as DataObject;
      return slackPaginate(
        ctx,
        i,
        'conversations.history',
        'messages',
        {
          channel: requiredId(ctx, 'channelId', i, 'Channel'),
          oldest: filters.oldest ? toSlackTs(filters.oldest) : undefined,
          latest: filters.latest ? toSlackTs(filters.latest) : undefined,
          inclusive: filters.inclusive,
        },
        limitOf(ctx, i),
      );
    },
    async get(ctx, i) {
      const response = await slackRequest(
        ctx,
        credentialType(ctx, i),
        'GET',
        'conversations.info',
        undefined,
        {
          channel: requiredId(ctx, 'channelId', i, 'Channel'),
          include_num_members: true,
        },
        i,
      );
      return response.channel as DataObject;
    },
    async invite(ctx, i) {
      const users = fieldList(ctx.getNodeParameter('userIds', i, ''));
      if (!users.length)
        throw new NodeOperationError(ctx.getNode(), 'Add at least one user ID', { itemIndex: i });
      const response = await slackRequest(
        ctx,
        credentialType(ctx, i),
        'POST',
        'conversations.invite',
        { channel: requiredId(ctx, 'channelId', i, 'Channel'), users: users.join(',') },
        undefined,
        i,
      );
      return response.channel as DataObject;
    },
  },
  user: {
    async info(ctx, i) {
      const response = await slackRequest(
        ctx,
        credentialType(ctx, i),
        'GET',
        'users.info',
        undefined,
        {
          user: requiredId(ctx, 'user', i, 'User'),
        },
        i,
      );
      return response.user as DataObject;
    },
    async getAll(ctx, i) {
      return slackPaginate(ctx, i, 'users.list', 'members', {}, limitOf(ctx, i));
    },
  },
  file: {
    async upload(ctx, i) {
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      let data: Uint8Array;
      let fileName = String(options.fileName ?? '');
      if (ctx.getNodeParameter('binaryData', i, true)) {
        const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
        const meta = ctx.helpers.assertBinaryData(i, property);
        data = await ctx.helpers.getBinaryDataBuffer(i, property);
        fileName ||= meta.fileName ?? property;
      } else {
        data = Buffer.from(String(ctx.getNodeParameter('fileContent', i, '') ?? ''), 'utf8');
        fileName ||= 'file.txt';
      }
      const type = credentialType(ctx, i);
      const ticket = await slackRequest(
        ctx,
        type,
        'GET',
        'files.getUploadURLExternal',
        undefined,
        {
          filename: fileName,
          length: data.byteLength,
        },
        i,
      );
      // the upload URL is pre-signed; it is still fetched through the SSRF-guarded client
      await ctx.helpers.httpRequest({
        method: 'POST',
        url: String(ticket.upload_url),
        body: data,
        bodyType: 'raw',
        headers: { 'content-type': 'application/octet-stream' },
        responseType: 'text',
      });
      const channel = String(ctx.getNodeParameter('channelId', i, '', { extractValue: true }) ?? '');
      const done = await slackRequest(
        ctx,
        type,
        'POST',
        'files.completeUploadExternal',
        {
          files: [{ id: ticket.file_id, title: options.title || fileName }],
          channel_id: channel || undefined,
          initial_comment: options.initialComment,
          thread_ts: options.threadTs,
        },
        undefined,
        i,
      );
      return ((done.files as DataObject[]) ?? [])[0] ?? done;
    },
  },
  reaction: {
    async add(ctx, i) {
      return reaction(ctx, i, 'reactions.add');
    },
    async remove(ctx, i) {
      return reaction(ctx, i, 'reactions.remove');
    },
  },
};

async function reaction(ctx: ExecuteContext, i: number, endpoint: string): Promise<DataObject> {
  const name = requiredId(ctx, 'name', i, 'Emoji name').replace(/^:|:$/g, '');
  return slackRequest(
    ctx,
    credentialType(ctx, i),
    'POST',
    endpoint,
    {
      channel: requiredId(ctx, 'channelId', i, 'Channel'),
      timestamp: requiredId(ctx, 'ts', i, 'Message timestamp'),
      name,
    },
    undefined,
    i,
  );
}

/** Slack timestamps are seconds with a fraction; accept ISO dates or millis too. */
function toSlackTs(value: unknown): string {
  if (typeof value === 'number') return String(value > 1e11 ? value / 1000 : value);
  const s = String(value);
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? s : String(ms / 1000);
}

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const channelLocator = locator('channelId', 'Channel', {
  searchListMethod: 'searchChannels',
  idPlaceholder: 'C0122KQ70S7',
  urlRegex: 'https://[\\w.-]+\\.slack\\.com/(?:archives|messages)/([A-Z0-9]+)',
  urlPlaceholder: 'https://myteam.slack.com/archives/C0122KQ70S7',
});
const userLocator = locator('user', 'User', {
  searchListMethod: 'searchUsers',
  idPlaceholder: 'U0123ABCDEF',
});
const tsProperty: NodeProperty = {
  displayName: 'Message Timestamp',
  name: 'ts',
  type: 'string',
  default: '',
  required: true,
  placeholder: '1663233118.856619',
  description: 'The "ts" of the message, returned when it was sent',
};

const properties: NodeProperty[] = [
  {
    displayName: 'Authentication',
    name: 'authentication',
    type: 'options',
    default: 'accessToken',
    options: [
      { name: 'Access Token', value: 'accessToken' },
      { name: 'OAuth2', value: 'oAuth2' },
    ],
  },
  resourceProperty(
    [
      { name: 'Message', value: 'message' },
      { name: 'Channel', value: 'channel' },
      { name: 'User', value: 'user' },
      { name: 'File', value: 'file' },
      { name: 'Reaction', value: 'reaction' },
    ],
    'message',
  ),
  operationProperty(
    'message',
    [
      { name: 'Send', value: 'send', action: 'Send a message' },
      { name: 'Update', value: 'update', action: 'Update a message' },
      { name: 'Delete', value: 'delete', action: 'Delete a message' },
      { name: 'Get Permalink', value: 'getPermalink', action: 'Get a message permalink' },
      { name: 'Search', value: 'search', action: 'Search for messages' },
    ],
    'send',
  ),
  operationProperty(
    'channel',
    [
      { name: 'Get Many', value: 'list', action: 'Get many channels' },
      { name: 'Create', value: 'create', action: 'Create a channel' },
      { name: 'History', value: 'history', action: 'Get the history of a channel' },
      { name: 'Get', value: 'get', action: 'Get a channel' },
      { name: 'Invite', value: 'invite', action: 'Invite users to a channel' },
    ],
    'list',
  ),
  operationProperty(
    'user',
    [
      { name: 'Get', value: 'info', action: 'Get a user' },
      { name: 'Get Many', value: 'getAll', action: 'Get many users' },
    ],
    'info',
  ),
  operationProperty('file', [{ name: 'Upload', value: 'upload', action: 'Upload a file' }], 'upload'),
  operationProperty(
    'reaction',
    [
      { name: 'Add', value: 'add', action: 'Add a reaction' },
      { name: 'Remove', value: 'remove', action: 'Remove a reaction' },
    ],
    'add',
  ),
  // message: send
  forOps(
    {
      displayName: 'Send Message To',
      name: 'select',
      type: 'options',
      default: 'channel',
      options: [
        { name: 'Channel', value: 'channel' },
        { name: 'User (Direct Message)', value: 'user' },
      ],
    },
    'message',
    'send',
  ),
  {
    ...channelLocator,
    displayOptions: { show: { resource: ['message'], operation: ['send'], select: ['channel'] } },
  },
  {
    ...userLocator,
    displayOptions: { show: { resource: ['message'], operation: ['send'], select: ['user'] } },
  },
  forOps(channelLocator, 'message', ['update', 'delete', 'getPermalink']),
  forOps(tsProperty, 'message', ['update', 'delete', 'getPermalink']),
  forOps(
    {
      displayName: 'Message Type',
      name: 'messageType',
      type: 'options',
      default: 'text',
      options: [
        { name: 'Simple Text Message', value: 'text' },
        { name: 'Blocks', value: 'block', description: 'Block Kit layout with a text fallback' },
      ],
    },
    'message',
    ['send', 'update'],
  ),
  forOps(
    {
      displayName: 'Message Text',
      name: 'text',
      type: 'string',
      default: '',
      typeOptions: { rows: 3 },
      description: 'Supports Slack mrkdwn; used as the notification fallback for blocks',
    },
    'message',
    ['send', 'update'],
  ),
  {
    displayName: 'Blocks',
    name: 'blocksUi',
    type: 'json',
    default: '[]',
    typeOptions: { rows: 6 },
    description: 'Block Kit JSON, e.g. from the Block Kit Builder',
    displayOptions: {
      show: { resource: ['message'], operation: ['send', 'update'], messageType: ['block'] },
    },
  },
  forOps(
    {
      displayName: 'Options',
      name: 'otherOptions',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { displayName: 'Reply in Thread (Thread TS)', name: 'thread_ts', type: 'string', default: '' },
        { displayName: 'Also Send to Channel', name: 'reply_broadcast', type: 'boolean', default: false },
        { displayName: 'Use Markdown', name: 'mrkdwn', type: 'boolean', default: true },
        { displayName: 'Unfurl Links', name: 'unfurl_links', type: 'boolean', default: false },
        { displayName: 'Unfurl Media', name: 'unfurl_media', type: 'boolean', default: true },
        { displayName: 'Link User and Channel Names', name: 'link_names', type: 'boolean', default: false },
      ],
    },
    'message',
    'send',
  ),
  // message: search
  forOps(
    {
      displayName: 'Search Query',
      name: 'query',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'invoice in:#finance',
    },
    'message',
    'search',
  ),
  forOps(
    {
      displayName: 'Sort By',
      name: 'sort',
      type: 'options',
      default: 'timestamp',
      options: [
        { name: 'Newest/Oldest', value: 'timestamp' },
        { name: 'Relevance', value: 'score' },
      ],
    },
    'message',
    'search',
  ),
  forOps(
    {
      displayName: 'Sort Direction',
      name: 'sortDirection',
      type: 'options',
      default: 'desc',
      options: [
        { name: 'Descending', value: 'desc' },
        { name: 'Ascending', value: 'asc' },
      ],
    },
    'message',
    'search',
  ),
  ...returnAllProperties('message', 'search'),
  // channel
  forOps(channelLocator, 'channel', ['history', 'get', 'invite']),
  forOps(
    {
      displayName: 'Channel Name',
      name: 'channelName',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'project-x',
    },
    'channel',
    'create',
  ),
  forOps({ displayName: 'Private', name: 'isPrivate', type: 'boolean', default: false }, 'channel', 'create'),
  forOps(
    {
      displayName: 'User IDs',
      name: 'userIds',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'U012ABC, U034DEF',
      description: 'Comma-separated IDs of the users to invite',
    },
    'channel',
    'invite',
  ),
  ...returnAllProperties('channel', ['list', 'history']),
  forOps(
    {
      displayName: 'Filters',
      name: 'filters',
      type: 'collection',
      default: {},
      placeholder: 'Add filter',
      options: [
        {
          displayName: 'Types',
          name: 'types',
          type: 'multiOptions',
          default: ['public_channel'],
          options: [
            { name: 'Public Channel', value: 'public_channel' },
            { name: 'Private Channel', value: 'private_channel' },
            { name: 'Multi-Person Direct Message', value: 'mpim' },
            { name: 'Direct Message', value: 'im' },
          ],
        },
        { displayName: 'Exclude Archived', name: 'excludeArchived', type: 'boolean', default: true },
      ],
    },
    'channel',
    'list',
  ),
  forOps(
    {
      displayName: 'Filters',
      name: 'filters',
      type: 'collection',
      default: {},
      placeholder: 'Add filter',
      options: [
        {
          displayName: 'Oldest',
          name: 'oldest',
          type: 'dateTime',
          default: '',
          description: 'Only messages after this time',
        },
        {
          displayName: 'Latest',
          name: 'latest',
          type: 'dateTime',
          default: '',
          description: 'Only messages before this time',
        },
        { displayName: 'Inclusive', name: 'inclusive', type: 'boolean', default: false },
      ],
    },
    'channel',
    'history',
  ),
  // user
  forOps(userLocator, 'user', 'info'),
  ...returnAllProperties('user', 'getAll'),
  // file
  forOps(
    {
      displayName: 'Binary File',
      name: 'binaryData',
      type: 'boolean',
      default: true,
      description: 'Whether to upload a binary file of the item instead of text',
    },
    'file',
    'upload',
  ),
  {
    displayName: 'Input Binary Field',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: { show: { resource: ['file'], operation: ['upload'], binaryData: [true] } },
  },
  {
    displayName: 'File Content',
    name: 'fileContent',
    type: 'string',
    default: '',
    typeOptions: { rows: 4 },
    displayOptions: { show: { resource: ['file'], operation: ['upload'], binaryData: [false] } },
  },
  forOps(
    { ...channelLocator, required: false, description: 'Channel to share the file in (optional)' },
    'file',
    'upload',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { displayName: 'File Name', name: 'fileName', type: 'string', default: '' },
        { displayName: 'Title', name: 'title', type: 'string', default: '' },
        { displayName: 'Initial Comment', name: 'initialComment', type: 'string', default: '' },
        { displayName: 'Thread TS', name: 'threadTs', type: 'string', default: '' },
      ],
    },
    'file',
    'upload',
  ),
  // reaction
  forOps(channelLocator, 'reaction', ['add', 'remove']),
  forOps(tsProperty, 'reaction', ['add', 'remove']),
  forOps(
    {
      displayName: 'Emoji Name',
      name: 'name',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'thumbsup',
    },
    'reaction',
    ['add', 'remove'],
  ),
];

function loadCredentialType(ctx: LoadOptionsContext): string {
  return ctx.getCurrentNodeParameter('authentication') === 'oAuth2' ? 'slackOAuth2Api' : 'slackApi';
}

export const SlackNode: NodeType = {
  description: {
    name: 'app.slack',
    displayName: 'Slack',
    description: 'Send messages and manage channels, users, files and reactions in Slack',
    icon: 'simple:slack',
    iconColor: '#4a154b',
    group: ['output'],
    version: 1,
    defaults: { name: 'Slack' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Communication'],
    alias: ['chat', 'message', 'notify', 'channel', 'team'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [
      { name: 'slackApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'slackOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties,
  },
  async execute(ctx) {
    return runOperations(ctx, handlers);
  },
  methods: {
    listSearch: {
      async searchChannels(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const response = await slackRequest(
          ctx,
          loadCredentialType(ctx),
          'GET',
          'conversations.list',
          undefined,
          {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor: paginationToken,
          },
        );
        const term = (filter ?? '').toLowerCase();
        const results = ((response.channels as DataObject[]) ?? [])
          .filter((c) => !term || String(c.name).toLowerCase().includes(term))
          .map((c) => ({ name: `#${String(c.name)}`, value: String(c.id) }));
        const next = (response.response_metadata as DataObject | undefined)?.next_cursor as
          | string
          | undefined;
        return { results, paginationToken: next || undefined };
      },
      async searchUsers(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const response = await slackRequest(ctx, loadCredentialType(ctx), 'GET', 'users.list', undefined, {
          limit: 200,
          cursor: paginationToken,
        });
        const term = (filter ?? '').toLowerCase();
        const results = ((response.members as DataObject[]) ?? [])
          .filter((u) => !u.deleted)
          .filter((u) => !term || `${u.name} ${u.real_name ?? ''}`.toLowerCase().includes(term))
          .map((u) => ({ name: String(u.real_name || u.name), value: String(u.id) }));
        const next = (response.response_metadata as DataObject | undefined)?.next_cursor as
          | string
          | undefined;
        return { results, paginationToken: next || undefined };
      },
    },
  },
};
