/**
 * Provider-neutral chat model over HTTP. A provider adapter maps `AiChatRequest` to the
 * provider's wire format and back; this class adds retries with backoff, timeouts, credential
 * handling (through `ctx.helpers.httpRequestWithAuthentication`, so the SSRF guard and credential
 * templates apply) and AI log entries (`ctx.logSubNodeRun`).
 */
import {
  type AiChatMessage,
  type AiChatModel,
  type AiChatRequest,
  type AiChatResponse,
  type DataObject,
  type HttpRequestOptions,
  type HttpResponseStream,
  NodeOperationError,
  type SupplyDataContext,
} from '@workflow/workflow';
import { withRetries } from './retry';
import { parseSse, type SseEvent, sseJson } from './sse';

export interface ChatModelCapabilities {
  /** the provider can be asked for JSON matching a schema */
  structuredOutput: boolean;
  /** ...in the same request that offers tools */
  structuredOutputWithTools: boolean;
}

export interface ChatAdapter {
  readonly provider: string;
  readonly model: string;
  readonly credentialType: string;
  readonly capabilities: ChatModelCapabilities;
  buildRequest(request: AiChatRequest, stream: boolean): HttpRequestOptions;
  parseResponse(body: unknown): AiChatResponse;
  /** start rebuilding a `stream: true` response; the parser reports text deltas as their events arrive */
  streamParser?(onDelta: (text: string) => void): ChatStreamParser;
}

/** Rebuilds a response from a provider's SSE stream, one event at a time. */
export interface ChatStreamParser {
  /** one event's JSON payload; throws on an error event */
  push(event: string, json: any): void;
  /** the response once the stream ended */
  finish(): AiChatResponse;
}

/** Run a stream parser over a complete SSE body. */
export function parseCompleteStream(parser: ChatStreamParser, body: string): AiChatResponse {
  for (const { event, json } of sseJson(body)) parser.push(event, json);
  return parser.finish();
}

export interface HttpChatModelOptions {
  itemIndex: number;
  maxRetries: number;
  timeoutMs?: number;
}

/** Thrown when a provider declines to answer (safety refusal, blocked prompt). */
export class ModelRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRefusalError';
  }
}

/**
 * A stream that failed after deltas reached the caller. It is never retried, since the retry would send
 * the same text again; the caller receives the original error.
 */
class StreamInterruptedError extends Error {
  constructor(readonly original: unknown) {
    super('The model stream failed after part of the answer was sent');
    this.name = 'StreamInterruptedError';
  }
}

/**
 * An error event inside a response stream. Providers answer 200 and report overload or server
 * trouble in the body, so the equivalent HTTP status is carried over to let the retry policy see it.
 */
export function streamError(message: string, httpCode?: number): Error {
  return Object.assign(new Error(message), httpCode ? { httpCode } : {});
}

export class HttpChatModel implements AiChatModel {
  readonly kind = 'chatModel' as const;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ChatModelCapabilities;
  readonly stream?: AiChatModel['stream'];

  constructor(
    private readonly ctx: SupplyDataContext,
    private readonly adapter: ChatAdapter,
    private readonly options: HttpChatModelOptions,
  ) {
    this.provider = adapter.provider;
    this.model = adapter.model;
    this.capabilities = adapter.capabilities;
    if (adapter.streamParser) {
      this.stream = (request, onDelta) => this.call(request, onDelta);
    }
  }

  chat(request: AiChatRequest): Promise<AiChatResponse> {
    return this.call(request);
  }

  private async call(request: AiChatRequest, onDelta?: (text: string) => void): Promise<AiChatResponse> {
    const streaming = Boolean(onDelta && this.adapter.streamParser);
    const http: HttpRequestOptions = {
      ...this.adapter.buildRequest(request, streaming),
      timeout: this.options.timeoutMs,
      ...(streaming ? { responseType: 'stream' as const } : {}),
    };
    const input = logInput(request, this.model);
    const signal = request.signal ?? this.ctx.signal;
    let emitted = false;
    const emit = (text: string) => {
      emitted = true;
      onDelta!(text);
    };
    try {
      // streams are parsed inside the retry: an error event in the body is retried like the HTTP error
      // it stands for, as long as no delta reached the caller yet
      const response = await withRetries(
        async () => {
          const body = await this.ctx.helpers.httpRequestWithAuthentication(
            this.adapter.credentialType,
            http,
            this.options.itemIndex,
          );
          if (!streaming) return this.adapter.parseResponse(body);
          try {
            return await readStreamedBody(this.adapter, body, emit, signal);
          } catch (error) {
            if (emitted) throw new StreamInterruptedError(error);
            throw error;
          }
        },
        { maxRetries: this.options.maxRetries, signal },
      );
      this.ctx.logSubNodeRun(input, logOutput(response));
      return response;
    } catch (caught) {
      const error = caught instanceof StreamInterruptedError ? caught.original : caught;
      this.ctx.logSubNodeRun(input, {}, error as Error);
      if (error instanceof ModelRefusalError) {
        throw new NodeOperationError(this.ctx.getNode(), error.message, {
          code: 'AI_REFUSAL',
          itemIndex: this.options.itemIndex,
        });
      }
      throw error;
    }
  }
}

/**
 * SSE text that arrives in pieces, cut into complete events. Linear in the bytes received: each piece
 * is normalised and searched once, and pending text is joined only when an event completes.
 */
