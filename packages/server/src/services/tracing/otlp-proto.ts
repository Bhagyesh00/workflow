/**
 * P6-65 (S5 L9): our own protobuf encoder of OTLP `ExportTraceServiceRequest` (no SDK), shared by the HTTP exporter
 * (L9) and the gRPC exporter (L13). Messages: ExportTraceServiceRequest, ResourceSpans, Resource, ScopeSpans,
 * InstrumentationScope, Span, Span.Event, Span.Link, Status, KeyValue, AnyValue (string, bool, int, double, array,
 * kvlist, bytes), ArrayValue, KeyValueList. Every field number comes from `OTLP_FIELDS`, the one table, written from
 * the public opentelemetry-proto files. Times are fixed64 Unix nanoseconds, ids raw bytes.
 */
import type { SpanAttributes, SpanData, SpanEvent, SpanKind, SpanLink, SpanStatus } from './span';

export interface OtlpResource {
  attributes: SpanAttributes;
}

/** the instrumentation scope the spans are sent under */
export interface OtlpScope {
  name: string;
  version?: string;
}

/** an attribute value as OTLP's AnyValue: a plain object is a kvlist, a Uint8Array bytes, a bigint an int */
export type OtlpValue =
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  | null
  | undefined
  | OtlpValue[]
  | { [key: string]: OtlpValue };

/** field numbers of opentelemetry-proto (collector/trace/v1, trace/v1, common/v1, resource/v1): the one table */
export const OTLP_FIELDS = {
  ExportTraceServiceRequest: { resource_spans: 1 },
  ResourceSpans: { resource: 1, scope_spans: 2, schema_url: 3 },
  Resource: { attributes: 1, dropped_attributes_count: 2 },
  ScopeSpans: { scope: 1, spans: 2, schema_url: 3 },
  InstrumentationScope: { name: 1, version: 2, attributes: 3, dropped_attributes_count: 4 },
  Span: {
    trace_id: 1,
    span_id: 2,
    trace_state: 3,
    parent_span_id: 4,
    name: 5,
    kind: 6,
    start_time_unix_nano: 7,
    end_time_unix_nano: 8,
    attributes: 9,
    dropped_attributes_count: 10,
    events: 11,
    dropped_events_count: 12,
    links: 13,
    dropped_links_count: 14,
    status: 15,
    flags: 16,
  },
  Event: { time_unix_nano: 1, name: 2, attributes: 3, dropped_attributes_count: 4 },
  Link: { trace_id: 1, span_id: 2, trace_state: 3, attributes: 4, dropped_attributes_count: 5, flags: 6 },
  Status: { message: 2, code: 3 },
  KeyValue: { key: 1, value: 2 },
  AnyValue: {
    string_value: 1,
    bool_value: 2,
    int_value: 3,
    double_value: 4,
    array_value: 5,
    kvlist_value: 6,
    bytes_value: 7,
  },
  ArrayValue: { values: 1 },
  KeyValueList: { values: 1 },
} as const;

/** Span.SpanKind (0 is SPAN_KIND_UNSPECIFIED) */
export const OTLP_SPAN_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/** Status.StatusCode */
export const OTLP_STATUS_CODE: Record<SpanStatus['code'], number> = { unset: 0, ok: 1, error: 2 };

const DEFAULT_SCOPE: OtlpScope = { name: 'workflow' };

/** protobuf wire types */
const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

const utf8 = new TextEncoder();

