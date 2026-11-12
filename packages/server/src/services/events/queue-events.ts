/**
 * P6-58 (S5 C0 stub, L1 fills it): `queue.job.*` events from the execution queue's job events, and
 * `worker.started` / `worker.stopped` from the context's `startWorker` and `close`.
 */
import type { ServiceDeps } from '../../context';
import type { QueueEventListener } from '../queue';

/** stub (L1): PASSES: a listener that does nothing */
export function createQueueEventListener(_deps: ServiceDeps): QueueEventListener {
  return {
    enqueued() {},
    dequeued() {},
    completed() {},
    failed() {},
    stalled() {},
  };
}

/** stub (L1): PASSES: does nothing until L1 */
export function workerStarted(_deps: ServiceDeps): void {}

/** stub (L1): PASSES: does nothing until L1 */
export function workerStopped(_deps: ServiceDeps): void {}