export class SseEventBuffer {
  /** pieces of the event still being received, line breaks already normalised to LF */
  private parts: string[] = [];
  /** the pending text ends with LF, so a LF opening the next piece completes a blank line */
  private endsWithLf = false;
  /** a CR ended the last piece: it may be the first half of a CRLF that the next piece completes */
  private heldCr = false;

  /** the events `text` completes */
  push(text: string): SseEvent[] {
    let raw = this.heldCr ? `\r${text}` : text;
    this.heldCr = raw.endsWith('\r');
    if (this.heldCr) raw = raw.slice(0, -1);
    if (raw === '') return [];
    const piece = raw.replace(/\r\n?/g, '\n');
    let cut = piece.lastIndexOf('\n\n');
    if (cut >= 0) cut += 2;
    else if (this.endsWithLf && piece.startsWith('\n')) cut = 1; // the blank line straddles two pieces
    if (cut < 0) {
      this.parts.push(piece);
      this.endsWithLf = piece.endsWith('\n');
      return [];
    }
    const ready = this.parts.join('') + piece.slice(0, cut);
    const rest = piece.slice(cut);
    this.parts = rest ? [rest] : [];
    this.endsWithLf = rest.endsWith('\n');
    return parseSse(ready);
  }

  /** the last event of a body that ended without a blank line */
  end(): SseEvent[] {
    const rest = this.parts.join('') + (this.heldCr ? '\n' : '');
    this.parts = [];
    this.endsWithLf = false;
    this.heldCr = false;
    return parseSse(rest);
  }
}

async function* textOf(body: string | HttpResponseStream): AsyncGenerator<string> {
  if (typeof body === 'string') {
    yield body;
    return;
  }
  const decoder = new TextDecoder();
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  yield decoder.decode();
}

function isResponseStream(body: unknown): body is HttpResponseStream {
  return typeof (body as Partial<HttpResponseStream> | null)?.[Symbol.asyncIterator] === 'function';
}

/** an event stream starts with an SSE field or comment; anything else is a plain JSON answer */
const SSE_START = /^(data|event|id|retry)?:/;

/**
 * Read a streamed response, feeding SSE events to the adapter's parser as they arrive, so deltas reach
 * the caller while the model is still answering. A body an HTTP client already read (a string, or a
 * parsed object) takes the same path. Gateways and compatible servers sometimes ignore `stream: true`
 * and answer with plain JSON; that is parsed whole and reported as one delta.
 */
async function readStreamedBody(
  adapter: ChatAdapter,
  body: unknown,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AiChatResponse> {
  if (typeof body !== 'string' && !isResponseStream(body)) return wholeResponse(adapter, body, onDelta);
  const parser = adapter.streamParser!(onDelta);
  const events = new SseEventBuffer();
  const feed = (list: SseEvent[]) => {
    for (const e of list) {
      if (e.data === '[DONE]') continue;
      let json: unknown;
      try {
        json = JSON.parse(e.data);
      } catch {
        continue;
      }
      parser.push(e.event, json);
    }
  };
  // text read before the first characters tell an event stream from a JSON answer
  let head = '';
  let sse: boolean | undefined;
  for await (const text of textOf(body)) {
    signal?.throwIfAborted();
    if (sse === undefined) {
      head += text;
      const start = head.trimStart();
      if (start.length < 6) continue;
      sse = SSE_START.test(start);
      if (sse) feed(events.push(head));
    } else if (sse) feed(events.push(text));
    else head += text;
  }
  if (sse === undefined) {
    sse = SSE_START.test(head.trimStart());
    if (sse) feed(events.push(head));
  }
  if (!sse) return wholeResponse(adapter, JSON.parse(head), onDelta);
  feed(events.end());
  return parser.finish();
}

function wholeResponse(adapter: ChatAdapter, body: unknown, onDelta: (text: string) => void): AiChatResponse {
  const response = adapter.parseResponse(body);
  const content = response.message.content;
  const full = typeof content === 'string' ? content : '';
  if (full) onDelta(full);
  return response;
}

/** Model capabilities; objects not created by this package are assumed to support nothing extra. */
export function capabilitiesOf(model: AiChatModel): ChatModelCapabilities {
  const caps = (model as Partial<{ capabilities: ChatModelCapabilities }>).capabilities;
  return caps ?? { structuredOutput: false, structuredOutputWithTools: false };
}

function summarizeMessage(message: AiChatMessage): DataObject {
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((p) => (p.type === 'text' ? p.text : `[image ${p.mimeType}]`)).join('\n');
  return {
    role: message.role,
    content,
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

function logInput(request: AiChatRequest, model: string): DataObject {
  return {
    model,
    messages: request.messages.map(summarizeMessage),
    ...(request.tools?.length ? { tools: request.tools.map((t) => t.name) } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat.type } : {}),
  };
}

function logOutput(response: AiChatResponse): DataObject {
  return {
    response: summarizeMessage(response.message),
    ...(response.usage ? { tokenUsage: { ...response.usage } } : {}),
    ...(response.stopReason ? { stopReason: response.stopReason } : {}),
    ...(response.model ? { model: response.model } : {}),
  };
}

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Common model options (temperature, max tokens, ...) from a node's `options` collection. */
export interface CommonModelOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries: number;
}

export function readCommonOptions(options: DataObject): CommonModelOptions {
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    temperature: num(options.temperature),
    topP: num(options.topP),
    maxTokens: num(options.maxTokens),
    timeoutMs: num(options.timeout),
    maxRetries: num(options.maxRetries) ?? 2,
  };
}
