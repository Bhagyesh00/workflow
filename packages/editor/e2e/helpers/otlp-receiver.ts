/**
 * A local OTLP/HTTP receiver for the live OpenTelemetry spec (P6-68): `node:http` on 127.0.0.1 and an ephemeral
 * port (port 0; never 4317 or 4318, the `otel-collector` service holds them). It answers every request with an
 * empty `ExportTraceServiceResponse` and records the method, path, content type, the NAMES of the request headers
 * and the body bytes. It never records a header value. The server under test must run with SSRF_ALLOW=127.0.0.1,
 * because a collector may not sit on a loopback address otherwise.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OtlpRequest {
  method: string;
  path: string;
  contentType: string;
  /** lower-case header names only, never a value */
  headerNames: string[];
  body: Buffer;
}

export interface OtlpReceiver {
  /** http://127.0.0.1:<port> (the endpoint; the tracing path is /v1/traces) */
  url: string;
  /** every request so far, oldest first */
  requests(): OtlpRequest[];
  /** resolves with the request at index `count` (the first one after `count` earlier ones), or rejects after `timeoutMs` */
  next(count: number, timeoutMs?: number): Promise<OtlpRequest>;
  /** stops the server and drops open connections */
  close(): Promise<void>;
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const received: OtlpRequest[] = [];
  const waiting: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
        contentType: String(req.headers['content-type'] ?? ''),
        headerNames: Object.keys(req.headers),
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      for (const wake of waiting.splice(0)) wake();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => [...received],
    next(count, timeoutMs = 15_000) {
      return new Promise<OtlpRequest>((resolve, reject) => {
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
