import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpFullResponse, HttpResponseStream } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, HttpError, SsrfBlockedError } from '../src';

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** a gate the server waits on before it sends the rest of a response */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('R57: streamed HTTP responses', () => {
  let rest = gate();
  let endedAt = 0;
  let port = 0;
  let internalPort = 0;
  const internal = http.createServer((_req, res) => res.end('INTERNAL-SECRET'));
  const server = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      void rest.opened.then(() => {
        endedAt = Date.now();
        res.end('data: second\n\n');
      });
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('123456');
      void rest.opened.then(() => res.end('7890123456'));
    } else if (req.url === '/hang') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
    } else if (req.url === '/limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    } else if (req.url === '/to-loopback') {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/x` });
      res.end();
    } else res.end('OK');
  });

  beforeAll(async () => {
    port = await listen(server, '127.0.0.1');
    internalPort = await listen(internal, '127.0.0.1');
  });

  afterAll(async () => {
    await Promise.all([close(server), close(internal)]);
  });

  // `allow: ['localhost']` stands in for a public host that passes the policy
  const client = (maxResponseBytes?: number) => new HttpClient({ ssrf: { allow: ['localhost'] }, maxResponseBytes });

  it('returns the body while it arrives: the first chunk comes before the response ends', async () => {
    rest = gate();
    // a client that buffers the whole body would wait here forever; the server ends on its own later.
    // The reader opens the gate 50 ms after the first chunk, so the fallback only bounds a buffering client
    const fallback = setTimeout(() => rest.open(), 5000);
    const c = client();
    try {
      const response = (await c.request<HttpResponseStream>({
        url: `http://localhost:${port}/sse`,
        responseType: 'stream',
        returnFullResponse: true,
      })) as HttpFullResponse<HttpResponseStream>;
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      const decoder = new TextDecoder();
      const received: Array<{ text: string; at: number }> = [];
      for await (const chunk of response.body) {
        received.push({ text: decoder.decode(chunk, { stream: true }), at: Date.now() });
        // the server sends the rest only after the first chunk reached us
        if (received.length === 1) setTimeout(rest.open, 50);
      }
      expect(received.map((r) => r.text).join('')).toBe('data: first\n\ndata: second\n\n');
      expect(received[0].text).toBe('data: first\n\n');
      expect(received[0].at).toBeLessThan(endedAt);
    } finally {
      clearTimeout(fallback);
      await c.close();
    }
  }, 15_000);

  it('enforces the response size limit while the stream is read', async () => {
    rest = gate();
    const c = client(10);
    try {
      const body = (await c.request<HttpResponseStream>({
        url: `http://localhost:${port}/big`,
        responseType: 'stream',
      })) as HttpResponseStream;
      const chunks: string[] = [];
      await expect(
        (async () => {
          for await (const chunk of body) {
            chunks.push(new TextDecoder().decode(chunk));
            rest.open();
          }
        })(),
      ).rejects.toThrow('Response exceeds the maximum size of 10 bytes');
      expect(chunks).toEqual(['123456']);
    } finally {
      await c.close();
    }
  });

  it('stops reading when the abort signal fires', async () => {
    const c = client();
    const controller = new AbortController();
    try {
      const body = (await c.request<HttpResponseStream>(
        { url: `http://localhost:${port}/hang`, responseType: 'stream' },
        controller.signal,
      )) as HttpResponseStream;
      const chunks: string[] = [];
      await expect(
        (async () => {
          for await (const chunk of body) {
            chunks.push(new TextDecoder().decode(chunk));
            controller.abort();
          }
        })(),
      ).rejects.toThrow(/abort/i);
      expect(chunks).toEqual(['data: first\n\n']);
    } finally {
      await c.close();
    }
  });

  it('throws an HttpError with the parsed body for a non-2xx response', async () => {
    const c = client();
    try {
      const error = await c
        .request({ url: `http://localhost:${port}/limited`, responseType: 'stream' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(429);
      expect((error as HttpError).body).toEqual({ error: { message: 'slow down' } });
      expect((error as HttpError).retryAfterMs).toBe(2000);
    } finally {
      await c.close();
    }
  });

  it('keeps the SSRF guard: a redirect to a loopback address is blocked', async () => {
    const c = client();
    try {
      await expect(
        c.request({ url: `http://localhost:${port}/to-loopback`, responseType: 'stream' }),
      ).rejects.toThrow(SsrfBlockedError);
      await expect(
        c.request({ url: `http://127.0.0.1:${internalPort}/x`, responseType: 'stream' }),
      ).rejects.toThrow(SsrfBlockedError);
    } finally {
      await c.close();
    }
  });
});
