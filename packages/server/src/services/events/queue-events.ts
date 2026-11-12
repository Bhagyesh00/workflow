/**
 * P6-58 (S5, L1): `queue.job.*` events from the execution queue's job events, and `worker.started` /
 * `worker.stopped` from the context's `startWorker` and `close`.
 *
 * A job event goes to the job's tenant (its job data). `queue.job.stalled` gets only the job id from BullMQ, so the
 * tenant is read from the job's data in Redis. A worker serves every tenant, so `worker.*` goes to each tenant with
 * an enabled destination subscribed to it (one cross-tenant read, `repos.logDestinations.listEnabledAcrossTenants`);
 * the payload names the worker by `ctx.instance.id`, never by a host name. The error of a failed job is not sent
 * (only its class): a job error can hold run text.
 */
import { matchesSubscription } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExecutionJob, QueueEventListener } from '../queue';

/** the tenants that heard `worker.started`, for the matching `worker.stopped` (it must not wait for a read) */
const workerAudience = new WeakMap<object, string[]>();

function streamOf(deps: ServiceDeps) {
  try {
    return deps.context().events;
  } catch {
    return undefined;
  }
}

const jobPayload =
  (deps: ServiceDeps, job: ExecutionJob, extra: Record<string, unknown> = {}) =>
  async () => {
    const row = await deps.repos.executions.get(job.tenantId, job.executionId);
    return {
      executionId: job.executionId,
      workflowId: row?.workflowId ?? null,
      // BullMQ's job id is not handed to the listener: one job per execution, so the execution id names it
      jobId: job.executionId,
      kind: job.kind,
      ...extra,
    };
  };

/** the tenants with an enabled destination whose subscriptions include `eventName` */
async function audienceFor(deps: ServiceDeps, eventName: string): Promise<string[]> {
  const rows = await deps.repos.logDestinations.listEnabledAcrossTenants();
  const tenants = new Set<string>();
  for (const row of rows) {
    if (matchesSubscription(eventName, row.subscribedEvents)) tenants.add(row.tenantId);
  }
  return [...tenants];
}

/** reads the job's data from Redis (BullMQ's hash `<prefix>:bull:executions:<id>`, field `data`) */
async function stalledJob(deps: ServiceDeps, jobId: string): Promise<ExecutionJob | undefined> {
  const ctx = deps.context();
  if (!ctx.redis || !/^[A-Za-z0-9_:-]{1,128}$/.test(jobId)) return undefined;
  const raw = await ctx.redis.hget(`${deps.config.queue.prefix}:bull:executions:${jobId}`, 'data');
  if (!raw) return undefined;
  const data = JSON.parse(raw) as Partial<ExecutionJob>;
  if (typeof data.tenantId !== 'string' || typeof data.executionId !== 'string') return undefined;
  return data as ExecutionJob;
}

export function createQueueEventListener(deps: ServiceDeps): QueueEventListener {
  const send = (name: string, job: ExecutionJob, extra?: Record<string, unknown>) => {
    streamOf(deps)?.emit(job.tenantId, name, jobPayload(deps, job, extra));
  };
  return {
    enqueued: (job) => send('queue.job.enqueued', job),
    dequeued: (job) => send('queue.job.dequeued', job),
    completed: (job) => send('queue.job.completed', job),
    failed: (job, error) =>
      send('queue.job.failed', job, { errorName: error instanceof Error ? error.name : 'Error' }),
    stalled(jobId) {
      void stalledJob(deps, jobId)
        .then((job) => {
          if (job) send('queue.job.stalled', job, { jobId });
        })
        .catch(() => {
          // the job is gone or Redis is down: no event, and the queue goes on
        });
    },
  };
}

function announceWorker(deps: ServiceDeps, eventName: string, tenants: string[]): void {
  const events = streamOf(deps);
  if (!events) return;
  const workerId = deps.context().instance.id;
  for (const tenantId of tenants) events.emit(tenantId, eventName, { workerId });
}

/** `worker.started` to each tenant with an enabled destination subscribed to it (does not wait for the read) */
export function workerStarted(deps: ServiceDeps): void {
  void audienceFor(deps, 'worker.started')
    .then((tenants) => {
      workerAudience.set(deps, tenants);
      announceWorker(deps, 'worker.started', tenants);
    })
    .catch((error) => {
      deps.logger.warn({ err: error }, 'The worker start event could not be sent');
    });
}

/**
 * `worker.stopped`: the close flushes the stream straight after this call, so the tenants are those `worker.started`
 * reached plus, once a fresh read answers, any that subscribed since (those may arrive after the close)
 */
export function workerStopped(deps: ServiceDeps): void {
  const heard = workerAudience.get(deps) ?? [];
  announceWorker(deps, 'worker.stopped', heard);
  void audienceFor(deps, 'worker.stopped')
    .then((tenants) =>
      announceWorker(
        deps,
        'worker.stopped',
        tenants.filter((tenantId) => !heard.includes(tenantId)),
      ),
    )
    .catch(() => {
      // the database is closing: nothing more to send
    });
}
