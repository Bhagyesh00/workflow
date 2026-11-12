/**
 * P6-65 (S5 C0 stub, L9 fills it): the span model the tracer, processor and OTLP encoder share. Times are Unix
 * nanoseconds as bigint (OTLP fixed64).
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
