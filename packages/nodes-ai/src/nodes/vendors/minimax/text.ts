/**
 * MiniMax, shared pieces and Text > Message a Model. The credential's base URL (it already ends in `/v1`),
 * one call helper that turns a MiniMax `base_resp` failure (HTTP 200 with a code in the body) into an
 * error, and the message operation on `openAiAdapter` with Hide Thinking.
 */
import {
  type AiChatResponse,
  type DataObject,
  type ExecuteContext,
  type HttpRequestOptions,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { openAiAdapter } from '../../../providers/openai';
import { type ChatAdapter, trimSlash } from '../../../shared/chat-model';
import { redactSecrets } from '../../../shared/utils';
import { vendorError, vendorRequest } from '../shared/api';
import {
  maxToolIterationsOption,
  messagesProperty,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { runVendorChat, VENDOR_WAIT_TOOL } from '../shared/tool-loop';

export const MINIMAX_CREDENTIAL = 'minimaxApi';
export const DEFAULT_MINIMAX_URL = 'https://api.minimax.io/v1';
export const DEFAULT_TEXT_MODEL = 'MiniMax-M3';

export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** the credential's base URL, without a trailing slash */
export async function minimaxBase(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const creds = await ctx.getCredentials(MINIMAX_CREDENTIAL, itemIndex);
  return trimSlash(String(creds.url || DEFAULT_MINIMAX_URL));
}

/** MiniMax answers a failure with HTTP 200 and a `base_resp.status_code` other than 0 */
export function checkBaseResp(ctx: ExecuteContext, itemIndex: number, body: unknown): void {
  const resp = (body as { base_resp?: { status_code?: unknown; status_msg?: unknown } } | null)?.base_resp;
  if (!resp || resp.status_code === undefined || resp.status_code === 0) return;
  const text = typeof resp.status_msg === 'string' && resp.status_msg ? resp.status_msg : 'The request failed';
  throw new NodeOperationError(
    ctx.getNode(),
    `MiniMax: ${redactSecrets(text)} (code ${String(resp.status_code)})`,
    { itemIndex },
  );
}

/** one call on the credential's host (`path` starts with a slash), with the key; checks `base_resp` */
export async function minimaxCall<T = DataObject>(
  ctx: ExecuteContext,
  itemIndex: number,
  path: string,
  request: Omit<HttpRequestOptions, 'url'> = {},
): Promise<T> {
  const base = await minimaxBase(ctx, itemIndex);
  const body = await vendorRequest<T>(ctx, MINIMAX_CREDENTIAL, itemIndex, { ...request, url: `${base}${path}` });
  checkBaseResp(ctx, itemIndex, body);
  return body;
}

/** the model id of the node, kept to model-name characters */
export function readModel(ctx: ExecuteContext, itemIndex: number, fallback: string): string {
  const chosen = String(ctx.getNodeParameter('modelId', itemIndex, fallback) ?? '').trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(chosen)) {
    throw new NodeOperationError(ctx.getNode(), 'The model name has characters a model name cannot have', {
      itemIndex,
    });
  }
  return chosen;
}

const THINKING = /<think>[\s\S]*?(?:<\/think>|$)\s*/g;

/** `openAiAdapter` for MiniMax: a failure in `base_resp` is an error, and `<think>` blocks can be cut out */
export function minimaxAdapter(config: {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  hideThinking: boolean;
}): ChatAdapter {
  const base = openAiAdapter({
    baseUrl: config.baseUrl,
    model: config.model,
    credentialType: MINIMAX_CREDENTIAL,
    provider: 'minimax',
    maxTokensField: 'max_tokens',
    responseFormatMode: 'none',
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    streamUsage: false,
  });
  return {
    ...base,
    parseResponse: (body: unknown): AiChatResponse => {
      const resp = (body as { base_resp?: { status_code?: unknown; status_msg?: unknown } } | null)?.base_resp;
      if (resp && resp.status_code !== undefined && resp.status_code !== 0) {
        throw new Error(
          `MiniMax: ${String(resp.status_msg || 'The request failed')} (code ${String(resp.status_code)})`,
        );
      }
      const parsed = base.parseResponse(body);
      if (!config.hideThinking || typeof parsed.message.content !== 'string') return parsed;
      return {
        ...parsed,
        message: { ...parsed.message, content: parsed.message.content.replace(THINKING, '').trim() },
      };
    },
  };
}

const shown = { show: { resource: ['text'], operation: ['message'] } };

export const textProperties: NodeProperty[] = [
  {
    displayName: 'Model',
    name: 'modelId',
    type: 'options',
    default: DEFAULT_TEXT_MODEL,
    displayOptions: shown,
    description: 'The model to message. Choose from the list, or use an expression for another model id.',
    options: [
      { name: 'MiniMax-M3', value: 'MiniMax-M3' },
      { name: 'MiniMax-M2.5', value: 'MiniMax-M2.5' },
      { name: 'MiniMax-M2.1', value: 'MiniMax-M2.1' },
      { name: 'MiniMax-M2', value: 'MiniMax-M2' },
    ],
  },
  { ...messagesProperty({ roles: ['user', 'assistant'] }), displayOptions: shown },
  { ...simplifyProperty(), displayOptions: shown },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: shown,
    options: [
      {
        displayName: 'Hide Thinking',
        name: 'hideThinking',
        type: 'boolean',
        default: true,
        description: "Whether to cut the model's thinking (the text between think tags) out of the answer",
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 1024,
        typeOptions: { minValue: 1 },
      },
      maxToolIterationsOption,
      {
        displayName: 'System Message',
        name: 'systemMessage',
        type: 'string',
        default: '',
        typeOptions: { rows: 2 },
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0.01, maxValue: 1, numberPrecision: 2 },
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
  const adapter = minimaxAdapter({
    baseUrl: await minimaxBase(ctx, itemIndex),
    model,
    temperature: num(options.temperature),
    maxTokens: num(options.maxTokens) ?? 1024,
    hideThinking: options.hideThinking !== false,
  });
  const system = String(options.systemMessage ?? '').trim();
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
  const paired = { item: itemIndex };
  if (ctx.getNodeParameter('simplify', itemIndex, true) === false) {
    const raw = (result.raw && typeof result.raw === 'object' ? result.raw : {}) as DataObject;
    return { json: raw, pairedItem: paired };
  }
  return { json: { output: result.text }, pairedItem: paired };
}
