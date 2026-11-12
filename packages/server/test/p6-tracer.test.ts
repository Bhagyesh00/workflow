/**
 * P6-65 (S5 L9): trace and span ids, W3C Trace Context and Baggage, the parent-based ratio sampler, the per-tenant
 * batch span processor and the `TracingService` (span start and end, processors per tenant, idle drop, the startup
 * probe). No database: the deps are a fake with its own `HttpClient` (127.0.0.1 allowed for the fake collector).
 * Header values are fixed fakes and never printed.
 */
import { HttpClient } from '@workflow/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext, ServiceDeps } from '../src/context';
import { randomSpanId, randomTraceId } from '../src/services/tracing/ids';
import { BATCH_DEFAULTS, BatchSpanProcessor } from '../src/services/tracing/processor';
import { shouldSample } from '../src/services/tracing/sampler';
import type { EffectiveOtelSettings } from '../src/services/tracing/settings';
import type { SpanData } from '../src/services/tracing/span';
import { IDLE_PROCESSOR_MS, TracingService } from '../src/services/tracing/tracer';
import {
  BAGGAGE_MAX_BYTES,
  BAGGAGE_MAX_ENTRIES,
  formatBaggage,
  formatTraceparent,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  TRACESTATE_MAX_ENTRIES,
  TRACESTATE_MAX_LENGTH,
} from '../src/services/tracing/w3c';
import { startOtlpCollector } from './fakes/otlp';

const HEADER_VALUE = 'fake-header-value-l9-tracer';

function fakeLogger() {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeDeps(http: HttpClient = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } })) {
  const logger = fakeLogger();
  const deps = {
    config: { version: '9.8.7' },
    logger,
    context: () => ({ http, instance: { id: 'instance-1', role: 'main' } }) as unknown as ServerContext,
  } as unknown as ServiceDeps;
  return { deps, logger };
}

function settingsFor(endpoint: string, over: Partial<EffectiveOtelSettings> = {}): EffectiveOtelSettings {
  return {
    tenantId: 'tenant-a',
    enabled: true,
    exporterProtocol: 'http/protobuf',
    exporterEndpoint: endpoint,
    exporterTracingPath: '/v1/traces',
    exporterServiceName: 'workflow',
    tracesSampleRate: 1,
    startupConnectivityTimeoutMs: 2000,
    includeNodeSpans: true,
    emitWorkflowStartSpan: false,
    emitNodeStartSpan: false,
    injectOutbound: true,
    productionExecutionsOnly: false,
    headers: { 'x-api-key': HEADER_VALUE },
    ...over,
  };
}

function span(i: number, traceFlags = 1): SpanData {
  return {
    tenantId: 'tenant-a',
    name: `span-${i}`,
    kind: 'internal',
    context: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: randomSpanId(), traceFlags },
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    attributes: {},
    events: [],
    links: [],
    status: { code: 'unset' },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ids', () => {
  it('trace ids are 16 random bytes and span ids 8, lowercase hex, never all zero', () => {
    const traces = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = randomTraceId();
      const s = randomSpanId();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(s).toMatch(/^[0-9a-f]{16}$/);
      expect(t).not.toBe('0'.repeat(32));
      expect(s).not.toBe('0'.repeat(16));
      traces.add(t);
    }
    expect(traces.size).toBe(200);
  });
});

