/**
 * SSE Trigger: starts a run on each server-sent event from a URL. The stream is read through the guarded
 * ctx.helpers.httpRequest (SSRF policy, redirects, TLS) with `streamNoTotalTimeout`, so the request timeout
 * covers only the wait for the response headers and a quiet stream stays open. The events are read by our own
 * parser (utils/sse-parser.ts), which caps one event. A dropped connection, a stream that ends and a 5xx answer
 * reconnect with `Last-Event-ID`; any other status, a blocked address or a stream that is not an event stream
 * goes to emitError and the trigger stops.
 */
import type { DataObject, NodeType, TriggerContext, TriggerResponse } from '@workflow/workflow';
import { SseEventTooLargeError, SseParser } from '../../utils/sse-parser';

const MANUAL_WAIT_MS = 60_000;

/** reconnect delays when the stream sets no `retry`, and the wait for the response headers */
export const sseRetry = { baseMs: 1000, maxMs: 30_000, requestTimeoutMs: 30_000 };

/** the longest pause between two connections, whatever the stream asks for */
const MAX_SERVER_RETRY_MS = 60_000;

interface ParsedUrl {
  url: string;
  auth?: { username: string; password: string };
}

/** user:password in the URL becomes Basic auth and leaves the URL */
function parseUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('URL is not a valid address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }
  if (!url.username && !url.password) return { url: url.toString() };
  const auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  url.username = '';
  url.password = '';
  return { url: url.toString(), auth };
}

/** an error that ends the trigger instead of reconnecting */
class Fatal extends Error {}

function classify(error: unknown): Fatal | undefined {
  const e = error as { httpCode?: string; cause?: { name?: string }; message?: string } | undefined;
  if (error instanceof SseEventTooLargeError) return new Fatal(error.message);
  if (e?.cause?.name === 'SsrfBlockedError') return new Fatal(e.message ?? 'The address is blocked');
  if (e?.httpCode) {
    const status = Number(e.httpCode);
    if (status >= 500 && status <= 599) return undefined;
    return new Fatal(`The server answered with status ${status}`);
  }
  return undefined;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

export const SseTriggerNode: NodeType = {
  description: {
    name: 'core.sseTrigger',
    displayName: 'SSE Trigger',
    description: 'Starts a run on each server-sent event from a URL',
    icon: 'lucide:radio',
    iconColor: '#225577',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'SSE Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Triggers'],
    eventTriggerDescription: 'Waiting for a server-sent event',
    properties: [
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://example.com/events',
        description:
          'The address of the event stream. A user name and password in the address are sent as Basic authentication',
      },
    ],
  },

  async trigger(ctx: TriggerContext): Promise<TriggerResponse | undefined> {
    const manual = ctx.getActivationMode() === 'manual';
    const target = parseUrl(String(ctx.getNodeParameter('url', 0, '')));

    // closing ends the loop at once; the host's signal also ends it (and the open connection)
    const stop = new AbortController();
    const ended = AbortSignal.any([stop.signal, ctx.signal]);

    let deliver: ((json: DataObject) => void) | undefined;
    let first: DataObject | undefined;

    const onEvent = (json: DataObject): void => {
      if (manual) {
        if (deliver) deliver(json);
        else first ??= json;
        return;
      }
      ctx.emit([[{ json }]]);
    };

    const handle = (data: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        ctx.logger.warn('A server-sent event was skipped: its data is not JSON');
        return;
      }
      const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
      onEvent((isObject ? value : { data: value }) as DataObject);
    };

    const loop = async (): Promise<void> => {
      let lastEventId = '';
      let delay = sseRetry.baseMs;
      while (!ended.aborted) {
        const parser = new SseParser({ lastEventId });
        try {
          const headers: Record<string, string> = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
          if (lastEventId) headers['last-event-id'] = lastEventId;
          const full = (await ctx.helpers.httpRequest({
            url: target.url,
            method: 'GET',
            headers,
            auth: target.auth,
            responseType: 'stream',
            streamNoTotalTimeout: true,
            timeout: sseRetry.requestTimeoutMs,
            returnFullResponse: true,
          })) as unknown as {
            body: AsyncIterable<Uint8Array>;
            headers: Record<string, string>;
            statusCode: number;
          };
          if (full.statusCode === 204) throw new Fatal('The server ended the event stream (status 204)');
          const type = String(full.headers['content-type'] ?? '').toLowerCase();
          if (!type.startsWith('text/event-stream')) {
            throw new Fatal('The URL did not answer with an event stream (content type text/event-stream)');
          }
          delay = sseRetry.baseMs;
          for await (const chunk of full.body) {
            if (ended.aborted) return;
            for (const event of parser.feed(chunk)) handle(event.data);
            lastEventId = parser.lastEventId;
          }
        } catch (error) {
          if (ended.aborted) return;
          const fatal = error instanceof Fatal ? error : classify(error);
          if (fatal) {
            ctx.emitError(fatal);
            return;
          }
        }
        lastEventId = parser.lastEventId || lastEventId;
        if (ended.aborted) return;
        const wait = parser.retryMs !== undefined ? Math.min(parser.retryMs, MAX_SERVER_RETRY_MS) : delay;
        await sleep(wait, ended);
        delay = Math.min(sseRetry.maxMs, delay * 2);
      }
    };

    void loop().catch((error: unknown) => {
      if (!ended.aborted) ctx.emitError(error instanceof Error ? error : new Error(String(error)));
    });

    // the loop ends at its next step; the open connection ends with the host's signal
    const closeFunction = async (): Promise<void> => {
      stop.abort();
      deliver = undefined;
    };

    if (!manual) return { closeFunction };

    // a test run: the first event starts the run, a quiet minute ends the wait
    const manualTriggerFunction = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          deliver = undefined;
          void closeFunction().finally(() =>
            reject(new Error('No event arrived within 60 seconds, the test was stopped')),
          );
        }, MANUAL_WAIT_MS);
        const finish = (json: DataObject): void => {
          clearTimeout(timer);
          deliver = undefined;
          ctx.emit([[{ json }]]);
          resolve();
        };
        if (first) finish(first);
        else deliver = finish;
      });
    return { closeFunction, manualTriggerFunction };
  },
};
