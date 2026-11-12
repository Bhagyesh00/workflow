/**
 * P6-65 (S5 L9): a test-only OTLP collector. `decodeExportTraceServiceRequest` reads an OTLP/HTTP protobuf body
 * with its own field numbers (written from the public opentelemetry-proto files, never from our encoder's table),
 * so a round trip proves the encoder writes the spec. `startOtlpCollector` listens on 127.0.0.1 on an ephemeral
 * port (`tls` serves HTTPS with the PEM pair of test/fixtures/tls), records every request with its decoded body and
 * answers with the status, body and headers set by `respondWith` (200 and an empty body until then). L9, L10 and
 * L13 use it. Tests assert on what it captured and never print a header value.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

/** a decoded AnyValue: int as bigint, double as number, bytes as Buffer, kvlist as a plain object */
export type DecodedValue = string | boolean | bigint | number | Buffer | DecodedValue[] | DecodedKvList;

export interface DecodedKvList {
  [key: string]: DecodedValue;
}

export interface DecodedScope {
  name: string;
  version: string;
  attributes: Record<string, DecodedValue>;
}

export interface DecodedEvent {
  timeUnixNano: bigint;
  name: string;
  attributes: Record<string, DecodedValue>;
}

export interface DecodedLink {
  traceId: string;
  spanId: string;
  traceState: string;
  attributes: Record<string, DecodedValue>;
  flags: number;
}

export interface DecodedSpan {
  traceId: string;
  spanId: string;
  traceState: string;
  /** '' for a root span */
  parentSpanId: string;
  name: string;
  /** 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer */
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, DecodedValue>;
  events: DecodedEvent[];
  links: DecodedLink[];
  /** code 0 unset, 1 ok, 2 error */
  status: { code: number; message: string };
  flags: number;
}

export interface DecodedScopeSpans {
  scope: DecodedScope;
  spans: DecodedSpan[];
}

export interface DecodedResourceSpans {
  resource: { attributes: Record<string, DecodedValue> };
  scopeSpans: DecodedScopeSpans[];
}

export interface DecodedExportRequest {
  resourceSpans: DecodedResourceSpans[];
}

// ---------------------------------------------------------------------------------------------
// protobuf reading
// ---------------------------------------------------------------------------------------------

interface Field {
  field: number;
  wire: number;
  /** varint (wire 0) */
  varint?: bigint;
  /** fixed64 (wire 1) or fixed32 (wire 5), raw little-endian bytes */
  fixed?: Buffer;
  /** length-delimited (wire 2) */
  bytes?: Buffer;
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('otlp decoder: truncated varint');
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('otlp decoder: varint too long');
  }
  return { value, next: pos };
}

