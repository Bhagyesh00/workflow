/**
 * P6-65 (S5 L9): sends a batch of spans to the tenant's collector, dispatching on `exporterProtocol`:
 * `http/protobuf` POSTs endpoint + path through `ctx.http` (the SSRF guard: every connect checked, TLS verified,
 * redirects off, so a 3xx is a failed export), `grpc` goes through L13's `exportGrpc`. A 2xx is success; any other
 * answer gives the collector's status text (and its message, when it sends one). The header values never reach a
 * log or an error text: an error is scrubbed of them, passes `redactSecrets` and is cut to 1000 characters.
 */
import { type HttpFullResponse, redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { exportGrpc } from './exporter-grpc';
import { encodeExportTraceServiceRequest, type OtlpResource } from './otlp-proto';
import type { EffectiveOtelSettings } from './settings';
import type { SpanData } from './span';

export interface ExportResult {
  success: boolean;
  /** redacted, at most 1000 characters */
  error?: string;
}

/** the OTel batch processor's export timeout */
export const EXPORT_TIMEOUT_MS = 30_000;
const ERROR_MAX_LENGTH = 1000;
const DETAIL_MAX_LENGTH = 500;
/** the instrumentation scope our spans go out under */
const SCOPE_NAME = 'workflow';

/** an export result with the HTTP status (or `unreachable` when no answer came), for the startup probe's log line */
export interface ExportOutcome extends ExportResult {
  status: number | 'unreachable';
}

export interface ExportOptions {
  /** default 30 s */
  timeoutMs?: number;
}

/**
 * n8n's resource attributes without `n8n.`: `service.name`, `service.version`, `instance.id`, `instance.role`.
 * No tenant id: each tenant's collector gets only its own spans (decisions F).
 */
export function resourceFor(deps: ServiceDeps, settings: EffectiveOtelSettings): OtlpResource {
  const { instance } = deps.context();
  return {
    attributes: {
      'service.name': settings.exporterServiceName,
      'service.version': deps.config.version,
      'instance.id': instance.id,
      'instance.role': instance.role,
    },
  };
}

/** the endpoint and the tracing path, joined with one slash */
export function tracesUrl(
  settings: Pick<EffectiveOtelSettings, 'exporterEndpoint' | 'exporterTracingPath'>,
): string {
  const base = settings.exporterEndpoint.trim().replace(/\/+$/, '');
  const path = settings.exporterTracingPath.trim();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** encodes the spans with the tenant's resource and sends them */
export async function exportSpans(
  deps: ServiceDeps,
  settings: EffectiveOtelSettings,
  spans: SpanData[],
  options: ExportOptions = {},
): Promise<ExportResult> {
  let body: Uint8Array;
  try {
    body = encodeExportTraceServiceRequest(resourceFor(deps, settings), spans, {
      name: SCOPE_NAME,
      version: deps.config.version,
    });
  } catch (error) {
    return { success: false, error: cleanError(messageOf(error), settings) };
  }
  const { success, error } = await sendExportBody(
    deps,
    settings,
    body,
    options.timeoutMs ?? EXPORT_TIMEOUT_MS,
  );
  return success ? { success } : { success, error };
}

/** sends one encoded ExportTraceServiceRequest; never throws */
export async function sendExportBody(
  deps: ServiceDeps,
  settings: EffectiveOtelSettings,
  body: Uint8Array,
  timeoutMs: number,
): Promise<ExportOutcome> {
  if (settings.exporterProtocol === 'grpc') {
    try {
      const result = await exportGrpc(deps, settings, body);
      return result.success
        ? { success: true, status: 200 }
        : {
            success: false,
            error: cleanError(result.error ?? 'Export failed', settings),
            status: 'unreachable',
          };
    } catch (error) {
      return { success: false, error: cleanError(messageOf(error), settings), status: 'unreachable' };
    }
  }

  let response: HttpFullResponse<unknown>;
  try {
    response = (await deps.context().http.request({
      url: tracesUrl(settings),
      method: 'POST',
      // our content type last, so a settings header of the same name cannot replace it
      headers: { ...settings.headers, 'content-type': 'application/x-protobuf' },
      body,
      bodyType: 'raw',
      responseType: 'arraybuffer',
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      followRedirects: false,
      timeout: timeoutMs,
    })) as HttpFullResponse<unknown>;
  } catch (error) {
    return { success: false, error: cleanError(messageOf(error), settings), status: 'unreachable' };
  }

  const status = response.statusCode;
  if (status >= 200 && status < 300) return { success: true, status };
  const statusText = `${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}`;
  const detail = detailOf(response.body, response.headers['content-type'] ?? '');
  return {
    success: false,
    error: cleanError(detail ? `${statusText}: ${detail}` : statusText, settings),
    status,
  };
}

/** an error's message, with its cause (a TLS or socket error under undici's `fetch failed`) */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'Export failed';
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return cause && cause !== error.message ? `${error.message}: ${cause}` : error.message || 'Export failed';
}

/** the collector's own words: google.rpc.Status `message` for protobuf, `message` or the text otherwise */
function detailOf(body: unknown, contentType: string): string {
  if (!(body instanceof Uint8Array) || body.length === 0) return '';
  let detail = '';
  if (/protobuf/i.test(contentType)) {
    detail = statusMessageOf(body);
  } else {
    const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
    if (/json/i.test(contentType)) {
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        detail = typeof parsed?.message === 'string' ? parsed.message : text;
      } catch {
        detail = text;
      }
    } else {
      detail = text;
    }
  }
  // printable text only, on one line
  const clean = Array.from(detail, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, DETAIL_MAX_LENGTH);
}

/** field 2 (`message`) of a google.rpc.Status; '' when the bytes are not one */
function statusMessageOf(bytes: Uint8Array): string {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new Error('truncated');
      const byte = bytes[pos++];
      value += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return value;
      factor *= 0x80;
    }
    throw new Error('varint too long');
  };
  try {
    while (pos < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else if (wire === 2) {
        const length = varint();
        if (pos + length > bytes.length) return '';
        if (field === 2) return Buffer.from(bytes.subarray(pos, pos + length)).toString('utf8');
        pos += length;
      } else return '';
    }
  } catch {
    return '';
  }
  return '';
}

/** no header value, no known secret pattern, at most 1000 characters */
function cleanError(text: string, settings: EffectiveOtelSettings): string {
  let out = text;
  for (const value of Object.values(settings.headers)) {
    if (value && value.length >= 3) out = out.split(value).join('[redacted]');
  }
  return redactSecrets(out).slice(0, ERROR_MAX_LENGTH);
}
