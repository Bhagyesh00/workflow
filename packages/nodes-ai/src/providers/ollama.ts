/**
 * Ollama native chat API (`POST /api/chat`) with tools and JSON-schema `format`.
 * Ollama usually runs on a private address: the SSRF policy blocks it unless an admin
 * allow-lists the host (or the instance is single-tenant with SSRF protection off).
 */
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiToolCall,
  DataObject,
  HttpRequestOptions,
} from '@workflow/workflow';
import { type ChatAdapter, trimSlash } from '../shared/chat-model';
import { messageText } from '../shared/utils';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

export interface OllamaChatConfig {
  baseUrl: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  numCtx?: number;
  keepAlive?: string;
  credentialType?: string;
}

export function toOllamaMessages(messages: AiChatMessage[]): DataObject[] {
  return messages.map((m): DataObject => {
    const images =
      typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image').map((p) => p.data);
    const base: DataObject = { role: m.role, content: messageText(m.content) };
    if (images.length) base.images = images;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      base.tool_calls = m.toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.arguments ?? {} },
      }));
    }
    if (m.role === 'tool' && m.name) base.tool_name = m.name;
    return base;
  });
}

export function ollamaRequestBody(request: AiChatRequest, config: OllamaChatConfig): DataObject {
  const body: DataObject = {
    model: config.model,
    messages: toOllamaMessages(request.messages),
    stream: false,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (request.responseFormat?.type === 'json') body.format = request.responseFormat.schema ?? 'json';
  const options: DataObject = {};
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) options.temperature = temperature;
  if (config.topP !== undefined) options.top_p = config.topP;
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) options.num_predict = maxTokens;
  if (config.numCtx !== undefined) options.num_ctx = config.numCtx;
  if (Object.keys(options).length) body.options = options;
  if (config.keepAlive) body.keep_alive = config.keepAlive;
  return body;
}

export function parseOllamaResponse(body: unknown): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  if (b.error) throw new Error(String(b.error));
  const message = b.message ?? {};
  const toolCalls: AiToolCall[] = (message.tool_calls ?? []).map((c: any, i: number) => {
    let args = c.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { _rawArguments: args };
      }
    }
    return {
      id: String(c.id ?? `call_${i}_${Math.random().toString(36).slice(2, 10)}`),
      name: String(c.function?.name),
      arguments: args,
    };
  });
  return {
    message: {
      role: 'assistant',
      content: String(message.content ?? ''),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    usage:
      b.prompt_eval_count !== undefined || b.eval_count !== undefined
        ? { inputTokens: Number(b.prompt_eval_count ?? 0), outputTokens: Number(b.eval_count ?? 0) }
        : undefined,
    stopReason: toolCalls.length ? 'tool_calls' : b.done_reason === 'length' ? 'max_tokens' : 'end',
    model: b.model,
  };
}

export function ollamaAdapter(config: OllamaChatConfig): ChatAdapter {
  return {
    provider: 'ollama',
    model: config.model,
    credentialType: config.credentialType ?? 'ollamaApi',
    capabilities: { structuredOutput: true, structuredOutputWithTools: false },
    buildRequest: (request): HttpRequestOptions => ({
      url: `${trimSlash(config.baseUrl)}/api/chat`,
      method: 'POST',
      body: ollamaRequestBody(request, config),
    }),
    parseResponse: parseOllamaResponse,
  };
}
