/**
 * OpenAI text operations (Message a Model on the Responses API, Classify Text for Violations) and the
 * helpers every OpenAI operation file shares: the credential's base URL, the guarded call with n8n's fixed
 * error texts, model and file pickers, and bytes from a reply.
 */
import {
  type AiChatMessage,
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
  type OpenAiBuiltInTools,
  type OpenAiResponsesConfig,
  type OpenAiTextFormat,
  openAiResponsesAdapter,
  parseOpenAiResponses,
} from '../../../providers/openai-responses';
import { type ChatAdapter, HttpChatModel, trimSlash } from '../../../shared/chat-model';
import { messageText } from '../../../shared/utils';
import { vendorError } from '../shared/api';
import {
  maxToolIterationsOption,
  readVendorMessages,
  messagesProperty,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { modelListSearch } from '../shared/model-lists';
import { pollUntil } from '../shared/poll';
import { runVendorChat, VENDOR_WAIT_TOOL } from '../shared/tool-loop';

export const OPENAI_CREDENTIAL = 'openAiApi';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** fixed texts for the vendor's error codes */
export const OPENAI_ERROR_TEXTS: Record<string, string> = {
  insufficient_quota:
    'Insufficient quota detected. Check your OpenAI plan and billing details, then try again.',
  rate_limit_exceeded:
    'OpenAI: Rate limit reached. Wait a moment and try again, or check the limits of your plan.',
};

/** the credential's base URL without a trailing slash */
export async function openAiBaseUrl(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const credentials = await ctx.getCredentials(OPENAI_CREDENTIAL, itemIndex);
  return trimSlash(String(credentials.baseUrl || OPENAI_DEFAULT_BASE_URL));
}

/** one request with the credential; a failure becomes a node error with secrets redacted */
export async function openAiCall<T>(
  ctx: ExecuteContext,
  itemIndex: number,
  request: HttpRequestOptions,
): Promise<T> {
  try {
    return (await ctx.helpers.httpRequestWithAuthentication<T>(OPENAI_CREDENTIAL, request, itemIndex)) as T;
  } catch (error) {
    throw vendorError(ctx, error, itemIndex, OPENAI_ERROR_TEXTS);
  }
}

/** the bytes of a binary reply */
export function bytesOf(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(0);
}

/** the value of a resource locator (or a plain string) parameter */
export function readLocator(ctx: ExecuteContext, itemIndex: number, name: string, label: string): string {
  const raw = ctx.getNodeParameter(name, itemIndex, '') as unknown;
  const value = raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new NodeOperationError(ctx.getNode(), `Choose a ${label}`, { itemIndex });
  return text;
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** a JSON field that must hold an object */
export function readJsonObject(
  ctx: ExecuteContext,
  itemIndex: number,
  label: string,
  raw: unknown,
): DataObject | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`, { itemIndex });
  }
  return value as DataObject;
}

/** `properties` shown for one resource and operation only */
export function forOperation(resource: string, operation: string, properties: NodeProperty[]): NodeProperty[] {
  return properties.map((property) => ({
    ...property,
    displayOptions: {
      ...property.displayOptions,
      show: { ...property.displayOptions?.show, resource: [resource], operation: [operation] },
    },
  }));
}

/** the model picker: from the account's list or by id */
export function modelLocator(defaultModel: string): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: defaultModel },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: 'modelSearch', searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. gpt-5-mini' },
    ],
  };
}

const NOT_A_TEXT_MODEL = /audio|realtime|transcribe|tts|image|embed|moderation|search-preview|whisper|dall-e|sora/i;

async function listModels(ctx: LoadOptionsContext) {
  const credentials = await ctx.getCredentials(OPENAI_CREDENTIAL);
  const base = trimSlash(String(credentials.baseUrl || OPENAI_DEFAULT_BASE_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication(OPENAI_CREDENTIAL, {
    url: `${base}/models`,
  })) as { data?: Array<{ id?: string }> };
  return (response.data ?? []).filter((m): m is { id: string } => typeof m?.id === 'string');
}

/** the model list search of the node (text and vision models) */
export const searchModels: (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> =
  modelListSearch(
    async (ctx) => (await listModels(ctx)).sort((a, b) => a.id.localeCompare(b.id)),
    (id) => /^(gpt-|o\d|chatgpt-|codex)/i.test(id) && !NOT_A_TEXT_MODEL.test(id),
  );

const LEVELS = ['low', 'medium', 'high'].map((value) => ({ name: value, value }));

const textResponseProperties: NodeProperty[] = [
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
  modelLocator('gpt-5-mini'),
  messagesProperty({ roles: ['user', 'assistant', 'system'], attachments: true }),
  simplifyProperty(true),
  {
    displayName: 'Built-in Tools',
    name: 'builtInTools',
    type: 'collection',
    default: {},
    placeholder: 'Add built-in tool',
    options: [
      {
        displayName: 'Web Search',
        name: 'webSearch',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Search Context Size',
            name: 'searchContextSize',
            type: 'options',
            default: 'medium',
            options: LEVELS,
          },
          {
            displayName: 'Allowed Domains',
            name: 'allowedDomains',
            type: 'string',
            default: '',
            description: 'Comma separated domains the search may use. Leave empty for all.',
          },
          { displayName: 'Country (ISO code)', name: 'country', type: 'string', default: '' },
          { displayName: 'City', name: 'city', type: 'string', default: '' },
          { displayName: 'Region', name: 'region', type: 'string', default: '' },
        ],
      },
      {
        displayName: 'File Search',
        name: 'fileSearch',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Vector Store IDs',
            name: 'vectorStoreIds',
            type: 'string',
            default: '',
            description: 'Comma separated ids of OpenAI vector stores',
          },
          {
            displayName: 'Filters',
            name: 'filters',
            type: 'json',
            default: '',
            description: 'An attribute filter, as a JSON object',
          },
          {
            displayName: 'Max Results',
            name: 'maxResults',
            type: 'number',
            default: 1,
            typeOptions: { minValue: 1, maxValue: 50 },
          },
        ],
      },
      {
        displayName: 'Code Interpreter',
        name: 'codeInterpreter',
        type: 'collection',
        default: {},
        placeholder: 'Enable',
        options: [],
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      { displayName: 'Conversation ID', name: 'conversationId', type: 'string', default: '' },
      {
        displayName: 'Include Additional Data',
        name: 'include',
        type: 'string',
        default: '',
        placeholder: 'code_interpreter_call.outputs',
        description: 'Comma separated names of extra data the reply should hold',
      },
      { displayName: 'Instructions', name: 'instructions', type: 'string', default: '', typeOptions: { rows: 3 } },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 16,
        typeOptions: { minValue: 1, maxValue: 32768 },
      },
      { ...maxToolIterationsOption },
      {
        displayName: 'Max Built-in Tool Calls',
        name: 'maxToolCalls',
        type: 'number',
        default: 15,
        typeOptions: { minValue: 1 },
      },
      { displayName: 'Parallel Tool Calls', name: 'parallelToolCalls', type: 'boolean', default: false },
      { displayName: 'Previous Response ID', name: 'previousResponseId', type: 'string', default: '' },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'fixedCollection',
        default: {},
        placeholder: 'Add stored prompt',
        options: [
          {
            displayName: 'Prompt',
            name: 'promptOptions',
            values: [
              { displayName: 'Prompt ID', name: 'id', type: 'string', default: '' },
              { displayName: 'Version', name: 'version', type: 'string', default: '' },
              {
                displayName: 'Variables',
                name: 'variables',
                type: 'json',
                default: '',
                description: 'The values of the prompt variables, as a JSON object',
              },
            ],
          },
        ],
      },
      { displayName: 'Prompt Cache Key', name: 'promptCacheKey', type: 'string', default: '' },
      {
        displayName: 'Reasoning',
        name: 'reasoning',
        type: 'fixedCollection',
        default: {},
        placeholder: 'Add reasoning options',
        options: [
          {
            displayName: 'Reasoning',
            name: 'reasoningOptions',
            values: [
              {
                displayName: 'Effort',
                name: 'effort',
                type: 'options',
                default: 'medium',
                options: ['minimal', 'low', 'medium', 'high'].map((value) => ({ name: value, value })),
              },
              {
                displayName: 'Summary',
                name: 'summary',
                type: 'options',
                default: 'auto',
                options: ['auto', 'concise', 'detailed'].map((value) => ({ name: value, value })),
              },
            ],
          },
        ],
      },
      { displayName: 'Safety Identifier', name: 'safetyIdentifier', type: 'string', default: '' },
      {
        displayName: 'Service Tier',
        name: 'serviceTier',
        type: 'options',
        default: 'auto',
        options: ['auto', 'default', 'flex', 'priority'].map((value) => ({ name: value, value })),
      },
      { displayName: 'Store', name: 'store', type: 'boolean', default: true },
      {
        displayName: 'Output Format',
        name: 'textFormat',
        type: 'fixedCollection',
        default: {},
        placeholder: 'Add output format',
        options: [
          {
            displayName: 'Format',
            name: 'values',
            values: [
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'text',
                options: [
                  { name: 'Text', value: 'text' },
                  { name: 'JSON Object', value: 'json_object' },
                  { name: 'JSON Schema', value: 'json_schema' },
                ],
              },
              { displayName: 'Name', name: 'name', type: 'string', default: 'response' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Schema', name: 'schema', type: 'json', default: '' },
              { displayName: 'Strict', name: 'strict', type: 'boolean', default: false },
            ],
          },
        ],
      },
      { displayName: 'Verbosity', name: 'verbosity', type: 'options', default: 'medium', options: LEVELS },
      {
        displayName: 'Top Logprobs',
        name: 'topLogprobs',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0, maxValue: 20 },
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
      },
      {
        displayName: 'Top P',
        name: 'topP',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
      },
      { displayName: 'Truncation', name: 'truncation', type: 'boolean', default: false },
      {
        displayName: 'Background Mode',
        name: 'backgroundMode',
        type: 'boolean',
        default: false,
        description: 'Whether to run the request in the background and wait for it to finish',
      },
      {
        displayName: 'Timeout',
        name: 'timeout',
        type: 'number',
        default: 300,
        typeOptions: { minValue: 0, maxValue: 3600 },
        description: 'Seconds to wait for a reply. 0 uses the default of the instance.',
      },
    ],
  },
];

const classifyProperties: NodeProperty[] = [
  { displayName: 'Text Input', name: 'input', type: 'string', default: '', required: true },
  simplifyProperty(false),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Use Stable Model',
        name: 'useStableModel',
        type: 'boolean',
        default: false,
        description: 'Whether to use the stable version of the moderation model instead of the latest',
      },
    ],
  },
];

export const textProperties: NodeProperty[] = [
  ...forOperation('text', 'response', textResponseProperties),
  ...forOperation('text', 'classify', classifyProperties),
];

/** the Tools port is on for Message a Model once Hide Tools is set to Show */
export const TEXT_TOOLS_CONDITION = `$parameter.resource === 'text' && $parameter.operation === 'response' && $parameter.hideTools === 'show'`;

function readBuiltInTools(
  ctx: ExecuteContext,
  itemIndex: number,
  builtIn: DataObject,
): { tools: OpenAiBuiltInTools; allowedDomains?: string[]; fileFilters?: DataObject } {
  const tools: OpenAiBuiltInTools = {};
  let allowedDomains: string[] | undefined;
  let fileFilters: DataObject | undefined;
  const web = builtIn.webSearch as DataObject | undefined;
  if (web) {
    tools.webSearch = {
      searchContextSize: optionalText(web.searchContextSize),
      country: optionalText(web.country),
      city: optionalText(web.city),
      region: optionalText(web.region),
    };
    const domains = String(web.allowedDomains ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length) allowedDomains = domains;
  }
  const file = builtIn.fileSearch as DataObject | undefined;
  if (file) {
    const ids = String(file.vectorStoreIds ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (ids.length) {
      tools.fileSearch = {
        vectorStoreIds: ids,
        maxResults: file.maxResults ? Number(file.maxResults) : undefined,
      };
      fileFilters = readJsonObject(ctx, itemIndex, 'File Search Filters', file.filters);
    }
  }
  if (builtIn.codeInterpreter !== undefined) tools.codeInterpreter = true;
  return { tools, allowedDomains, fileFilters };
}

function readTextFormat(ctx: ExecuteContext, itemIndex: number, options: DataObject) {
  const entry = (options.textFormat as { values?: DataObject } | undefined)?.values;
  if (!entry || entry.type === 'text' || entry.type === undefined) return undefined;
  if (entry.type === 'json_object') return { format: { type: 'json_object' } as OpenAiTextFormat };
  const schema = readJsonObject(ctx, itemIndex, 'The output schema', entry.schema);
  if (!schema) throw new NodeOperationError(ctx.getNode(), 'The output schema is empty', { itemIndex });
  const format: OpenAiTextFormat = {
    type: 'json_schema',
    name: optionalText(entry.name) ?? 'response',
    schema,
    strict: entry.strict === true,
  };
  return { format, description: optionalText(entry.description) };
}

/** Message a Model: the Responses API with the connected tools and the built-in tools. */
async function textResponse(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const modelName = readLocator(ctx, itemIndex, 'modelId', 'model');
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const simplify = ctx.getNodeParameter('simplify', itemIndex, true) === true;
  const messages: AiChatMessage[] = toChatMessages(await readVendorMessages(ctx, itemIndex));
  if (!messages.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one message', { itemIndex });
  }

  const { tools, allowedDomains, fileFilters } = readBuiltInTools(
    ctx,
    itemIndex,
    (ctx.getNodeParameter('builtInTools', itemIndex, {}) as DataObject) ?? {},
  );
  const reasoning = (options.reasoning as { reasoningOptions?: DataObject } | undefined)?.reasoningOptions;
  const stored = (options.prompt as { promptOptions?: DataObject } | undefined)?.promptOptions;
  const storedId = optionalText(stored?.id);
  const format = readTextFormat(ctx, itemIndex, options);
  const background = options.backgroundMode === true;
  const include = String(options.include ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const topLogprobs = options.topLogprobs ? Number(options.topLogprobs) : undefined;
  const verbosity = optionalText(options.verbosity);

  const extraBody: DataObject = {};
  if (include.length) {
    extraBody.include = [...include, ...(topLogprobs ? ['message.output_text.logprobs'] : [])];
  }
  if (options.maxToolCalls !== undefined) extraBody.max_tool_calls = Number(options.maxToolCalls);
  if (options.parallelToolCalls !== undefined) extraBody.parallel_tool_calls = options.parallelToolCalls === true;
  if (optionalText(options.previousResponseId)) extraBody.previous_response_id = options.previousResponseId;
  if (reasoning?.summary) {
    extraBody.reasoning = {
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      summary: reasoning.summary,
    };
  }
  if (options.truncation === true) extraBody.truncation = 'auto';
  if (background) extraBody.background = true;
  if (format?.description && format.format.type === 'json_schema') {
    // a description has no field in the shared config: the whole text block is written here
    extraBody.text = {
      format: { ...format.format, description: format.description },
      ...(verbosity ? { verbosity } : {}),
    };
  }

  const config: OpenAiResponsesConfig = {
    baseUrl,
    model: modelName,
    credentialType: OPENAI_CREDENTIAL,
    temperature: options.temperature !== undefined ? Number(options.temperature) : undefined,
    topP: options.topP !== undefined ? Number(options.topP) : undefined,
    maxTokens: options.maxTokens !== undefined ? Number(options.maxTokens) : undefined,
    reasoningEffort: optionalText(reasoning?.effort),
    verbosity,
    textFormat: format?.format,
    serviceTier: options.serviceTier && options.serviceTier !== 'auto' ? String(options.serviceTier) : undefined,
    topLogprobs,
    promptCacheKey: optionalText(options.promptCacheKey),
    safetyIdentifier: optionalText(options.safetyIdentifier),
    conversationId: optionalText(options.conversationId),
    storedPrompt: storedId
      ? {
          id: storedId,
          version: optionalText(stored?.version),
          variables: readJsonObject(ctx, itemIndex, 'The stored prompt variables', stored?.variables),
        }
      : undefined,
    store: options.store !== undefined ? options.store === true : undefined,
    builtInTools: tools,
    extraBody: Object.keys(extraBody).length ? extraBody : undefined,
  };

  const adapter = openAiResponsesAdapter(config);
  let raw: unknown;
  const wrapped: ChatAdapter = {
    ...adapter,
    buildRequest: (request, stream) => {
      const built = adapter.buildRequest(request, stream);
      const body = built.body as DataObject | undefined;
      if (body && Array.isArray(body.tools)) {
        // the filters have no field in the shared config: they are added to the built-in tools here
        body.tools = (body.tools as DataObject[]).map((tool) => {
          if (tool.type === 'web_search' && allowedDomains) {
            return { ...tool, filters: { allowed_domains: allowedDomains } };
          }
          if (tool.type === 'file_search' && fileFilters) return { ...tool, filters: fileFilters };
          return tool;
        });
      }
      return built;
    },
    parseResponse: (body) => {
      raw = body;
      return adapter.parseResponse(body);
    },
  };
  const timeout = options.timeout !== undefined ? Number(options.timeout) : 300;
  const model = new HttpChatModel(ctx, wrapped, {
    itemIndex,
    maxRetries: 2,
    ...(timeout > 0 ? { timeoutMs: timeout * 1000 } : {}),
  });

  let result;
  try {
    result = await runVendorChat(ctx, itemIndex, wrapped, {
      messages,
      system: optionalText(options.instructions),
      maxIterations: Number(options.maxToolsIterations ?? 15),
      model,
    });
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === VENDOR_WAIT_TOOL) throw error;
    throw vendorError(ctx, error, itemIndex, OPENAI_ERROR_TEXTS);
  }

  let text = result.text;
  let body = raw as DataObject | undefined;
  if (background && body && (body.status === 'queued' || body.status === 'in_progress') && body.id) {
    // a background response is read again until it has finished
    const waitMs = (timeout > 0 ? timeout : 300) * 1000;
    const done = await pollUntil(
      () =>
        openAiCall<DataObject>(ctx, itemIndex, {
          url: `${baseUrl}/responses/${encodeURIComponent(String(body!.id))}`,
          method: 'GET',
        }),
      (value) => value.status !== 'queued' && value.status !== 'in_progress',
      {
        intervalMs: 2000,
        timeoutMs: waitMs,
        signal: ctx.signal,
        timeoutText: `The response was not ready after ${waitMs / 1000} seconds. Raise the Timeout option.`,
      },
    );
    body = done;
    text = messageText(parseOpenAiResponses(done).message.content);
  }

  const usage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  } as unknown as DataObject;
  if (!simplify) {
    return { json: { ...(body ?? {}), output_text: text } as DataObject };
  }
  return {
    json: {
      text,
      ...(body?.id ? { id: body.id } : {}),
      ...(body?.model ? { model: body.model } : {}),
      usage,
    } as DataObject,
  };
}

/** Classify Text for Violations: the moderation endpoint. */
async function textClassify(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  const input = String(ctx.getNodeParameter('input', itemIndex, ''));
  if (!input.trim()) throw new NodeOperationError(ctx.getNode(), 'Enter the text to classify', { itemIndex });
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const response = await openAiCall<DataObject>(ctx, itemIndex, {
    url: `${baseUrl}/moderations`,
    method: 'POST',
    body: {
      input,
      model: options.useStableModel === true ? 'text-moderation-stable' : 'text-moderation-latest',
    },
  });
  if (ctx.getNodeParameter('simplify', itemIndex, false) === true) {
    const first = (response.results as DataObject[] | undefined)?.[0] ?? {};
    return { json: first };
  }
  return { json: response };
}

export async function executeText(ctx: ExecuteContext, itemIndex: number, operation: string): Promise<Item> {
  switch (operation) {
    case 'response':
      return textResponse(ctx, itemIndex);
    case 'classify':
      return textClassify(ctx, itemIndex);
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
