/**
 * Google Gemini API (`models/{model}:generateContent`) with function declarations.
 * Model turns produced in this run are replayed with their original parts so thought
 * signatures survive a tool loop.
 */
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiToolCall,
  DataObject,
  HttpRequestOptions,
} from '@workflow/workflow';
import { type ChatAdapter, ModelRefusalError, trimSlash } from '../shared/chat-model';
import { isObjectSchema, toGeminiSchema } from '../shared/json-schema';
import { RawContentCache } from '../shared/markers';
import { sseJson } from '../shared/sse';
import { messageText } from '../shared/utils';

export const GEMINI_DEFAULT_HOST = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
/** ids we invent for calls the API returned without one; never echoed back */
const GENERATED_ID_PREFIX = 'gemini_call_';

export interface GeminiChatConfig {
  host: string;
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  credentialType?: string;
  safetySettings?: Array<{ category: string; threshold: string }>;
}

type Part = DataObject;

export function geminiModelPath(model: string): string {
  return model.replace(/^models\//, '');
}

export function toGeminiContents(messages: AiChatMessage[], cache?: RawContentCache<Part[]>): DataObject[] {
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  // tool results need the function name; recover it from the calls of earlier model turns
  const callNames = new Map<string, string>();
  const push = (role: 'user' | 'model', parts: Part[], mergeFunctionResponses = false) => {
    const last = contents[contents.length - 1];
    if (mergeFunctionResponses && last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const parts: Part[] =
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map((p) =>
              p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.data } },
            );
      push('user', parts);
    } else if (m.role === 'assistant') {
      for (const call of m.toolCalls ?? []) callNames.set(call.id, call.name);
      const raw = cache?.recall(m);
      if (raw) {
        push('model', raw);
        continue;
      }
      const parts: Part[] = [];
      const text = messageText(m.content);
      if (text) parts.push({ text });
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
      }
      if (parts.length) push('model', parts);
    } else if (m.role === 'tool') {
      const name = m.name ?? callNames.get(m.toolCallId ?? '') ?? 'tool';
      const text = messageText(m.content);
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        response = text;
      }
      push(
        'user',
        [
          {
            functionResponse: {
              ...(m.toolCallId && !m.toolCallId.startsWith(GENERATED_ID_PREFIX) ? { id: m.toolCallId } : {}),
              name,
              response:
                response && typeof response === 'object' && !Array.isArray(response)
                  ? response
                  : { result: response },
            },
          },
        ],
        true,
      );
    }
  }
  return contents;
}

export function geminiRequestBody(
  request: AiChatRequest,
  config: GeminiChatConfig,
  cache?: RawContentCache<Part[]>,
) {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => messageText(m.content))
    .filter(Boolean)
    .join('\n\n');
  const body: DataObject = { contents: toGeminiContents(request.messages, cache) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema({ type: 'object', ...t.parameters }),
        })),
      },
    ];
  }
  const generationConfig: DataObject = {};
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (config.topP !== undefined) generationConfig.topP = config.topP;
  if (config.topK !== undefined) generationConfig.topK = config.topK;
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
  // JSON mode cannot be combined with function calling on Gemini
  if (request.responseFormat?.type === 'json' && !request.tools?.length) {
    generationConfig.responseMimeType = 'application/json';
    if (request.responseFormat.schema && isObjectSchema(request.responseFormat.schema)) {
      generationConfig.responseSchema = toGeminiSchema(request.responseFormat.schema);
    }
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (config.safetySettings?.length) body.safetySettings = config.safetySettings;
  return body;
}

function mapFinish(reason: unknown, hasCalls: boolean): AiChatResponse['stopReason'] {
  if (hasCalls) return 'tool_calls';
  if (reason === 'STOP') return 'end';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return 'other';
}

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

export function parseGeminiResponse(body: unknown, cache?: RawContentCache<Part[]>): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  if (b.promptFeedback?.blockReason) {
    throw new ModelRefusalError(`The prompt was blocked by the provider (${b.promptFeedback.blockReason})`);
  }
  const candidate = b.candidates?.[0];
  if (!candidate) throw new Error('The model returned no candidates');
  const parts: Part[] = candidate.content?.parts ?? [];
  if (!parts.length && BLOCKED.has(candidate.finishReason)) {
    throw new ModelRefusalError(`The response was blocked by the provider (${candidate.finishReason})`);
  }
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('');
  const toolCalls: AiToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => {
      const call = p.functionCall as DataObject;
      return {
        id: call.id
          ? String(call.id)
          : `${GENERATED_ID_PREFIX}${i}_${Math.random().toString(36).slice(2, 10)}`,
        name: String(call.name),
        arguments: (call.args && typeof call.args === 'object' ? call.args : {}) as DataObject,
      };
    });
  const message: AiChatMessage = {
    role: 'assistant',
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  cache?.remember(message, parts);
  const usage = b.usageMetadata;
  return {
    message,
    usage: usage
      ? {
          inputTokens: Number(usage.promptTokenCount ?? 0),
          outputTokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
        }
      : undefined,
    stopReason: mapFinish(candidate.finishReason, toolCalls.length > 0),
    model: b.modelVersion,
  };
}

/** `streamGenerateContent?alt=sse` delivers partial candidates; merge them into one response. */
export function parseGeminiStream(
  text: string,
  onDelta: (text: string) => void,
  cache?: RawContentCache<Part[]>,
) {
  const parts: Part[] = [];
  let last: Record<string, any> = {};
  for (const { json } of sseJson(text)) {
    if (json.error) throw new Error(json.error.message ?? 'The Gemini stream reported an error');
    last = json;
    for (const p of json.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text === 'string' && !p.thought) onDelta(p.text);
      const prev = parts[parts.length - 1];
      if (
        prev &&
        typeof prev.text === 'string' &&
        typeof p.text === 'string' &&
        !prev.thought &&
        !p.thought
      ) {
        prev.text = `${prev.text}${p.text}`;
        if (p.thoughtSignature) prev.thoughtSignature = p.thoughtSignature;
      } else parts.push({ ...p });
    }
  }
  const candidate = { ...(last.candidates?.[0] ?? {}), content: { role: 'model', parts } };
  return parseGeminiResponse({ ...last, candidates: [candidate] }, cache);
}

export function geminiAdapter(config: GeminiChatConfig): ChatAdapter {
  const cache = new RawContentCache<Part[]>();
  const base = `${trimSlash(config.host)}/v1beta/models/${encodeURIComponent(geminiModelPath(config.model))}`;
  return {
    provider: 'google',
    model: config.model,
    credentialType: config.credentialType ?? 'googleGeminiApi',
    capabilities: { structuredOutput: true, structuredOutputWithTools: false },
    buildRequest: (request, stream): HttpRequestOptions => ({
      url: stream ? `${base}:streamGenerateContent` : `${base}:generateContent`,
      method: 'POST',
      ...(stream ? { qs: { alt: 'sse' } } : {}),
      body: geminiRequestBody(request, config, cache),
    }),
    parseResponse: (body) => parseGeminiResponse(body, cache),
    parseStream: (body, onDelta) => parseGeminiStream(body, onDelta, cache),
  };
}
