/**
 * P6-69 (S5 L13): OTLP over gRPC, our own unary client on `node:http2` (no gRPC library: its sockets would skip the
 * SSRF guard). One call per export: `POST /opentelemetry.proto.collector.trace.v1.TraceService/Export` with the
 * encoded `ExportTraceServiceRequest` in one length-prefixed message (1 byte compressed flag 0, 4 bytes big-endian
 * length), headers `content-type: application/grpc`, `te: trailers`, `grpc-timeout` and the settings headers as
 * metadata. The answer is `grpc-status` and `grpc-message` from the trailers, or from the headers of a trailers-only
 * answer; `0` is success, anything else is "<code> <NAME>[: <message>]" (the form gRPC clients print).
 *
 * The socket is ours: the endpoint's host goes through `ctx.http.resolveAllowedHost` (every address checked, throws
 * for a blocked one) and the socket connects through its pinned `lookup`, so a DNS rebind cannot move it. `https://`
 * is `tls.connect` with certificate verification on (the system store; no skip option exists), `servername` = the
 * host name (never an address) and ALPN `h2`; `http://` is `net.connect` with HTTP/2 prior knowledge (h2c).
 * `http2.connect` gets that socket through `createConnection` and never opens one itself.
 *
 * Header values never reach an error text: an error is scrubbed of them, passes `redactSecrets` and is cut to 1000
 * characters. Never throws.
 */
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { type AllowedHost, redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExportResult } from './exporter';
import type { EffectiveOtelSettings } from './settings';

/** the unary method every OTLP/gRPC trace export calls */
export const GRPC_TRACE_EXPORT_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';
/** the OTel batch processor's export timeout, used when the caller names none */
export const GRPC_EXPORT_TIMEOUT_MS = 30_000;
const ERROR_MAX_LENGTH = 1000;
const MESSAGE_MAX_LENGTH = 500;

/** the gRPC status codes 0 to 16 by number */
const GRPC_CODE_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

