/**
 * P6-65 (S5 C0 stub, L9 fills it): sends a batch of spans to the tenant's collector, dispatching on
 * `exporterProtocol`: `http/protobuf` through `ctx.http` (the SSRF guard), `grpc` through L13's `exportGrpc`. The
 * header values never reach a log or an error text.
 */
import type { ServiceDeps } from '../../context';
import type { EffectiveOtelSettings } from './settings';
import type { SpanData } from './span';

export interface ExportResult {
  success: boolean;
  /** redacted, at most 1000 characters */
  error?: string;
}

/** stub (L9) */
export function exportSpans(
  _deps: ServiceDeps,
  _settings: EffectiveOtelSettings,
  _spans: SpanData[],
): Promise<ExportResult> {
  throw new Error('not implemented (L9)');
}
