/**
 * P6-65 (S5 L9): our OTLP protobuf encoder. The field numbers below are written from the public opentelemetry-proto
 * files (collector/trace/v1/trace_service.proto, trace/v1/trace.proto, common/v1/common.proto,
 * resource/v1/resource.proto); the encoder keeps them in one table, and the test decoder (test/fakes/otlp.ts) reads
 * with its own numbers, so a round trip proves the bytes follow the spec. No network.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeAnyValue,
  encodeExportTraceServiceRequest,
  OTLP_FIELDS,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
} from '../src/services/tracing/otlp-proto';
import type { SpanData } from '../src/services/tracing/span';
import { decodeAnyValue, decodeExportTraceServiceRequest, readFields, spansOf } from './fakes/otlp';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const PARENT = '00f067aa0ba902b7';
const OTHER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER_SPAN = '53995c3f42cd8ad8';

function fullSpan(): SpanData {
  return {
    tenantId: 'tenant-1',
    name: 'workflow.execute',
    kind: 'server',
    context: { traceId: TRACE, spanId: SPAN, traceFlags: 1, traceState: 'vendor=abc,other=x' },
    parentSpanId: PARENT,
    // beyond 2^53 and with the top bit of a 32-bit half set: fixed64 must keep every bit
    startTimeUnixNano: 1_762_000_000_123_456_789n,
    endTimeUnixNano: 18_446_744_073_709_551_615n,
    attributes: {
      'workflow.id': 'wf-1',
      'workflow.name': 'Zürich ✓ flow',
      'node.count': 3,
      'execution.negative': -42,
      'execution.ratio': 0.25,
      'execution.big': 9_007_199_254_740_991,
      'workflow.active': true,
      'workflow.archived': false,
      'workflow.empty': '',
    },
    events: [
      {
        name: 'exception',
        timeUnixNano: 1_762_000_000_200_000_000n,
        attributes: { 'exception.type': 'Error' },
      },
      { name: 'marker', timeUnixNano: 1n, attributes: {} },
    ],
    links: [
      {
        context: { traceId: OTHER_TRACE, spanId: OTHER_SPAN, traceFlags: 1, traceState: 'k=v' },
        attributes: { 'continuation.reason': 'wait' },
      },
      { context: { traceId: OTHER_TRACE, spanId: PARENT, traceFlags: 0 } },
    ],
    status: { code: 'error', message: 'Node failed' },
  };
}

describe('OTLP field numbers (one table, as the public spec)', () => {
  it('the encoder table equals the field numbers of the opentelemetry-proto files', () => {
    expect(OTLP_FIELDS).toEqual({
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
    });
    expect(OTLP_SPAN_KIND).toEqual({ internal: 1, server: 2, client: 3, producer: 4, consumer: 5 });
    expect(OTLP_STATUS_CODE).toEqual({ unset: 0, ok: 1, error: 2 });
  });
});

describe('ExportTraceServiceRequest round trip', () => {
  it('every span field survives encode and decode', () => {
    const bytes = encodeExportTraceServiceRequest(
      { attributes: { 'service.name': 'workflow', 'service.version': '1.2.3', 'instance.role': 'main' } },
      [fullSpan()],
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = decodeExportTraceServiceRequest(bytes);
    expect(decoded.resourceSpans).toHaveLength(1);
    expect(decoded.resourceSpans[0].resource.attributes).toEqual({
      'service.name': 'workflow',
      'service.version': '1.2.3',
      'instance.role': 'main',
    });
    expect(decoded.resourceSpans[0].scopeSpans).toHaveLength(1);
    expect(decoded.resourceSpans[0].scopeSpans[0].scope.name).toBe('workflow');

    const [span] = spansOf(decoded);
    expect(span.traceId).toBe(TRACE);
    expect(span.spanId).toBe(SPAN);
    expect(span.traceState).toBe('vendor=abc,other=x');
    expect(span.parentSpanId).toBe(PARENT);
    expect(span.name).toBe('workflow.execute');
    expect(span.kind).toBe(2);
    expect(span.startTimeUnixNano).toBe(1_762_000_000_123_456_789n);
    expect(span.endTimeUnixNano).toBe(18_446_744_073_709_551_615n);
    expect(span.attributes).toEqual({
      'workflow.id': 'wf-1',
      'workflow.name': 'Zürich ✓ flow',
      'node.count': 3n,
      'execution.negative': -42n,
      'execution.ratio': 0.25,
      'execution.big': 9_007_199_254_740_991n,
      'workflow.active': true,
      'workflow.archived': false,
      'workflow.empty': '',
    });
    expect(span.events).toEqual([
      {
        name: 'exception',
        timeUnixNano: 1_762_000_000_200_000_000n,
        attributes: { 'exception.type': 'Error' },
      },
      { name: 'marker', timeUnixNano: 1n, attributes: {} },
    ]);
    expect(span.links).toEqual([
      {
        traceId: OTHER_TRACE,
        spanId: OTHER_SPAN,
        traceState: 'k=v',
        attributes: { 'continuation.reason': 'wait' },
        flags: 1,
      },
      { traceId: OTHER_TRACE, spanId: PARENT, traceState: '', attributes: {}, flags: 0 },
    ]);
    expect(span.status).toEqual({ code: 2, message: 'Node failed' });
    expect(span.flags & 0xff).toBe(1);
  });

  it('times are fixed64 (wire type 1) and ids are 16 and 8 raw bytes', () => {
    const bytes = encodeExportTraceServiceRequest({ attributes: {} }, [fullSpan()]);
    const [resourceSpans] = readFields(bytes);
    const scopeSpans = readFields(resourceSpans.bytes as Buffer).find((f) => f.field === 2);
    const spanField = readFields(scopeSpans?.bytes as Buffer).find((f) => f.field === 2);
    const fields = readFields(spanField?.bytes as Buffer);
    const byNumber = (n: number) => fields.find((f) => f.field === n);
    expect(byNumber(7)?.wire).toBe(1);
    expect(byNumber(8)?.wire).toBe(1);
    expect(byNumber(1)?.bytes).toHaveLength(16);
    expect(byNumber(2)?.bytes).toHaveLength(8);
    expect(byNumber(4)?.bytes).toHaveLength(8);
    expect(byNumber(16)?.wire).toBe(5);
  });

  it('every kind and status code, a root span and an open span', () => {
    const kinds = ['internal', 'server', 'client', 'producer', 'consumer'] as const;
    const statuses = ['unset', 'ok', 'error'] as const;
    const spans: SpanData[] = kinds.map((kind, i) => ({
      ...fullSpan(),
      kind,
      parentSpanId: undefined,
      context: { traceId: TRACE, spanId: `000000000000000${i + 1}`, traceFlags: 1 },
      endTimeUnixNano: i === 0 ? undefined : 5n,
      attributes: {},
      events: [],
      links: [],
      status: { code: statuses[i % 3] },
    }));
    const decoded = spansOf(
      decodeExportTraceServiceRequest(encodeExportTraceServiceRequest({ attributes: {} }, spans)),
    );
    expect(decoded.map((s) => s.kind)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded.map((s) => s.status.code)).toEqual([0, 1, 2, 0, 1]);
    expect(decoded.every((s) => s.parentSpanId === '' && s.traceState === '')).toBe(true);
    // an open span is sent with its start as its end
    expect(decoded[0].endTimeUnixNano).toBe(decoded[0].startTimeUnixNano);
  });

  it('an empty batch encodes one resource and no spans', () => {
    const decoded = decodeExportTraceServiceRequest(
      encodeExportTraceServiceRequest({ attributes: { 'service.name': 'x' } }, []),
    );
    expect(spansOf(decoded)).toEqual([]);
    expect(decoded.resourceSpans[0].resource.attributes).toEqual({ 'service.name': 'x' });
  });
});

describe('AnyValue: every type', () => {
  it('string, bool, int, double, array, kvlist and bytes', () => {
    expect(decodeAnyValue(encodeAnyValue('hello'))).toBe('hello');
    expect(decodeAnyValue(encodeAnyValue(''))).toBe('');
    expect(decodeAnyValue(encodeAnyValue(true))).toBe(true);
    expect(decodeAnyValue(encodeAnyValue(false))).toBe(false);
    expect(decodeAnyValue(encodeAnyValue(0))).toBe(0n);
    expect(decodeAnyValue(encodeAnyValue(300))).toBe(300n);
    expect(decodeAnyValue(encodeAnyValue(-1))).toBe(-1n);
    expect(decodeAnyValue(encodeAnyValue(-9_223_372_036_854_775_808n))).toBe(-9_223_372_036_854_775_808n);
    expect(decodeAnyValue(encodeAnyValue(9_223_372_036_854_775_807n))).toBe(9_223_372_036_854_775_807n);
    expect(decodeAnyValue(encodeAnyValue(1.5))).toBe(1.5);
    expect(decodeAnyValue(encodeAnyValue(-0.001))).toBe(-0.001);
    expect(decodeAnyValue(encodeAnyValue(Number.NaN))).toBeNaN();
    expect(decodeAnyValue(encodeAnyValue(new Uint8Array([0, 1, 254, 255])))).toEqual(
      Buffer.from([0, 1, 254, 255]),
    );
    expect(decodeAnyValue(encodeAnyValue(['a', 2, false, 2.5, ['nested']]))).toEqual([
      'a',
      2n,
      false,
      2.5,
      ['nested'],
    ]);
    expect(decodeAnyValue(encodeAnyValue([]))).toEqual([]);
    expect(
      decodeAnyValue(
        encodeAnyValue({
          name: 'n',
          count: 7,
          ok: true,
          inner: { list: [1, 'x'] },
          raw: new Uint8Array([9]),
        }),
      ),
    ).toEqual({ name: 'n', count: 7n, ok: true, inner: { list: [1n, 'x'] }, raw: Buffer.from([9]) });
  });

  it('a long string uses a multi-byte length', () => {
    const long = 'x'.repeat(70_000);
    expect(decodeAnyValue(encodeAnyValue(long))).toBe(long);
  });
});
