/**
 * OpenAI Chat Completions wire format. Used by the OpenAI node and by every OpenAI-compatible
 * endpoint (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM, ...).
 */
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiToolCall,
  DataObject,
} from '@workflow/workflow';
import {
  type ChatAdapter,
  type ChatModelCapabilities,
  type ChatStreamParser,
  ModelRefusalError,
  parseCompleteStream,
  streamError,
  trimSlash,
} from '../shared/chat-model';
import { isObjectSchema } from '../shared/json-schema';
import { messageText } from '../shared/utils';

export type ResponseFormatMode = 'jsonSchema' | 'jsonObject' | 'none';

export interface OpenAiChatConfig {
  baseUrl: string;
  model: string;
  credentialType: string;
  provider?: string;
  /** `max_completion_tokens` (OpenAI) or `max_tokens` (most compatible servers) */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  responseFormatMode: ResponseFormatMode;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoningEffort?: string;
  extraHeaders?: Record<string, string>;
  /** path after `baseUrl`, default `/chat/completions` (Azure classic has its own) */
  chatPath?: string;
  /** query string of the chat call, such as Azure's `api-version`; never put a secret here */
  query?: Record<string, string>;
  /** ask for usage on a stream with `stream_options`, default true (Mistral may reject the field) */
  streamUsage?: boolean;
  /** extra body fields, merged last: they win on a collision */
  extraBody?: DataObject;
}

export function toOpenAiMessages(messages: AiChatMessage[]): DataObject[] {
  return messages.map((m): DataObject => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: messageText(m.content) };
      case 'user':
        if (typeof m.content === 'string') return { role: 'user', content: m.content };
        return {
          role: 'user',
          content: m.content.map((p) => {
            if (p.type === 'text') return { type: 'text', text: p.text };
            const dataUrl = `data:${p.mimeType};base64,${p.data}`;
            if (p.type === 'file') {
              return { type: 'file', file: { filename: p.fileName ?? 'file', file_data: dataUrl } };
            }
            return { type: 'image_url', image_url: { url: dataUrl } };
          }),
        };
      case 'assistant': {
        const text = messageText(m.content);
        return {
          role: 'assistant',
          content: text || (m.toolCalls?.length ? null : ''),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                })),
              }
            : {}),
        };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: messageText(m.content) };
      default:
        throw new Error(`Unsupported message role "${String((m as AiChatMessage).role)}"`);
    }
  });
}

export function openAiChatBody(
  request: AiChatRequest,
  config: OpenAiChatConfig,
  stream: boolean,
): DataObject {
  const body: DataObject = {
    model: config.model,
    messages: toOpenAiMessages(request.messages),
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (request.toolChoice === 'any') body.tool_choice = 'required';
  }
  const format = request.responseFormat;
  if (format?.type === 'json' && config.responseFormatMode !== 'none') {
    if (config.responseFormatMode === 'jsonSchema' && format.schema && isObjectSchema(format.schema)) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: format.schema, strict: false },
      };
    } else {
      body.response_format = { type: 'json_object' };
    }
  }
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  if (config.topP !== undefined) body.top_p = config.topP;
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) body[config.maxTokensField] = maxTokens;
  if (config.frequencyPenalty !== undefined) body.frequency_penalty = config.frequencyPenalty;
  if (config.presencePenalty !== undefined) body.presence_penalty = config.presencePenalty;
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  if (stream) {
    body.stream = true;
    if (config.streamUsage !== false) body.stream_options = { include_usage: true };
  }
  return config.extraBody ? { ...body, ...config.extraBody } : body;
}

