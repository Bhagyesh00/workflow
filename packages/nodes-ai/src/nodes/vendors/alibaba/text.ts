/**
 * Qwen Cloud (Alibaba Cloud DashScope), shared pieces and the text operations: the credential's base URL
 * and the calls on it, the async task runner (create, poll) the image and video operations use, the model
 * pickers, and Text > Message a Model on a small native adapter (`dashScopeAdapter`) for the tool loop.
 */
import {
  type AiChatMessage,
  type AiChatResponse,
  type AiToolCall,
  type DataObject,
  type ExecuteContext,
  type HttpRequestOptions,
  isResourceLocatorValue,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { type ChatAdapter, trimSlash } from '../../../shared/chat-model';
import { messageText, redactSecrets } from '../../../shared/utils';
import { vendorError, vendorRequest } from '../shared/api';
import {
  maxToolIterationsOption,
  messagesProperty,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { modelListSearch } from '../shared/model-lists';
import { pollUntil } from '../shared/poll';
import { runVendorChat, VENDOR_WAIT_TOOL } from '../shared/tool-loop';

export const QWEN_CREDENTIAL = 'alibabaCloudApi';
export const DEFAULT_QWEN_REGION_URL = 'https://dashscope-intl.aliyuncs.com';
export const DEFAULT_TEXT_MODEL = 'qwen3.5-flash';
export const DEFAULT_VISION_MODEL = 'qwen3-vl-flash';

/** Poll timing of the async tasks; tests shorten the intervals. */
export const pollTiming = {
  imageIntervalMs: 3000,
  imageTimeoutMs: 5 * 60 * 1000,
  videoIntervalMs: 10_000,
  videoTimeoutMs: 20 * 60 * 1000,
};

const TEXT_PATH = '/api/v1/services/aigc/text-generation/generation';
export const MULTIMODAL_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/** the credential's base URL (the region's host) without a trailing slash */
export async function qwenBase(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const creds = await ctx.getCredentials(QWEN_CREDENTIAL, itemIndex);
  return trimSlash(String(creds.url || DEFAULT_QWEN_REGION_URL));
}

/** one call on the credential's host (`path` starts with a slash), with the key and workspace header */
export async function qwenCall<T = DataObject>(
  ctx: ExecuteContext,
  itemIndex: number,
  path: string,
  request: Omit<HttpRequestOptions, 'url'> = {},
): Promise<T> {
  const base = await qwenBase(ctx, itemIndex);
  return vendorRequest<T>(ctx, QWEN_CREDENTIAL, itemIndex, { ...request, url: `${base}${path}` });
}

/** the plain text of a resource locator value or a string */
export function locatorValue(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** the chosen model; it goes into a request body only with the characters a model id has */
export function readModel(ctx: ExecuteContext, itemIndex: number, fallback: string): string {
  const chosen = locatorValue(ctx.getNodeParameter('modelId', itemIndex, fallback)) || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(chosen)) {
    throw new NodeOperationError(ctx.getNode(), 'The model name has characters a model name cannot have', {
      itemIndex,
    });
  }
  return chosen;
}

export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** a model picker: a list from the API (by `searchMethod`) or an id typed in */
export function modelProperty(options: {
  resource: string;
  operations?: string[];
  searchMethod: string;
  defaultModel: string;
}): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: options.defaultModel },
    required: true,
    displayOptions: {
      show: {
        resource: [options.resource],
        ...(options.operations ? { operation: options.operations } : {}),
      },
    },
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: options.searchMethod, searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: options.defaultModel },
    ],
  };
}

