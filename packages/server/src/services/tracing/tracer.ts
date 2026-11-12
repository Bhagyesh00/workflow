/**
 * P6-65 (S5 C0 stub, L9 fills it): one `TracingService` per process: a span processor per tenant (built from its
 * effective settings), span start and end, flush and close. stub (L9): the constructor, `flush` and `close` PASS
 * (the context's `close` calls them); the span methods throw.
 */
import type { ServiceDeps } from '../../context';
import type { SpanProcessor } from './processor';
import type { EffectiveOtelSettings } from './settings';
import type { SpanAttributes, SpanContext, SpanData, SpanKind, SpanLink, SpanStatus } from './span';

export interface StartSpanInput {
  tenantId: string;
  name: string;
  kind?: SpanKind;
  /** the parent span; none = a new root */
  parent?: SpanContext;
  attributes?: SpanAttributes;
  links?: SpanLink[];
  startTimeUnixNano?: bigint;
}

export interface EndSpanInput {
  status?: SpanStatus;
  attributes?: SpanAttributes;
  endTimeUnixNano?: bigint;
}

export class TracingService {
  constructor(readonly deps: ServiceDeps) {}

  /** stub (L9): the tenant's processor, rebuilt when its settings change */
  processorFor(_tenantId: string, _settings: EffectiveOtelSettings): SpanProcessor {
    throw new Error('not implemented (L9)');
  }

  /** stub (L9) */
  startSpan(_input: StartSpanInput): SpanData {
    throw new Error('not implemented (L9)');
  }

  /** stub (L9): ends the span and hands it to its tenant's processor */
  endSpan(_span: SpanData, _input?: EndSpanInput): void {
    throw new Error('not implemented (L9)');
  }

  /** stub (L9): PASSES: exports what every processor holds */
  async flush(): Promise<void> {}

  /** stub (L9): PASSES: flushes and shuts every processor down */
  async close(): Promise<void> {}
}
