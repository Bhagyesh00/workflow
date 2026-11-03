/**
 * Version history compaction (P3-18): hourly optimize and daily trim on the leader, with
 * config.historyCompaction; started and stopped with the Pruner.
 *
 * C0 STUB: lane L12 writes the bodies (start / stop are no-ops).
 */
import type { HistoryCompactionMode } from '@workflow/workflow';
import type { ServiceDeps } from '../context';

export class HistoryCompactionService {
  constructor(readonly deps: ServiceDeps) {}

  start(): void {}

  stop(): void {}

  /** one pass over every tenant; returns the number of versions removed */
  async runOnce(_mode: HistoryCompactionMode, _now?: Date): Promise<number> {
    throw new Error('not implemented (L12)');
  }
}