async function listApiModels(ctx: LoadOptionsContext): Promise<Array<{ id: string }>> {
  const creds = await ctx.getCredentials(QWEN_CREDENTIAL);
  const base = trimSlash(String(creds.url || DEFAULT_QWEN_REGION_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication(QWEN_CREDENTIAL, {
    url: `${base}/compatible-mode/v1/models`,
  })) as { data?: Array<{ id?: string }> };
  return (response.data ?? []).filter((m): m is { id: string } => typeof m.id === 'string');
}

const NOT_CHAT = /(embedding|rerank|tts|asr|image|wan|livetranslate|realtime|-vl|ocr|mt-)/i;

/** the pickers of the node: chat models and vision models */
export const qwenListSearch: Record<
  string,
  (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult>
> = {
  textModels: modelListSearch(listApiModels, (id) => !NOT_CHAT.test(id)),
  visionModels: modelListSearch(listApiModels, (id) => /(-vl|vision|omni)/i.test(id) && !/realtime/i.test(id)),
};

// ---- async tasks ----

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Create an async task (`X-DashScope-Async: enable`), poll `/api/v1/tasks/<id>` until it ends, and return the
 * task's `output` and `usage`. A failed, canceled or expired task is an error with the vendor's text.
 */
export async function runTask(
  ctx: ExecuteContext,
  itemIndex: number,
  options: { path: string; body: DataObject; intervalMs: number; timeoutMs: number; what: string },
): Promise<{ output: DataObject; usage: unknown }> {
  const created = await qwenCall<{ output?: { task_id?: unknown } }>(ctx, itemIndex, options.path, {
    method: 'POST',
    headers: { 'X-DashScope-Async': 'enable' },
    body: options.body,
  });
  const taskId = created.output?.task_id;
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new NodeOperationError(ctx.getNode(), `Qwen Cloud did not start the ${options.what} task`, {
      itemIndex,
    });
  }
  const final = await pollUntil(
    () =>
      qwenCall<{ output?: DataObject; usage?: unknown }>(
        ctx,
        itemIndex,
        `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      ),
    (value) => {
      const status = String(value.output?.task_status ?? '').toUpperCase();
      return status !== '' && status !== 'PENDING' && status !== 'RUNNING';
    },
    {
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
      signal: ctx.signal,
      timeoutText: `The ${options.what} was not ready in time. Try again later.`,
    },
  );
  const output = final.output ?? {};
  const status = String(output.task_status ?? '').toUpperCase();
  if (status === 'SUCCEEDED') return { output: { ...output, task_id: taskId }, usage: final.usage };
  if (status === 'CANCELED') {
    throw new NodeOperationError(ctx.getNode(), `The ${options.what} task was canceled`, { itemIndex });
  }
  if (status === 'UNKNOWN') {
    throw new NodeOperationError(ctx.getNode(), `The ${options.what} task was not found or has expired`, {
      itemIndex,
    });
  }
  const reason = [output.code, output.message]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(': ');
  throw new NodeOperationError(
    ctx.getNode(),
    `The ${options.what} task failed${reason ? `: ${redactSecrets(reason)}` : ''}`,
    { itemIndex },
  );
}

// ---- chat adapter ----

export interface DashScopeChatConfig {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  repetitionPenalty?: number;
  topK?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
  enableSearch?: boolean;
}

function wireMessage(message: AiChatMessage): DataObject {
  const text = typeof message.content === 'string' ? message.content : messageText(message.content);
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: text,
      tool_calls: message.toolCalls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', content: text, tool_call_id: message.toolCallId ?? '', name: message.name ?? '' };
  }
  return { role: message.role, content: text };
}

function parseArguments(value: unknown): DataObject {
  if (value && typeof value === 'object') return value as DataObject;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as DataObject) : {};
  } catch {
    return {};
  }
}

/** an answer's text: a string, or a list of parts with a `text` */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

/** The native DashScope text generation API as a `ChatAdapter` (messages, tools, `result_format: message`). */
export function dashScopeAdapter(config: DashScopeChatConfig): ChatAdapter {
  return {
    provider: 'qwen',
    model: config.model,
    credentialType: QWEN_CREDENTIAL,
    capabilities: { structuredOutput: false, structuredOutputWithTools: false },
    buildRequest: (request) => {
      const parameters: DataObject = { result_format: 'message' };
      if (request.tools?.length) {
        parameters.tools = request.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      }
      const temperature = request.temperature ?? config.temperature;
      if (temperature !== undefined) parameters.temperature = temperature;
      const maxTokens = request.maxTokens ?? config.maxTokens;
      if (maxTokens !== undefined) parameters.max_tokens = maxTokens;
      if (config.repetitionPenalty !== undefined) parameters.repetition_penalty = config.repetitionPenalty;
      if (config.topK !== undefined) parameters.top_k = config.topK;
      if (config.topP !== undefined) parameters.top_p = config.topP;
      if (config.seed !== undefined) parameters.seed = config.seed;
      if (config.stop?.length) parameters.stop = config.stop;
      if (config.enableSearch) parameters.enable_search = true;
      return {
        url: `${trimSlash(config.baseUrl)}${TEXT_PATH}`,
        method: 'POST',
        body: { model: config.model, input: { messages: request.messages.map(wireMessage) }, parameters },
      };
    },
    parseResponse: (body: unknown): AiChatResponse => {
      const data = (body ?? {}) as {
        output?: { text?: unknown; finish_reason?: unknown; choices?: Array<DataObject> };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const choice = data.output?.choices?.[0] as
        | { message?: { content?: unknown; tool_calls?: Array<DataObject> }; finish_reason?: string }
        | undefined;
      if (!choice && typeof data.output?.text !== 'string') {
        throw new Error('Qwen Cloud returned no answer');
      }
      const text = choice ? contentText(choice.message?.content) : String(data.output?.text ?? '');
      const toolCalls: AiToolCall[] = (choice?.message?.tool_calls ?? [])
        .map((call, index) => {
          const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown };
          return {
            id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments: parseArguments(fn.arguments),
          };
        })
        .filter((call) => call.name);
      const finish = choice?.finish_reason ?? String(data.output?.finish_reason ?? '');
      return {
        message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        usage: data.usage
          ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
          : undefined,
        stopReason: toolCalls.length
          ? 'tool_calls'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'stop'
              ? 'end'
              : 'other',
        model: config.model,
      };
    },
  };
}

// ---- Text > Message a Model ----

const shown = (extra: DataObject = {}) => ({ show: { resource: ['text'], operation: ['message'], ...extra } });

export const textProperties: NodeProperty[] = [
  modelProperty({
    resource: 'text',
    operations: ['message'],
    searchMethod: 'textModels',
    defaultModel: DEFAULT_TEXT_MODEL,
  }),
  { ...messagesProperty({ roles: ['user', 'assistant'] }), displayOptions: shown() },
  { ...simplifyProperty(true), displayOptions: shown() },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: shown(),
    options: [
      {
        displayName: 'Enable Search',
        name: 'enableSearch',
        type: 'boolean',
        default: false,
        description: 'Whether the model may search the web before it answers',
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 2000,
        typeOptions: { minValue: 1 },
        description: 'The most tokens the answer may have',
      },
      maxToolIterationsOption,
      {
        displayName: 'Repetition Penalty',
        name: 'repetitionPenalty',
        type: 'number',
        default: 1.1,
        typeOptions: { minValue: 1, maxValue: 2, numberPrecision: 2 },
        description: 'Above 1 makes the model repeat itself less',
      },
      {
        displayName: 'Seed',
        name: 'seed',
        type: 'number',
        default: 1234,
        description: 'The same seed and input give about the same answer',
      },
      {
        displayName: 'Stop Sequences',
        name: 'stop',
        type: 'string',
        default: '',
        description: 'Comma separated texts that end the answer',
      },
      {
        displayName: 'System Message',
        name: 'system',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
      },
      {
        displayName: 'Top K',
        name: 'topK',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 },
        description: 'How many of the most likely words the model picks from',
      },
      {
        displayName: 'Top P',
        name: 'topP',
        type: 'number',
        default: 0.9,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
        description: 'Nucleus sampling. Lower values make the answer more focused.',
      },
    ],
  },
];

/** Text > Message a Model */
export async function textMessage(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const model = readModel(ctx, itemIndex, DEFAULT_TEXT_MODEL);
  const messages = toChatMessages(await readVendorMessages(ctx, itemIndex));
  if (!messages.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one message', { itemIndex });
  }
  const stop = String(options.stop ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const adapter = dashScopeAdapter({
    baseUrl: await qwenBase(ctx, itemIndex),
    model,
    temperature: num(options.temperature),
    maxTokens: num(options.maxTokens),
    repetitionPenalty: num(options.repetitionPenalty),
    topK: num(options.topK),
    topP: num(options.topP),
    seed: num(options.seed),
    stop,
    enableSearch: options.enableSearch === true,
  });
  const system = String(options.system ?? '').trim();
  let result: Awaited<ReturnType<typeof runVendorChat>>;
  try {
    result = await runVendorChat(ctx, itemIndex, adapter, {
      messages,
      ...(system ? { system } : {}),
      maxIterations: num(options.maxToolsIterations) ?? 15,
    });
  } catch (error) {
    // a refusal to start (a tool that waits) keeps its code; any other failure loses key-shaped text
    if ((error as { code?: string } | undefined)?.code === VENDOR_WAIT_TOOL) throw error;
    throw vendorError(ctx, error, itemIndex);
  }
  const raw = (result.raw && typeof result.raw === 'object' ? result.raw : {}) as DataObject;
  const json: DataObject =
    ctx.getNodeParameter('simplify', itemIndex, true) === false
      ? { content: result.text, model, usage: raw.usage, fullResponse: raw }
      : { content: result.text };
  return { json, pairedItem: { item: itemIndex } };
}
