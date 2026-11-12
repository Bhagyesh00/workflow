/**
 * A local HTTP receiver for the live log streaming spec (P6-64): `node:http` on 127.0.0.1 and an ephemeral port
 * (never 4317 or 4318, the collector holds them), the way helpers/git-http.ts starts its remote. It answers every
 * request with `status` and records the method, path and body. The server under test must run with
 * SSRF_ALLOW=127.0.0.1, because a destination may not send to a loopback address otherwise.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  method: string;
  path: string;
  body: string;
}

export interface HttpReceiver {
  /** http://127.0.0.1:<port>/hook */
  url: string;
  /** every request so far, oldest first */
  requests(): ReceivedRequest[];
  /** resolves with the first request received after `count` earlier ones, or rejects after `timeoutMs` */
  next(count: number, timeoutMs?: number): Promise<ReceivedRequest>;
  /** stops the server and drops open connections */
  close(): Promise<void>;
}

export async function startHttpReceiver(status = 200): Promise<HttpReceiver> {
  const received: ReceivedRequest[] = [];
  const waiting: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
      for (const wake of waiting.splice(0)) wake();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests: () => [...received],
    next(count, timeoutMs = 15_000) {
      return new Promise<ReceivedRequest>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No request number ${count + 1} reached the receiver`)),
          timeoutMs,
        );
        const check = () => {
          const found = received[count];
          if (found) {
            clearTimeout(timer);
            resolve(found);
          } else waiting.push(check);
        };
        check();
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
