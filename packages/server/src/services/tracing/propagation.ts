/**
 * P6-66 (S5 C0 stub, L10 fills it): the trace headers a node sends outbound (`traceparent`, `tracestate`,
 * `baggage`), from its open span.
 */
import type { SpanContext } from './span';

/** stub (L10) */
export function outboundTraceHeaders(_span: SpanContext, _baggage?: string): Record<string, string> {
  throw new Error('not implemented (L10)');
}
