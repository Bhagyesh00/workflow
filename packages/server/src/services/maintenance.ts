/**
 * Leader-only background jobs: the wait tracker (resumes executions whose `wait_till` passed)
 * and pruning (old executions, their binary data, expired sessions and idempotency keys).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config';
import type { PinoLogger } from '../logger';
import { effectiveLimits, type TenantSettings } from '../plans';
import type { Repositories } from '../repositories';
import { LOG_STREAM_FAILED_RETENTION_DAYS } from '../repositories/log-stream-failed';
import type { ExecutionService } from './executions';

export class WaitTracker {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repos: Repositories,
    private readonly executions: ExecutionService,
    private readonly logger: PinoLogger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** resume every waiting execution that is due; returns how many were resumed */
  async check(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let resumed = 0;
    try {
      const due = await this.repos.executions.listDueWaiting(new Date());
      for (const { id, tenantId } of due) {
        try {
          if (await this.executions.resume(tenantId, id)) resumed++;
        } catch (error) {
          this.logger.warn({ err: error, tenantId, executionId: id }, 'Could not resume execution');
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Wait tracker check failed');
    } finally {
      this.busy = false;
    }
    return resumed;
  }
}

const DAY = 86_400_000;

export class Pruner {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly repos: Repositories,
    private readonly executions: ExecutionService,
    private readonly logger: PinoLogger,
    private readonly intervalMs = 3_600_000,
  ) {}

  private initial?: NodeJS.Timeout;

  start(): void {
    if (this.timer) return;
    const run = () => void this.prune().catch((error) => this.logger.warn({ err: error }, 'Pruning failed'));
    // first run shortly after start-up, then on the interval
    this.initial = setTimeout(run, 60_000);
    this.initial.unref();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.initial);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** delete finished executions older than the retention period (per-plan override) */
  async prune(now = new Date()): Promise<number> {
    let total = 0;
    // a plan may shorten retention below the instance default, but never below one day
    const tenantIds = await this.repos.executions.tenantsWithFinishedBefore(new Date(now.getTime() - DAY));
    for (const tenantId of tenantIds) {
      const tenant = await this.repos.tenants.get(tenantId);
      if (!tenant) continue;
      const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
      const days = Math.max(1, limits.pruneDays ?? this.config.pruneDays);
      const cutoff = new Date(now.getTime() - days * DAY);
      for (;;) {
        const batch = await this.repos.executions.listPrunable(cutoff, 500, tenantId);
        if (!batch.length) break;
        const ids = batch.map((r) => r.id);
        await this.repos.executions.deleteMany(tenantId, ids);
        for (const id of ids) await this.executions.removeBinaryData(tenantId, id);
        total += ids.length;
        if (batch.length < 500) break;
      }
    }
    await this.sweepActivationBinaryData(now);
    await this.repos.sessions.deleteExpired();
    await this.repos.idempotency.prune(new Date(now.getTime() - DAY));
    await this.repos.publicIdempotency.prune(new Date(now.getTime() - DAY));
    await this.repos.logStreamFailed.pruneBefore(
      new Date(now.getTime() - LOG_STREAM_FAILED_RETENTION_DAYS * DAY),
    );
    if (total) this.logger.info({ deleted: total }, 'Pruned old executions');
    return total;
  }

  /**
   * Contexts without an execution (webhook lifecycle hooks) store binary data under
   * `<tenantId>/activation`. No execution references those files, so they go by age.
   */
  private async sweepActivationBinaryData(now: Date): Promise<void> {
    const { mode, dir } = this.config.binaryData;
    if (mode !== 'filesystem') return;
    const cutoff = now.getTime() - DAY;
    for (const tenantId of await readdir(dir).catch(() => [])) {
      const activation = path.join(dir, tenantId, 'activation');
      for (const name of await readdir(activation).catch(() => [])) {
        const file = path.join(activation, name);
        const info = await stat(file).catch(() => undefined);
        if (info && info.mtimeMs < cutoff) await rm(file, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
