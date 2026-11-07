/**
 * Anthropic text.message (Messages API) and the helpers every Anthropic operation file shares: the
 * credential's base URL, the guarded call with the beta header, the model picker and the one-operation
 * property filter.
 *
 * The Tools port runs through `runVendorChat`. `pause_turn` (a server tool such as web search ran long and
 * the model stopped to be continued) needs the assistant's raw content blocks sent back, which the agent
 * loop's messages do not hold, so the chat model below loops on it at raw level and hands the loop one
 * merged reply.
 */
import {
  type AiChatModel,
  type AiChatRequest,
  type AiChatResponse,
  type DataObject,
  type ExecuteContext,
  type HttpRequestOptions,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicAdapter,
} from '../../../providers/anthropic';
import { type ChatAdapter, trimSlash } from '../../../shared/chat-model';
import { vendorError, vendorRequest } from '../shared/api';
import {
  maxToolIterationsOption,
  messagesProperty,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { modelListSearch } from '../shared/model-lists';
import { runVendorChat } from '../shared/tool-loop';

export const ANTHROPIC_CREDENTIAL = 'anthropicApi';
export const FILES_BETA = 'files-api-2025-04-14';
export const PROMPT_TOOLS_BETA = 'prompt-tools-2025-04-02';
export const CODE_EXECUTION_BETA = 'code-execution-2025-05-22';

/** the Tools port shows on Message a Model once Hide Tools is Show */
export const TEXT_TOOLS_CONDITION = `$parameter.resource === 'text' && $parameter.operation === 'message' && $parameter.hideTools === 'show'`;

type Block = DataObject & { type: string };

/** the credential's base URL without a trailing slash */
export async function anthropicBaseUrl(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const credentials = await ctx.getCredentials(ANTHROPIC_CREDENTIAL, itemIndex);
  return trimSlash(String(credentials.baseUrl || ANTHROPIC_DEFAULT_BASE_URL));
}

/** `anthropic-beta` header value: the existing value and `betas`, each once */
function withBetas(existing: string | string[] | undefined, betas: string[]): string | undefined {
  const prior = Array.isArray(existing) ? existing.join(',') : existing;
  const all = [...(prior ? prior.split(',') : []), ...betas].map((beta) => beta.trim()).filter(Boolean);
  return all.length ? [...new Set(all)].join(',') : undefined;
}

/** One request with the credential, our API version and the beta headers; failures are node errors. */
export async function anthropicCall<T>(
  ctx: ExecuteContext,
  itemIndex: number,
  request: HttpRequestOptions,
  betas: string[] = [],
): Promise<T> {
  const beta = withBetas(request.headers?.['anthropic-beta'], betas);
  return vendorRequest<T>(ctx, ANTHROPIC_CREDENTIAL, itemIndex, {
    ...request,
    headers: {
      'anthropic-version': ANTHROPIC_API_VERSION,
      ...request.headers,
      ...(beta ? { 'anthropic-beta': beta } : {}),
    },
  });
}

/** the value of a resource locator (or a plain string) parameter */
export function readLocator(ctx: ExecuteContext, itemIndex: number, name: string, label: string): string {
  const raw = ctx.getNodeParameter(name, itemIndex, '') as unknown;
  const value = raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new NodeOperationError(ctx.getNode(), `Choose a ${label}`, { itemIndex });
  return text;
}

/** `properties` shown for one resource and operation only */
export function forOperation(
  resource: string,
  operation: string,
  properties: NodeProperty[],
): NodeProperty[] {
  return properties.map((property) => ({
    ...property,
    displayOptions: {
      ...property.displayOptions,
      show: { ...property.displayOptions?.show, resource: [resource], operation: [operation] },
    },
  }));
}

/** the model picker: from the account's list or by id */
export function modelLocator(): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: ANTHROPIC_DEFAULT_MODEL },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: 'modelSearch', searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. claude-sonnet-5-5' },
    ],
  };
}

