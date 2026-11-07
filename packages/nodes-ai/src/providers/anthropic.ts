/**
 * Anthropic Messages API (`POST /v1/messages`, API version 2026-10-21).
 *
 * - System messages go to the top-level `system` field; tool results are `tool_result` blocks in
 *   one user turn, with `is_error` for failed tools.
 * - Assistant turns produced in this run are replayed with their original content blocks
 *   (thinking blocks and signatures included), as the API requires inside a tool loop.
 * - Structured output uses `output_config.format` (`json_schema`).
 * - Sampling parameters (`temperature`, `top_p`, `top_k`) are not sent: API version 2026-10-21
 *   rejects them on every model. Depth is controlled with `output_config.effort`.
 */
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiToolCall,
  DataObject,
  HttpRequestOptions,
} from '@workflow/workflow';
import {
  type ChatAdapter,
  type ChatStreamParser,
  ModelRefusalError,
  parseCompleteStream,
  streamError,
  trimSlash,
} from '../shared/chat-model';
import { toAnthropicSchema } from '../shared/json-schema';
import { isToolError, RawContentCache } from '../shared/markers';
import { messageText } from '../shared/utils';

export const ANTHROPIC_API_VERSION = '2026-10-21';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** the latest Sonnet; users pick any model from the list loaded from `/v1/models` */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** models that accept server-side refusal fallbacks (`fallbacks: "default"`) on the Claude API */
const SERVER_FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** HTTP status a stream `error` event stands for (the status line is already 200 by then) */
const ANTHROPIC_STREAM_STATUS: Record<string, number> = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
  timeout_error: 504,
};

export interface AnthropicChatConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  effort?: string;
  /** top-level automatic prompt caching (cheaper repeated prefixes in agent loops) */
  promptCaching: boolean;
  /** retry policy declines on the model Anthropic recommends (Claude API only) */
  refusalFallback: boolean;
  credentialType?: string;
}

type Block = DataObject & { type: string };

export function toAnthropicMessages(
  messages: AiChatMessage[],
  cache?: RawContentCache<Block[]>,
): DataObject[] {
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out[out.length - 1];
    // tool results of one assistant turn must arrive together in a single user turn
    if (
      last &&
      last.role === role &&
      role === 'user' &&
      last.content.every((b) => b.type === 'tool_result')
    ) {
      if (blocks.every((b) => b.type === 'tool_result')) {
        last.content.push(...blocks);
        return;
      }
    }
    out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const blocks: Block[] =
        typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : m.content.map((p): Block => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              const source = { type: 'base64', media_type: p.mimeType, data: p.data };
              if (p.type === 'image') return { type: 'image', source };
              return { type: 'document', source, ...(p.fileName ? { title: p.fileName } : {}) };
            });
      push(
        'user',
        blocks.filter((b) => b.type !== 'text' || (b.text as string).length > 0),
      );
    } else if (m.role === 'assistant') {
      const raw = cache?.recall(m);
      if (raw) {
        push('assistant', raw);
        continue;
      }
      const blocks: Block[] = [];
      const text = messageText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: messageText(m.content) || '(empty result)',
          ...(isToolError(m) ? { is_error: true } : {}),
        },
      ]);
    }
  }
  return out.filter((m) => m.content.length > 0);
}

export function anthropicRequestBody(
  request: AiChatRequest,
  config: AnthropicChatConfig,
  stream: boolean,
  cache?: RawContentCache<Block[]>,
): { body: DataObject; headers: Record<string, string> } {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => messageText(m.content))
    .filter(Boolean)
    .join('\n\n');
  const body: DataObject = {
    model: config.model,
    max_tokens: request.maxTokens ?? config.maxTokens,
    messages: toAnthropicMessages(request.messages, cache),
  };
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_API_VERSION };
  if (system) body.system = system;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.parameters },
    }));
    if (request.toolChoice === 'any') body.tool_choice = { type: 'any' };
  }
  const outputConfig: DataObject = {};
  if (request.responseFormat?.type === 'json' && request.responseFormat.schema) {
    const schema = toAnthropicSchema(request.responseFormat.schema);
    if (schema) outputConfig.format = { type: 'json_schema', schema };
  }
  if (config.effort) outputConfig.effort = config.effort;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (config.promptCaching) body.cache_control = { type: 'ephemeral' };
  const isClaudeApi = trimSlash(config.baseUrl) === ANTHROPIC_DEFAULT_BASE_URL;
  if (config.refusalFallback && isClaudeApi && SERVER_FALLBACK_MODELS.has(config.model)) {
    headers['anthropic-beta'] = SERVER_FALLBACK_BETA;
    body.fallbacks = 'default';
  }
  if (stream) body.stream = true;
  return { body, headers };
}

