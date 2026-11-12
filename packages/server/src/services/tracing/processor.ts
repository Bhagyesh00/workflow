/**
 * P6-65 (S5 L9): one batch span processor per tenant, with the OpenTelemetry SDK's batch defaults: ended (sampled)
 * spans queue up to 2048 (more are dropped and counted), go out 512 per export as soon as a full batch waits or
 * 5 s after the first queued span, one export at a time, each given up after 30 s; flushed on shutdown. A failed
 * export logs the tenant id and the span count only (never the error text, a header or a span).
 */
import type { ServiceDeps } from '../../context';
import { EXPORT_TIMEOUT_MS, type ExportResult, exportSpans } from './exporter';
import type { EffectiveOtelSettings } from './settings';
import { isSampled, type SpanData } from './span';

export interface SpanProcessor {
  onEnd(span: SpanData): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BatchSettings {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMs: number;
  exportTimeoutMs: number;
}

/** the OTel SDK's BatchSpanProcessor defaults */
export const BATCH_DEFAULTS: Readonly<BatchSettings> = Object.freeze({
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMs: 5000,
  exportTimeoutMs: EXPORT_TIMEOUT_MS,
});

export interface BatchSpanProcessorOptions extends Partial<BatchSettings> {
  /** replaces `exportSpans` with the tenant's settings (a test seam) */
  exporter?: (spans: SpanData[]) => Promise<ExportResult>;
}

export class BatchSpanProcessor implements SpanProcessor {
  private readonly batch: BatchSettings;
  private readonly exporter: (spans: SpanData[]) => Promise<ExportResult>;
  private queue: SpanData[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the running export loop */
  private exporting: Promise<void> | undefined;
  private dropped = 0;
  private droppedSinceLog = 0;
  private shut = false;

  constructor(
    readonly deps: ServiceDeps,
    readonly settings: EffectiveOtelSettings,
    options: BatchSpanProcessorOptions = {},
  ) {
    const { exporter, ...batch } = options;
    this.batch = { ...BATCH_DEFAULTS, ...definedOnly(batch) };
    this.exporter =
      exporter ?? ((spans) => exportSpans(deps, settings, spans, { timeoutMs: this.batch.exportTimeoutMs }));
  }

  /** spans waiting for export */
  get queued(): number {
    return this.queue.length;
  }

  /** spans dropped because the queue was full, since the processor started */
  get droppedSpans(): number {
    return this.dropped;
  }

  onEnd(span: SpanData): void {
    if (this.shut || !isSampled(span.context)) return;
    if (this.queue.length >= this.batch.maxQueueSize) {
      this.dropped++;
      this.droppedSinceLog++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.batch.maxExportBatchSize) void this.run(false);
    else this.schedule();
  }

  async forceFlush(): Promise<void> {
    while (this.exporting || this.queue.length) {
      await this.run(true);
    }
  }

  async shutdown(): Promise<void> {
    this.shut = true;
    await this.forceFlush();
    this.clearTimer();
  }

  private schedule(): void {
    if (this.timer || this.exporting || this.shut) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(false);
    }, this.batch.scheduledDelayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** starts the export loop (on a microtask, never inside `onEnd`) unless it runs; resolves when it ends */
  private run(all: boolean): Promise<void> {
    if (!this.exporting) {
      this.clearTimer();
      this.exporting = Promise.resolve()
        .then(() => this.drain(all))
        .finally(() => {
          this.exporting = undefined;
          this.afterDrain();
        });
    }
    return this.exporting;
  }

  /** one batch, then more while a full batch waits (or, flushing, while anything waits) */
  private async drain(all: boolean): Promise<void> {
    do {
      const batch = this.queue.splice(0, this.batch.maxExportBatchSize);
      if (!batch.length) break;
      await this.exportBatch(batch);
    } while (this.queue.length >= this.batch.maxExportBatchSize || (all && this.queue.length > 0));
  }

  private afterDrain(): void {
    if (!this.queue.length || this.shut) return;
    if (this.queue.length >= this.batch.maxExportBatchSize) void this.run(false);
    else this.schedule();
  }

  private async exportBatch(batch: SpanData[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ExportResult>((resolve) => {
      timer = setTimeout(() => resolve({ success: false }), this.batch.exportTimeoutMs);
      timer.unref?.();
    });
    let result: ExportResult;
    try {
      result = await Promise.race([this.exporter(batch), timeout]);
    } catch {
      result = { success: false };
    } finally {
      clearTimeout(timer);
    }
    const { tenantId } = this.settings;
    if (!result.success) {
      this.deps.logger.warn(
        { tenantId, spans: batch.length },
        "Couldn't export spans to the OpenTelemetry collector",
      );
    }
    if (this.droppedSinceLog) {
      this.deps.logger.warn(
        { tenantId, dropped: this.droppedSinceLog },
        'The OpenTelemetry span queue was full: spans were dropped',
      );
      this.droppedSinceLog = 0;
    }
  }
}

function definedOnly(values: Partial<BatchSettings>): Partial<BatchSettings> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0),
  ) as Partial<BatchSettings>;
}
