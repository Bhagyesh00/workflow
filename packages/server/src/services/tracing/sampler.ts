/**
 * P6-65 (S5 L9): parent-based trace id ratio sampling, as the OpenTelemetry SDK's default with `tracesSampleRate`:
 * a parent's decision is kept (a sampled-out parent stays out), and a root is kept when the low 63 bits of the low
 * 8 bytes of its trace id fall under `ratio x 2^63`, as the OTel spec's TraceIdRatioBased sampler.
 */

const TRACE_ID = /^[0-9a-f]{32}$/;
const LOW_63_BITS = (1n << 63n) - 1n;

/** `parentSampled` given: the parent's decision; otherwise the root decision by `ratio` (0 to 1) */
export function shouldSample(traceId: string, ratio: number, parentSampled?: boolean): boolean {
  if (parentSampled !== undefined) return parentSampled;
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  if (ratio >= 1) return true;
  if (!TRACE_ID.test(traceId)) return false;
  const low = BigInt(`0x${traceId.slice(16)}`) & LOW_63_BITS;
  const bound = BigInt(Math.floor(ratio * 2 ** 63));
  return low < bound;
}
