/** Prometheus metrics (ARCHITECTURE.md §16). One registry per server instance. */
import type { GuardEvent } from '@workflow/core';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsToggles } from '../config';
import type { Database } from '../db/client';
import type { EventSink } from './events/stream';
import {
  apiMetrics,
  cachedRead,
  DEFAULT_METRICS_TOGGLES,
  eventMetrics,
  guardMetrics,
  instanceMetrics,
  poolMetrics,
  queueGauges,
  READ_TIMEOUT_MS,
  statisticsMetrics,
  type TriggerObservers,
  triggerMetrics,
  type WebhookFormObservers,
  webhookFormMetrics,
  withTimeout,
} from './metrics-collectors';
import type { ExecutionQueue, Leadership } from './queue';

/**
 * P6-71 (S5 C0, final): what the metrics read. Every field is optional, so `new Metrics()` still builds (tests).
 * L15 gates the families with `toggles` (absent = n8n's defaults).
 */
export interface MetricsOptions {
  queueDepth?: () => Promise<number>;
  activeWorkflows?: () => Promise<number>;
  toggles?: MetricsToggles;
  /** the server version (`workflow_version_info`) */
  version?: string;
  /** the pool gauges */
  database?: Database;
  /** the queue gauges (`jobCounts`) */
  queue?: ExecutionQueue;
  /** `workflow_instance_role_leader` */
  leadership?: Leadership;
}

export class Metrics {
  readonly registry = new Registry();
  readonly executions: Counter<'status' | 'mode'>;
  readonly executionDuration: Histogram<'status' | 'mode'>;
  readonly webhookDuration: Histogram<'status'>;
  readonly queueDepth: Gauge;
  readonly activeWorkflows: Gauge;

  /**
   * P6-71: the event counters' sink (`ctx.events`): the per-event counters behind `includeMessageEventBusMetrics`;
   * it accepts nothing when the toggle is off. The queue job counters are counted by `queueGauges`.
   */
  readonly eventsSink: EventSink;

  private readonly observeApiRequest?: ReturnType<typeof apiMetrics>;
  private readonly webhookForm: WebhookFormObservers;
  private readonly triggers: TriggerObservers;
  private readonly guard?: ReturnType<typeof guardMetrics>;

  constructor(readonly options: MetricsOptions = {}) {
    const collectors = options;
    const toggles = options.toggles ?? DEFAULT_METRICS_TOGGLES;
    if (toggles.includeDefaultMetrics)
      collectDefaultMetrics({ register: this.registry, prefix: 'workflow_' });
    this.executions = new Counter({
      name: 'workflow_executions_total',
      help: 'Finished executions by status and mode',
      labelNames: ['status', 'mode'],
      registers: [this.registry],
    });
    this.executionDuration = new Histogram({
      name: 'workflow_execution_duration_seconds',
      help: 'Execution duration',
      labelNames: ['status', 'mode'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800],
      // the histogram exists either way (recordExecution observes it); off, no scrape shows it
      registers: toggles.includeWorkflowExecutionDuration ? [this.registry] : [],
    });
    this.webhookDuration = new Histogram({
      name: 'workflow_webhook_duration_seconds',
      help: 'Webhook request latency',
      labelNames: ['status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    const queueDepth = collectors.queueDepth;
    this.queueDepth = new Gauge({
      name: 'workflow_queue_depth',
      help: 'Jobs waiting or running in the execution queue',
      registers: [this.registry],
      async collect() {
        if (queueDepth) this.set(await withTimeout(queueDepth(), READ_TIMEOUT_MS).catch(() => 0));
      },
    });
    // read at most every METRICS_ACTIVE_WORKFLOW_METRIC_INTERVAL seconds
    const activeWorkflows = collectors.activeWorkflows;
    const readActive = cachedRead(
      toggles.activeWorkflowCountInterval,
      async () => activeWorkflows?.() ?? 0,
      0,
    );
    this.activeWorkflows = new Gauge({
      name: 'workflow_active_workflows',
      help: 'Active (published) workflows',
      registers: [this.registry],
      async collect() {
        if (activeWorkflows) this.set(await readActive());
      },
    });

    this.observeApiRequest = apiMetrics(this.registry, toggles);
    this.webhookForm = webhookFormMetrics(this.registry, toggles);
    this.triggers = triggerMetrics(this.registry, toggles);
    this.guard = guardMetrics(this.registry, toggles);
    poolMetrics(this.registry, toggles, options.database);
    statisticsMetrics(this.registry, toggles, options.database);
    queueGauges(this.registry, toggles, options.queue);
    instanceMetrics(this.registry, options.version, options.leadership);
    this.eventsSink = eventMetrics(this.registry, toggles);
  }

  recordExecution(status: string, mode: string, durationMs: number): void {
    this.executions.inc({ status, mode });
    this.executionDuration.observe({ status, mode }, durationMs / 1000);
  }

  /** P6-71: one REST or public API request; `route` is the route pattern, never the raw URL. */
  observeApi(method: string, route: string, status: number, ms: number): void {
    this.observeApiRequest?.(method, route, status, ms);
  }

  /** P6-71: one webhook request (a test URL's included, as n8n counts it), with the hook's registered path (behind `includeWebhookMetrics`). */
  observeWebhook(o: {
    method: string;
    statusCode: number;
    webhookPath: string;
    workflowId: string;
    ms: number;
  }): void {
    this.webhookForm.webhook?.(o);
  }

  /** P6-71: one form submission, with the form's registered path (behind `includeFormMetrics`). */
  observeForm(o: { statusCode: number; formPath: string; workflowId: string; ms: number }): void {
    this.webhookForm.form?.(o);
  }

  /** P6-71: one poll of a polling trigger (behind `includePollTriggerMetrics`). */
  recordPoll(nodeType: string, ok: boolean, ms: number): void {
    this.triggers.poll?.(nodeType, ok, ms);
  }

  /** P6-71: one schedule trigger fire (behind `includeSchedulerMetrics`). */
  recordSchedule(nodeType: string, ms: number): void {
    this.triggers.schedule?.(nodeType, ms);
  }

  /** P6-71: an SSRF guard check or DNS lookup (`HttpClient.setGuardListener`). */
  onGuard(event: GuardEvent): void {
    this.guard?.(event);
  }
}
