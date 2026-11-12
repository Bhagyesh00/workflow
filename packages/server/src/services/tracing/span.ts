/**
 * P6-65 (S5 L9): the span model the tracer, processor and OTLP encoder share. Times are Unix nanoseconds as bigint
 * (OTLP fixed64). A span holds names, ids, counts and status only: never node input or output, a credential, a
 * header value, a request body or a stack.
 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface SpanContext {
  /** 32 lowercase hex characters */
  traceId: string;
  /** 16 lowercase hex characters */
  spanId: string;
  /** W3C trace flags (bit 0: sampled) */
  traceFlags: number;
  traceState?: string;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: SpanAttributes;
}

export interface SpanLink {
  context: SpanContext;
  attributes?: SpanAttributes;
}

export interface SpanStatus {
  code: 'unset' | 'ok' | 'error';
  message?: string;
}

export interface SpanData {
  tenantId: string;
  name: string;
  kind: SpanKind;
  context: SpanContext;
  parentSpanId?: string;
  startTimeUnixNano: bigint;
  /** undefined while the span is open */
  endTimeUnixNano?: bigint;
  attributes: SpanAttributes;
  events: SpanEvent[];
  links: SpanLink[];
  status: SpanStatus;
}

/** W3C trace flags bit 0 */
export const TRACE_FLAG_SAMPLED = 0x01;

/** whether a span context carries the sampled flag */
export function isSampled(context: SpanContext): boolean {
  return (context.traceFlags & TRACE_FLAG_SAMPLED) === TRACE_FLAG_SAMPLED;
}

// the wall clock at load, then the monotonic clock: nanosecond steps that never go back within a process
const CLOCK_BASE_NS = BigInt(Date.now()) * 1_000_000n;
const CLOCK_BASE_HR = process.hrtime.bigint();

/** the current time in Unix nanoseconds */
export function nowUnixNano(): bigint {
  return CLOCK_BASE_NS + (process.hrtime.bigint() - CLOCK_BASE_HR);
}
