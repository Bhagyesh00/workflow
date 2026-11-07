/**
 * Cohere v2 chat API (`POST <credential url>/v2/chat`).
 *
 * - Roles are `system`, `user`, `assistant` and `tool`. An assistant turn that asked for tools carries
 *   `tool_calls` (arguments as a JSON string); each result is a `tool` message with `tool_call_id`.
 * - Images go as `image_url` parts with a data URL. Cohere takes no file parts: they are refused.
 * - `toolChoice: 'any'` is `tool_choice: "REQUIRED"`, sent only when the request offers tools.
 * - Structured output is `response_format: { type: "json_object", json_schema }`.
 * - The base URL comes from the credential, so a proxy or private deployment is honoured.
 * - Streaming is SSE; every event has a `type` (`content-delta`, `tool-call-start`, ...).
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
  parseCompleteStream,
  streamError,
  trimSlash,
} from '../shared/chat-model';
import { messageText } from '../shared/utils';

export const COHERE_DEFAULT_BASE_URL = 'https://api.cohere.ai';
export const COHERE_DEFAULT_MODEL = 'command-a-03-2025';

export interface CohereChatConfig {
  /** from the credential: a custom URL is honoured */
  baseUrl: string;
  model: string;
  credentialType?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export function toCohereMessages(messages: AiChatMessage[]): DataObject[] {
  const out: DataObject[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: messageText(m.content) });
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      const parts = m.content.map((p): DataObject => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image') {
          return { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
        }
        throw new Error('Cohere cannot read files here');
      });
      out.push({
        role: 'user',
        content: parts.filter((p) => p.type !== 'text' || String(p.text).length > 0),
      });
    } else if (m.role === 'assistant') {
      const text = messageText(m.content);
      const msg: DataObject = { role: 'assistant' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
        if (text) msg.tool_plan = text;
      } else {
        if (!text) continue;
        msg.content = text;
      }
      out.push(msg);
    } else {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: messageText(m.content) || '(empty result)',
      });
    }
  }
  return out;
}

export function cohereRequestBody(
  request: AiChatRequest,
  config: CohereChatConfig,
  stream: boolean,
): DataObject {
  const body: DataObject = { model: config.model, messages: toCohereMessages(request.messages) };
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  // Cohere takes `p` from 0.01 to 0.99; the node's Top P runs from 0 to 1
  if (config.topP !== undefined) body.p = Math.min(0.99, Math.max(0.01, config.topP));
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.parameters } },
    }));
    if (request.toolChoice === 'any') body.tool_choice = 'REQUIRED';
  }
  if (request.responseFormat?.type === 'json') {
    body.response_format = request.responseFormat.schema
      ? { type: 'json_object', json_schema: request.responseFormat.schema }
      : { type: 'json_object' };
  }
  if (stream) body.stream = true;
  return body;
}

function mapFinishReason(reason: unknown): AiChatResponse['stopReason'] {
  if (reason === 'COMPLETE' || reason === 'STOP_SEQUENCE') return 'end';
  if (reason === 'TOOL_CALL') return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return 'other';
}

function parseArguments(raw: unknown): DataObject {
  if (raw && typeof raw === 'object') return raw as DataObject;
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DataObject)
      : { _rawArguments: text };
  } catch {
    return { _rawArguments: text };
  }
}

function usageOf(usage: any): AiChatResponse['usage'] {
  if (!usage) return undefined;
  const counts = usage.tokens ?? usage.billed_units ?? {};
  return { inputTokens: Number(counts.input_tokens ?? 0), outputTokens: Number(counts.output_tokens ?? 0) };
}

export function parseCohereResponse(body: unknown): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  if (b.finish_reason === 'ERROR') throw new Error('The Cohere API ended the reply with an error');
  if (!b.message || typeof b.message !== 'object') {
    throw new Error(typeof b.message === 'string' ? b.message : 'The Cohere API returned no message');
  }
  const message = b.message as Record<string, any>;
  const content: Array<Record<string, any>> = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('');
  const toolCalls: AiToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(
    (c: any) => ({
      id: String(c.id),
      name: String(c.function?.name ?? ''),
      arguments: parseArguments(c.function?.arguments),
    }),
  );
  return {
    message: {
      role: 'assistant',
      content: text || (toolCalls.length && typeof message.tool_plan === 'string' ? message.tool_plan : ''),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    usage: usageOf(b.usage),
    stopReason: mapFinishReason(b.finish_reason),
  };
}

export function cohereStreamParser(onDelta: (text: string) => void): ChatStreamParser {
  let text = '';
  let plan = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: unknown;
  let usage: any;
  return {
    push(event, json) {
      switch (json.type ?? event) {
        case 'content-delta': {
          const piece = json.delta?.message?.content?.text;
          if (typeof piece === 'string' && piece) {
            text += piece;
            onDelta(piece);
          }
          break;
        }
        case 'tool-plan-delta': {
          const piece = json.delta?.message?.tool_plan;
          if (typeof piece === 'string') plan += piece;
          break;
        }
        case 'tool-call-start': {
          const call = json.delta?.message?.tool_calls ?? {};
          calls.set(Number(json.index ?? calls.size), {
            id: String(call.id ?? ''),
            name: String(call.function?.name ?? ''),
            args: String(call.function?.arguments ?? ''),
          });
          break;
        }
        case 'tool-call-delta': {
          const call = calls.get(Number(json.index ?? 0));
          const piece = json.delta?.message?.tool_calls?.function?.arguments;
          if (call && typeof piece === 'string') call.args += piece;
          break;
        }
        case 'message-end':
          finish = json.delta?.finish_reason;
          usage = json.delta?.usage;
          break;
        case 'error':
          throw streamError(
            String(json.error?.message ?? json.message ?? 'The Cohere stream reported an error'),
            typeof json.status === 'number' ? json.status : undefined,
          );
        default:
          break;
      }
    },
    finish() {
      if (finish === 'ERROR') throw new Error('The Cohere API ended the reply with an error');
      const toolCalls: AiToolCall[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ id: c.id, name: c.name, arguments: parseArguments(c.args) }));
      return {
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? plan : ''),
          ...(toolCalls.length ? { toolCalls } : {}),
        },
        usage: usageOf(usage),
        stopReason: mapFinishReason(finish ?? (toolCalls.length ? 'TOOL_CALL' : 'COMPLETE')),
      };
    },
  };
}

export function parseCohereStream(text: string, onDelta: (text: string) => void): AiChatResponse {
  return parseCompleteStream(cohereStreamParser(onDelta), text);
}

export function cohereAdapter(config: CohereChatConfig): ChatAdapter {
  return {
    provider: 'cohere',
    model: config.model,
    credentialType: config.credentialType ?? 'cohereApi',
    capabilities: { structuredOutput: true, structuredOutputWithTools: false },
    buildRequest: (request, stream): HttpRequestOptions => ({
      url: `${trimSlash(config.baseUrl || COHERE_DEFAULT_BASE_URL)}/v2/chat`,
      method: 'POST',
      headers: { accept: stream ? 'text/event-stream' : 'application/json' },
      body: cohereRequestBody(request, config, stream),
    }),
    parseResponse: parseCohereResponse,
    streamParser: (onDelta) => cohereStreamParser(onDelta),
  };
}
