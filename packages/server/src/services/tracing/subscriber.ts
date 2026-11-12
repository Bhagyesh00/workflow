/**
 * P6-66 (S5 C0 stub, L10 fills it): tracing as a `LifecycleObserver`: `workflow.execute` and `node.execute` spans
 * per run (n8n's names and attributes less `n8n.`), continued across processes through `executions.tracing_context`;
 * `headersFor` gives a node's outbound trace headers (`ExecutionServices.traceHeaders`, wired by C0d).
 */
import type { ServiceDeps } from '../../context';
import type { LifecycleObserver } from '../observability/lifecycle';

export type TracingObserver = LifecycleObserver & {
  /** the open node span's `traceparent`, `tracestate` and `baggage` when `injectOutbound`; undefined otherwise */
  headersFor(executionId: string, nodeName: string): Record<string, string> | undefined;
};

/** stub (L10): PASSES: no hooks, and `headersFor` gives undefined */
export function createTracingObserver(_deps: ServiceDeps): TracingObserver {
  return {
    headersFor: () => undefined,
  };
}
