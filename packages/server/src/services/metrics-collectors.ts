/**
 * P6-71 (S5 L15): the Prometheus families behind `METRICS_*` toggles (n8n's names under our `workflow_` prefix).
 * One builder per family; each registers only when its toggle is on, so an off family costs nothing and is absent
 * from a scrape. The registry is platform level: no label names a tenant, and the labels that name a tenant's
 * data (workflow id, workflow name, node type, credential type, webhook and form paths) exist only when the
 * operator turned them on.
 */
import type { GuardEvent } from '@workflow/core';
import { EVENT_CATALOG } from '@workflow/workflow';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { MetricsToggles } from '../config';
import type { Database } from '../db/client';
import type { EventSink, StreamEvent } from './events/stream';
import type { ExecutionQueue, Leadership } from './queue';

/** n8n's defaults: default metrics and the execution duration on, every other family off */
export const DEFAULT_METRICS_TOGGLES: MetricsToggles = {
  includeDefaultMetrics: true,
  includeWorkflowIdLabel: false,
  includeWorkflowNameLabel: false,
  includeNodeTypeLabel: false,
  includeCredentialTypeLabel: false,
  includeApiEndpoints: false,
  includeApiPathLabel: false,
  includeApiMethodLabel: false,
  includeApiStatusCodeLabel: false,
  includeMessageEventBusMetrics: false,
  includeQueueMetrics: false,
  includeSchedulerMetrics: false,
  includePollTriggerMetrics: false,
  includeWorkflowStatistics: false,
  includeSsrfMetrics: false,
  includeDnsCacheMetrics: false,
  includeWebhookMetrics: false,
  includeFormMetrics: false,
  includeDbPoolMetrics: false,
  includeWorkflowExecutionDuration: true,
  queueMetricsInterval: 20,
  schedulerInterval: 20,
  activeWorkflowCountInterval: 60,
  workflowStatisticsInterval: 300,
};

const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const LOOKUP_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];
const LABEL_LIMIT = 256;

/** a label value: text cut at 256 characters; anything else is empty */
function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, LABEL_LIMIT) : '';
}

/** milliseconds as seconds; a negative or non-finite duration counts as 0 */
function seconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

/** longest wait for one read of Redis or the database during a scrape, milliseconds */
export const READ_TIMEOUT_MS = 5000;

/**
 * P6-71 (S5 fix, metrics-2): rejects when `promise` has not settled after `ms`. The queue's Redis connection retries
 * without end (`maxRetriesPerRequest: null`), so a read made while Redis is down never settles by itself.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The read timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads at most once per `intervalSeconds`; callers inside one read share it. A failed read, or one that has not
 * settled after 5 seconds (or the interval, if shorter), keeps the last value (`initial` before the first read), so a
 * scrape never fails or hangs because of it.
 */
export function cachedRead<T>(intervalSeconds: number, read: () => Promise<T>, initial: T): () => Promise<T> {
  let value = initial;
  let readAt = 0;
  let inflight: Promise<T> | undefined;
  const limit = Math.min(READ_TIMEOUT_MS, intervalSeconds * 1000);
  return () => {
    if (inflight) return inflight;
    if (readAt !== 0 && Date.now() - readAt < intervalSeconds * 1000) return Promise.resolve(value);
    inflight = withTimeout(read(), limit)
      .then((next) => {
        value = next;
        return next;
      })
      .catch(() => value)
      .finally(() => {
        readAt = Date.now();
        inflight = undefined;
      });
    return inflight;
  };
}

/** `workflow_http_request_duration_seconds` with `method`, `path` (the route pattern) and `status_code` per toggle */
export function apiMetrics(
  registry: Registry,
  toggles: MetricsToggles,
): ((method: string, route: string, status: number, ms: number) => void) | undefined {
  if (!toggles.includeApiEndpoints) return undefined;
  const labelNames: string[] = [];
  if (toggles.includeApiMethodLabel) labelNames.push('method');
  if (toggles.includeApiPathLabel) labelNames.push('path');
  if (toggles.includeApiStatusCodeLabel) labelNames.push('status_code');
  const histogram = new Histogram({
    name: 'workflow_http_request_duration_seconds',
    help: 'Duration of HTTP requests answered by the server',
    labelNames,
    buckets: REQUEST_BUCKETS,
    registers: [registry],
  });
  return (method, route, status, ms) => {
    const labels: Record<string, string> = {};
    if (toggles.includeApiMethodLabel) labels.method = text(method);
    if (toggles.includeApiPathLabel) labels.path = text(route);
    if (toggles.includeApiStatusCodeLabel) labels.status_code = String(status);
    histogram.observe(labels, seconds(ms));
  };
}

