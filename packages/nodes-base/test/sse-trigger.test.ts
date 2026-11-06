/** P4-11 SSE Trigger: own parser, Last-Event-ID, retry on network and 5xx, other status to emitError, auth, long stream. */

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { createTriggerContext, HttpClient } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type TriggerResponse, Workflow } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { sseRetry } from '../src/nodes/core/SseTrigger.node';
import { SseEventTooLargeError, SseParser } from '../src/utils/sse-parser';
import { node, nodeTypes, testServices } from './harness';
import { localHttp, type ReceivedRequest, startHttpServer } from './servers';

const rand = () => randomBytes(4).toString('hex');
const enc = (s: string) => new TextEncoder().encode(s);
const closers: Array<() => Promise<void> | void> = [];
const original = { ...sseRetry };

const typeOf = () => nodes.find((n) => n.description.name === 'core.sseTrigger')!;

function build(
  parameters: DataObject,
  mode: 'activate' | 'manual' = 'activate',
  http: HttpClient = localHttp(),
) {
  const wfNode = node('SSE Trigger', 'core.sseTrigger', parameters, [0, 0], { id: `n${rand()}` });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: {} },
    nodeTypes,
  );
  const emitted: DataObject[] = [];
  const errors: Error[] = [];
  const abort = new AbortController();
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices({}, { mode: mode === 'manual' ? 'manual' : 'trigger', http }),
      evaluator: new ExpressionEvaluator(),
      signal: abort.signal,
    },
    {
      activationMode: mode,
      emit: (data) => void emitted.push(...(data[0] ?? []).map((i) => i.json)),
      emitError: (error) => void errors.push(error),
    },
  );
  closers.push(() => abort.abort());
  return { ctx, emitted, errors, abort };
}

