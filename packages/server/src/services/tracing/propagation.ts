/**
 * P6-66 (S5 L10): the trace headers a node sends outbound (`traceparent`, `tracestate`, `baggage`), from its open
 * span, and the inbound `baggage` a run keeps: every key under our reserved attribute roots is dropped (as n8n
 * drops its `n8n.` keys), so a caller can never pass itself off as a workflow, execution, node, project, workspace
 * instance or service.
 */
import type { SpanContext } from './span';
import { formatBaggage, formatTraceparent, parseBaggage } from './w3c';

/** baggage keys under these roots never pass through a run */
export const RESERVED_BAGGAGE_ROOTS = [
  'workflow.',
  'execution.',
  'node.',
  'project.',
  'instance.',
  'service.',
] as const;

function reserved(key: string): boolean {
  const lower = key.toLowerCase();
  return RESERVED_BAGGAGE_ROOTS.some((root) => lower.startsWith(root));
}

/**
 * The inbound `baggage` header a run keeps and forwards: parsed (malformed members skipped, limits kept), the
 * reserved keys dropped and written again; undefined when nothing is left.
 */
export function inboundBaggage(header: string | undefined): string | undefined {
  const entries = parseBaggage(header);
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!reserved(key)) kept[key] = value;
  }
  const formatted = formatBaggage(kept);
  return formatted || undefined;
}

/** the W3C headers of a span: `traceparent` always, `tracestate` and `baggage` when there are any */
export function outboundTraceHeaders(span: SpanContext, baggage?: string): Record<string, string> {
  const headers: Record<string, string> = { traceparent: formatTraceparent(span) };
  if (span.traceState) headers.tracestate = span.traceState;
  if (baggage) headers.baggage = baggage;
  return headers;
}
