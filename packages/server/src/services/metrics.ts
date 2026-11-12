/** Prometheus metrics (ARCHITECTURE.md §16). One registry per server instance. */
import type { GuardEvent } from '@workflow/core';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsToggles } from '../config';
import type { Database } from '../db/client';
import type { EventSink } from './events/stream';
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
   * P6-71 (S5 C0): the event counters' sink (`ctx.events`). stub (L15): PASSES: accepts nothing.
   */
  readonly eventsSink: EventSink = { accepts: () => false, deliver: () => {} };

  constructor(readonly options: MetricsOptions = {}) {
    const collectors = options;
    // stays always on until L15 gates it with `toggles.includeDefaultMetrics`
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
      registers: [this.registry],
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
        if (queueDepth) this.set(await queueDepth().catch(() => 0));
      },
    });
    const activeWorkflows = collectors.activeWorkflows;
    this.activeWorkflows = new Gauge({
      name: 'workflow_active_workflows',
      help: 'Active (published) workflows',
      registers: [this.registry],
      async collect() {
        if (activeWorkflows) this.set(await activeWorkflows().catch(() => 0));
      },
    });
  }

  recordExecution(status: string, mode: string, durationMs: number): void {
    this.executions.inc({ status, mode });
    this.executionDuration.observe({ status, mode }, durationMs / 1000);
  }

  /** P6-71: one REST or public API request; `route` is the route pattern, never the raw URL. stub (L15): PASSES */
  observeApi(_method: string, _route: string, _status: number, _ms: number): void {}

  /** P6-71: one production webhook request, with the hook's registered path. stub (L15): PASSES */
  observeWebhook(_o: {
    method: string;
    statusCode: number;
    webhookPath: string;
    workflowId: string;
    ms: number;
  }): void {}

  /** P6-71: one form submission, with the form's registered path. stub (L15): PASSES */
  observeForm(_o: { statusCode: number; formPath: string; workflowId: string; ms: number }): void {}

  /** P6-71: one poll of a polling trigger. stub (L15): PASSES */
  recordPoll(_nodeType: string, _ok: boolean, _ms: number): void {}

  /** P6-71: one schedule trigger fire. stub (L15): PASSES */
  recordSchedule(_nodeType: string, _ms: number): void {}

  /** P6-71: an SSRF guard check or DNS lookup (`HttpClient.setGuardListener`). stub (L15): PASSES */
  onGuard(_event: GuardEvent): void {}
}