/** The answer in `content`: a string, or an array where only `text` blocks count (Magistral thinking does not). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function parseArguments(raw: unknown): DataObject {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as DataObject;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: parsed };
  } catch {
    return { _rawArguments: raw };
  }
}

function stopReason(finish: unknown, hasToolCalls: boolean): AiChatResponse['stopReason'] {
  if (hasToolCalls || finish === 'tool_calls' || finish === 'function_call') return 'tool_calls';
  if (finish === 'stop') return 'end';
  if (finish === 'length') return 'max_tokens';
  return 'other';
}

export function parseOpenAiResponse(body: unknown): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  const choice = b.choices?.[0];
  if (!choice)
    throw new Error(`The model returned no choices${b.error?.message ? `: ${b.error.message}` : ''}`);
  const message = choice.message ?? {};
  const text = contentText(message.content);
  if (choice.finish_reason === 'content_filter' && !text) {
    throw new ModelRefusalError('The model provider blocked the response (content filter)');
  }
  if (message.refusal) throw new ModelRefusalError(`The model declined to answer: ${message.refusal}`);
  const toolCalls: AiToolCall[] = (message.tool_calls ?? [])
    .filter((c: any) => c?.function?.name)
    .map((c: any, i: number) => ({
      id: String(c.id ?? `call_${i}`),
      name: String(c.function.name),
      arguments: parseArguments(c.function.arguments),
    }));
  return {
    message: {
      role: 'assistant',
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    usage: b.usage
      ? {
          inputTokens: Number(b.usage.prompt_tokens ?? 0),
          outputTokens: Number(b.usage.completion_tokens ?? 0),
        }
      : undefined,
    stopReason: stopReason(choice.finish_reason, toolCalls.length > 0),
    model: b.model,
  };
}

/** HTTP status a stream `error` object stands for (the status line is already 200 by then) */
const OPENAI_STREAM_STATUS: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
  rate_limit_error: 429,
  engine_overloaded: 503,
  overloaded_error: 503,
};

/** Rebuild a response from `stream: true` chunks as they arrive. */
export function openAiStreamParser(onDelta: (text: string) => void): ChatStreamParser {
  let content = '';
  let refusal = '';
  let finish: unknown;
  let model: string | undefined;
  let usage: AiChatResponse['usage'];
  const calls = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(_event, json) {
      if (json.error) {
        throw streamError(
          json.error.message ?? 'The model stream reported an error',
          OPENAI_STREAM_STATUS[String(json.error.code)] ?? OPENAI_STREAM_STATUS[String(json.error.type)],
        );
      }
      model ??= json.model;
      if (json.usage) {
        usage = {
          inputTokens: Number(json.usage.prompt_tokens ?? 0),
          outputTokens: Number(json.usage.completion_tokens ?? 0),
        };
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const text = contentText(delta.content);
      if (text) {
        content += text;
        onDelta(text);
      }
      if (typeof delta.refusal === 'string') refusal += delta.refusal;
      for (const tc of delta.tool_calls ?? []) {
        const index = Number(tc.index ?? 0);
        const entry = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        calls.set(index, entry);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    },
    finish() {
      // the same refusal rules as parseOpenAiResponse
      if (finish === 'content_filter' && !content) {
        throw new ModelRefusalError('The model provider blocked the response (content filter)');
      }
      if (refusal) throw new ModelRefusalError(`The model declined to answer: ${refusal}`);
      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArguments(c.args) }));
      return {
        message: { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) },
        usage,
        stopReason: stopReason(finish, toolCalls.length > 0),
        model,
      };
    },
  };
}

/** Rebuild a response from a complete `stream: true` SSE body. */
export function parseOpenAiStream(text: string, onDelta: (text: string) => void): AiChatResponse {
  return parseCompleteStream(openAiStreamParser(onDelta), text);
}

export function openAiAdapter(config: OpenAiChatConfig): ChatAdapter {
  const capabilities: ChatModelCapabilities = {
    structuredOutput: config.responseFormatMode !== 'none',
    structuredOutputWithTools: config.responseFormatMode !== 'none',
  };
  return {
    provider: config.provider ?? 'openai',
    model: config.model,
    credentialType: config.credentialType,
    capabilities,
    buildRequest: (request, stream) => ({
      url: `${trimSlash(config.baseUrl)}/${(config.chatPath ?? 'chat/completions').replace(/^\/+/, '')}`,
      method: 'POST',
      headers: { accept: stream ? 'text/event-stream' : 'application/json', ...(config.extraHeaders ?? {}) },
      ...(config.query ? { qs: config.query } : {}),
      body: openAiChatBody(request, config, stream),
    }),
    parseResponse: parseOpenAiResponse,
    streamParser: openAiStreamParser,
  };
}
