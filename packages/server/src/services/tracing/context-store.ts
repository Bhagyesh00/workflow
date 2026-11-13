/**
 * P6-66 (S5 L10): a run's trace context (traceparent, tracestate, baggage, identity) stored in
 * `executions.tracing_context` once per segment, so a resume, a sub-workflow or an error workflow in any process
 * continues the trace (through C0b's `setTracingContext` and `tracingContextOf`). The `traceparent` names the
 * segment's `workflow.execute` span; `identity` holds the execution identity attributes (ids only);
 * `parentSpanId` is that span's parent (a crash rebuilt in another process keeps it).
 */
import type { ServiceDeps } from '../../context';
import type { TracingContextRow } from '../../db/schema';

/** the stored row plus the segment span's parent span id (an id only; the jsonb keeps the extra field) */
export interface StoredTracingContext extends TracingContextRow {
  parentSpanId?: string;
}

const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_SPAN_ID = '0'.repeat(16);

const validSpanId = (value: unknown): value is string =>
  typeof value === 'string' && SPAN_ID.test(value) && value !== ZERO_SPAN_ID;

export function saveTracingContext(
  deps: ServiceDeps,
  tenantId: string,
  executionId: string,
  value: StoredTracingContext,
): Promise<void> {
  const stored: StoredTracingContext = { traceparent: value.traceparent, identity: { ...value.identity } };
  if (value.tracestate) stored.tracestate = value.tracestate;
  if (value.baggage) stored.baggage = value.baggage;
  if (validSpanId(value.parentSpanId)) stored.parentSpanId = value.parentSpanId;
  return deps.repos.executions.setTracingContext(tenantId, executionId, stored);
}

/** null when the run has none (or its row is gone, or it is another tenant's) */
export async function loadTracingContext(
  deps: ServiceDeps,
  tenantId: string,
  executionId: string,
): Promise<StoredTracingContext | null> {
  const row: StoredTracingContext | null = await deps.repos.executions.tracingContextOf(
    tenantId,
    executionId,
  );
  if (!row || typeof row.traceparent !== 'string') return null;
  const identity: Record<string, string> = {};
  if (row.identity && typeof row.identity === 'object') {
    for (const [key, value] of Object.entries(row.identity)) {
      if (typeof value === 'string') identity[key] = value;
    }
  }
  const out: StoredTracingContext = { traceparent: row.traceparent, identity };
  if (typeof row.tracestate === 'string' && row.tracestate) out.tracestate = row.tracestate;
  if (typeof row.baggage === 'string' && row.baggage) out.baggage = row.baggage;
  if (validSpanId(row.parentSpanId)) out.parentSpanId = row.parentSpanId;
  return out;
}
