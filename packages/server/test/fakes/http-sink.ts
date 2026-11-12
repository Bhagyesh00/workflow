/**
 * P6 S5 (C0g, FULL, C0-final): an HTTP sink for tests on 127.0.0.1, an ephemeral port: it records every request
 * (method, path with query, headers, raw body) and answers with the status set by `respondWith` (200 and an
 * empty body until then). With `tls` it serves HTTPS (`node:https`) with that key and certificate, for example
 * the PEM pair of test/fixtures/tls (`loadTlsFixtures()`: the server certificate holds 127.0.0.1 and localhost,
 * signed by `ca`; `otherCa` is a second CA that does not sign it). No network beyond 127.0.0.1. L3, L4, L6, L7
 * and L9 share it; tests assert on what it captured and never print a header value.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface HttpSinkRequest {
  method: string;
  /** the request target as sent: the path and its query */
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface HttpSinkOptions {
  tls?: { key: string | Buffer; cert: string | Buffer };
}

export interface HttpSink {
  /** `http://127.0.0.1:<port>` (or `https://` with `tls`), no trailing slash */
  url: string;
  /** every request received, in arrival order (pushed once its body is read) */
  requests: HttpSinkRequest[];
  /** the status (and body) every later request gets; the default is 200 with an empty body */
  respondWith(status: number, body?: string): void;
  /** resolves once `count` requests were received; rejects after `timeoutMs` (default 10 s) */
  waitForRequests(count: number, timeoutMs?: number): Promise<HttpSinkRequest[]>;
  /** stops listening and drops open connections */
  close(): Promise<void>;
}

/** the folder of the PEM fixtures (ca.pem, server.pem, server-key.pem, other-ca.pem) */
export const TLS_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'tls');

/** the PEM fixtures as text: `ca` signs `cert` (SAN 127.0.0.1, localhost); `otherCa` is an unrelated CA */
export function loadTlsFixtures(): { ca: string; cert: string; key: string; otherCa: string } {
  const read = (name: string) => readFileSync(path.join(TLS_FIXTURE_DIR, name), 'utf8');
  return {
    ca: read('ca.pem'),
    cert: read('server.pem'),
    key: read('server-key.pem'),
    otherCa: read('other-ca.pem'),
  };
}

export async function startHttpSink(options: HttpSinkOptions = {}): Promise<HttpSink> {
  const requests: HttpSinkRequest[] = [];
  let reply: { status: number; body: string } = { status: 200, body: '' };
  const waiters = new Set<() => void>();

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', () => response.destroy());
    request.on('end', () => {
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      for (const wake of [...waiters]) wake();
      const { status, body } = reply;
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  };

  const server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    respondWith(status: number, body = '') {
      reply = { status, body };
    },
    waitForRequests(count: number, timeoutMs = 10_000) {
      return new Promise<HttpSinkRequest[]>((resolve, reject) => {
        const check = () => {
          if (requests.length < count) return false;
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(requests.slice(0, count));
          return true;
        };
        const wake = () => {
          check();
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`http sink: ${requests.length} of ${count} requests after ${timeoutMs} ms`));
        }, timeoutMs);
        if (!check()) waiters.add(wake);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
