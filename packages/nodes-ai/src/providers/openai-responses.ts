/**
 * OpenAI Responses API wire format (`POST <baseUrl>/responses`), used by the OpenAI node and Azure Foundry.
 * Function tools and the built-in tools (web search, file search, code interpreter) share one `tools` list.
 * Calls are stateless: the full history is sent as `input` items each time, and a `conversation` id is
 * sent only when the node asks for one.
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
  type ChatStreamParser,
  ModelRefusalError,
  parseCompleteStream,
  streamError,
  trimSlash,
} from '../shared/chat-model';
import { isObjectSchema } from '../shared/json-schema';
import { messageText } from '../shared/utils';
import type { ResponseFormatMode } from './openai';

export interface OpenAiWebSearchTool {
  /** `low`, `medium` or `high` */
  searchContextSize?: string;
  /** an ISO country code, such as `US` */
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
}

export interface OpenAiFileSearchTool {
  vectorStoreIds: string[];
  maxResults?: number;
}

export interface OpenAiBuiltInTools {
  webSearch?: OpenAiWebSearchTool | boolean;
  fileSearch?: OpenAiFileSearchTool;
  codeInterpreter?: boolean;
}

/** a fixed answer format for requests that carry no response format of their own */
export type OpenAiTextFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: DataObject; strict?: boolean };

export interface OpenAiStoredPrompt {
  id: string;
  version?: string;
  variables?: DataObject;
}

export interface OpenAiResponsesConfig {
  baseUrl: string;
  model: string;
  credentialType: string;
  provider?: string;
  /** how JSON is asked for when a parser wants it (the Structured Output option); unset is 'jsonSchema' */
  responseFormatMode?: ResponseFormatMode;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  /** query string of the call; never put a secret here */
  query?: Record<string, string>;
  /** extra body fields, merged last: they win on a collision */
  extraBody?: DataObject;
  builtInTools?: OpenAiBuiltInTools;
  /** `low`, `medium` or `high` */
  verbosity?: string;
  reasoningEffort?: string;
  textFormat?: OpenAiTextFormat;
  serviceTier?: string;
  metadata?: Record<string, string>;
  topLogprobs?: number;
  promptCacheKey?: string;
  safetyIdentifier?: string;
  conversationId?: string;
  storedPrompt?: OpenAiStoredPrompt;
  /** ask the server to keep the response (`store`); unset leaves the server default */
  store?: boolean;
}

export function toResponsesInput(messages: AiChatMessage[]): DataObject[] {
  const items: DataObject[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        items.push({ role: 'system', content: messageText(m.content) });
        break;
      case 'user':
        if (typeof m.content === 'string') {
          items.push({ role: 'user', content: m.content });
          break;
        }
        items.push({
          role: 'user',
          content: m.content.map((p) => {
            if (p.type === 'text') return { type: 'input_text', text: p.text };
            const dataUrl = `data:${p.mimeType};base64,${p.data}`;
            if (p.type === 'file') {
              return { type: 'input_file', filename: p.fileName ?? 'file', file_data: dataUrl };
            }
            return {
              type: 'input_image',
              image_url: dataUrl,
              ...(p.detail && p.detail !== 'auto' ? { detail: p.detail } : {}),
            };
          }),
        });
        break;
      case 'assistant': {
        const text = messageText(m.content);
        if (text) items.push({ role: 'assistant', content: text });
        for (const c of m.toolCalls ?? []) {
          items.push({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments ?? {}),
          });
        }
        break;
      }
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: m.toolCallId ?? '',
          output: messageText(m.content),
        });
        break;
      default:
        throw new Error(`Unsupported message role "${String((m as AiChatMessage).role)}"`);
    }
  }
  return items;
}