/** a growable protobuf writer */
class ProtoWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  /** an unsigned varint of a non-negative safe integer */
  private uvarint(value: number): void {
    this.reserve(10);
    let v = value;
    while (v > 0x7f) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  /** an int64 as a varint (two's complement: a negative value takes 10 bytes) */
  private varint64(value: bigint): void {
    this.reserve(10);
    let v = BigInt.asUintN(64, value);
    while (v > 0x7fn) {
      this.buf[this.pos++] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    this.buf[this.pos++] = Number(v);
  }

  private tag(field: number, wire: number): void {
    this.uvarint(field * 8 + wire);
  }

  uint(field: number, value: number): this {
    this.tag(field, VARINT);
    this.uvarint(value);
    return this;
  }

  int64(field: number, value: bigint): this {
    this.tag(field, VARINT);
    this.varint64(value);
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.uint(field, value ? 1 : 0);
  }

  fixed64(field: number, value: bigint): this {
    this.tag(field, I64);
    this.reserve(8);
    this.view.setBigUint64(this.pos, BigInt.asUintN(64, value), true);
    this.pos += 8;
    return this;
  }

  fixed32(field: number, value: number): this {
    this.tag(field, I32);
    this.reserve(4);
    this.view.setUint32(this.pos, value >>> 0, true);
    this.pos += 4;
    return this;
  }

  double(field: number, value: number): this {
    this.tag(field, I64);
    this.reserve(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, LEN);
    this.uvarint(value.length);
    this.reserve(value.length);
    this.buf.set(value, this.pos);
    this.pos += value.length;
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, utf8.encode(value));
  }

  /** a nested message, written by `write` into its own writer */
  message(field: number, write: (w: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    write(inner);
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function writeAnyValue(w: ProtoWriter, value: OtlpValue): void {
  const F = OTLP_FIELDS.AnyValue;
  if (value === null || value === undefined) return;
  if (typeof value === 'string') w.string(F.string_value, value);
  else if (typeof value === 'boolean') w.bool(F.bool_value, value);
  else if (typeof value === 'bigint') w.int64(F.int_value, value);
  else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) w.int64(F.int_value, BigInt(value));
    else w.double(F.double_value, value);
  } else if (value instanceof Uint8Array) w.bytes(F.bytes_value, value);
  else if (Array.isArray(value)) {
    w.message(F.array_value, (array) => {
      for (const item of value) array.message(OTLP_FIELDS.ArrayValue.values, (v) => writeAnyValue(v, item));
    });
  } else {
    w.message(F.kvlist_value, (list) => writeKeyValues(list, OTLP_FIELDS.KeyValueList.values, value));
  }
}

function writeKeyValues(w: ProtoWriter, field: number, attributes: Record<string, OtlpValue>): void {
  for (const [key, value] of Object.entries(attributes)) {
    w.message(field, (kv) => {
      kv.string(OTLP_FIELDS.KeyValue.key, key);
      kv.message(OTLP_FIELDS.KeyValue.value, (v) => writeAnyValue(v, value));
    });
  }
}

/** one AnyValue message (the encoder's attribute values; exported for the round-trip test) */
export function encodeAnyValue(value: OtlpValue): Uint8Array {
  const w = new ProtoWriter();
  writeAnyValue(w, value);
  return w.finish();
}

function writeEvent(w: ProtoWriter, event: SpanEvent): void {
  const F = OTLP_FIELDS.Event;
  w.fixed64(F.time_unix_nano, event.timeUnixNano);
  w.string(F.name, event.name);
  writeKeyValues(w, F.attributes, event.attributes);
}

function writeLink(w: ProtoWriter, link: SpanLink): void {
  const F = OTLP_FIELDS.Link;
  w.bytes(F.trace_id, hexBytes(link.context.traceId));
  w.bytes(F.span_id, hexBytes(link.context.spanId));
  if (link.context.traceState) w.string(F.trace_state, link.context.traceState);
  writeKeyValues(w, F.attributes, link.attributes ?? {});
  w.fixed32(F.flags, link.context.traceFlags & 0xff);
}

function writeSpan(w: ProtoWriter, span: SpanData): void {
  const F = OTLP_FIELDS.Span;
  w.bytes(F.trace_id, hexBytes(span.context.traceId));
  w.bytes(F.span_id, hexBytes(span.context.spanId));
  if (span.context.traceState) w.string(F.trace_state, span.context.traceState);
  if (span.parentSpanId) w.bytes(F.parent_span_id, hexBytes(span.parentSpanId));
  w.string(F.name, span.name);
  w.uint(F.kind, OTLP_SPAN_KIND[span.kind] ?? OTLP_SPAN_KIND.internal);
  w.fixed64(F.start_time_unix_nano, span.startTimeUnixNano);
  // a span still open is sent with its start as its end
  w.fixed64(F.end_time_unix_nano, span.endTimeUnixNano ?? span.startTimeUnixNano);
  writeKeyValues(w, F.attributes, span.attributes);
  for (const event of span.events) w.message(F.events, (e) => writeEvent(e, event));
  for (const link of span.links) w.message(F.links, (l) => writeLink(l, link));
  const code = OTLP_STATUS_CODE[span.status.code] ?? 0;
  if (code !== 0 || span.status.message) {
    w.message(F.status, (s) => {
      if (span.status.message) s.string(OTLP_FIELDS.Status.message, span.status.message);
      if (code !== 0) s.uint(OTLP_FIELDS.Status.code, code);
    });
  }
  w.fixed32(F.flags, span.context.traceFlags & 0xff);
}

/** one ExportTraceServiceRequest: one ResourceSpans holding one ScopeSpans with every span */
export function encodeExportTraceServiceRequest(
  resource: OtlpResource,
  spans: SpanData[],
  scope: OtlpScope = DEFAULT_SCOPE,
): Uint8Array {
  const w = new ProtoWriter();
  w.message(OTLP_FIELDS.ExportTraceServiceRequest.resource_spans, (rs) => {
    rs.message(OTLP_FIELDS.ResourceSpans.resource, (r) =>
      writeKeyValues(r, OTLP_FIELDS.Resource.attributes, resource.attributes),
    );
    rs.message(OTLP_FIELDS.ResourceSpans.scope_spans, (ss) => {
      ss.message(OTLP_FIELDS.ScopeSpans.scope, (s) => {
        s.string(OTLP_FIELDS.InstrumentationScope.name, scope.name);
        if (scope.version) s.string(OTLP_FIELDS.InstrumentationScope.version, scope.version);
      });
      for (const span of spans) ss.message(OTLP_FIELDS.ScopeSpans.spans, (sp) => writeSpan(sp, span));
    });
  });
  return w.finish();
}