/** every field of one message, in wire order */
export function readFields(input: Uint8Array): Field[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      fields.push({ field, wire, varint: v.value });
    } else if (wire === 1) {
      fields.push({ field, wire, fixed: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 5) {
      fields.push({ field, wire, fixed: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      const end = pos + Number(len.value);
      if (end > buf.length) throw new Error('otlp decoder: truncated field');
      fields.push({ field, wire, bytes: buf.subarray(pos, end) });
      pos = end;
    } else {
      throw new Error(`otlp decoder: unsupported wire type ${wire}`);
    }
  }
  return fields;
}

function expectWire(f: Field, wire: number, what: string): void {
  if (f.wire !== wire)
    throw new Error(`otlp decoder: ${what} (field ${f.field}) has wire type ${f.wire}, not ${wire}`);
}

const str = (f: Field, what: string) => {
  expectWire(f, 2, what);
  return (f.bytes as Buffer).toString('utf8');
};
const hex = (f: Field, what: string) => {
  expectWire(f, 2, what);
  return (f.bytes as Buffer).toString('hex');
};
const fixed64 = (f: Field, what: string) => {
  expectWire(f, 1, what);
  return (f.fixed as Buffer).readBigUInt64LE(0);
};
const fixed32 = (f: Field, what: string) => {
  expectWire(f, 5, what);
  return (f.fixed as Buffer).readUInt32LE(0);
};
const varintNumber = (f: Field, what: string) => {
  expectWire(f, 0, what);
  return Number(f.varint);
};

/** AnyValue: string_value 1, bool_value 2, int_value 3, double_value 4, array_value 5, kvlist_value 6, bytes_value 7 */
export function decodeAnyValue(input: Uint8Array): DecodedValue {
  let value: DecodedValue = '';
  for (const f of readFields(input)) {
    if (f.field === 1) value = str(f, 'string_value');
    else if (f.field === 2) {
      expectWire(f, 0, 'bool_value');
      value = f.varint === 1n;
    } else if (f.field === 3) {
      expectWire(f, 0, 'int_value');
      value = BigInt.asIntN(64, f.varint as bigint);
    } else if (f.field === 4) {
      expectWire(f, 1, 'double_value');
      value = (f.fixed as Buffer).readDoubleLE(0);
    } else if (f.field === 5) {
      expectWire(f, 2, 'array_value');
      // ArrayValue: values 1
      value = readFields(f.bytes as Buffer)
        .filter((v) => v.field === 1)
        .map((v) => decodeAnyValue(v.bytes as Buffer));
    } else if (f.field === 6) {
      expectWire(f, 2, 'kvlist_value');
      // KeyValueList: values 1
      value = decodeKeyValues(readFields(f.bytes as Buffer).filter((v) => v.field === 1));
    } else if (f.field === 7) {
      expectWire(f, 2, 'bytes_value');
      value = Buffer.from(f.bytes as Buffer);
    }
  }
  return value;
}

/** KeyValue: key 1, value 2 */
function decodeKeyValues(fields: Field[]): Record<string, DecodedValue> {
  const out: Record<string, DecodedValue> = {};
  for (const f of fields) {
    expectWire(f, 2, 'KeyValue');
    let key = '';
    let value: DecodedValue = '';
    for (const kv of readFields(f.bytes as Buffer)) {
      if (kv.field === 1) key = str(kv, 'KeyValue.key');
      else if (kv.field === 2) value = decodeAnyValue(kv.bytes as Buffer);
    }
    out[key] = value;
  }
  return out;
}

/** Span.Event: time_unix_nano 1, name 2, attributes 3 */
function decodeEvent(input: Buffer): DecodedEvent {
  const event: DecodedEvent = { timeUnixNano: 0n, name: '', attributes: {} };
  const attrs: Field[] = [];
  for (const f of readFields(input)) {
    if (f.field === 1) event.timeUnixNano = fixed64(f, 'Event.time_unix_nano');
    else if (f.field === 2) event.name = str(f, 'Event.name');
    else if (f.field === 3) attrs.push(f);
  }
  event.attributes = decodeKeyValues(attrs);
  return event;
}

/** Span.Link: trace_id 1, span_id 2, trace_state 3, attributes 4, flags 6 */
function decodeLink(input: Buffer): DecodedLink {
  const link: DecodedLink = { traceId: '', spanId: '', traceState: '', attributes: {}, flags: 0 };
  const attrs: Field[] = [];
  for (const f of readFields(input)) {
    if (f.field === 1) link.traceId = hex(f, 'Link.trace_id');
    else if (f.field === 2) link.spanId = hex(f, 'Link.span_id');
    else if (f.field === 3) link.traceState = str(f, 'Link.trace_state');
    else if (f.field === 4) attrs.push(f);
    else if (f.field === 6) link.flags = fixed32(f, 'Link.flags');
  }
  link.attributes = decodeKeyValues(attrs);
  return link;
}

/**
 * Span: trace_id 1, span_id 2, trace_state 3, parent_span_id 4, name 5, kind 6, start_time_unix_nano 7,
 * end_time_unix_nano 8, attributes 9, events 11, links 13, status 15, flags 16
 */
function decodeSpan(input: Buffer): DecodedSpan {
  const span: DecodedSpan = {
    traceId: '',
    spanId: '',
    traceState: '',
    parentSpanId: '',
    name: '',
    kind: 0,
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    attributes: {},
    events: [],
    links: [],
    status: { code: 0, message: '' },
    flags: 0,
  };
  const attrs: Field[] = [];
  for (const f of readFields(input)) {
    if (f.field === 1) span.traceId = hex(f, 'Span.trace_id');
    else if (f.field === 2) span.spanId = hex(f, 'Span.span_id');
    else if (f.field === 3) span.traceState = str(f, 'Span.trace_state');
    else if (f.field === 4) span.parentSpanId = hex(f, 'Span.parent_span_id');
    else if (f.field === 5) span.name = str(f, 'Span.name');
    else if (f.field === 6) span.kind = varintNumber(f, 'Span.kind');
    else if (f.field === 7) span.startTimeUnixNano = fixed64(f, 'Span.start_time_unix_nano');
    else if (f.field === 8) span.endTimeUnixNano = fixed64(f, 'Span.end_time_unix_nano');
    else if (f.field === 9) attrs.push(f);
    else if (f.field === 11) span.events.push(decodeEvent(f.bytes as Buffer));
    else if (f.field === 13) span.links.push(decodeLink(f.bytes as Buffer));
    else if (f.field === 15) {
      // Status: message 2, code 3
      for (const s of readFields(f.bytes as Buffer)) {
        if (s.field === 2) span.status.message = str(s, 'Status.message');
        else if (s.field === 3) span.status.code = varintNumber(s, 'Status.code');
      }
    } else if (f.field === 16) span.flags = fixed32(f, 'Span.flags');
  }
  span.attributes = decodeKeyValues(attrs);
  return span;
}

/** ExportTraceServiceRequest: resource_spans 1; ResourceSpans: resource 1, scope_spans 2; ScopeSpans: scope 1, spans 2 */
export function decodeExportTraceServiceRequest(input: Uint8Array): DecodedExportRequest {
  const resourceSpans: DecodedResourceSpans[] = [];
  for (const rs of readFields(input)) {
    if (rs.field !== 1) continue;
    const entry: DecodedResourceSpans = { resource: { attributes: {} }, scopeSpans: [] };
    for (const f of readFields(rs.bytes as Buffer)) {
      if (f.field === 1) {
        // Resource: attributes 1
        entry.resource.attributes = decodeKeyValues(
          readFields(f.bytes as Buffer).filter((r) => r.field === 1),
        );
      } else if (f.field === 2) {
        const scopeSpans: DecodedScopeSpans = { scope: { name: '', version: '', attributes: {} }, spans: [] };
        for (const s of readFields(f.bytes as Buffer)) {
          if (s.field === 1) {
            // InstrumentationScope: name 1, version 2, attributes 3
            const attrs: Field[] = [];
            for (const sc of readFields(s.bytes as Buffer)) {
              if (sc.field === 1) scopeSpans.scope.name = str(sc, 'InstrumentationScope.name');
              else if (sc.field === 2) scopeSpans.scope.version = str(sc, 'InstrumentationScope.version');
              else if (sc.field === 3) attrs.push(sc);
            }
            scopeSpans.scope.attributes = decodeKeyValues(attrs);
          } else if (s.field === 2) scopeSpans.spans.push(decodeSpan(s.bytes as Buffer));
        }
        entry.scopeSpans.push(scopeSpans);
      }
    }
    resourceSpans.push(entry);
  }
  return { resourceSpans };
}

/** every span of a decoded request with its resource attributes, in order */
export function spansOf(
  request: DecodedExportRequest,
): Array<DecodedSpan & { resource: Record<string, DecodedValue>; scope: DecodedScope }> {
  return request.resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) =>
      ss.spans.map((span) => ({ ...span, resource: rs.resource.attributes, scope: ss.scope })),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// the HTTP collector
// ---------------------------------------------------------------------------------------------

export interface OtlpCollectorRequest {
  method: string;
  /** the request target as sent: the path and its query */
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** the body decoded as an ExportTraceServiceRequest; undefined when it is not one */
  decoded?: DecodedExportRequest;
}

export interface OtlpCollectorReply {
  status: number;
  body?: string | Buffer;
  /** extra response headers (a `location` for a redirect); content-type defaults to application/x-protobuf */
  headers?: Record<string, string>;
}

export interface OtlpCollector {
  /** `http://127.0.0.1:<port>` (or `https://` with `tls`), no trailing slash */
  url: string;
  requests: OtlpCollectorRequest[];
  /** every span received so far, in arrival order */
  spans(): Array<DecodedSpan & { resource: Record<string, DecodedValue>; scope: DecodedScope }>;
  /** the reply every later request gets */
  respondWith(reply: OtlpCollectorReply): void;
  /** resolves once `count` requests were received; rejects after `timeoutMs` (default 10 s) */
  waitForRequests(count: number, timeoutMs?: number): Promise<OtlpCollectorRequest[]>;
  /** resolves once `count` spans were received; rejects after `timeoutMs` (default 10 s) */
  waitForSpans(
    count: number,
    timeoutMs?: number,
  ): Promise<Array<DecodedSpan & { resource: Record<string, DecodedValue>; scope: DecodedScope }>>;
  close(): Promise<void>;
}

export async function startOtlpCollector(
  options: { tls?: { key: string | Buffer; cert: string | Buffer } } = {},
): Promise<OtlpCollector> {
  const requests: OtlpCollectorRequest[] = [];
  let reply: OtlpCollectorReply = { status: 200 };
  const waiters = new Set<() => void>();
  const allSpans = () => requests.flatMap((r) => (r.decoded ? spansOf(r.decoded) : []));

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', () => response.destroy());
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      let decoded: DecodedExportRequest | undefined;
      try {
        decoded = decodeExportTraceServiceRequest(body);
      } catch {
        decoded = undefined;
      }
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body,
        decoded,
      });
      for (const wake of [...waiters]) wake();
      const out = reply.body ?? '';
      response.writeHead(reply.status, {
        'content-type': 'application/x-protobuf',
        ...reply.headers,
        'content-length': Buffer.byteLength(out),
      });
      response.end(out);
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

  const waitFor = <T>(ready: () => T | undefined, describe: () => string, timeoutMs: number) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = ready();
        if (value === undefined) return false;
        clearTimeout(timer);
        waiters.delete(wake);
        resolve(value);
        return true;
      };
      const wake = () => {
        check();
      };
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error(`otlp collector: ${describe()} after ${timeoutMs} ms`));
      }, timeoutMs);
      if (!check()) waiters.add(wake);
    });

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    spans: allSpans,
    respondWith(next: OtlpCollectorReply) {
      reply = next;
    },
    waitForRequests(count: number, timeoutMs = 10_000) {
      return waitFor(
        () => (requests.length >= count ? requests.slice(0, count) : undefined),
        () => `${requests.length} of ${count} requests`,
        timeoutMs,
      );
    },
    waitForSpans(count: number, timeoutMs = 10_000) {
      return waitFor(
        () => {
          const spans = allSpans();
          return spans.length >= count ? spans : undefined;
        },
        () => `${allSpans().length} of ${count} spans`,
        timeoutMs,
      );
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
