/**
 * P6-58 (S5 C0 stub, L1 fills it): the `workflow.*` and `node.*` events (n8n's names less `n8n.`) from the run
 * lifecycle, emitted on `ctx.events`; run text stays out when the context's `redacted` is true.
 */
import type { ServiceDeps } from '../../context';
import type { LifecycleObserver } from '../observability/lifecycle';

/** stub (L1): PASSES: an observer with no hooks */
export function createExecutionEventsObserver(_deps: ServiceDeps): LifecycleObserver {
  return {};
}
