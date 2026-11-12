/**
 * P6-69 (S5 C0 stub, L13 fills it): OTLP over gRPC (HTTP/2, unary `TraceService/Export`) with our own framing (no
 * gRPC library); the socket is pinned through `resolveAllowedHost`.
 */
import type { ServiceDeps } from '../../context';
import type { ExportResult } from './exporter';
import type { EffectiveOtelSettings } from './settings';

/** stub (L13): `body` is an encoded `ExportTraceServiceRequest` */
export function exportGrpc(
  _deps: ServiceDeps,
  _settings: EffectiveOtelSettings,
  _body: Uint8Array,
): Promise<ExportResult> {
  throw new Error('not implemented (L13)');
}
