/**
 * P6-66 (S5 C0 stub, L10 fills it): a run's trace context (traceparent, tracestate, baggage, identity) stored in
 * `executions.tracing_context` once per segment, so a resume, a sub-workflow or an error workflow in any process
 * continues the trace (through C0b's `setTracingContext` and `tracingContextOf`).
 */
import type { ServiceDeps } from '../../context';
import type { TracingContextRow } from '../../db/schema';

/** stub (L10) */
export function saveTracingContext(
  _deps: ServiceDeps,
  _tenantId: string,
  _executionId: string,
  _value: TracingContextRow,
): Promise<void> {
  throw new Error('not implemented (L10)');
}

/** stub (L10): null when the run has none */
export function loadTracingContext(
  _deps: ServiceDeps,
  _tenantId: string,
  _executionId: string,
): Promise<TracingContextRow | null> {
  throw new Error('not implemented (L10)');
}