export interface WebhookFormObservers {
  webhook?: (o: {
    method: string;
    statusCode: number;
    webhookPath: string;
    workflowId: string;
    ms: number;
  }) => void;
  form?: (o: { statusCode: number; formPath: string; workflowId: string; ms: number }) => void;
}

/** n8n's `webhook_request_duration_seconds` and `form_submission_duration_seconds`, each behind its own toggle */
export function webhookFormMetrics(registry: Registry, toggles: MetricsToggles): WebhookFormObservers {
  const out: WebhookFormObservers = {};
  if (toggles.includeWebhookMetrics) {
    const histogram = new Histogram({
      name: 'workflow_webhook_request_duration_seconds',
      help: 'Duration of webhook requests',
      labelNames: ['method', 'status_code', 'webhook_path', 'workflow_id'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    });
    out.webhook = (o) =>
      histogram.observe(
        {
          method: text(o.method),
          status_code: String(o.statusCode),
          webhook_path: text(o.webhookPath),
          workflow_id: text(o.workflowId),
        },
        seconds(o.ms),
      );
  }
  if (toggles.includeFormMetrics) {
    const histogram = new Histogram({
      name: 'workflow_form_submission_duration_seconds',
      help: 'Duration of form submissions',
      labelNames: ['status_code', 'form_path', 'workflow_id'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    });
    out.form = (o) =>
      histogram.observe(
        { status_code: String(o.statusCode), form_path: text(o.formPath), workflow_id: text(o.workflowId) },
        seconds(o.ms),
      );
  }
  return out;
}

export interface TriggerObservers {
  poll?: (nodeType: string, ok: boolean, ms: number) => void;
  schedule?: (nodeType: string, ms: number) => void;
}

/** poll trigger and schedule trigger counters and durations by node type */
export function triggerMetrics(registry: Registry, toggles: MetricsToggles): TriggerObservers {
  const out: TriggerObservers = {};
  if (toggles.includePollTriggerMetrics) {
    const polls = new Counter({
      name: 'workflow_poll_trigger_polls_total',
      help: 'Polls of polling triggers by node type and status',
      labelNames: ['node_type', 'status'],
      registers: [registry],
    });
    const duration = new Histogram({
      name: 'workflow_poll_trigger_duration_seconds',
      help: 'Duration of one poll of a polling trigger',
      labelNames: ['node_type', 'status'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    });
    out.poll = (nodeType, ok, ms) => {
      const type = text(nodeType);
      const status = ok ? 'ok' : 'error';
      polls.inc({ node_type: type, status });
      duration.observe({ node_type: type, status }, seconds(ms));
    };
  }
  if (toggles.includeSchedulerMetrics) {
    const fires = new Counter({
      name: 'workflow_scheduler_triggers_total',
      help: 'Schedule trigger fires by node type',
      labelNames: ['node_type'],
      registers: [registry],
    });
    const duration = new Histogram({
      name: 'workflow_scheduler_trigger_duration_seconds',
      help: 'Time from a schedule trigger fire until its run started',
      labelNames: ['node_type'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    });
    out.schedule = (nodeType, ms) => {
      const type = text(nodeType);
      fires.inc({ node_type: type });
      duration.observe({ node_type: type }, seconds(ms));
    };
  }
  return out;
}

/** SSRF checks (allowed, blocked) and DNS lookups (ok, error) from the HTTP client's guard */
export function guardMetrics(
  registry: Registry,
  toggles: MetricsToggles,
): ((event: GuardEvent) => void) | undefined {
  if (!toggles.includeSsrfMetrics && !toggles.includeDnsCacheMetrics) return undefined;
  const checks = toggles.includeSsrfMetrics
    ? new Counter({
        name: 'workflow_ssrf_checks_total',
        help: 'Outbound request address checks by result',
        labelNames: ['result'],
        registers: [registry],
      })
    : undefined;
  const lookups = toggles.includeDnsCacheMetrics
    ? new Counter({
        name: 'workflow_dns_lookups_total',
        help: 'DNS lookups made by the outbound request guard, by result (no DNS cache exists here)',
        labelNames: ['result'],
        registers: [registry],
      })
    : undefined;
  const lookupDuration = toggles.includeDnsCacheMetrics
    ? new Histogram({
        name: 'workflow_dns_lookup_duration_seconds',
        help: 'Duration of DNS lookups made by the outbound request guard',
        buckets: LOOKUP_BUCKETS,
        registers: [registry],
      })
    : undefined;
  return (event) => {
    if (event.kind === 'check') checks?.inc({ result: event.allowed ? 'allowed' : 'blocked' });
    else {
      lookups?.inc({ result: event.ok ? 'ok' : 'error' });
      lookupDuration?.observe(seconds(event.durationMs));
    }
  };
}

/** `workflow_db_pool_connections_active|idle` and `workflow_db_pool_requests_pending`, read from the pool on each scrape */
export function poolMetrics(
  registry: Registry,
  toggles: MetricsToggles,
  database: Database | undefined,
): void {
  if (!toggles.includeDbPoolMetrics) return;
  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(database ? read() : 0);
      },
    });
  gauge(
    'workflow_db_pool_connections_active',
    'Connections in the database pool',
    () => database?.pool.totalCount ?? 0,
  );
  gauge(
    'workflow_db_pool_connections_idle',
    'Idle connections in the database pool',
    () => database?.pool.idleCount ?? 0,
  );
  gauge(
    'workflow_db_pool_requests_pending',
    'Requests waiting for a database connection',
    () => database?.pool.waitingCount ?? 0,
  );
}

/**
 * `workflow_production_executions|manual_executions|users|workflows|credentials`: platform totals (no tenant label),
 * read at most every `workflowStatisticsInterval` seconds. The execution gauges count finished runs only (success or
 * error); n8n reads a counter table that pruning never touches, here the rows are counted, so pruning lowers them.
 */
export function statisticsMetrics(
  registry: Registry,
  toggles: MetricsToggles,
  database: Database | undefined,
): void {
  if (!toggles.includeWorkflowStatistics) return;
  const zero = { manual: 0, production: 0, users: 0, workflows: 0, credentials: 0 };
  const read = cachedRead(
    toggles.workflowStatisticsInterval,
    async () => {
      if (!database) return zero;
      const { rows } = await database.pool.query<Record<keyof typeof zero, number>>(
        `select
           (select count(*)::int from executions where mode = 'manual' and status in ('success', 'error')) as manual,
           (select count(*)::int from executions where mode <> 'manual' and status in ('success', 'error')) as production,
           (select count(*)::int from users) as users,
           (select count(*)::int from workflows) as workflows,
           (select count(*)::int from credentials) as credentials`,
      );
      const row = rows[0];
      return row
        ? {
            manual: Number(row.manual),
            production: Number(row.production),
            users: Number(row.users),
            workflows: Number(row.workflows),
            credentials: Number(row.credentials),
          }
        : zero;
    },
    zero,
  );
  const gauge = (name: string, help: string, key: keyof typeof zero) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        this.set((await read())[key]);
      },
    });
  gauge(
    'workflow_production_executions',
    'Finished executions started by a trigger, all workspaces',
    'production',
  );
  gauge(
    'workflow_manual_executions',
    'Finished executions started from the editor, all workspaces',
    'manual',
  );
  gauge('workflow_users', 'Users, all workspaces', 'users');
  gauge('workflow_workflows', 'Workflows, all workspaces', 'workflows');
  gauge('workflow_credentials', 'Credentials, all workspaces', 'credentials');
}

