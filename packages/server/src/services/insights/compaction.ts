/**
 * P6-05 (L11): leader-only insights upkeep: hour to day after `compactionHourlyToDailyThresholdDays`, day to
 * week (weeks start Monday) after `compactionDailyToWeeklyThresholdDays`, every `compactionIntervalMinutes`,
 * under a lock, within the batch bounds of `config.insights`; prune by `maxAgeDays` every
 * `pruneCheckIntervalHours`. Started and stopped with the leadership (context.ts) and stopped in `close`.
 * Totals never change: a bucket is added to the coarser one and removed, in one transaction per batch.
 */
import type { ServiceDeps } from '../../context';

const DAY_MS = 86_400_000;

export interface InsightsCompactionResult {
  hourToDay: number;
  dayToWeek: number;
  batches: number;
}

export class InsightsCompaction {
  private compactTimer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> = Promise.resolve();
  private running = false;
  private stopped = false;

  constructor(readonly deps: ServiceDeps) {}

  start(): void {
    if (this.compactTimer) return;
    this.stopped = false;
    const { compactionIntervalMinutes, pruneCheckIntervalHours } = this.deps.config.insights;
    this.compactTimer = setInterval(
      () => void this.scheduled(() => this.runOnce()),
      Math.max(1, compactionIntervalMinutes) * 60_000,
    );
    this.pruneTimer = setInterval(
      () => void this.scheduled(() => this.pruneOnce()),
      Math.max(1, pruneCheckIntervalHours) * 3_600_000,
    );
    this.compactTimer.unref?.();
    this.pruneTimer.unref?.();
  }

  /** ends the timers and waits for a run in flight */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.compactTimer) clearInterval(this.compactTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.compactTimer = undefined;
    this.pruneTimer = undefined;
    await this.current.catch(() => {});
  }

  /**
   * One pass: hours older than the threshold into days, then days older than the threshold into weeks, in
   * batches of `compactionBatchSize` with a pause between full batches. A pass ends at
   * `compactionMaxBatchesPerRun` batches or `compactionMaxRuntimeSeconds` seconds (0 = no bound), when no
   * rows are left, or when the service stops.
   */
  async runOnce(now: Date = new Date()): Promise<InsightsCompactionResult> {
    const c = this.deps.config.insights;
    const { insights } = this.deps.repos;
    const startedAt = Date.now();
    const result: InsightsCompactionResult = { hourToDay: 0, dayToWeek: 0, batches: 0 };
    const stages = [
      { from: 0, to: 1, days: c.compactionHourlyToDailyThresholdDays, key: 'hourToDay' },
      { from: 1, to: 2, days: c.compactionDailyToWeeklyThresholdDays, key: 'dayToWeek' },
    ] as const;
    for (const stage of stages) {
      const before = new Date(now.getTime() - stage.days * DAY_MS);
      for (;;) {
        if (this.stopped && this.running) return result;
        if (c.compactionMaxBatchesPerRun > 0 && result.batches >= c.compactionMaxBatchesPerRun) return result;
        if (
          c.compactionMaxRuntimeSeconds > 0 &&
          Date.now() - startedAt >= c.compactionMaxRuntimeSeconds * 1000
        ) {
          return result;
        }
        const moved = await insights.compact(stage.from, stage.to, before, c.compactionBatchSize);
        if (moved === 0) break;
        result.batches++;
        result[stage.key] += moved;
        if (moved < c.compactionBatchSize) break;
        if (c.compactionBatchDelayMilliseconds > 0) await sleep(c.compactionBatchDelayMilliseconds);
      }
    }
    return result;
  }

  /** deletes the buckets older than `maxAgeDays`; answers how many */
  async pruneOnce(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.deps.config.insights.maxAgeDays * DAY_MS);
    return this.deps.repos.insights.prune(before);
  }

  /** a tick: one at a time, a failure only logs */
  private scheduled(task: () => Promise<unknown>): Promise<void> {
    if (this.running || this.stopped) return Promise.resolve();
    this.running = true;
    const run: Promise<void> = task()
      .then(
        () => undefined,
        (error) => this.deps.logger.warn({ err: error }, 'Insights compaction failed'),
      )
      .finally(() => {
        this.running = false;
      });
    this.current = run;
    return run;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