function builtInToolList(tools: OpenAiBuiltInTools | undefined): DataObject[] {
  const list: DataObject[] = [];
  if (!tools) return list;
  if (tools.webSearch) {
    const o = tools.webSearch === true ? {} : tools.webSearch;
    const location: DataObject = {};
    if (o.country) location.country = o.country;
    if (o.city) location.city = o.city;
    if (o.region) location.region = o.region;
    if (o.timezone) location.timezone = o.timezone;
    list.push({
      type: 'web_search',
      ...(o.searchContextSize ? { search_context_size: o.searchContextSize } : {}),
      ...(Object.keys(location).length ? { user_location: { type: 'approximate', ...location } } : {}),
    });
  }
  if (tools.fileSearch?.vectorStoreIds.length) {
    list.push({
      type: 'file_search',
      vector_store_ids: tools.fileSearch.vectorStoreIds,
      ...(tools.fileSearch.maxResults ? { max_num_results: tools.fileSearch.maxResults } : {}),
    });
  }
  if (tools.codeInterpreter) list.push({ type: 'code_interpreter', container: { type: 'auto' } });
  return list;
}

export function openAiResponsesBody(
  request: AiChatRequest,
  config: OpenAiResponsesConfig,
  stream: boolean,
): DataObject {
  const body: DataObject = { model: config.model, input: toResponsesInput(request.messages) };
  const tools: DataObject[] = (request.tools ?? []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
  tools.push(...builtInToolList(config.builtInTools));
  if (tools.length) body.tools = tools;
  if (request.tools?.length && request.toolChoice === 'any') body.tool_choice = 'required';

  const text: DataObject = {};
  const format = request.responseFormat;
  if (format?.type === 'json') {
    if (config.responseFormatMode !== 'none') {
      text.format =
        config.responseFormatMode !== 'jsonObject' && format.schema && isObjectSchema(format.schema)
          ? { type: 'json_schema', name: 'response', schema: format.schema, strict: false }
          : { type: 'json_object' };
    }
  } else if (config.textFormat) {
    text.format = config.textFormat;
  }
  if (config.verbosity) text.verbosity = config.verbosity;
  if (Object.keys(text).length) body.text = text;

  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  if (config.topP !== undefined) body.top_p = config.topP;
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
  if (config.serviceTier) body.service_tier = config.serviceTier;
  if (config.metadata && Object.keys(config.metadata).length) body.metadata = config.metadata;
  if (config.topLogprobs !== undefined) {
    body.top_logprobs = config.topLogprobs;
    body.include = ['message.output_text.logprobs'];
  }
  if (config.promptCacheKey) body.prompt_cache_key = config.promptCacheKey;
  if (config.safetyIdentifier) body.safety_identifier = config.safetyIdentifier;
  if (config.conversationId) body.conversation = config.conversationId;
  if (config.storedPrompt?.id) {
    body.prompt = {
      id: config.storedPrompt.id,
      ...(config.storedPrompt.version ? { version: config.storedPrompt.version } : {}),
      ...(config.storedPrompt.variables ? { variables: config.storedPrompt.variables } : {}),
    };
  }
  if (config.store !== undefined) body.store = config.store;
  if (stream) body.stream = true;
  return config.extraBody ? { ...body, ...config.extraBody } : body;
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

/** HTTP status an error code in a failed response stands for, so the retry policy can see it */
const RESPONSES_ERROR_STATUS: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
  engine_overloaded: 503,
};

/** the answer of a complete (or incomplete) Responses object */
export function parseOpenAiResponses(body: unknown): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  if (b.error?.message && b.status !== 'completed' && b.status !== 'incomplete') {
    throw streamError(String(b.error.message), RESPONSES_ERROR_STATUS[String(b.error.code)]);
  }
  if (!Array.isArray(b.output)) {
    throw new Error(`The model returned no output${b.error?.message ? `: ${b.error.message}` : ''}`);
  }
  let text = '';
  let refusal = '';
  const toolCalls: AiToolCall[] = [];
  for (const item of b.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
      }
    } else if (item?.type === 'function_call' && item.name) {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`),
        name: String(item.name),
        arguments: parseArguments(item.arguments),
      });
    }
  }
  const reason = b.incomplete_details?.reason;
  if (b.status === 'incomplete' && reason === 'content_filter' && !text) {
    throw new ModelRefusalError('The model provider blocked the response (content filter)');
  }
  if (refusal) throw new ModelRefusalError(`The model declined to answer: ${refusal}`);
  let stopReason: AiChatResponse['stopReason'] = 'other';
  if (toolCalls.length) stopReason = 'tool_calls';
  else if (b.status === 'completed') stopReason = 'end';
  else if (b.status === 'incomplete' && reason === 'max_output_tokens') stopReason = 'max_tokens';
  return {
    message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    usage: b.usage
      ? { inputTokens: Number(b.usage.input_tokens ?? 0), outputTokens: Number(b.usage.output_tokens ?? 0) }
      : undefined,
    stopReason,
    model: b.model,
  };
}

/** Rebuild a response from Responses stream events as they arrive. */
export function openAiResponsesStreamParser(onDelta: (text: string) => void): ChatStreamParser {
  let text = '';
  let refusal = '';
  let final: Record<string, any> | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(event, json) {
      const type = String(json?.type ?? event);
      switch (type) {
        case 'response.output_text.delta':
          if (typeof json.delta === 'string' && json.delta) {
            text += json.delta;
            onDelta(json.delta);
          }
          break;
        case 'response.refusal.delta':
          if (typeof json.delta === 'string') refusal += json.delta;
          break;
        case 'response.output_item.added':
        case 'response.output_item.done': {
          const item = json.item;
          if (item?.type !== 'function_call') break;
          const index = Number(json.output_index ?? 0);
          const entry = calls.get(index) ?? { id: '', name: '', args: '' };
          entry.id = String(item.call_id ?? item.id ?? entry.id);
          if (item.name) entry.name = String(item.name);
          if (type === 'response.output_item.done' && typeof item.arguments === 'string') {
            entry.args = item.arguments;
          }
          calls.set(index, entry);
          break;
        }
        case 'response.function_call_arguments.delta': {
          const index = Number(json.output_index ?? 0);
          const entry = calls.get(index) ?? { id: '', name: '', args: '' };
          if (typeof json.delta === 'string') entry.args += json.delta;
          calls.set(index, entry);
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          final = json.response ?? {};
          break;
        case 'response.failed': {
          const error = json.response?.error ?? {};
          throw streamError(
            String(error.message ?? 'The model stream reported an error'),
            RESPONSES_ERROR_STATUS[String(error.code)],
          );
        }
        case 'error':
          throw streamError(
            String(json.message ?? json.error?.message ?? 'The model stream reported an error'),
            RESPONSES_ERROR_STATUS[String(json.code ?? json.error?.code)],
          );
        default:
          break;
      }
    },
    finish() {
      if (final && Array.isArray(final.output) && final.output.length) {
        return parseOpenAiResponses(final);
      }
      if (refusal) throw new ModelRefusalError(`The model declined to answer: ${refusal}`);
      const toolCalls: AiToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArguments(c.args) }));
      const usage = final?.usage;
      return {
        message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        usage: usage
          ? { inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) }
          : undefined,
        stopReason: toolCalls.length ? 'tool_calls' : final?.status === 'incomplete' ? 'max_tokens' : 'end',
        model: final?.model,
      };
    },
  };
}

/** Rebuild a response from a complete `stream: true` SSE body. */
export function parseOpenAiResponsesStream(body: string, onDelta: (text: string) => void): AiChatResponse {
  return parseCompleteStream(openAiResponsesStreamParser(onDelta), body);
}

export function openAiResponsesAdapter(config: OpenAiResponsesConfig): ChatAdapter {
  return {
    provider: config.provider ?? 'openai',
    model: config.model,
    credentialType: config.credentialType,
    capabilities: {
      structuredOutput: config.responseFormatMode !== 'none',
      structuredOutputWithTools: config.responseFormatMode !== 'none',
    },
    buildRequest: (request, stream) => ({
      url: `${trimSlash(config.baseUrl)}/responses`,
      method: 'POST',
      headers: { accept: stream ? 'text/event-stream' : 'application/json', ...(config.extraHeaders ?? {}) },
      ...(config.query ? { qs: config.query } : {}),
      body: openAiResponsesBody(request, config, stream),
    }),
    parseResponse: parseOpenAiResponses,
    streamParser: openAiResponsesStreamParser,
  };
}
