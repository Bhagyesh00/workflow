/**
 * P6-65 (S5 C0 stub, L9 fills it): parent-based trace id ratio sampling, as the OpenTelemetry SDK's default with
 * `tracesSampleRate`: a sampled-out parent stays out, a root is kept when its trace id falls under the ratio.
 */

/** stub (L9) */
export function shouldSample(_traceId: string, _ratio: number, _parentSampled?: boolean): boolean {
  throw new Error('not implemented (L9)');
}