/** `workflow_version_info` (version, major, minor, patch) and `workflow_instance_role_leader` (1 or 0) */
export function instanceMetrics(
  registry: Registry,
  version: string | undefined,
  leadership: Leadership | undefined,
): void {
  new Gauge({
    name: 'workflow_instance_role_leader',
    help: '1 when this process is the leader, else 0',
    registers: [registry],
    collect() {
      this.set(leadership?.isLeader ? 1 : 0);
    },
  });
  if (version === undefined) return;
  const [major = '0', minor = '0', patch = '0'] = (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1);
  new Gauge({
    name: 'workflow_version_info',
    help: 'Server version',
    labelNames: ['version', 'major', 'minor', 'patch'],
    registers: [registry],
  }).set({ version: text(version), major, minor, patch }, 1);
}

/**
 * The gauges `waiting` and `active` of the execution queue, read at most every `queueMetricsInterval` seconds, and
 * the counters `completed` and `failed`. The counters are counted on the main from the queue's global events
 * (`ExecutionQueue.onFinished`, as n8n counts Bull's global events), never in a worker process: a worker's own
 * `completed` and `failed` events fire only there, and the main is the process a scrape reads.
 */
export function queueGauges(
  registry: Registry,
  toggles: MetricsToggles,
  queue: ExecutionQueue | undefined,
): void {
  if (!toggles.includeQueueMetrics) return;
  const read = cachedRead(
    toggles.queueMetricsInterval,
    async () => (queue ? queue.jobCounts() : { waiting: 0, active: 0 }),
    { waiting: 0, active: 0 },
  );
  const gauge = (name: string, help: string, key: 'waiting' | 'active') =>
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        if (queue) this.set((await read())[key]);
      },
    });
  gauge('workflow_scaling_mode_queue_jobs_waiting', 'Jobs waiting in the execution queue', 'waiting');
  gauge('workflow_scaling_mode_queue_jobs_active', 'Jobs running in the execution queue', 'active');
  const completed = new Counter({
    name: 'workflow_scaling_mode_queue_jobs_completed',
    help: 'Jobs completed in the execution queue',
    registers: [registry],
  });
  const failed = new Counter({
    name: 'workflow_scaling_mode_queue_jobs_failed',
    help: 'Jobs failed in the execution queue',
    registers: [registry],
  });
  // a process that consumes the queue does not count: the main counts every job once
  void queue?.onFinished((outcome) => {
    if (queue.isWorker) return;
    (outcome === 'completed' ? completed : failed).inc();
  });
}

