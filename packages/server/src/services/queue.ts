/**
 * Queue mode: mains enqueue `{ executionId }`, workers execute (BullMQ on Redis).
 * A Redis lock with TTL renewal elects one leader among mains for triggers, pollers,
 * the wait tracker and pruning.
 */
import { randomUUID } from 'node:crypto';
import { type Job, Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';

export interface ExecutionJob {
  executionId: string;
  tenantId: string;
  kind: 'run' | 'resume';
  /** someone (webhook request, parent execution) waits for `exec-events` of this execution */
  notify?: boolean;
}

export const QUEUE_NAME = 'executions';

/**
 * P6-58 (S5 C0): the queue's job events (L1 turns them into `queue.job.*` events). Each call sits in a try/catch:
 * a throwing listener is swallowed, so it never fails an enqueue or a job.
 */
export interface QueueEventListener {
  /** a main added the job */
  enqueued(job: ExecutionJob): void;
  /** a worker took the job (start of the processor) */
  dequeued(job: ExecutionJob): void;
  completed(job: ExecutionJob): void;
  failed(job: ExecutionJob, error: unknown): void;
  /** BullMQ found the job's worker gone and hands it out again */
  stalled(jobId: string): void;
}

export class ExecutionQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<ExecutionJob>;
  private worker?: Worker<ExecutionJob>;
  private queueEvents?: QueueEvents;

  constructor(
    redisUrl: string,
    private readonly prefix: string,
    /** P6-58 (S5 C0): the job event listener (a new third argument; absent = no events) */
    private readonly events?: QueueEventListener,
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
    this.notify((events) => events.enqueued(job));
  }

  /** calls the listener, swallowing what it throws */
  private notify(call: (events: QueueEventListener) => void): void {
    if (!this.events) return;
    try {
      call(this.events);
    } catch {
      // a listener never fails an enqueue or a job
    }
  }

  startWorker(
    processor: (job: ExecutionJob, meta: { redelivered: boolean }) => Promise<void>,
    concurrency: number,
  ): void {
    if (this.worker) return;
    this.worker = new Worker<ExecutionJob>(
      QUEUE_NAME,
      // a stalled job (its worker died) is handed out again: the processor marks it crashed
      async (job: Job<ExecutionJob>) => {
        this.notify((events) => events.dequeued(job.data));
        return processor(job.data, { redelivered: job.stalledCounter > 0 || job.attemptsStarted > 1 });
      },
      {
        connection: this.connection.duplicate(),
        prefix: `${this.prefix}:bull`,
        concurrency,
      },
    );
    this.worker.on('error', () => {});
    this.worker.on('completed', (job) => this.notify((events) => events.completed(job.data)));
    this.worker.on('failed', (job, error) => {
      if (job) this.notify((events) => events.failed(job.data, error));
    });
    this.worker.on('stalled', (jobId) => this.notify((events) => events.stalled(String(jobId))));
  }

  /** true once this process consumes the queue (`startWorker` ran) */
  get isWorker(): boolean {
    return this.worker !== undefined;
  }

  /**
   * P6-71 (S5 fix, metrics-1): calls `fn` for every job that finishes, in any process (BullMQ `QueueEvents`, the
   * queue's global `completed` and `failed` events; n8n counts them on the main from Bull's global events). The
   * worker-side `completed` and `failed` events of `startWorker` fire only in the worker's own process. The
   * stream is created on the first call and closed in `close()`; the returned promise settles when it is
   * connected (a job that finishes earlier is not seen). A throwing `fn` is swallowed.
   */
  onFinished(fn: (outcome: 'completed' | 'failed') => void): Promise<void> {
    if (!this.queueEvents) {
      this.queueEvents = new QueueEvents(QUEUE_NAME, {
        connection: this.connection.duplicate(),
        prefix: `${this.prefix}:bull`,
      });
      this.queueEvents.on('error', () => {});
    }
    const events = this.queueEvents;
    const call = (outcome: 'completed' | 'failed') => {
      try {
        fn(outcome);
      } catch {
        // a listener never fails the stream
      }
    };
    events.on('completed', () => call('completed'));
    events.on('failed', () => call('failed'));
    return events.waitUntilReady().then(
      () => undefined,
      () => undefined,
    );
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  /**
   * P6-71 (S5 C0, FULL): the waiting and active job counts (BullMQ `getJobCounts`), read by the queue gauges (L15).
   * Completed jobs are removed at once (`enqueue`), so completed and failed are counted from `onFinished` instead.
   */
  async jobCounts(): Promise<{ waiting: number; active: number }> {
    const counts = await this.queue.getJobCounts('waiting', 'active');
    return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 };
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queueEvents?.close().catch(() => {});
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
