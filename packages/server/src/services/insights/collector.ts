/**
 * P6-05 (L11): the insights buffer of one process (mains and workers alike). `record` (called in `finish`
 * and `afterCrash`, C0d1) applies `countingFacts` and adds to a map keyed by tenant, workflow, type and hour;
 * it never throws, never awaits and reads nothing. A flush every `config.insights.flushIntervalSeconds` or
 * at `flushBatchSize` keys writes one sorted multi-row upsert (and the metadata upsert on a name or project
 * change); a failed flush puts the facts back. `stop` ends the timer and flushes what is left; `close`
 * (context.ts) flushes it.
 * Stub from C0: every method PASSES (record is a no-op) until L11.
 */
import type { ServiceDeps } from '../../context';
import type { InsightRun } from './rules';

export class InsightsCollector {
  constructor(readonly deps: ServiceDeps) {}

  record(_run: InsightRun): void {
    // stub (L11): PASSES, a no-op (L11 calls `countingFacts` here)
  }

  start(): void {
    // stub (L11): PASSES
  }

  async stop(): Promise<void> {
    // stub (L11): PASSES
  }

  async flush(): Promise<void> {
    // stub (L11): PASSES
  }
}
