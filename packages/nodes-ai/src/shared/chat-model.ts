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
  NodeOperationError,
  type SupplyDataContext,
} from '@workflow/workflow';
import { withRetries } from './retry';

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
  /** parse a complete SSE body, reporting text deltas in order */
  parseStream?(body: string, onDelta: (text: string) => void): AiChatResponse;
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
    if (adapter.parseStream) {
      this.stream = (request, onDelta) => this.call(request, onDelta);
    }
  }

  chat(request: AiChatRequest): Promise<AiChatResponse> {
    return this.call(request);
  }

  private async call(request: AiChatRequest, onDelta?: (text: string) => void): Promise<AiChatResponse> {
    const streaming = Boolean(onDelta && this.adapter.parseStream);
    const http: HttpRequestOptions = {
      ...this.adapter.buildRequest(request, streaming),
      timeout: this.options.timeoutMs,
      ...(streaming ? { responseType: 'text' as const } : {}),
    };
    const input = logInput(request, this.model);
    try {
      const body = await withRetries(
        () =>
          this.ctx.helpers.httpRequestWithAuthentication(
            this.adapter.credentialType,
            http,
            this.options.itemIndex,
          ),
        { maxRetries: this.options.maxRetries, signal: request.signal ?? this.ctx.signal },
      );
      const response = streaming
        ? parseStreamedBody(this.adapter, body, onDelta!)
        : this.adapter.parseResponse(body);
      this.ctx.logSubNodeRun(input, logOutput(response));
      return response;
    } catch (error) {
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
 * Gateways and compatible servers sometimes ignore `stream: true` and answer with plain JSON;
 * treat that as one complete delta instead of failing.
 */
function parseStreamedBody(
  adapter: ChatAdapter,
  body: unknown,
  onDelta: (text: string) => void,
): AiChatResponse {
  if (typeof body === 'string' && /^(event|data):/m.test(body)) return adapter.parseStream!(body, onDelta);
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  const response = adapter.parseResponse(parsed);
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