async function listModels(ctx: LoadOptionsContext) {
  const credentials = await ctx.getCredentials(ANTHROPIC_CREDENTIAL);
  const base = trimSlash(String(credentials.baseUrl || ANTHROPIC_DEFAULT_BASE_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication(ANTHROPIC_CREDENTIAL, {
    url: `${base}/v1/models`,
    qs: { limit: 1000 },
    headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
  })) as { data?: Array<{ id?: string; display_name?: string }> };
  return (response.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m?.id === 'string')
    .map((m) => ({ id: m.id, ...(m.display_name ? { name: m.display_name } : {}) }));
}

/** the model list search of the node */
export const searchModels: (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> =
  modelListSearch(listModels);

/** the file list search of the node */
export async function searchFiles(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const credentials = await ctx.getCredentials(ANTHROPIC_CREDENTIAL);
  const base = trimSlash(String(credentials.baseUrl || ANTHROPIC_DEFAULT_BASE_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication(ANTHROPIC_CREDENTIAL, {
    url: `${base}/v1/files`,
    qs: { limit: 1000 },
    headers: { 'anthropic-version': ANTHROPIC_API_VERSION, 'anthropic-beta': FILES_BETA },
  })) as { data?: Array<{ id?: string; filename?: string }> };
  const needle = filter?.trim().toLowerCase() ?? '';
  const results: ListSearchResult['results'] = [];
  for (const file of response.data ?? []) {
    if (!file?.id) continue;
    const name = file.filename ? `${file.filename} (${file.id})` : file.id;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    results.push({ name, value: file.id });
  }
  return { results };
}

// ---------------------------------------------------------------------------------------------
// the pause_turn chat model
// ---------------------------------------------------------------------------------------------

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

function addUsage(a: DataObject | undefined, b: DataObject | undefined): DataObject | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum: DataObject = { ...a, ...b };
  for (const key of USAGE_KEYS) {
    if (typeof a[key] === 'number' || typeof b[key] === 'number') {
      sum[key] = Number(a[key] ?? 0) + Number(b[key] ?? 0);
    }
  }
  return sum;
}

/** What the node adds to every request the loop sends: server tools and the beta headers they need. */
interface ServerSide {
  tools: DataObject[];
  betas: string[];
}

/**
 * A chat model over `adapter` that continues on `stop_reason: "pause_turn"`: the paused turn's content
 * blocks are sent back as the last assistant message and the call repeated (at most `maxPauses` times).
 * The reply handed on holds the blocks of every round, so a following tool turn replays the whole turn.
 * `onRaw` gets the last merged reply body.
 */
export function pauseTurnModel(
  ctx: ExecuteContext,
  itemIndex: number,
  adapter: ChatAdapter,
  serverSide: ServerSide,
  maxPauses: number,
  onRaw: (body: DataObject) => void,
): AiChatModel {
  const decorate = (request: HttpRequestOptions): HttpRequestOptions => {
    const body = { ...(request.body as DataObject) };
    if (serverSide.tools.length)
      body.tools = [...((body.tools as DataObject[] | undefined) ?? []), ...serverSide.tools];
    const beta = withBetas(request.headers?.['anthropic-beta'], serverSide.betas);
    return { ...request, body, headers: { ...request.headers, ...(beta ? { 'anthropic-beta': beta } : {}) } };
  };
  return {
    kind: 'chatModel',
    provider: adapter.provider,
    model: adapter.model,
    async chat(request: AiChatRequest): Promise<AiChatResponse> {
      let sent = decorate(adapter.buildRequest(request, false));
      let carried: Block[] = [];
      let usage: DataObject | undefined;
      for (let round = 0; ; round++) {
        const reply = await vendorRequest<DataObject>(ctx, adapter.credentialType, itemIndex, sent);
        const content = Array.isArray(reply?.content) ? (reply.content as Block[]) : [];
        usage = addUsage(usage, reply?.usage as DataObject | undefined);
        if (reply?.stop_reason === 'pause_turn') {
          if (round >= maxPauses) {
            throw vendorError(
              ctx,
              new Error(
                `The model paused ${maxPauses} times without finishing. Raise Max Tool Calls Iterations.`,
              ),
              itemIndex,
            );
          }
          carried = [...carried, ...content];
          const body = sent.body as DataObject;
          sent = {
            ...sent,
            body: {
              ...body,
              messages: [...(body.messages as DataObject[]), { role: 'assistant', content: carried }],
            },
          };
          continue;
        }
        const merged: DataObject = {
          ...reply,
          content: [...carried, ...content],
          ...(usage ? { usage } : {}),
        };
        onRaw(merged);
        return adapter.parseResponse(merged);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// text.message
// ---------------------------------------------------------------------------------------------

export const messageProperties: NodeProperty[] = forOperation('text', 'message', [
  {
    displayName: 'Hide Tools',
    name: 'hideTools',
    type: 'options',
    default: 'hide',
    noDataExpression: true,
    description: 'Whether the node takes tools on its Tools input',
    options: [
      { name: 'Hide', value: 'hide' },
      { name: 'Show', value: 'show' },
    ],
  },
  modelLocator(),
  messagesProperty({ roles: ['user', 'assistant'], attachments: true }),
  simplifyProperty(true),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Include Merged Response',
        name: 'includeMergedResponse',
        type: 'boolean',
        default: false,
        description: 'Whether to add one string that joins all text parts of the reply',
      },
      {
        displayName: 'System Message',
        name: 'system',
        type: 'string',
        default: '',
        typeOptions: { rows: 2 },
      },
      {
        displayName: 'Prompt Caching',
        name: 'promptCaching',
        type: 'boolean',
        default: false,
        description: 'Whether to let the API cache the prompt prefix so repeated calls cost less',
      },
      {
        displayName: 'Code Execution',
        name: 'codeExecution',
        type: 'boolean',
        default: false,
        description: 'Whether the model may run code in Anthropic’s sandbox',
      },
      {
        displayName: 'Web Search',
        name: 'webSearch',
        type: 'boolean',
        default: false,
        description: 'Whether the model may search the web',
      },
      {
        displayName: 'Web Search Max Uses',
        name: 'webSearchMaxUses',
        type: 'number',
        default: 5,
        typeOptions: { minValue: 1 },
        description: 'Searches allowed in one request',
      },
      {
        displayName: 'Web Search Allowed Domains',
        name: 'allowedDomains',
        type: 'string',
        default: '',
        placeholder: 'example.com, docs.example.org',
        description: 'Comma separated. Only these sites are searched. Not together with blocked domains.',
      },
      {
        displayName: 'Web Search Blocked Domains',
        name: 'blockedDomains',
        type: 'string',
        default: '',
        placeholder: 'example.com',
        description: 'Comma separated. These sites are never searched. Not together with allowed domains.',
      },
      {
        displayName: 'Maximum Number of Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 1024,
        typeOptions: { minValue: 1 },
      },
      {
        displayName: 'Top P',
        name: 'topP',
        type: 'number',
        default: 0.7,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
        description: 'Sent only on models that still take it',
      },
      {
        displayName: 'Top K',
        name: 'topK',
        type: 'number',
        default: 40,
        typeOptions: { minValue: 0 },
        description: 'Sent only on models that still take it',
      },
      maxToolIterationsOption,
    ],
  },
]);

const domainList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(/[,\n]/)
        .map((domain) => domain.trim())
        .filter(Boolean)
    : [];

function readServerSide(ctx: ExecuteContext, itemIndex: number, options: DataObject): ServerSide {
  const tools: DataObject[] = [];
  const betas: string[] = [];
  if (options.codeExecution === true) {
    tools.push({ type: 'code_execution_20250522', name: 'code_execution' });
    betas.push(CODE_EXECUTION_BETA);
  }
  if (options.webSearch === true) {
    const allowed = domainList(options.allowedDomains);
    const blocked = domainList(options.blockedDomains);
    if (allowed.length && blocked.length) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Use allowed domains or blocked domains for web search, not both',
        {
          itemIndex,
        },
      );
    }
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: Math.max(1, Math.floor(Number(options.webSearchMaxUses ?? 5))),
      ...(allowed.length ? { allowed_domains: allowed } : {}),
      ...(blocked.length ? { blocked_domains: blocked } : {}),
    });
  }
  return { tools, betas };
}