describe('W3C traceparent and tracestate', () => {
  const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  it('parses and formats version 00', () => {
    const ctx = parseTraceparent(header);
    expect(ctx).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    });
    expect(formatTraceparent(ctx as NonNullable<typeof ctx>)).toBe(header);
    expect(parseTraceparent(`  ${header}  `)?.spanId).toBe('b7ad6b7169203331');
    expect(formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 })).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`,
    );
  });

  it('ignores missing and malformed headers (never an error)', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      header.toUpperCase(),
      `00-${'0'.repeat(32)}-b7ad6b7169203331-01`,
      `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`,
      `ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`,
      `${header}-extra`,
      '00-0af7651916cd43dd8448eb211c80319-b7ad6b7169203331-01',
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1',
      '00_0af7651916cd43dd8448eb211c80319c_b7ad6b7169203331_01',
    ]) {
      expect(parseTraceparent(bad)).toBeUndefined();
    }
  });

  it('a later version keeps the four known fields and ignores what follows', () => {
    expect(parseTraceparent('cc-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-09-whatever')).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 9,
    });
    expect(parseTraceparent('cc-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-09x')).toBeUndefined();
  });

  it('tracestate: valid members kept, at most 32 entries and 512 characters', () => {
    expect(parseTracestate('rojo=00f067aa0ba902b7, congo=t61rcWkgMzE')).toBe(
      'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
    );
    expect(parseTracestate('tenant@vendor=1,bad key=2,=x,ok=')).toBe('tenant@vendor=1');
    expect(parseTracestate(undefined)).toBeUndefined();
    expect(parseTracestate('')).toBeUndefined();
    const many = Array.from({ length: 40 }, (_, i) => `k${i}=v${i}`).join(',');
    const kept = parseTracestate(many) as string;
    expect(kept.split(',')).toHaveLength(TRACESTATE_MAX_ENTRIES);
    expect(kept.startsWith('k0=v0,k1=v1')).toBe(true);
    // over 512 characters: entries over 128 characters go first, then from the end
    const big = `big=${'x'.repeat(200)}`;
    const small = Array.from({ length: 20 }, (_, i) => `s${i}=${'y'.repeat(20)}`);
    const trimmed = parseTracestate([small[0], big, ...small.slice(1)].join(',')) as string;
    expect(trimmed.length).toBeLessThanOrEqual(TRACESTATE_MAX_LENGTH);
    expect(trimmed).not.toContain('big=');
    expect(trimmed.startsWith('s0=')).toBe(true);
    expect(TRACESTATE_MAX_ENTRIES).toBe(32);
    expect(TRACESTATE_MAX_LENGTH).toBe(512);
  });
});

describe('W3C baggage', () => {
  it('parses members, decodes values, drops properties and malformed members', () => {
    expect(parseBaggage('userId=alice, serverNode=DF%2028,isProduction=false;prop=1,bad,=x,k=')).toEqual({
      userId: 'alice',
      serverNode: 'DF 28',
      isProduction: 'false',
      k: '',
    });
    expect(parseBaggage(undefined)).toEqual({});
    expect(parseBaggage('a=%E0%A4%A')).toEqual({});
  });

  it('at most 180 entries and 8192 bytes', () => {
    const many = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(',');
    expect(Object.keys(parseBaggage(many))).toHaveLength(BAGGAGE_MAX_ENTRIES);
    expect(parseBaggage(`a=${'x'.repeat(BAGGAGE_MAX_BYTES)}`)).toEqual({});
    expect(BAGGAGE_MAX_ENTRIES).toBe(180);
    expect(BAGGAGE_MAX_BYTES).toBe(8192);
  });

  it('formats with percent-encoded values, within the limits, and round trips', () => {
    const text = formatBaggage({ userId: 'alice', note: 'a b,c;d=é' });
    expect(text).toBe('userId=alice,note=a%20b%2Cc%3Bd%3D%C3%A9');
    expect(parseBaggage(text)).toEqual({ userId: 'alice', note: 'a b,c;d=é' });
    expect(formatBaggage({ 'bad key': 'x', ok: 'y' })).toBe('ok=y');
    const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'v'.repeat(60)]));
    const out = formatBaggage(entries);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(BAGGAGE_MAX_BYTES);
    expect(out.split(',').length).toBeLessThanOrEqual(BAGGAGE_MAX_ENTRIES);
  });
});

describe('sampler (parent based, trace id ratio on the low 8 bytes)', () => {
  const low = (hex16: string) => `${'f'.repeat(16)}${hex16}`;

  it('ratio 0 never and 1 always samples a root', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomTraceId();
      expect(shouldSample(id, 0)).toBe(false);
      expect(shouldSample(id, 1)).toBe(true);
    }
  });

  it('a root is sampled when its low 63 bits fall under ratio x 2^63', () => {
    expect(shouldSample(low('0000000000000000'), 0.5)).toBe(true);
    expect(shouldSample(low('3fffffffffffffff'), 0.5)).toBe(true);
    expect(shouldSample(low('4000000000000000'), 0.5)).toBe(false);
    expect(shouldSample(low('7fffffffffffffff'), 0.5)).toBe(false);
    // the top bit of the low 8 bytes is not used
    expect(shouldSample(low('8000000000000000'), 0.5)).toBe(true);
    // the high 8 bytes are not used
    expect(shouldSample(`${'0'.repeat(16)}4000000000000000`, 0.5)).toBe(false);
    let kept = 0;
    for (let i = 0; i < 2000; i++) if (shouldSample(randomTraceId(), 0.25)) kept++;
    expect(kept).toBeGreaterThan(350);
    expect(kept).toBeLessThan(650);
  });

  it('the parent flag wins over the ratio', () => {
    const id = randomTraceId();
    expect(shouldSample(id, 0, true)).toBe(true);
    expect(shouldSample(id, 1, false)).toBe(false);
  });
});

describe('BatchSpanProcessor', () => {
  it("keeps OpenTelemetry's batch defaults", () => {
    expect(BATCH_DEFAULTS).toEqual({
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMs: 5000,
      exportTimeoutMs: 30_000,
    });
  });

  it('flushes after 5 s by the timer', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const calls: SpanData[][] = [];
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: async (spans) => {
        calls.push(spans);
        return { success: true };
      },
    });
    for (let i = 0; i < 10; i++) processor.onEnd(span(i));
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((s) => s.name)).toEqual(Array.from({ length: 10 }, (_, i) => `span-${i}`));
    await processor.shutdown();
  });

  it('flushes a full batch of 512 at once, without waiting for the timer', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const calls: SpanData[][] = [];
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: async (spans) => {
        calls.push(spans);
        return { success: true };
      },
    });
    for (let i = 0; i < 1025; i++) processor.onEnd(span(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.length)).toEqual([512, 512]);
    expect(processor.queued).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((c) => c.length)).toEqual([512, 512, 1]);
    await processor.shutdown();
  });

  it('drops and counts spans over the 2048 queue, and skips unsampled spans', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: () => new Promise(() => {}),
    });
    processor.onEnd(span(-1, 0));
    expect(processor.queued).toBe(0);
    for (let i = 0; i < 2048 + 7; i++) processor.onEnd(span(i));
    expect(processor.queued).toBe(2048);
    expect(processor.droppedSpans).toBe(7);
  });

  it('gives up on an export after 30 s and goes on with the next batch', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const calls: number[] = [];
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: (spans) => {
        calls.push(spans.length);
        return new Promise(() => {});
      },
    });
    for (let i = 0; i < 1024; i++) processor.onEnd(span(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([512]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toEqual([512]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([512, 512]);
  });

  it('shutdown flushes what is queued; later spans are ignored', async () => {
    const { deps } = makeDeps();
    const calls: SpanData[][] = [];
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: async (spans) => {
        calls.push(spans);
        return { success: true };
      },
    });
    for (let i = 0; i < 3; i++) processor.onEnd(span(i));
    await processor.shutdown();
    expect(calls.map((c) => c.length)).toEqual([3]);
    processor.onEnd(span(9));
    await processor.forceFlush();
    expect(calls).toHaveLength(1);
  });

  it('a failed export logs the tenant id and the count only', async () => {
    const { deps, logger } = makeDeps();
    const processor = new BatchSpanProcessor(deps, settingsFor('http://127.0.0.1:1'), {
      exporter: async () => ({ success: false, error: `401 ${HEADER_VALUE}` }),
    });
    processor.onEnd(span(1));
    await processor.forceFlush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ tenantId: 'tenant-a', spans: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(HEADER_VALUE);
    await processor.shutdown();
  });
});

describe('TracingService', () => {
  function withExporter(rate = 1) {
    const { deps, logger } = makeDeps();
    const exported: SpanData[] = [];
    let now = 1_000_000;
    const tracing = new TracingService(deps, {
      now: () => now,
      probe: false,
      processorOptions: {
        exporter: async (spans) => {
          exported.push(...spans);
          return { success: true };
        },
      },
    });
    const settings = settingsFor('http://127.0.0.1:1', { tracesSampleRate: rate });
    tracing.processorFor('tenant-a', settings);
    return { tracing, exported, logger, settings, advance: (ms: number) => (now += ms) };
  }

  it('a root span: new ids, kind internal, sampled by the tenant ratio', async () => {
    const { tracing, exported } = withExporter(1);
    const before = BigInt(Date.now()) * 1_000_000n;
    const root = tracing.startSpan({
      tenantId: 'tenant-a',
      name: 'workflow.execute',
      attributes: { 'workflow.id': 'w1' },
    });
    expect(root.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.kind).toBe('internal');
    expect(root.context.traceFlags & 1).toBe(1);
    expect(root.startTimeUnixNano >= before - 1_000_000_000n).toBe(true);
    expect(root.endTimeUnixNano).toBeUndefined();
    tracing.endSpan(root, { status: { code: 'ok' }, attributes: { 'node.count': 2 } });
    expect((root.endTimeUnixNano as bigint) >= root.startTimeUnixNano).toBe(true);
    expect(root.status).toEqual({ code: 'ok' });
    expect(root.attributes).toEqual({ 'workflow.id': 'w1', 'node.count': 2 });
    // a second end changes nothing and sends nothing again
    tracing.endSpan(root, { status: { code: 'error', message: 'x' } });
    await tracing.flush();
    expect(exported).toHaveLength(1);
    expect(exported[0].status).toEqual({ code: 'ok' });
    await tracing.close();
  });

  it('a child continues its parent: trace id, parent span id, tracestate, the parent flag over the ratio', async () => {
    const { tracing, exported } = withExporter(0);
    const parent = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      traceState: 'a=1',
    };
    const child = tracing.startSpan({ tenantId: 'tenant-a', name: 'node.execute', parent, kind: 'client' });
    expect(child.context.traceId).toBe(parent.traceId);
    expect(child.context.spanId).not.toBe(parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.context.traceState).toBe('a=1');
    expect(child.context.traceFlags & 1).toBe(1);
    expect(child.kind).toBe('client');
    // ratio 0: a root is not sampled and never exported
    const root = tracing.startSpan({ tenantId: 'tenant-a', name: 'workflow.execute' });
    expect(root.context.traceFlags & 1).toBe(0);
    tracing.endSpan(child, { endTimeUnixNano: child.startTimeUnixNano + 5n });
    tracing.endSpan(root);
    await tracing.flush();
    expect(exported.map((s) => s.name)).toEqual(['node.execute']);
    expect(exported[0].endTimeUnixNano).toBe(child.startTimeUnixNano + 5n);
    await tracing.close();
  });

  it('a span of a tenant with no processor is dropped', async () => {
    const { tracing, exported } = withExporter(1);
    const other = tracing.startSpan({ tenantId: 'tenant-b', name: 'workflow.execute' });
    tracing.endSpan(other);
    await tracing.flush();
    expect(exported).toHaveLength(0);
    await tracing.close();
  });

  it('one processor per tenant, rebuilt when its settings change, dropped after 10 idle minutes', async () => {
    const { tracing, settings, advance } = withExporter(1);
    const first = tracing.processorFor('tenant-a', settings);
    expect(tracing.processorFor('tenant-a', { ...settings })).toBe(first);
    const changed = tracing.processorFor('tenant-a', { ...settings, exporterServiceName: 'renamed' });
    expect(changed).not.toBe(first);
    tracing.processorFor('tenant-b', { ...settings, tenantId: 'tenant-b' });
    expect(tracing.activeTenants().sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(IDLE_PROCESSOR_MS).toBe(600_000);
    advance(IDLE_PROCESSOR_MS - 1);
    tracing.processorFor('tenant-b', { ...settings, tenantId: 'tenant-b' });
    advance(2);
    tracing.sweepIdle();
    expect(tracing.activeTenants()).toEqual(['tenant-b']);
    await tracing.close();
    expect(tracing.activeTenants()).toEqual([]);
  });
});

describe('startup probe (once per tenant per process)', () => {
  it('probes the collector when a tenant settings first load, never again', async () => {
    const collector = await startOtlpCollector();
    try {
      const { deps, logger } = makeDeps();
      const tracing = new TracingService(deps);
      const settings = settingsFor(collector.url);
      tracing.processorFor('tenant-a', settings);
      tracing.processorFor('tenant-a', { ...settings, exporterServiceName: 'changed' });
      await tracing.flush();
      expect(collector.requests).toHaveLength(1);
      expect(collector.requests[0].method).toBe('POST');
      expect(collector.requests[0].path).toBe('/v1/traces');
      expect(collector.requests[0].headers['x-api-key']).toBe(HEADER_VALUE);
      expect(logger.warn).not.toHaveBeenCalled();
      await tracing.close();
    } finally {
      await collector.close();
    }
  });

  it('a failing collector logs a warning with the tenant id and status only', async () => {
    const collector = await startOtlpCollector();
    collector.respondWith({ status: 401, body: `denied ${HEADER_VALUE}` });
    try {
      const { deps, logger } = makeDeps();
      const tracing = new TracingService(deps);
      tracing.processorFor('tenant-a', settingsFor(collector.url));
      await tracing.flush();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toEqual({ tenantId: 'tenant-a', status: 401 });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(HEADER_VALUE);

      const blocked = makeDeps(new HttpClient());
      const tracingBlocked = new TracingService(blocked.deps);
      tracingBlocked.processorFor('tenant-a', settingsFor(collector.url));
      await tracingBlocked.flush();
      expect(blocked.logger.warn.mock.calls[0][0]).toEqual({ tenantId: 'tenant-a', status: 'unreachable' });
      expect(collector.requests).toHaveLength(1);
      await tracing.close();
      await tracingBlocked.close();
    } finally {
      await collector.close();
    }
  });
});
