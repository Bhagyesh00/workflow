/**
 * P6-65 (S5 L9): one `TracingService` per process: a batch span processor per tenant (built from its effective
 * settings, rebuilt when newer settings change them, never by older ones, dropped after 10 idle minutes), span
 * start and end with the tenant's
 * parent-based ratio sampling, one startup probe per tenant per process (a warning with the tenant id and status
 * only), flush and close. A span holds names, ids, counts and status: its status message passes `redactSecrets`
 * and is cut to 1000 characters.
 */
import { createHash } from 'node:crypto';
import { redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { sendExportBody } from './exporter';
import { randomSpanId, randomTraceId } from './ids';
import { BatchSpanProcessor, type BatchSpanProcessorOptions, type SpanProcessor } from './processor';
import { shouldSample } from './sampler';
import type { EffectiveOtelSettings } from './settings';
import {
  isSampled,
  nowUnixNano,
  type SpanAttributes,
  type SpanContext,
  type SpanData,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  TRACE_FLAG_SAMPLED,
} from './span';

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

/** a tenant's processor is dropped after this long without a span or a settings load */
export const IDLE_PROCESSOR_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const STATUS_MESSAGE_MAX_LENGTH = 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

export interface TracingServiceOptions {
  /** default 10 minutes */
  idleMs?: number;
  /** milliseconds clock for the idle check (a test seam) */
  now?: () => number;
  /** false: no startup probe (a test seam) */
  probe?: boolean;
  /** options of every processor (a test seam) */
  processorOptions?: BatchSpanProcessorOptions;
}

interface TenantEntry {
  processor: BatchSpanProcessor;
  /** a hash of the settings the processor was built from */
  key: string;
  settings: EffectiveOtelSettings;
  lastUsed: number;
}

/** the processor a run with superseded settings gets when its tenant has none: its spans go nowhere */
const NO_PROCESSOR: SpanProcessor = Object.freeze({
  onEnd: () => undefined,
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
});

export class TracingService {
  private readonly tenants = new Map<string, TenantEntry>();
  private readonly probed = new Set<string>();
  /**
   * The order settings objects were first handed in. `forTenant` answers one object while its cache holds and a new
   * one after a save, so a later first sight is a newer load; a run hands back the object of its start.
   */
  private readonly loadOrder = new WeakMap<EffectiveOtelSettings, number>();
  private loads = 0;
  /** per tenant, the newest settings handed in: their load order and hash (no setting value) */
  private readonly newest = new Map<string, { order: number; key: string }>();
  /** probes and the shutdowns of replaced or idle processors, awaited by `flush` and `close` */
  private readonly pending = new Set<Promise<unknown>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    readonly deps: ServiceDeps,
    private readonly options: TracingServiceOptions = {},
  ) {}

  /**
   * The tenant's processor, rebuilt when newer settings change it; the first load in this process probes the
   * collector. Settings older than the newest the tenant handed in (a run that started before a save) never rebuild
   * it: they keep the current processor alive, or get none when the tenant has no processor.
   */
  processorFor(tenantId: string, settings: EffectiveOtelSettings): SpanProcessor {
    this.sweepIdle();
    const key = settingsKey(settings);
    const now = this.now();
    const entry = this.tenants.get(tenantId);
    const order = this.orderOf(settings);
    const newest = this.newest.get(tenantId);
    if (newest && order < newest.order && key !== newest.key) {
      if (!entry) return NO_PROCESSOR;
      entry.lastUsed = now;
      return entry.processor;
    }
    if (!newest || order > newest.order) this.newest.set(tenantId, { order, key });
    if (entry && entry.key === key) {
      entry.lastUsed = now;
      entry.settings = settings;
      return entry.processor;
    }
    if (entry) this.track(entry.processor.shutdown());
    const processor = new BatchSpanProcessor(this.deps, settings, this.options.processorOptions);
    this.tenants.set(tenantId, { processor, key, settings, lastUsed: now });
    this.startSweep();
    if (this.options.probe !== false && !this.probed.has(tenantId)) {
      this.probed.add(tenantId);
      this.track(this.probe(tenantId, settings));
    }
    return processor;
  }

  /** a new span: the parent's trace (and its sampled flag), or a new root sampled by the tenant's ratio */
  startSpan(input: StartSpanInput): SpanData {
    const parent =
      input.parent && TRACE_ID.test(input.parent.traceId) && SPAN_ID.test(input.parent.spanId)
        ? input.parent
        : undefined;
    const ratio = this.tenants.get(input.tenantId)?.settings.tracesSampleRate ?? 1;
    const traceId = parent?.traceId ?? randomTraceId();
    const sampled = shouldSample(traceId, ratio, parent ? isSampled(parent) : undefined);
    const context: SpanContext = {
      traceId,
      spanId: randomSpanId(),
      traceFlags: ((parent?.traceFlags ?? 0) & 0xfe) | (sampled ? TRACE_FLAG_SAMPLED : 0),
    };
    if (parent?.traceState) context.traceState = parent.traceState;
    const span: SpanData = {
      tenantId: input.tenantId,
      name: input.name,
      kind: input.kind ?? 'internal',
      context,
      startTimeUnixNano: input.startTimeUnixNano ?? nowUnixNano(),
      attributes: { ...input.attributes },
      events: [],
      links: input.links ? [...input.links] : [],
      status: { code: 'unset' },
    };
    if (parent) span.parentSpanId = parent.spanId;
    return span;
  }

  /** ends the span (once) and hands a sampled one to its tenant's processor; no processor, no export */
  endSpan(span: SpanData, input: EndSpanInput = {}): void {
    if (span.endTimeUnixNano !== undefined) return;
    // bigint nanoseconds (Math.max takes no bigint): an end before the start is the start
    let end = input.endTimeUnixNano ?? nowUnixNano();
    if (end < span.startTimeUnixNano) end = span.startTimeUnixNano;
    span.endTimeUnixNano = end;
    if (input.attributes) Object.assign(span.attributes, input.attributes);
    if (input.status) {
      span.status = input.status.message
        ? {
            code: input.status.code,
            message: redactSecrets(input.status.message).slice(0, STATUS_MESSAGE_MAX_LENGTH),
          }
        : { code: input.status.code };
    }
    if (!isSampled(span.context)) return;
    const entry = this.tenants.get(span.tenantId);
    if (!entry) return;
    entry.lastUsed = this.now();
    entry.processor.onEnd(span);
  }

  /** the tenants holding a processor */
  activeTenants(): string[] {
    return [...this.tenants.keys()];
  }

  /** drops (and flushes) the processors idle for 10 minutes */
  sweepIdle(): void {
    const now = this.now();
    const idleMs = this.options.idleMs ?? IDLE_PROCESSOR_MS;
    for (const [tenantId, entry] of this.tenants) {
      if (now - entry.lastUsed > idleMs) {
        this.tenants.delete(tenantId);
        this.track(entry.processor.shutdown());
      }
    }
  }

  /** exports what every processor holds (and waits for running probes) */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.tenants.values()].map((entry) => entry.processor.forceFlush()));
  }

  /** flushes and shuts every processor down */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const entries = [...this.tenants.values()];
    this.tenants.clear();
    this.newest.clear();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled(entries.map((entry) => entry.processor.shutdown()));
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** when these settings were first handed in (a test passing equal copies gets a new load each time) */
  private orderOf(settings: EffectiveOtelSettings): number {
    let order = this.loadOrder.get(settings);
    if (order === undefined) {
      order = ++this.loads;
      this.loadOrder.set(settings, order);
    }
    return order;
  }

  private startSweep(): void {
    if (this.sweepTimer || this.closed) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined);
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** an empty export with the startup timeout; a failure logs the tenant id and the status only */
  private async probe(tenantId: string, settings: EffectiveOtelSettings): Promise<void> {
    const timeoutMs =
      settings.startupConnectivityTimeoutMs > 0
        ? settings.startupConnectivityTimeoutMs
        : DEFAULT_PROBE_TIMEOUT_MS;
    const outcome = await sendExportBody(this.deps, settings, new Uint8Array(0), timeoutMs);
    if (!outcome.success) {
      this.deps.logger.warn(
        { tenantId, status: outcome.status },
        "Couldn't reach the OpenTelemetry collector at startup",
      );
    }
  }
}

/** a hash of every setting (header values included, never kept as text) */
function settingsKey(settings: EffectiveOtelSettings): string {
  const stable = Object.entries(settings)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => [
      name,
      value && typeof value === 'object' ? Object.entries(value as Record<string, string>).sort() : value,
    ]);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
