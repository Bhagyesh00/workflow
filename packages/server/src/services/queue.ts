/**
 * Queue mode: mains enqueue `{ executionId }`, workers execute (BullMQ on Redis).
 * A Redis lock with TTL renewal elects one leader among mains for triggers, pollers,
 * the wait tracker and pruning.
 */
import { randomUUID } from 'node:crypto';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

export interface ExecutionJob {
  executionId: string;
  tenantId: string;
  kind: 'run' | 'resume';
  /** someone (webhook request, parent execution) waits for `exec-events` of this execution */
  notify?: boolean;
}

export const QUEUE_NAME = 'executions';

export class ExecutionQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<ExecutionJob>;
  private worker?: Worker<ExecutionJob>;

  constructor(
    redisUrl: string,
    private readonly prefix: string,
  ) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', () => {});
    this.queue = new Queue<ExecutionJob>(QUEUE_NAME, {
      connection: this.connection,
      prefix: `${prefix}:bull`,
    });
  }

  async enqueue(job: ExecutionJob): Promise<void> {
    await this.queue.add(job.kind, job, {
      removeOnComplete: true,
      removeOnFail: 1000,
      attempts: 1,
    });
  }

  startWorker(
    processor: (job: ExecutionJob, meta: { redelivered: boolean }) => Promise<void>,
    concurrency: number,
  ): void {
    if (this.worker) return;
    this.worker = new Worker<ExecutionJob>(
      QUEUE_NAME,
      // a stalled job (its worker died) is handed out again: the processor marks it crashed
      async (job: Job<ExecutionJob>) =>
        processor(job.data, { redelivered: job.stalledCounter > 0 || job.attemptsStarted > 1 }),
      {
        connection: this.connection.duplicate(),
        prefix: `${this.prefix}:bull`,
        concurrency,
      },
    );
    this.worker.on('error', () => {});
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => {});
  }
}

export interface Leadership {
  readonly isLeader: boolean;
  start(onElected: () => Promise<void> | void, onDemoted: () => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
}

/** regular mode: the single process is always the leader */
export class SingleLeader implements Leadership {
  isLeader = false;

  async start(onElected: () => Promise<void> | void): Promise<void> {
    this.isLeader = true;
    await onElected();
  }

  async stop(): Promise<void> {
    this.isLeader = false;
  }
}

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export class RedisLeader implements Leadership {
  isLeader = false;
  readonly instanceId = randomUUID();
  private readonly redis: Redis;
  private timer?: NodeJS.Timeout;
  private onElected?: () => Promise<void> | void;
  private onDemoted?: () => Promise<void> | void;
  private stopped = false;

  constructor(
    redisUrl: string,
    private readonly key: string,
    private readonly ttlMs = 10_000,
    private readonly renewMs = 3_000,
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.redis.on('error', () => {});
  }

  async start(onElected: () => Promise<void> | void, onDemoted: () => Promise<void> | void): Promise<void> {
    this.onElected = onElected;
    this.onDemoted = onDemoted;
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.renewMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.isLeader) {
        const renewed = await this.redis.eval(RENEW_SCRIPT, 1, this.key, this.instanceId, this.ttlMs);
        if (Number(renewed) !== 1) await this.demote();
      } else {
        const acquired = await this.redis.set(this.key, this.instanceId, 'PX', this.ttlMs, 'NX');
        if (acquired === 'OK') {
          this.isLeader = true;
          await this.onElected?.();
        }
      }
    } catch {
      // Redis unreachable: stop acting as leader, another main takes over after the TTL
      if (this.isLeader) await this.demote();
    }
  }

  private async demote(): Promise<void> {
    this.isLeader = false;
    await this.onDemoted?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.isLeader) {
      this.isLeader = false;
      await this.onDemoted?.();
      await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.instanceId).catch(() => {});
    }
    await this.redis.quit().catch(() => {});
  }
}
