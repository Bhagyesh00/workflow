/** Prometheus metrics (ARCHITECTURE.md §16). One registry per server instance. */
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly executions: Counter<'status' | 'mode'>;
  readonly executionDuration: Histogram<'status' | 'mode'>;
  readonly webhookDuration: Histogram<'status'>;
  readonly queueDepth: Gauge;
  readonly activeWorkflows: Gauge;

  constructor(
    collectors: { queueDepth?: () => Promise<number>; activeWorkflows?: () => Promise<number> } = {},
  ) {
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
}
