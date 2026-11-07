import { ERROR_MESSAGES } from './i18n';
import type { ChatMessage, ChatOptions, ChatRequestOverride } from './index';

/** The one place a request leaves the widget: `credentials: 'omit'` is always set, whatever `fetch` is used. */
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const NDJSON_ACCEPT = 'application/x-ndjson';

/** An error whose text is safe to show to the person chatting. */
export class ChatRequestError extends Error {}

export interface ApiConfig {
  webhookUrl: string;
  webhookConfig?: ChatOptions['webhookConfig'];
  chatInputKey: string;
  chatSessionKey: string;
  fetch?: typeof fetch;
}

export interface SendArgs {
  sessionId: string;
  message: string;
  files?: File[];
  metadata?: Record<string, unknown>;
  /** where to post instead of the webhook (the stored `resumeUrl` of a `wait` frame) */
  url?: string;
  override?: ChatRequestOverride;
}

export type ParsedReply = { kind: 'text'; text: string } | { kind: 'html' };

/** `new URL(webhookUrl, location.href).origin`; undefined when the URL is not http(s). */
export function originOf(url: string): string | undefined {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const parsed = new URL(url, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** True only when `url` is http(s) and has the webhook's origin. Used for buttons, `wait` and request overrides. */
export function hasWebhookOrigin(url: string, webhookUrl: string): boolean {
  const expected = originOf(webhookUrl);
  return expected !== undefined && originOf(url) === expected;
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes('text/html')) return true;
  return /^\s*<(!doctype html|html[\s>])/i.test(text);
}

/** Text of a reply: `output`, `text` or `message` of a JSON object, else the JSON text, else the body as is. */
export function parseReply(body: string, contentType: string): ParsedReply {
  if (looksLikeHtml(body, contentType)) return { kind: 'html' };
  const trimmed = body.trim();
  if (trimmed === '') return { kind: 'text', text: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'text', text: body };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['output', 'text', 'message']) {
      const value = record[key];
      if (typeof value === 'string') return { kind: 'text', text: value };
    }
  }
  return { kind: 'text', text: trimmed };
}

/** The shown text of a non-2xx reply: the JSON `message`, else a generic line with the status. */
export function errorTextOf(status: number, body: string, contentType: string): string {
  if (looksLikeHtml(body, contentType)) return ERROR_MESSAGES.htmlReply;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const message = (parsed as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    // not JSON
  }
  return `${ERROR_MESSAGES.failed} (${status})`;
}

function mapHistory(payload: unknown): ChatMessage[] {
  const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const messages: ChatMessage[] = [];
  data.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const { id, kwargs } = entry as { id?: unknown; kwargs?: { content?: unknown } };
    const kind = Array.isArray(id) ? String(id[id.length - 1]) : '';
    const content = kwargs?.content;
    if (typeof content !== 'string') return;
    if (kind === 'HumanMessage') messages.push({ id: `history-${index}`, sender: 'user', text: content });
    else if (kind === 'AIMessage') messages.push({ id: `history-${index}`, sender: 'bot', text: content });
  });
  return messages;
}

export interface ChatApi {
  /** Every request goes through here. */
  request(url: string, init?: RequestInit): Promise<Response>;
  send(args: SendArgs): Promise<Response>;
  get(url: string): Promise<Response>;
  loadPrevious(sessionId: string): Promise<ChatMessage[]>;
}

export function createApi(config: ApiConfig): ChatApi {
  const doFetch: FetchFn = config.fetch
    ? (input, init) => (config.fetch as typeof fetch)(input, init)
    : (input, init) => globalThis.fetch(input, init);

  function baseHeaders(override?: ChatRequestOverride): Record<string, string> {
    return { ...(config.webhookConfig?.headers ?? {}), ...(override?.headers ?? {}) };
  }

  function request(url: string, init: RequestInit = {}): Promise<Response> {
    return doFetch(url, { ...init, credentials: 'omit' });
  }

  async function send(args: SendArgs): Promise<Response> {
    const method = config.webhookConfig?.method === 'GET' ? 'GET' : 'POST';
    // a hook may redirect a request only to the webhook's origin: the headers carry the page and auth tokens
    const hookUrl =
      args.override?.url && hasWebhookOrigin(args.override.url, config.webhookUrl)
        ? args.override.url
        : undefined;
    const target = args.url ?? hookUrl ?? config.webhookUrl;
    const fields: Record<string, string> = {
      action: 'sendMessage',
      [config.chatSessionKey]: args.sessionId,
      [config.chatInputKey]: args.message,
    };
    const metadata = args.metadata && Object.keys(args.metadata).length > 0 ? args.metadata : undefined;

    if (method === 'GET') {
      const url = new URL(target, typeof location !== 'undefined' ? location.href : undefined);
      for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
      if (metadata) url.searchParams.set('metadata', JSON.stringify(metadata));
      return request(url.toString(), { method, headers: baseHeaders(args.override) });
    }

    if (args.files && args.files.length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      if (metadata) form.append('metadata', JSON.stringify(metadata));
      for (const file of args.files) form.append('files', file);
      // the browser sets the multipart content type with its boundary
      return request(target, { method, headers: baseHeaders(args.override), body: form });
    }

    const body: Record<string, unknown> = { ...fields };
    if (metadata) body.metadata = metadata;
    return request(target, {
      method,
      headers: { 'Content-Type': 'application/json', ...baseHeaders(args.override) },
      body: JSON.stringify(body),
    });
  }

  function get(url: string): Promise<Response> {
    return request(url, { method: 'GET', headers: { Accept: NDJSON_ACCEPT, ...baseHeaders() } });
  }

  async function loadPrevious(sessionId: string): Promise<ChatMessage[]> {
    try {
      const response = await request(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...baseHeaders() },
        body: JSON.stringify({ action: 'loadPreviousSession', [config.chatSessionKey]: sessionId }),
      });
      if (!response.ok) return [];
      return mapHistory(await response.json());
    } catch {
      return [];
    }
  }

  return { request, send, get, loadPrevious };
}
