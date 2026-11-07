/**
 * AWS Bedrock Converse API (`POST /model/<id>/converse` and `/converse-stream`).
 *
 * - System messages go in `system`. Roles are `user` and `assistant` and must take turns, so tool results
 *   and any user text that follows them share one user message.
 * - The model id is URL-encoded once here. SigV4 encodes the path a second time inside its signature only.
 * - The body is a string before the credential signs it, so the signature covers the exact bytes sent.
 * - Assistant turns produced in this run are replayed with their original blocks, as the API requires for
 *   reasoning blocks and their signatures inside a tool loop.
 * - There is no structured output: the agent falls back to prompt instructions.
 * - Streaming uses binary event-stream frames, not SSE (`shared/event-stream.ts`).
 */
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiContentPart,
  AiToolCall,
  DataObject,
} from '@workflow/workflow';
import { bedrockRuntimeBase } from '../shared/aws';
import {
  type ChatAdapter,
  type ChatStreamParser,
  ModelRefusalError,
  streamError,
} from '../shared/chat-model';
import { isToolError, RawContentCache } from '../shared/markers';
import { messageText } from '../shared/utils';

export type BedrockGuardrailTrace = 'disabled' | 'enabled' | 'enabled_full';

export interface BedrockGuardrail {
  identifier: string;
  version: string;
  trace?: BedrockGuardrailTrace;
}

export interface BedrockChatConfig {
  region: string;
  /** a model id, inference profile id or ARN */
  model: string;
  credentialType?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** the Bedrock Runtime endpoint of the credential; the credential refuses a host that is not AWS */
  endpoint?: string;
  additionalModelRequestFields?: DataObject;
  latency?: 'standard' | 'optimized';
  guardrail?: BedrockGuardrail;
}

type Block = Record<string, any>;

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

const IMAGE_FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const DOCUMENT_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/** what an exception in the stream stands for, so the retry policy treats it like the HTTP error */
const EXCEPTION_STATUS: Record<string, number> = {
  throttlingException: 429,
  modelTimeoutException: 408,
  internalServerException: 500,
  serviceUnavailableException: 503,
  validationException: 400,
  modelStreamErrorException: 424,
};

const mimeOf = (mimeType: string) => mimeType.split(';')[0].trim().toLowerCase();

/** Bedrock takes letters, digits, single spaces, hyphens, parentheses and square brackets in a name */
function documentName(fileName: string | undefined): string {
  const name = (fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\s\-()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return name || 'document';
}

function imageBlock(data: string, mimeType: string): Block {
  const format = IMAGE_FORMATS[mimeOf(mimeType)];
  if (!format) throw new Error('Bedrock cannot read this image type');
  return { image: { format, source: { bytes: data } } };
}

function partBlock(part: AiContentPart): Block {
  if (part.type === 'text') return { text: part.text };
  if (part.type === 'image') return imageBlock(part.data, part.mimeType);
  if (IMAGE_FORMATS[mimeOf(part.mimeType)]) return imageBlock(part.data, part.mimeType);
  const format = DOCUMENT_FORMATS[mimeOf(part.mimeType)];
  if (!format) throw new Error('Bedrock cannot read this file type');
  return { document: { format, name: documentName(part.fileName), source: { bytes: part.data } } };
}

export function toConverseMessages(
  messages: AiChatMessage[],
  cache?: RawContentCache<Block[]>,
): { system: Block[]; messages: ConverseMessage[] } {
  const system: Block[] = [];
  const out: ConverseMessage[] = [];
  const push = (role: ConverseMessage['role'], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      const text = messageText(m.content);
      if (text) system.push({ text });
    } else if (m.role === 'user') {
      const blocks =
        typeof m.content === 'string' ? [{ text: m.content } as Block] : m.content.map(partBlock);
      // Bedrock refuses a blank text block
      push(
        'user',
        blocks.filter((b) => b.text === undefined || String(b.text).length > 0),
      );
    } else if (m.role === 'assistant') {
      const raw = cache?.recall(m);
      if (raw) {
        push('assistant', raw);
        continue;
      }
      const blocks: Block[] = [];
      const text = messageText(m.content);
      if (text) blocks.push({ text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments ?? {} } });
      }
      push('assistant', blocks);
    } else {
      push('user', [
        {
          toolResult: {
            toolUseId: m.toolCallId ?? '',
            content: [{ text: messageText(m.content) || '(empty result)' }],
            ...(isToolError(m) ? { status: 'error' } : {}),
          },
        },
      ]);
    }
  }
  return { system, messages: out };
}

