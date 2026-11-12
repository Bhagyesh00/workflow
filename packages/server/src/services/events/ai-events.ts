/**
 * P6-59 (S5 C0 stub, L2 fills it): the 14 `ai.*` events from the run lifecycle's `aiEvent` hook; the node's `msg`
 * reaches only the tenant's own destinations and never when the context's `redacted` is true.
 */
import type { ServiceDeps } from '../../context';
import type { LifecycleObserver } from '../observability/lifecycle';

/** stub (L2): PASSES: an observer with no hooks */
export function createAiEventsObserver(_deps: ServiceDeps): LifecycleObserver {
  return {};
}
