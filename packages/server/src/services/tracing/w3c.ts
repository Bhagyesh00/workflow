/**
 * P6-65 (S5 C0 stub, L9 fills it): W3C Trace Context (`traceparent`, `tracestate`) and Baggage headers, parsed and
 * written; a malformed header is ignored, never an error.
 */
import type { SpanContext } from './span';

/** stub (L9): undefined for a missing or malformed header (version 00, all-zero ids refused) */
export function parseTraceparent(_header: string | undefined): SpanContext | undefined {
  throw new Error('not implemented (L9)');
}

/** stub (L9) */
export function formatTraceparent(_context: SpanContext): string {
  throw new Error('not implemented (L9)');
}

/** stub (L9): key to value; malformed members are skipped */
export function parseBaggage(_header: string | undefined): Record<string, string> {
  throw new Error('not implemented (L9)');
}

/** stub (L9) */
export function formatBaggage(_entries: Record<string, string>): string {
  throw new Error('not implemented (L9)');
}