function mapStopReason(reason: unknown): AiChatResponse['stopReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'other';
}

export function parseAnthropicMessage(body: unknown, cache?: RawContentCache<Block[]>): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  if (b.type === 'error' || (b.error && !b.content)) {
    throw new Error(b.error?.message ?? 'The Anthropic API returned an error');
  }
  if (b.stop_reason === 'refusal') {
    const category = b.stop_details?.category;
    throw new ModelRefusalError(
      `The model declined the request${category ? ` (category: ${category})` : ''}. Rephrase the request or choose another model.`,
    );
  }
  const content: Block[] = Array.isArray(b.content) ? b.content : [];
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('');
  const toolCalls: AiToolCall[] = content
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({
      id: String(c.id),
      name: String(c.name),
      arguments: (c.input && typeof c.input === 'object' ? c.input : {}) as DataObject,
    }));
  const message: AiChatMessage = {
    role: 'assistant',
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  cache?.remember(message, content);
  const u = b.usage ?? {};
  return {
    message,
    usage: b.usage
      ? {
          inputTokens:
            Number(u.input_tokens ?? 0) +
            Number(u.cache_creation_input_tokens ?? 0) +
            Number(u.cache_read_input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
        }
      : undefined,
    stopReason: mapStopReason(b.stop_reason),
    model: b.model,
  };
}

/** Rebuild the final message from `stream: true` events as they arrive, reporting text deltas. */
export function anthropicStreamParser(
  onDelta: (text: string) => void,
  cache?: RawContentCache<Block[]>,
): ChatStreamParser {
  const message: Record<string, any> = { content: [] as Block[], usage: {} };
  const partialJson = new Map<number, string>();
  return {
    push(_event, json) {
      switch (json.type) {
        case 'message_start':
          Object.assign(message, json.message, { content: [] });
          break;
        case 'content_block_start': {
          const block = { ...json.content_block } as Block;
          if (block.type === 'tool_use') partialJson.set(json.index, '');
          message.content[json.index] = block;
          break;
        }
        case 'content_block_delta': {
          const block = message.content[json.index] as Block | undefined;
          const delta = json.delta ?? {};
          if (!block) break;
          if (delta.type === 'text_delta') {
            block.text = String(block.text ?? '') + delta.text;
            onDelta(delta.text);
          } else if (delta.type === 'input_json_delta') {
            partialJson.set(json.index, (partialJson.get(json.index) ?? '') + delta.partial_json);
          } else if (delta.type === 'thinking_delta') {
            block.thinking = String(block.thinking ?? '') + delta.thinking;
          } else if (delta.type === 'signature_delta') {
            block.signature = String(block.signature ?? '') + delta.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const block = message.content[json.index] as Block | undefined;
          if (block?.type === 'tool_use') {
            const raw = partialJson.get(json.index) ?? '';
            try {
              block.input = raw ? JSON.parse(raw) : {};
            } catch {
              block.input = { _rawArguments: raw };
            }
          }
          break;
        }
        case 'message_delta':
          if (json.delta?.stop_reason) message.stop_reason = json.delta.stop_reason;
          if (json.delta?.stop_details) message.stop_details = json.delta.stop_details;
          message.usage = { ...message.usage, ...json.usage };
          break;
        case 'error':
          throw streamError(
            json.error?.message ?? 'The Anthropic stream reported an error',
            ANTHROPIC_STREAM_STATUS[json.error?.type as string],
          );
        default:
          break;
      }
    },
    finish() {
      message.content = (message.content as Block[]).filter(Boolean);
      return parseAnthropicMessage(message, cache);
    },
  };
}

/** Rebuild the final message from a complete `stream: true` SSE body, reporting text deltas. */
export function parseAnthropicStream(
  text: string,
  onDelta: (text: string) => void,
  cache?: RawContentCache<Block[]>,
): AiChatResponse {
  return parseCompleteStream(anthropicStreamParser(onDelta, cache), text);
}

export function anthropicAdapter(config: AnthropicChatConfig): ChatAdapter {
  const cache = new RawContentCache<Block[]>();
  return {
    provider: 'anthropic',
    model: config.model,
    credentialType: config.credentialType ?? 'anthropicApi',
    capabilities: { structuredOutput: true, structuredOutputWithTools: true },
    buildRequest: (request, stream): HttpRequestOptions => {
      const { body, headers } = anthropicRequestBody(request, config, stream, cache);
      return {
        url: `${trimSlash(config.baseUrl)}/v1/messages`,
        method: 'POST',
        headers: { ...headers, accept: stream ? 'text/event-stream' : 'application/json' },
        body,
      };
    },
    parseResponse: (body) => parseAnthropicMessage(body, cache),
    streamParser: (onDelta) => anthropicStreamParser(onDelta, cache),
  };
}
