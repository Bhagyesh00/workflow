/**
 * P6-69 (S5 L13): a test-only OTLP gRPC collector on `node:http2`, listening on 127.0.0.1 on an ephemeral port:
 * h2c (prior knowledge) by default, or TLS with ALPN `h2` and the PEM pair of test/fixtures/tls (`tls`; its CA is not
 * in the system store, so a client that verifies refuses it). It records every unary call with its headers, its
 * length-prefixed messages and the first message decoded by L9's `decodeExportTraceServiceRequest`, and answers as
 * `respondWith` says: an empty `ExportTraceServiceResponse` with `grpc-status: 0` in the trailers until then, a
 * status in the trailers, a trailers-only answer, another HTTP status, or no answer at all (`hang`). Tests assert on
 * what it captured and never print a header value.
 */
import http2, {
  type Http2SecureServer,
  type Http2Server,
  type Http2Session,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo, Server } from 'node:net';
import {
  type DecodedExportRequest,
  type DecodedScope,
  type DecodedSpan,
  type DecodedValue,
  decodeExportTraceServiceRequest,
  spansOf,
} from './otlp';

/** one length-prefixed gRPC message */
export interface GrpcFrame {
  compressed: boolean;
  message: Buffer;
}

export interface OtlpGrpcRequest {
  /** the `:path` pseudo-header */
  path: string;
  method: string;
  /** every request header, pseudo-headers included (`:scheme`, `:authority`) */
  headers: IncomingHttpHeaders;
  /** the raw request body (prefix and message) */
  body: Buffer;
  frames: GrpcFrame[];
  /** the first message decoded as an ExportTraceServiceRequest; undefined when it is not one */
  decoded?: DecodedExportRequest;
}

export interface OtlpGrpcReply {
  /** the `grpc-status` code (default 0) */
  grpcStatus?: number;
  /** sent as `grpc-message`, percent-encoded as the gRPC spec says */
  grpcMessage?: string;
  /** the HTTP status (default 200) */
  httpStatus?: number;
  /** send the status in the response headers and end the stream there (no message, no trailers) */
  trailersOnly?: boolean;
  /** read the request and never answer */
  hang?: boolean;
}

type ReceivedSpan = DecodedSpan & { resource: Record<string, DecodedValue>; scope: DecodedScope };

export interface OtlpGrpcCollector {
  /** `http://127.0.0.1:<port>` (h2c) or `https://127.0.0.1:<port>` (TLS), no trailing slash */
  url: string;
  port: number;
  requests: OtlpGrpcRequest[];
  /** every span received so far, in arrival order */
  spans(): ReceivedSpan[];
  /** the reply every later call gets */
  respondWith(reply: OtlpGrpcReply): void;
  /** resolves once `count` calls were received; rejects after `timeoutMs` (default 10 s) */
  waitForRequests(count: number, timeoutMs?: number): Promise<OtlpGrpcRequest[]>;
  close(): Promise<void>;
}

/** the gRPC framing: 1 byte compressed flag, 4 bytes big-endian length, the message */
export function readGrpcFrames(body: Buffer): GrpcFrame[] {
  const frames: GrpcFrame[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 5 > body.length) throw new Error('truncated gRPC frame prefix');
    const compressed = body[pos] === 1;
    const length = body.readUInt32BE(pos + 1);
    if (pos + 5 + length > body.length) throw new Error('truncated gRPC message');
    frames.push({ compressed, message: body.subarray(pos + 5, pos + 5 + length) });
    pos += 5 + length;
  }
  return frames;
}

/** percent-encodes the bytes the gRPC spec does not allow in `grpc-message` */
function encodeGrpcMessage(message: string): string {
  return Array.from(Buffer.from(message, 'utf8'), (byte) =>
    byte >= 0x20 && byte <= 0x7e && byte !== 0x25
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}

export async function startOtlpGrpcCollector(
  options: { tls?: { key: string | Buffer; cert: string | Buffer } } = {},
): Promise<OtlpGrpcCollector> {
  const requests: OtlpGrpcRequest[] = [];
  const sessions = new Set<Http2Session>();
  const waiters = new Set<() => void>();
  let reply: OtlpGrpcReply = {};

  const answer = (stream: ServerHttp2Stream, current: OtlpGrpcReply) => {
    if (current.hang || stream.destroyed) return;
    const status = String(current.grpcStatus ?? 0);
    const message =
      current.grpcMessage === undefined ? {} : { 'grpc-message': encodeGrpcMessage(current.grpcMessage) };
    const httpStatus = current.httpStatus ?? 200;
    if (current.trailersOnly || httpStatus !== 200) {
      stream.respond(
        { ':status': httpStatus, 'content-type': 'application/grpc', 'grpc-status': status, ...message },
        { endStream: true },
      );
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': status, ...message }));
    // an empty ExportTraceServiceResponse, when the call succeeded
    stream.end(status === '0' ? Buffer.alloc(5) : undefined);
  };

  const onStream = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', () => undefined);
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      let frames: GrpcFrame[] = [];
      let decoded: DecodedExportRequest | undefined;
      try {
        frames = readGrpcFrames(body);
        if (frames[0] && !frames[0].compressed) decoded = decodeExportTraceServiceRequest(frames[0].message);
      } catch {
        decoded = undefined;
      }
      requests.push({
        path: String(headers[':path'] ?? ''),
        method: String(headers[':method'] ?? ''),
        headers,
        body,
        frames,
        decoded,
      });
      for (const wake of [...waiters]) wake();
      answer(stream, reply);
    });
  };

  const onSession = (session: Http2Session) => {
    sessions.add(session);
    session.on('error', () => undefined);
    session.once('close', () => sessions.delete(session));
  };
  let server: Http2Server | Http2SecureServer;
  if (options.tls) {
    const secure = http2.createSecureServer({
      key: options.tls.key,
      cert: options.tls.cert,
      allowHTTP1: false,
    });
    secure.on('stream', onStream);
    secure.on('session', onSession);
    // a refused TLS handshake (the client did not trust us) is expected in tests
    secure.on('tlsClientError', () => undefined);
    secure.on('sessionError', () => undefined);
    server = secure;
  } else {
    const plain = http2.createServer();
    plain.on('stream', onStream);
    plain.on('session', onSession);
    plain.on('sessionError', () => undefined);
    server = plain;
  }
  const base: Server = server;
  await new Promise<void>((resolve, reject) => {
    base.once('error', reject);
    base.listen(0, '127.0.0.1', () => {
      base.off('error', reject);
      resolve();
    });
  });
  const { port } = base.address() as AddressInfo;
  const allSpans = () => requests.flatMap((r) => (r.decoded ? spansOf(r.decoded) : []));

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    spans: allSpans,
    respondWith(next: OtlpGrpcReply) {
      reply = next;
    },
    waitForRequests(count: number, timeoutMs = 10_000) {
      return new Promise<OtlpGrpcRequest[]>((resolve, reject) => {
        const check = () => {
          if (requests.length < count) return false;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(requests.slice(0, count));
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`otlp grpc collector: ${requests.length} of ${count} calls after ${timeoutMs} ms`),
          );
        }, timeoutMs);
        if (!check()) waiters.add(check);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        base.close(() => resolve());
      });
    },
  };
}
