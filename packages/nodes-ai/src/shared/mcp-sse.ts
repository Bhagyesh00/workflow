/**
 * The deprecated MCP HTTP+SSE transport, over the guarded node HTTP helper. One GET opens a
 * Server-Sent Events stream (`responseType: 'stream'`, `streamNoTotalTimeout`); the first `endpoint`
 * event names the URL requests are POSTed to, and every JSON-RPC answer comes back on the stream, matched
 * by id. The POST URL must have the same origin as the stream URL, else the connection is refused: a
 * server must not steer our requests (and their credentials) to another host.
 */
import type { HttpFullResponse, HttpRequestOptions, HttpResponseStream } from '@workflow/workflow';
import { McpError, type McpTransport } from './mcp-client';
import { parseSse } from './sse';
import { truncate } from './utils';

type Request = <T>(options: HttpRequestOptions) => Promise<T | HttpFullResponse<T>>;

export interface SseTransportOptions {
  request: Request;
  /** the stream URL (the configured endpoint) */
  endpoint: string;
  /** authentication headers; the stream request carries them too */
  headers: Record<string, string>;
  timeoutMs: number;
  /** hosts the credential may be sent to (the redirect rule of `HttpClient`) */
  allowedDomains?: string[];
}

export interface SseTransport {
  transport: McpTransport;
  /** stops reading and fails what still waits */
  close(): Promise<void>;
}

interface Waiter {
  resolve(message: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** `/messages?id=1` or a full URL, resolved against the stream URL; undefined when it is on another origin */
export function resolveSseEndpoint(data: string, endpoint: string): string | undefined {
  try {
    const base = new URL(endpoint);
    const target = new URL(data.trim(), base);
    return target.origin === base.origin ? target.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function createSseTransport(options: SseTransportOptions): SseTransport {
  const { request, endpoint, timeoutMs, allowedDomains } = options;
  const waiters = new Map<string | number, Waiter>();
  let postUrl: string | undefined;
  let opening: Promise<string> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let closed = false;
  let streamError: Error | undefined;

  const withDomains = (o: HttpRequestOptions): HttpRequestOptions =>
    allowedDomains === undefined ? o : { ...o, allowedDomains };

  function failAll(error: Error): void {
    streamError = error;
    for (const [id, w] of waiters) {
      clearTimeout(w.timer);
      w.reject(error);
      waiters.delete(id);
    }
  }

  function onMessage(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    for (const m of Array.isArray(json) ? json : [json]) {
      const message = m as { id?: string | number; result?: unknown; error?: unknown } | null;
      if (!message || typeof message !== 'object' || message.id === undefined || message.id === null)
        continue;
      if (!('result' in message) && !('error' in message)) continue;
      const waiter = waiters.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiters.delete(message.id);
      waiter.resolve(message);
    }
  }

  function open(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new McpError('The MCP server did not send an endpoint event'));
        void stop();
      }, timeoutMs);
      timer.unref();
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      void (async () => {
        let response: HttpFullResponse<HttpResponseStream>;
        try {
          response = (await request<HttpResponseStream>(
            withDomains({
              url: endpoint,
              method: 'GET',
              headers: { ...options.headers, accept: 'text/event-stream' },
              responseType: 'stream',
              streamNoTotalTimeout: true,
              returnFullResponse: true,
              ignoreHttpStatusErrors: true,
              timeout: timeoutMs,
            }),
          )) as HttpFullResponse<HttpResponseStream>;
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const body = response.body as HttpResponseStream | undefined;
        if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
          fail(
            new McpError(
              'The MCP server did not answer with an event stream',
              undefined,
              response.statusCode,
            ),
          );
          return;
        }
        iterator = body[Symbol.asyncIterator]();
        if (response.statusCode >= 400) {
          void iterator.return?.();
          fail(
            new McpError(
              `MCP server answered the event stream with HTTP ${response.statusCode}`,
              undefined,
              response.statusCode,
            ),
          );
          return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let gotEndpoint = false;
        try {
          for (;;) {
            const { done, value } = await iterator.next();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // whole events only: they end with a blank line
            const cut = Math.max(buffer.lastIndexOf('\n\n'), buffer.lastIndexOf('\r\n\r\n'));
            if (cut < 0) continue;
            const complete = buffer.slice(0, cut + 2);
            buffer = buffer.slice(cut + 2);
            for (const event of parseSse(complete)) {
              if (event.event === 'endpoint' && !gotEndpoint) {
                const url = resolveSseEndpoint(event.data, endpoint);
                if (!url) {
                  fail(new McpError('The MCP server named a message endpoint on another origin; refused'));
                  await stop();
                  return;
                }
                gotEndpoint = true;
                postUrl = url;
                clearTimeout(timer);
                resolve(url);
              } else if (event.event === 'message') {
                onMessage(event.data);
              }
            }
          }
          if (!gotEndpoint) fail(new McpError('The MCP server closed the stream before sending an endpoint'));
          failAll(new McpError('The MCP event stream ended'));
        } catch (error) {
          const e = error instanceof Error ? error : new Error(String(error));
          if (!gotEndpoint) fail(e);
          failAll(e);
        }
      })();
    });
  }

