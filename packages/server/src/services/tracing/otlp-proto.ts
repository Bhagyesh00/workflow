/**
 * P6-65 (S5 C0 stub, L9 fills it): our own protobuf encoder of OTLP `ExportTraceServiceRequest` (no SDK), shared by
 * the HTTP exporter (L9) and the gRPC exporter (L13).
 */
import type { SpanAttributes, SpanData } from './span';

export interface OtlpResource {
  attributes: SpanAttributes;
}

/** stub (L9) */
export function encodeExportTraceServiceRequest(_resource: OtlpResource, _spans: SpanData[]): Uint8Array {
  throw new Error('not implemented (L9)');
}