/** headers a settings entry cannot set: ours, and the HTTP/1 connection headers HTTP/2 forbids */
const RESERVED_HEADERS = new Set([
  'content-type',
  'te',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
// visible ASCII, space and tab: what gRPC metadata of a text header holds
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

export interface GrpcExportOptions {
  /** the whole call, connect included; default 30 s */
  timeoutMs?: number;
}

interface GrpcTarget {
  secure: boolean;
  /** without brackets, for the guard and the socket */
  host: string;
  port: number;
  /** `host[:port]` as the URL holds it, for `:authority` */
  authority: string;
}

/** `body` is an encoded `ExportTraceServiceRequest` (may be empty: the startup probe); never throws */
export async function exportGrpc(
  deps: ServiceDeps,
  settings: EffectiveOtelSettings,
  body: Uint8Array,
  options: GrpcExportOptions = {},
): Promise<ExportResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : GRPC_EXPORT_TIMEOUT_MS;
  const failure = (text: string): ExportResult => ({ success: false, error: cleanError(text, settings) });

  const target = targetOf(settings.exporterEndpoint);
  if (typeof target === 'string') return failure(target);

  let lookup: AllowedHost['lookup'];
  try {
    // throws SsrfBlockedError for a host the policy refuses, before any socket opens
    ({ lookup } = await deps.context().http.resolveAllowedHost(target.host));
  } catch (error) {
    return failure(messageOf(error));
  }

  return await new Promise<ExportResult>((resolve) => {
    let settled = false;
    let session: http2.ClientHttp2Session | undefined;
    const finish = (result: ExportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session?.destroy();
      socket.destroy();
      resolve(result);
    };
    const fail = (text: string) => finish(failure(text));
    const timer = setTimeout(() => fail(`The collector did not answer within ${timeoutMs} ms`), timeoutMs);

    // the pinned socket, opened inline (no shared helper): the lookup answers only the checked addresses
    const socket: net.Socket = target.secure
      ? tls.connect({
          host: target.host,
          port: target.port,
          lookup,
          // the certificate is checked against the name the admin typed, never an address
          servername: net.isIP(target.host) ? undefined : target.host,
          ALPNProtocols: ['h2'],
          minVersion: 'TLSv1.2',
        })
      : net.connect({ host: target.host, port: target.port, lookup });
    socket.on('error', (error) => fail(`Could not connect to the collector: ${messageOf(error)}`));
    socket.once(target.secure ? 'secureConnect' : 'connect', () => {
      if (target.secure && (socket as tls.TLSSocket).alpnProtocol !== 'h2') {
        fail('Could not connect to the collector: it does not offer HTTP/2 (ALPN h2)');
        return;
      }
      try {
        call();
      } catch (error) {
        fail(messageOf(error));
      }
    });

    const call = () => {
      session = http2.connect(`${target.secure ? 'https' : 'http'}://${target.authority}`, {
        createConnection: () => socket,
      });
      session.on('error', (error) => fail(`The gRPC connection failed: ${messageOf(error)}`));

      const request = session.request({
        // the settings headers first: ours win over a header of the same name
        ...metadataOf(settings.headers),
        ':method': 'POST',
        ':path': GRPC_TRACE_EXPORT_PATH,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-timeout': `${Math.ceil(timeoutMs)}m`,
      });
      let httpStatus: number | undefined;
      let grpcStatus: string | undefined;
      let grpcMessage: string | undefined;
      const readStatus = (headers: http2.IncomingHttpHeaders) => {
        const status = headers['grpc-status'];
        if (status === undefined) return;
        grpcStatus = String(status);
        const message = headers['grpc-message'];
        grpcMessage = message === undefined ? undefined : String(message);
      };
      request.on('response', (headers) => {
        httpStatus = Number(headers[':status']);
        // a trailers-only answer carries the status in its headers
        readStatus(headers);
      });
      request.on('trailers', readStatus);
      // the ExportTraceServiceResponse is not needed: drain it
      request.on('data', () => undefined);
      request.on('error', (error) => fail(`The gRPC call failed: ${messageOf(error)}`));
      request.on('close', () => {
        if (settled) return;
        if (httpStatus === undefined) {
          fail(`The collector closed the call without an answer (HTTP/2 code ${request.rstCode})`);
          return;
        }
        finish(resultOf(httpStatus, grpcStatus, grpcMessage, failure));
      });

      const frame = Buffer.alloc(5 + body.byteLength);
      frame.writeUInt8(0, 0);
      frame.writeUInt32BE(body.byteLength, 1);
      frame.set(body, 5);
      request.end(frame);
    };
  });
}

/** the endpoint as a gRPC target, or the error text */
function targetOf(endpoint: string): GrpcTarget | string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return 'The endpoint must be a URL that starts with http:// or https://';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The endpoint must start with http:// or https://';
  }
  const secure = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'The endpoint has no host';
  return { secure, host, port: url.port ? Number(url.port) : secure ? 443 : 80, authority: url.host };
}

/** the settings headers as gRPC metadata: lower-case names, reserved and malformed entries left out */
function metadataOf(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name) || name.startsWith('grpc-') || RESERVED_HEADERS.has(name)) continue;
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function resultOf(
  httpStatus: number,
  grpcStatus: string | undefined,
  grpcMessage: string | undefined,
  failure: (text: string) => ExportResult,
): ExportResult {
  const code = grpcStatus === undefined ? undefined : Number(grpcStatus);
  if (httpStatus === 200 && code === 0) return { success: true };
  const message = grpcMessage === undefined ? '' : messageText(grpcMessage);
  const status =
    code === undefined || !Number.isInteger(code)
      ? ''
      : `${code}${GRPC_CODE_NAMES[code] ? ` ${GRPC_CODE_NAMES[code]}` : ''}`;
  if (httpStatus !== 200) {
    const detail = [status, message].filter(Boolean).join(': ');
    return failure(`The collector answered HTTP ${httpStatus}${detail ? ` (${detail})` : ''}`);
  }
  if (!status) return failure('The collector sent no gRPC status');
  return failure(message ? `${status}: ${message}` : status);
}

/** `grpc-message` is percent-encoded UTF-8; printable text only, on one line */
function messageText(raw: string): string {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    text = raw;
  }
  return Array.from(text, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX_LENGTH);
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'Export failed';
  return error.message || 'Export failed';
}

/** no header value, no known secret pattern, at most 1000 characters */
function cleanError(text: string, settings: EffectiveOtelSettings): string {
  let out = text;
  for (const value of Object.values(settings.headers)) {
    if (value && value.length >= 3) out = out.split(value).join('[redacted]');
  }
  return redactSecrets(out).slice(0, ERROR_MAX_LENGTH);
}