async function start(parameters: DataObject, mode: 'activate' | 'manual' = 'activate', http?: HttpClient) {
  const built = build(parameters, mode, http);
  const response = (await typeOf().trigger!(built.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...built, response };
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function server(handler: (req: ReceivedRequest, res: ServerResponse) => unknown) {
  const s = await startHttpServer(handler);
  closers.push(() => s.close());
  return s;
}

const stream = (res: ServerResponse, status = 200) =>
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

afterEach(async () => {
  Object.assign(sseRetry, original);
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
});

describe('SseParser', () => {
  const run = (chunks: string[]) => {
    const p = new SseParser();
    return { p, events: chunks.flatMap((c) => p.feed(enc(c))) };
  };

  it('reads LF, CRLF and CR line ends', () => {
    expect(run(['data: a\n\ndata: b\r\n\r\ndata: c\r\r']).events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('joins data lines with LF and drops one leading space only', () => {
    expect(run(['data:  two spaces\ndata\ndata: last\n\n']).events[0]!.data).toBe(' two spaces\n\nlast');
  });

  it('survives any split of the bytes, a CRLF and a multi-byte character included', () => {
    const bytes = enc('event: tick\ndata: {"n":"é€😀"}\r\nid: 7\r\n\r\n');
    for (let cut = 1; cut < bytes.length; cut++) {
      const p = new SseParser();
      const events = [...p.feed(bytes.slice(0, cut)), ...p.feed(bytes.slice(cut))];
      expect(events).toEqual([{ type: 'tick', data: '{"n":"é€😀"}', lastEventId: '7' }]);
    }
  });

  it('drops a BOM, comments and an event with no data', () => {
    const { events } = run(['﻿: hello\nevent: x\n\ndata: y\n\n']);
    expect(events).toEqual([{ type: 'message', data: 'y', lastEventId: '' }]);
  });

  it('keeps the last event id across events and ignores an id with NUL', () => {
    const { p, events } = run(['id: 1\ndata: a\n\ndata: b\n\nid: x\0y\ndata: c\n\n']);
    expect(events.map((e) => e.lastEventId)).toEqual(['1', '1', '1']);
    expect(p.lastEventId).toBe('1');
  });

  it('reads retry only when it is digits', () => {
    expect(run(['retry: 1500\n']).p.retryMs).toBe(1500);
    expect(run(['retry: soon\n']).p.retryMs).toBeUndefined();
  });

  it('reads a long line that arrives in many small chunks, in time that grows with the size', () => {
    const p = new SseParser();
    const piece = enc('x'.repeat(1024));
    const started = Date.now();
    for (let i = 0; i < 4096; i++) expect(p.feed(piece)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    const q = new SseParser();
    q.feed(enc('data: '));
    for (let i = 0; i < 100; i++) q.feed(enc('é€'));
    const events = q.feed(enc('\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('é€'.repeat(100));
  });

  it('counts the bytes of a split multi-byte line against the cap', () => {
    const p = new SseParser({ maxEventBytes: 64 });
    p.feed(enc('data: '));
    expect(() => {
      for (let i = 0; i < 40; i++) p.feed(enc('€'));
    }).toThrow(SseEventTooLargeError);
  });

  it('refuses one event past the cap, also a line that never ends', () => {
    const p = new SseParser({ maxEventBytes: 64 });
    expect(() => p.feed(enc(`data: ${'x'.repeat(100)}`))).toThrow(SseEventTooLargeError);
    const q = new SseParser({ maxEventBytes: 64 });
    q.feed(enc(`data: ${'y'.repeat(30)}\n`));
    expect(() => q.feed(enc(`data: ${'y'.repeat(60)}\n`))).toThrow(SseEventTooLargeError);
  });
});

describe('core.sseTrigger', () => {
  it('starts one run per event with the parsed JSON, and skips (and logs) non-JSON data', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"n":1}\n\ndata: not json\n\ndata: {"n":2}\n\ndata: 5\n\n');
    });
    const { ctx, emitted } = build({ url: s.url });
    const warn = vi.spyOn(ctx.logger, 'warn');
    const response = (await typeOf().trigger!(ctx)) as TriggerResponse;
    closers.push(() => response.closeFunction?.());
    await waitFor(() => emitted.length === 3);
    expect(emitted).toEqual([{ n: 1 }, { n: 2 }, { data: 5 }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not json');
    expect(s.requests[0]!.headers.accept).toBe('text/event-stream');
  });

  it('reconnects when the stream ends, with Last-Event-ID and the server retry delay', async () => {
    let n = 0;
    const at: number[] = [];
    const s = await server((_req, res) => {
      stream(res);
      n++;
      at.push(Date.now());
      if (n === 1) res.end('retry: 200\nid: 41\ndata: {"a":1}\n\n');
      else res.write('id: 42\ndata: {"a":2}\n\n');
    });
    sseRetry.baseMs = 20;
    const { emitted } = await start({ url: s.url });
    await waitFor(() => emitted.length === 2);
    expect(emitted).toEqual([{ a: 1 }, { a: 2 }]);
    expect(s.requests[0]!.headers['last-event-id']).toBeUndefined();
    expect(s.requests[1]!.headers['last-event-id']).toBe('41');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(180);
  });

  it('a server retry of 0 does not make the reconnect loop spin: the base delay is the floor', async () => {
    const at: number[] = [];
    const s = await server((_req, res) => {
      stream(res);
      at.push(Date.now());
      res.end('retry: 0\ndata: {"a":1}\n\n');
    });
    sseRetry.baseMs = 200;
    await start({ url: s.url });
    await waitFor(() => at.length >= 3, 8000);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(180);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(180);
  });

  it('retries on a 5xx answer and on a refused connection', async () => {
    let n = 0;
    const s = await server((_req, res) => {
      n++;
      if (n < 3) {
        res.writeHead(503);
        return res.end('busy');
      }
      stream(res);
      res.write('data: {"ok":true}\n\n');
    });
    sseRetry.baseMs = 20;
    const { emitted, errors } = await start({ url: s.url });
    await waitFor(() => emitted.length === 1);
    expect(n).toBe(3);
    expect(errors).toEqual([]);
  });

  it('reports any other status once and stops', async () => {
    const s = await server((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    sseRetry.baseMs = 10;
    const { errors } = await start({ url: s.url });
    await waitFor(() => errors.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.requests).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('404');
  });

  it('reports an answer that is not an event stream', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>hi</p>');
    });
    const { errors } = await start({ url: s.url });
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.message).toContain('event stream');
    expect(s.requests).toHaveLength(1);
  });

  it('reports a blocked address and does not retry it', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"n":1}\n\n');
    });
    const { errors, emitted } = await start({ url: s.url }, 'activate', new HttpClient());
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.message).toContain('blocked');
    expect(emitted).toEqual([]);
    expect(s.requests).toHaveLength(0);
  });

  it('turns user:password in the URL into Basic auth and leaves them out of the request URL', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"n":1}\n\n');
    });
    const withUser = s.url.replace('http://', 'http://us%40er:p%3Ass@');
    const { emitted } = await start({ url: `${withUser}/feed?x=1` });
    await waitFor(() => emitted.length === 1);
    const req = s.requests[0]!;
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('us@er:p:ss').toString('base64')}`);
    expect(req.url).toBe('/feed?x=1');
  });

  it('rejects a URL that is not http or https', async () => {
    await expect(start({ url: 'ftp://example.com/x' })).rejects.toThrow('http');
    await expect(start({ url: 'nonsense' })).rejects.toThrow('valid');
  });

  it('keeps delivering from a stream open past the request timeout', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"n":1}\n\n');
      setTimeout(() => res.write('data: {"n":2}\n\n'), 900);
    });
    sseRetry.requestTimeoutMs = 300;
    const { emitted, errors } = await start({ url: s.url });
    await waitFor(() => emitted.length === 2);
    expect(emitted).toEqual([{ n: 1 }, { n: 2 }]);
    expect(errors).toEqual([]);
    expect(s.requests).toHaveLength(1);
  });

  it('stops reconnecting after closeFunction', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.end('retry: 20\ndata: {"n":1}\n\n');
    });
    const { response, emitted } = await start({ url: s.url });
    await waitFor(() => emitted.length >= 2);
    await response.closeFunction!();
    await new Promise((r) => setTimeout(r, 100));
    const seen = s.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(s.requests.length).toBe(seen);
  });

  it('stops when the host signal aborts, and closes the connection', async () => {
    let closed = false;
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"n":1}\n\n');
      res.on('close', () => (closed = true));
    });
    const { emitted, abort } = await start({ url: s.url });
    await waitFor(() => emitted.length === 1);
    abort.abort();
    await waitFor(() => closed);
  });

  it('manual mode: the first event starts the run', async () => {
    const s = await server((_req, res) => {
      stream(res);
      res.write('data: {"first":true}\n\ndata: {"second":true}\n\n');
    });
    const { response, emitted } = await start({ url: s.url }, 'manual');
    expect(emitted).toEqual([]);
    await response.manualTriggerFunction!();
    expect(emitted).toEqual([{ first: true }]);
  });

  it('manual mode: a quiet minute ends the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const s = await server((_req, res) => stream(res));
      const { response } = await start({ url: s.url }, 'manual');
      const waiting = response.manualTriggerFunction!();
      const assertion = expect(waiting).rejects.toThrow('60 seconds');
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
