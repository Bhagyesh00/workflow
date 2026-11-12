/**
 * P6-65 (S5 L9): one test span with the given settings, for the settings page's test button: n8n's
 * `n8n.test_trace` span without `n8n.`, so `test_trace` with `test: true`, sent at once (no sampling, no batch).
 * The answer is `{ success: true }` or `{ success: false, error }` with the collector's status text, redacted.
 */
import type { OtelTestResult } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { exportSpans } from './exporter';
import { randomSpanId, randomTraceId } from './ids';
import type { EffectiveOtelSettings } from './settings';
import { nowUnixNano, type SpanData, TRACE_FLAG_SAMPLED } from './span';

/** the test button waits at most this long for the collector */
const TEST_TRACE_TIMEOUT_MS = 10_000;

/** `{ success, error }`, the error text redacted; never throws */
export async function sendTestTrace(
  deps: ServiceDeps,
  settings: EffectiveOtelSettings,
): Promise<OtelTestResult> {
  const start = nowUnixNano();
  const span: SpanData = {
    tenantId: settings.tenantId,
    name: 'test_trace',
    kind: 'internal',
    context: { traceId: randomTraceId(), spanId: randomSpanId(), traceFlags: TRACE_FLAG_SAMPLED },
    startTimeUnixNano: start,
    endTimeUnixNano: nowUnixNano(),
    attributes: { test: true },
    events: [],
    links: [],
    status: { code: 'unset' },
  };
  try {
    const result = await exportSpans(deps, settings, [span], { timeoutMs: TEST_TRACE_TIMEOUT_MS });
    return result.success ? { success: true } : { success: false, error: result.error ?? 'Export failed' };
  } catch {
    return { success: false, error: 'Export failed' };
  }
}