/** The text of the content blocks, joined. */
function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Block => !!b && typeof b === 'object' && (b as Block).type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('');
}

/** The output item of a message or analyze reply: the content blocks, or the whole reply. */
export function replyItem(simplify: boolean, raw: DataObject, mergedText?: string): Item {
  const json: DataObject = simplify
    ? { content: (Array.isArray(raw.content) ? raw.content : []) as DataObject[] }
    : { ...raw };
  if (mergedText !== undefined) json.merged_response = mergedText;
  return { json };
}

export async function executeMessage(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: string,
): Promise<Item> {
  if (operation !== 'message') {
    throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const messages = await readVendorMessages(ctx, itemIndex);
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new NodeOperationError(ctx.getNode(), `The role "${message.role}" is not known`, { itemIndex });
    }
  }
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const adapter = anthropicAdapter({
    baseUrl,
    model: readLocator(ctx, itemIndex, 'modelId', 'model'),
    maxTokens: Math.max(1, Math.floor(Number(options.maxTokens ?? 1024))),
    promptCaching: options.promptCaching === true,
    refusalFallback: false,
    thinking: false,
    ...(options.topP !== undefined ? { topP: Number(options.topP) } : {}),
    ...(options.topK !== undefined ? { topK: Number(options.topK) } : {}),
    credentialType: ANTHROPIC_CREDENTIAL,
  });
  const maxIterations = Math.max(1, Math.floor(Number(options.maxToolsIterations ?? 15)));
  let raw: DataObject | undefined;
  const model = pauseTurnModel(
    ctx,
    itemIndex,
    adapter,
    readServerSide(ctx, itemIndex, options),
    maxIterations,
    (body) => {
      raw = body;
    },
  );
  const result = await runVendorChat(ctx, itemIndex, adapter, {
    messages: toChatMessages(messages),
    system: typeof options.system === 'string' && options.system.trim() ? options.system : undefined,
    maxIterations,
    model,
  });
  const simplify = ctx.getNodeParameter('simplify', itemIndex, true) === true;
  const body: DataObject = raw ?? { content: [{ type: 'text', text: result.text }] };
  return replyItem(
    simplify,
    body,
    options.includeMergedResponse === true ? result.text || blocksText(body.content) : undefined,
  );
}