export function bedrockRequestBody(
  request: AiChatRequest,
  config: BedrockChatConfig,
  cache?: RawContentCache<Block[]>,
): DataObject {
  const { system, messages } = toConverseMessages(request.messages, cache);
  const body: Record<string, unknown> = { messages };
  if (system.length) body.system = system;

  const inference: DataObject = {};
  const maxTokens = request.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) inference.maxTokens = maxTokens;
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) inference.temperature = temperature;
  if (config.topP !== undefined) inference.topP = config.topP;
  if (Object.keys(inference).length) body.inferenceConfig = inference;

  if (request.tools?.length) {
    body.toolConfig = {
      tools: request.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          // the API refuses an empty description
          ...(t.description ? { description: t.description } : {}),
          inputSchema: { json: { type: 'object', ...t.parameters } },
        },
      })),
      ...(request.toolChoice === 'any' ? { toolChoice: { any: {} } } : {}),
    };
  }
  if (config.additionalModelRequestFields) {
    body.additionalModelRequestFields = config.additionalModelRequestFields;
  }
  if (config.latency) body.performanceConfig = { latency: config.latency };
  if (config.guardrail) {
    body.guardrailConfig = {
      guardrailIdentifier: config.guardrail.identifier,
      guardrailVersion: config.guardrail.version,
      ...(config.guardrail.trace ? { trace: config.guardrail.trace } : {}),
    };
  }
  return body as DataObject;
}

function mapStopReason(reason: unknown): AiChatResponse['stopReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'other';
}

function usageOf(usage: any): AiChatResponse['usage'] {
  if (!usage) return undefined;
  return { inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) };
}

/** the answer from its content blocks; a guardrail's own message counts as the text of the answer */
function toResponse(
  content: Block[],
  stopReason: unknown,
  usage: unknown,
  cache?: RawContentCache<Block[]>,
): AiChatResponse {
  const text = content
    .filter((c) => typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
  const toolCalls: AiToolCall[] = content
    .filter((c) => c.toolUse)
    .map((c) => ({
      id: String(c.toolUse.toolUseId),
      name: String(c.toolUse.name ?? ''),
      arguments: (c.toolUse.input ?? {}) as DataObject,
    }));
  if (
    !text &&
    !toolCalls.length &&
    (stopReason === 'content_filtered' || stopReason === 'guardrail_intervened')
  ) {
    throw new ModelRefusalError('The model provider blocked the response (content filter)');
  }
  const message: AiChatMessage = {
    role: 'assistant',
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  if (content.length) cache?.remember(message, content);
  return { message, usage: usageOf(usage), stopReason: mapStopReason(stopReason) };
}

export function parseBedrockResponse(body: unknown, cache?: RawContentCache<Block[]>): AiChatResponse {
  const b = (body ?? {}) as Record<string, any>;
  const message = b.output?.message;
  if (!message || typeof message !== 'object') {
    throw new Error(typeof b.message === 'string' ? b.message : 'The Bedrock API returned no message');
  }
  const content: Block[] = Array.isArray(message.content) ? message.content : [];
  return toResponse(content, b.stopReason, b.usage, cache);
}

function parseArguments(raw: string): DataObject {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DataObject)
      : { _rawArguments: raw };
  } catch {
    return { _rawArguments: raw };
  }
}