/** n8n puts the `credential_type` label on the credential event counters only */
const CREDENTIAL_EVENT_PREFIX = 'audit.user.credentials.';
const CATALOG_NAMES: ReadonlySet<string> = new Set(EVENT_CATALOG.map((entry) => entry.name));

/** `workflow_<event name, dots as underscores>_total` */
export function eventMetricName(eventName: string): string {
  return `workflow_${eventName.replace(/[^a-zA-Z0-9]/g, '_')}_total`;
}

/**
 * The event counters (one per catalog event name, created on its first event) behind `includeMessageEventBusMetrics`.
 * The sink accepts nothing when the toggle is off. The queue job counters are not here: `queueGauges` counts them.
 * `credential_type` (payload `credentialType`, `unknown` when absent, dots as underscores) exists only on the
 * credential event counters, and only behind its own toggle.
 */
export function eventMetrics(registry: Registry, toggles: MetricsToggles): EventSink {
  const labelKeys: Array<[string, string]> = [];
  if (toggles.includeWorkflowIdLabel) labelKeys.push(['workflow_id', 'workflowId']);
  if (toggles.includeWorkflowNameLabel) labelKeys.push(['workflow_name', 'workflowName']);
  if (toggles.includeNodeTypeLabel) labelKeys.push(['node_type', 'nodeType']);
  const labelNames = labelKeys.map(([label]) => label);
  const hasCredentialLabel = (eventName: string) =>
    toggles.includeCredentialTypeLabel && eventName.startsWith(CREDENTIAL_EVENT_PREFIX);

  const counters = new Map<string, Counter<string>>();
  const counterFor = (eventName: string): Counter<string> => {
    let counter = counters.get(eventName);
    if (!counter) {
      counter = new Counter({
        name: eventMetricName(eventName),
        help: `Events named ${eventName}`,
        labelNames: hasCredentialLabel(eventName) ? [...labelNames, 'credential_type'] : labelNames,
        registers: [registry],
      });
      counters.set(eventName, counter);
    }
    return counter;
  };

  return {
    accepts(_tenantId: string, eventName: string): boolean {
      return toggles.includeMessageEventBusMetrics && CATALOG_NAMES.has(eventName);
    },
    deliver(event: StreamEvent): void {
      if (!toggles.includeMessageEventBusMetrics || !CATALOG_NAMES.has(event.eventName)) return;
      const labels: Record<string, string> = {};
      for (const [label, key] of labelKeys) labels[label] = text(event.payload[key]);
      if (hasCredentialLabel(event.eventName)) {
        labels.credential_type = text(event.payload.credentialType).replace(/\./g, '_') || 'unknown';
      }
      counterFor(event.eventName).inc(labels);
    },
  };
}
