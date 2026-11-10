/**
 * P6-05 (L11): leader-only insights upkeep: hour to day after `compactionHourlyToDailyThresholdDays`, day to
 * week (weeks start Monday) after `compactionDailyToWeeklyThresholdDays`, every `compactionIntervalMinutes`,
 * under a lock, within the batch bounds of `config.insights`; prune by `maxAgeDays` every
 * `pruneCheckIntervalHours`. Started and stopped with the leadership (context.ts) and stopped in `close`.
 * Stub from C0: both PASS until L11.
 */
import type { ServiceDeps } from '../../context';

export class InsightsCompaction {
  constructor(readonly deps: ServiceDeps) {}

  start(): void {
    // stub (L11): PASSES
  }

  /** ends the timers and waits for a run in flight */
  async stop(): Promise<void> {
    // stub (L11): PASSES
  }
}