  async function stop(): Promise<void> {
    closed = true;
    failAll(new McpError('The MCP event stream was closed'));
    // a read that waits for the next chunk ends when the server sends or closes; the cancel is queued behind it
    void iterator?.return?.().catch(() => undefined);
  }

  const synthetic = (body: unknown): HttpFullResponse<string> => ({
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    statusCode: 200,
    statusMessage: 'OK',
  });

  const transport: McpTransport = async (req) => {
    if (req.method === 'DELETE')
      return { body: '', headers: {}, statusCode: 204, statusMessage: 'No Content' };
    if (closed) throw new McpError('The MCP event stream was closed');
    if (streamError) throw streamError;
    opening ??= open();
    let url: string;
    try {
      url = postUrl ?? (await opening);
    } catch (error) {
      opening = undefined;
      throw error;
    }
    const message = typeof req.body === 'string' ? (JSON.parse(req.body) as { id?: string | number }) : {};
    const id = message.id;
    let answer: Promise<unknown> | undefined;
    if (id !== undefined) {
      answer = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new McpError(`MCP server sent no response to request ${id}`));
        }, req.timeout ?? timeoutMs);
        timer.unref();
        waiters.set(id, { resolve, reject, timer });
      });
      // the wait is only read below; a failure before that must not be an unhandled rejection
      answer.catch(() => undefined);
    }
    let post: HttpFullResponse<string>;
    try {
      post = (await request<string>(
        withDomains({ ...req, url, headers: { ...options.headers, ...req.headers } }),
      )) as HttpFullResponse<string>;
    } catch (error) {
      if (id !== undefined) {
        const w = waiters.get(id);
        if (w) clearTimeout(w.timer);
        waiters.delete(id);
      }
      throw error;
    }
    if (post.statusCode >= 400 || answer === undefined) {
      if (id !== undefined) {
        const w = waiters.get(id);
        if (w) clearTimeout(w.timer);
        waiters.delete(id);
      }
      return post;
    }
    // a server may also answer the POST itself with the JSON-RPC message
    if (typeof post.body === 'string' && post.body.trim().startsWith('{')) {
      try {
        const direct = JSON.parse(post.body) as { id?: unknown };
        if (direct.id === id) {
          const w = waiters.get(id as string | number);
          if (w) clearTimeout(w.timer);
          waiters.delete(id as string | number);
          return synthetic(direct);
        }
      } catch {
        throw new McpError(`MCP server returned invalid JSON: ${truncate(post.body, 200)}`);
      }
    }
    return synthetic(await answer);
  };

  return { transport, close: stop };
}