/** one content block as its deltas arrive */
interface StreamBlock {
  text?: string;
  tool?: { id: string; name: string; input: string };
  reasoning?: { text: string; signature: string };
  redacted?: string;
}

function finishedBlocks(blocks: Map<number, StreamBlock>): Block[] {
  const out: Block[] = [];
  for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (block.tool) {
      const { id, name, input } = block.tool;
      out.push({ toolUse: { toolUseId: id, name, input: parseArguments(input) } });
    } else if (block.reasoning) {
      const { text, signature } = block.reasoning;
      out.push({ reasoningContent: { reasoningText: { text, ...(signature ? { signature } : {}) } } });
    } else if (block.redacted !== undefined) {
      out.push({ reasoningContent: { redactedContent: block.redacted } });
    } else if (block.text) {
      out.push({ text: block.text });
    }
  }
  return out;
}

export function bedrockStreamParser(
  onDelta: (text: string) => void,
  cache?: RawContentCache<Block[]>,
): ChatStreamParser {
  const blocks = new Map<number, StreamBlock>();
  let stopReason: unknown;
  let stopped = false;
  let usage: unknown;
  const blockAt = (index: unknown): StreamBlock => {
    const at = Number(index ?? 0);
    let block = blocks.get(at);
    if (!block) {
      block = {};
      blocks.set(at, block);
    }
    return block;
  };
  return {
    push(event, json) {
      switch (event) {
        case 'contentBlockStart': {
          const tool = json.start?.toolUse;
          if (tool) {
            blockAt(json.contentBlockIndex).tool = {
              id: String(tool.toolUseId ?? ''),
              name: String(tool.name ?? ''),
              input: '',
            };
          }
          break;
        }
        case 'contentBlockDelta': {
          const block = blockAt(json.contentBlockIndex);
          const delta = json.delta ?? {};
          if (typeof delta.text === 'string') {
            block.text = (block.text ?? '') + delta.text;
            if (delta.text) onDelta(delta.text);
          }
          if (block.tool && typeof delta.toolUse?.input === 'string') block.tool.input += delta.toolUse.input;
          const reasoning = delta.reasoningContent;
          if (reasoning) {
            if (typeof reasoning.redactedContent === 'string') block.redacted = reasoning.redactedContent;
            else {
              block.reasoning ??= { text: '', signature: '' };
              if (typeof reasoning.text === 'string') block.reasoning.text += reasoning.text;
              if (typeof reasoning.signature === 'string') block.reasoning.signature += reasoning.signature;
            }
          }
          break;
        }
        case 'messageStop':
          stopped = true;
          stopReason = json.stopReason;
          break;
        case 'metadata':
          usage = json.usage;
          break;
        default:
          if (event === 'error' || event.endsWith('Exception')) {
            throw streamError(
              String(json.message || 'The Bedrock stream reported an error'),
              event === 'error' ? 500 : (EXCEPTION_STATUS[event] ?? 500),
            );
          }
          break;
      }
    },
    finish() {
      if (!stopped) throw new Error('The Bedrock stream ended before the reply was complete');
      return toResponse(finishedBlocks(blocks), stopReason, usage, cache);
    },
  };
}

export function bedrockAdapter(config: BedrockChatConfig): ChatAdapter {
  const cache = new RawContentCache<Block[]>();
  const model = encodeURIComponent(config.model);
  return {
    provider: 'bedrock',
    model: config.model,
    credentialType: config.credentialType ?? 'aws',
    capabilities: { structuredOutput: false, structuredOutputWithTools: false },
    eventStream: true,
    buildRequest: (request, stream) => ({
      url: `${bedrockRuntimeBase(config)}/model/${model}/${stream ? 'converse-stream' : 'converse'}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'application/vnd.amazon.eventstream' : 'application/json',
      },
      body: JSON.stringify(bedrockRequestBody(request, config, cache)),
      bodyType: 'raw',
    }),
    parseResponse: (body) => parseBedrockResponse(body, cache),
    streamParser: (onDelta) => bedrockStreamParser(onDelta, cache),
  };
}
