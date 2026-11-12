/**
 * P6-65 (S5 C0 stub, L9 fills it): one batch span processor per tenant: ended spans queue (bounded), go out in
 * batches through `exportSpans`, and are flushed on close.
 */
import type { ServiceDeps } from '../../context';
import type { EffectiveOtelSettings } from './settings';
import type { SpanData } from './span';

export interface SpanProcessor {
  onEnd(span: SpanData): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export class BatchSpanProcessor implements SpanProcessor {
  constructor(
    readonly deps: ServiceDeps,
    readonly settings: EffectiveOtelSettings,
  ) {}

  /** stub (L9) */
  onEnd(_span: SpanData): void {
    throw new Error('not implemented (L9)');
  }

  /** stub (L9) */
  forceFlush(): Promise<void> {
    throw new Error('not implemented (L9)');
  }

  /** stub (L9) */
  shutdown(): Promise<void> {
    throw new Error('not implemented (L9)');
  }
}
