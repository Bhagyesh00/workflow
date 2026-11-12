/**
 * P6-71 (S5 L15): the Prometheus metric families. With every toggle on, a scrape of /metrics shows each family
 * after its action (a REST call, an event, a queued job on Redis, a poll, a run, a blocked request, a form post,
 * a scrape of the pool, the leader); with the defaults the label families are absent and no workflow name
 * appears in the scrape. The label toggles are checked one by one on a bare `Metrics`. No network beyond
 * 127.0.0.1; fixed fake values only.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetricsToggles } from '../src/config';
import { Metrics } from '../src/services/metrics';
import { DEFAULT_METRICS_TOGGLES } from '../src/services/metrics-collectors';
import { startHttpSink } from './fakes/http-sink';
import {
  chain,
  createTestServer,
  createWorkflow,
  flushRedis,
  node,
  resetDatabase,
  setNode,
  signup,
  TEST_REDIS,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

const ALL_ON: Record<string, string> = {
  METRICS_INCLUDE_DEFAULT_METRICS: 'true',
  METRICS_INCLUDE_WORKFLOW_ID_LABEL: 'true',
  METRICS_INCLUDE_WORKFLOW_NAME_LABEL: 'true',
  METRICS_INCLUDE_NODE_TYPE_LABEL: 'true',
  METRICS_INCLUDE_CREDENTIAL_TYPE_LABEL: 'true',
  METRICS_INCLUDE_API_ENDPOINTS: 'true',
  METRICS_INCLUDE_API_PATH_LABEL: 'true',
  METRICS_INCLUDE_API_METHOD_LABEL: 'true',
  METRICS_INCLUDE_API_STATUS_CODE_LABEL: 'true',
  METRICS_INCLUDE_MESSAGE_EVENT_BUS_METRICS: 'true',
  METRICS_INCLUDE_QUEUE_METRICS: 'true',
  METRICS_INCLUDE_SCHEDULER_METRICS: 'true',
  METRICS_INCLUDE_POLL_TRIGGER_METRICS: 'true',
  METRICS_INCLUDE_WORKFLOW_STATISTICS: 'true',
  METRICS_INCLUDE_SSRF_METRICS: 'true',
  METRICS_INCLUDE_DNS_CACHE_METRICS: 'true',
  METRICS_INCLUDE_WEBHOOK_METRICS: 'true',
  METRICS_INCLUDE_FORM_METRICS: 'true',
  METRICS_INCLUDE_DB_POOL_METRICS: 'true',
  METRICS_INCLUDE_WORKFLOW_EXECUTION_DURATION: 'true',
  METRICS_QUEUE_METRICS_INTERVAL: '1',
  METRICS_ACTIVE_WORKFLOW_METRIC_INTERVAL: '1',
  METRICS_WORKFLOW_STATISTICS_INTERVAL: '1',
};

const toggles = (over: Partial<MetricsToggles> = {}): MetricsToggles => ({
  ...DEFAULT_METRICS_TOGGLES,
  ...over,
});

/** the value of the first sample of `metric` whose line holds every `labels` pair; undefined when none */
function sample(body: string, metric: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(metric)) continue;
    const rest = line.slice(metric.length);
    if (rest[0] !== ' ' && rest[0] !== '{') continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return undefined;
}

const scrapeOf = async (server: TestServer): Promise<string> =>
  (await server.app.inject({ url: '/metrics' })).body;

describe('defaults (n8n: label families and the webhook and form families are off)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await createTestServer();
  });
  afterAll(async () => {
    await server?.close();
  });

  it('shows the always-on families and the default process metrics only', async () => {
    const { client, tenant } = await signup(server.app);
    const name = `Secret flow ${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(client, { name, nodes: [node('Start', 'core.manualTrigger')] });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    server.ctx.events.emit(tenant.id, 'workflow.success', { workflowId: wf.id, workflowName: name });
    await client.get('/rest/workflows');
    const body = await scrapeOf(server);
    expect(sample(body, 'workflow_process_cpu_user_seconds_total')).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/workflow_executions_total\{status="success",mode="manual"\} \d+/);
    expect(body).toContain('workflow_execution_duration_seconds_bucket');
    expect(body).toContain('workflow_webhook_duration_seconds');
    expect(body).toContain('workflow_active_workflows');
    expect(sample(body, 'workflow_instance_role_leader')).toBe(1);
    expect(sample(body, 'workflow_version_info', { version: server.ctx.config.version })).toBe(1);
    for (const absent of [
      'workflow_http_request_duration_seconds',
      'workflow_webhook_request_duration_seconds',
      'workflow_form_submission_duration_seconds',
      'workflow_workflow_success_total',
      'workflow_scaling_mode_queue_jobs',
      'workflow_scheduler_',
      'workflow_poll_trigger_',
      'workflow_statistics_',
      'workflow_ssrf_',
      'workflow_dns_',
      'workflow_db_pool_',
    ]) {
      expect(body, absent).not.toContain(absent);
    }
    expect(body).not.toContain(name);
    expect(body).not.toContain(wf.id);
    expect(body).not.toContain(tenant.id);
  });
});

describe('toggles on a bare Metrics', () => {
  it('leaves the default process metrics out when the toggle is off, and always keeps the old families', async () => {
    const m = new Metrics({ toggles: toggles({ includeDefaultMetrics: false }) });
    const body = await m.registry.metrics();
    expect(body).not.toContain('workflow_process_cpu');
    expect(body).toContain('workflow_executions_total');
    expect(body).toContain('workflow_webhook_duration_seconds');
    expect(body).toContain('workflow_queue_depth');
    expect(body).toContain('workflow_active_workflows');
    const plain = await new Metrics().registry.metrics();
    expect(plain).toContain('workflow_process_cpu');
    expect(plain).toContain('workflow_execution_duration_seconds');
  });

  it('leaves the execution duration out when its toggle is off', async () => {
    const m = new Metrics({ toggles: toggles({ includeWorkflowExecutionDuration: false }) });
    m.recordExecution('success', 'manual', 20);
    const body = await m.registry.metrics();
    expect(body).not.toContain('workflow_execution_duration_seconds');
    expect(sample(body, 'workflow_executions_total', { status: 'success' })).toBe(1);
  });

  it('API requests: the family and each label follow their toggle; the path is the route pattern', async () => {
    const off = new Metrics({ toggles: toggles() });
    off.observeApi('GET', '/rest/x/:id', 200, 5);
    expect(await off.registry.metrics()).not.toContain('workflow_http_request_duration_seconds');

    const only = new Metrics({ toggles: toggles({ includeApiEndpoints: true }) });
    only.observeApi('GET', '/rest/x/:id', 200, 5);
    const bare = await only.registry.metrics();
    expect(sample(bare, 'workflow_http_request_duration_seconds_count')).toBe(1);
    expect(bare).not.toMatch(/workflow_http_request_duration_seconds_count\{/);

    const path = new Metrics({ toggles: toggles({ includeApiEndpoints: true, includeApiPathLabel: true }) });
    path.observeApi('POST', '/rest/x/:id', 404, 5);
    const pathBody = await path.registry.metrics();
    expect(sample(pathBody, 'workflow_http_request_duration_seconds_count', { path: '/rest/x/:id' })).toBe(1);
    expect(pathBody).not.toContain('method="POST"');
    expect(pathBody).not.toContain('status_code=');

    const full = new Metrics({
      toggles: toggles({
        includeApiEndpoints: true,
        includeApiPathLabel: true,
        includeApiMethodLabel: true,
        includeApiStatusCodeLabel: true,
      }),
    });
    full.observeApi('PATCH', '/rest/x/:id', 403, 5);
    expect(
      sample(await full.registry.metrics(), 'workflow_http_request_duration_seconds_count', {
        method: 'PATCH',
        path: '/rest/x/:id',
        status_code: '403',
      }),
    ).toBe(1);
  });

  it('webhook and form families carry n8n labels and need their own toggle', async () => {
    const off = new Metrics({ toggles: toggles() });
    off.observeWebhook({ method: 'POST', statusCode: 200, webhookPath: 'p', workflowId: 'w', ms: 3 });
    off.observeForm({ statusCode: 200, formPath: 'p', workflowId: 'w', ms: 3 });
    const offBody = await off.registry.metrics();
    expect(offBody).not.toContain('workflow_webhook_request_duration_seconds');
    expect(offBody).not.toContain('workflow_form_submission_duration_seconds');

    const on = new Metrics({ toggles: toggles({ includeWebhookMetrics: true, includeFormMetrics: true }) });
    on.observeWebhook({ method: 'POST', statusCode: 202, webhookPath: 'orders', workflowId: 'wf-1', ms: 3 });
    on.observeForm({ statusCode: 200, formPath: 'signup', workflowId: 'wf-2', ms: 3 });
    const body = await on.registry.metrics();
    expect(
      sample(body, 'workflow_webhook_request_duration_seconds_count', {
        method: 'POST',
        status_code: '202',
        webhook_path: 'orders',
        workflow_id: 'wf-1',
      }),
    ).toBe(1);
    expect(
      sample(body, 'workflow_form_submission_duration_seconds_count', {
        status_code: '200',
        form_path: 'signup',
        workflow_id: 'wf-2',
      }),
    ).toBe(1);
  });

  it('event counters: one per catalog name, tenant labels only on their toggle, unknown names ignored', async () => {
    const stream = (m: Metrics, name: string, payload: Record<string, unknown>) => {
      if (m.eventsSink.accepts('t', name)) {
        m.eventsSink.deliver({
          id: 'i',
          ts: new Date().toISOString(),
          eventName: name,
          message: name,
          payload: payload as never,
          tenantId: 't',
        });
      }
    };
    const payload = {
      workflowId: 'wf-9',
      workflowName: 'My flow',
      nodeType: 'core.code',
      credentialType: 'httpBasic',
    };
    const off = new Metrics({ toggles: toggles() });
    expect(off.eventsSink.accepts('t', 'workflow.started')).toBe(false);

    const bare = new Metrics({ toggles: toggles({ includeMessageEventBusMetrics: true }) });
    stream(bare, 'workflow.started', payload);
    stream(bare, 'audit.external-secrets.connection.created', payload);
    stream(bare, 'not.in.the.catalog', payload);
    const bareBody = await bare.registry.metrics();
    expect(sample(bareBody, 'workflow_workflow_started_total')).toBe(1);
    expect(sample(bareBody, 'workflow_audit_external_secrets_connection_created_total')).toBe(1);
    expect(bareBody).not.toContain('not_in_the_catalog');
    for (const label of ['workflow_id', 'workflow_name', 'node_type', 'credential_type', 'wf-9', 'My flow']) {
      expect(bareBody, label).not.toContain(label);
    }

    const labelled = new Metrics({
      toggles: toggles({
        includeMessageEventBusMetrics: true,
        includeWorkflowIdLabel: true,
        includeWorkflowNameLabel: true,
        includeNodeTypeLabel: true,
        includeCredentialTypeLabel: true,
      }),
    });
    stream(labelled, 'node.finished', payload);
    stream(labelled, 'node.finished', payload);
    expect(
      sample(await labelled.registry.metrics(), 'workflow_node_finished_total', {
        workflow_id: 'wf-9',
        workflow_name: 'My flow',
        node_type: 'core.code',
        credential_type: 'httpBasic',
      }),
    ).toBe(2);

    const idOnly = new Metrics({
      toggles: toggles({ includeMessageEventBusMetrics: true, includeWorkflowIdLabel: true }),
    });
    stream(idOnly, 'workflow.success', payload);
    const idBody = await idOnly.registry.metrics();
    expect(sample(idBody, 'workflow_workflow_success_total', { workflow_id: 'wf-9' })).toBe(1);
    expect(idBody).not.toContain('My flow');
    expect(idBody).not.toContain('node_type');
  });

  it('queue gauges come from jobCounts at the interval; completed and failed are counted from the events', async () => {
    let calls = 0;
    let counts = { waiting: 3, active: 2 };
    const queue = {
      jobCounts: async () => {
        calls += 1;
        return counts;
      },
    };
    const m = new Metrics({
      toggles: toggles({ includeQueueMetrics: true, queueMetricsInterval: 1 }),
      queue: queue as never,
    });
    const first = await m.registry.metrics();
    expect(sample(first, 'workflow_scaling_mode_queue_jobs_waiting')).toBe(3);
    expect(sample(first, 'workflow_scaling_mode_queue_jobs_active')).toBe(2);
    counts = { waiting: 7, active: 1 };
    await m.registry.metrics();
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const later = await m.registry.metrics();
    expect(calls).toBe(2);
    expect(sample(later, 'workflow_scaling_mode_queue_jobs_waiting')).toBe(7);

    expect(m.eventsSink.accepts('t', 'queue.job.completed')).toBe(true);
    expect(m.eventsSink.accepts('t', 'queue.job.failed')).toBe(true);
    expect(m.eventsSink.accepts('t', 'queue.job.enqueued')).toBe(false);
    const send = (eventName: string) =>
      m.eventsSink.deliver({ id: 'i', ts: '', eventName, message: eventName, payload: {}, tenantId: 't' });
    send('queue.job.completed');
    send('queue.job.completed');
    send('queue.job.failed');
    const end = await m.registry.metrics();
    expect(sample(end, 'workflow_scaling_mode_queue_jobs_completed')).toBe(2);
    expect(sample(end, 'workflow_scaling_mode_queue_jobs_failed')).toBe(1);
  });

  it('the pool gauges and the guard counters follow their toggles', async () => {
    const pool = { totalCount: 4, idleCount: 3, waitingCount: 1 };
    const on = new Metrics({
      toggles: toggles({
        includeDbPoolMetrics: true,
        includeSsrfMetrics: true,
        includeDnsCacheMetrics: true,
      }),
      database: { pool } as never,
    });
    on.onGuard({ kind: 'check', allowed: true });
    on.onGuard({ kind: 'check', allowed: false });
    on.onGuard({ kind: 'check', allowed: false });
    on.onGuard({ kind: 'lookup', ok: true, durationMs: 4 });
    on.onGuard({ kind: 'lookup', ok: false, durationMs: 9 });
    const body = await on.registry.metrics();
    expect(sample(body, 'workflow_db_pool_connections_total')).toBe(4);
    expect(sample(body, 'workflow_db_pool_connections_idle')).toBe(3);
    expect(sample(body, 'workflow_db_pool_connections_waiting')).toBe(1);
    expect(sample(body, 'workflow_ssrf_checks_total', { result: 'allowed' })).toBe(1);
    expect(sample(body, 'workflow_ssrf_checks_total', { result: 'blocked' })).toBe(2);
    expect(sample(body, 'workflow_dns_lookups_total', { result: 'ok' })).toBe(1);
    expect(sample(body, 'workflow_dns_lookups_total', { result: 'error' })).toBe(1);

    const off = new Metrics({ toggles: toggles() });
    off.onGuard({ kind: 'check', allowed: false });
    off.onGuard({ kind: 'lookup', ok: true, durationMs: 1 });
    const offBody = await off.registry.metrics();
    expect(offBody).not.toContain('workflow_ssrf_');
    expect(offBody).not.toContain('workflow_dns_');
  });

  it('scheduler and poll counters by node type, each behind its toggle', async () => {
    const off = new Metrics({ toggles: toggles() });
    off.recordPoll('test.poll', true, 5);
    off.recordSchedule('core.scheduleTrigger', 5);
    expect(await off.registry.metrics()).not.toMatch(/workflow_(poll_trigger|scheduler)_/);

    const on = new Metrics({
      toggles: toggles({ includePollTriggerMetrics: true, includeSchedulerMetrics: true }),
    });
    on.recordPoll('test.poll', true, 5);
    on.recordPoll('test.poll', false, 5);
    on.recordSchedule('core.scheduleTrigger', 5);
    const body = await on.registry.metrics();
    expect(sample(body, 'workflow_poll_trigger_polls_total', { node_type: 'test.poll', result: 'ok' })).toBe(
      1,
    );
    expect(
      sample(body, 'workflow_poll_trigger_polls_total', { node_type: 'test.poll', result: 'error' }),
    ).toBe(1);
    expect(sample(body, 'workflow_poll_trigger_duration_seconds_count', { node_type: 'test.poll' })).toBe(2);
    expect(sample(body, 'workflow_scheduler_triggers_total', { node_type: 'core.scheduleTrigger' })).toBe(1);
    expect(sample(body, 'workflow_scheduler_trigger_duration_seconds_count')).toBe(1);
  });

  it('version info splits the version; the leader gauge follows leadership', async () => {
    const leadership = { isLeader: false } as never;
    const m = new Metrics({ version: '1.22.3-beta.1', leadership });
    expect(
      sample(await m.registry.metrics(), 'workflow_version_info', { major: '1', minor: '22', patch: '3' }),
    ).toBe(1);
    expect(sample(await m.registry.metrics(), 'workflow_instance_role_leader')).toBe(0);
    (leadership as { isLeader: boolean }).isLeader = true;
    expect(sample(await m.registry.metrics(), 'workflow_instance_role_leader')).toBe(1);
  });
});

async function latestRun(server: TestServer, tenantId: string, workflowId: string) {
  return waitFor(
    async () => (await server.ctx.repos.executions.list(tenantId, { workflowId, limit: 1 }))[0],
    {
      message: 'the run to start',
    },
  );
}

describe('every toggle on, a scrape of /metrics after each action', () => {
  let server: TestServer;
  let owner: Awaited<ReturnType<typeof signup>>;
  const names = new Map<string, string>();
  const scrapeUntil = (check: (body: string) => boolean, message: string) =>
    waitFor(
      async () => {
        const body = await scrapeOf(server);
        return check(body) ? body : undefined;
      },
      { message, timeout: 15_000 },
    );

  beforeAll(async () => {
    server = await createTestServer(ALL_ON);
    owner = await signup(server.app);
  });
  afterAll(async () => {
    await server?.close();
  });

  const active = async (nodes: WorkflowNode[], connections: unknown) => {
    const workflow = await createWorkflow(owner.client, { nodes, connections });
    await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/activate`));
    return workflow;
  };

  it('a REST call: the request family with the route pattern, never the raw id', async () => {
    const wf = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    expect((await owner.client.get(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
    await owner.client.get(`/rest/workflows/${randomUUID()}`);
    const body = await scrapeOf(server);
    expect(
      sample(body, 'workflow_http_request_duration_seconds_count', {
        method: 'GET',
        path: '/rest/workflows/:id',
        status_code: '200',
      }),
    ).toBeGreaterThanOrEqual(1);
    const requestLines = body.split('\n').filter((line) => line.startsWith('workflow_http_request_duration'));
    expect(requestLines.length).toBeGreaterThan(0);
    expect(requestLines.join('\n')).not.toContain(wf.id);
  });

  it('a run: the execution counters and, by statistics, the manual execution total', async () => {
    const wf = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const { executionId } = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const body = await scrapeUntil(
      (b) => (sample(b, 'workflow_statistics_manual_executions') ?? 0) >= 1,
      'the statistics gauges',
    );
    expect(
      sample(body, 'workflow_executions_total', { status: 'success', mode: 'manual' }),
    ).toBeGreaterThanOrEqual(1);
    expect(sample(body, 'workflow_statistics_users')).toBeGreaterThanOrEqual(1);
    expect(sample(body, 'workflow_statistics_workflows')).toBeGreaterThanOrEqual(1);
    expect(sample(body, 'workflow_statistics_credentials')).toBe(0);
    expect(sample(body, 'workflow_statistics_production_executions')).toBe(0);
    expect(body).not.toContain('tenant');
  });

  it('an event: the counter named for it, with the label toggles on', async () => {
    const workflowName = `Flow ${randomUUID().slice(0, 8)}`;
    names.set('flow', workflowName);
    server.ctx.events.emit(owner.tenant.id, 'node.finished', {
      workflowId: 'wf-evt',
      workflowName,
      nodeType: 'core.code',
    });
    server.ctx.events.emit(owner.tenant.id, 'audit.user.credentials.created', {
      credentialType: 'httpBasicAuth',
    });
    server.ctx.events.emit(owner.tenant.id, 'not.in.the.catalog', {});
    const body = await scrapeOf(server);
    expect(
      sample(body, 'workflow_node_finished_total', {
        workflow_id: 'wf-evt',
        workflow_name: workflowName,
        node_type: 'core.code',
      }),
    ).toBe(1);
    expect(
      sample(body, 'workflow_audit_user_credentials_created_total', { credential_type: 'httpBasicAuth' }),
    ).toBe(1);
    expect(body).not.toContain('not_in_the_catalog');
  });

  it('a blocked request and an allowed one: the SSRF and DNS counters', async () => {
    const sink = await startHttpSink();
    try {
      expect(() => server.ctx.http.assertUrlAllowed('http://10.0.0.1/')).toThrow();
      const port = new URL(sink.url).port;
      await server.ctx.http.request({ url: `http://localhost:${port}/ok` }).catch(() => {});
      const body = await scrapeOf(server);
      expect(sample(body, 'workflow_ssrf_checks_total', { result: 'blocked' })).toBeGreaterThanOrEqual(1);
      expect(sample(body, 'workflow_ssrf_checks_total', { result: 'allowed' })).toBeGreaterThanOrEqual(1);
      expect(sample(body, 'workflow_dns_lookups_total', { result: 'ok' })).toBeGreaterThanOrEqual(1);
    } finally {
      await sink.close();
    }
  });

  it('a form post and a webhook: their families with the registered path and the workflow id', async () => {
    const formPath = `f-${randomUUID().slice(0, 8)}`;
    const form = await active(
      [
        node('Start', 'core.formTrigger', {
          formTitle: 'Sign up',
          path: formPath,
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
        }),
        setNode('Mark', 'done', 'yes'),
      ],
      chain('Start', 'Mark'),
    );
    const boundary = 'F0RMB0UNDARY';
    const posted = await server.app.inject({
      method: 'POST',
      url: `/form/${owner.tenant.slug}/${formPath}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="field-0"',
        '',
        'Ann',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    expect(posted.statusCode).toBe(200);

    const hookPath = `w-${randomUUID().slice(0, 8)}`;
    const hook = await active(
      [
        node('Hook', 'core.webhook', { path: hookPath, httpMethod: 'POST' }, [0, 0], {
          webhookId: randomUUID(),
        }),
        setNode('Done', 'ok', 'yes'),
      ],
      chain('Hook', 'Done'),
    );
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/${hookPath}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const run = await latestRun(server, owner.tenant.id, hook.id);
    await waitForExecution(server.ctx, owner.tenant.id, run.id, ['success']);

    const body = await scrapeOf(server);
    expect(
      sample(body, 'workflow_form_submission_duration_seconds_count', {
        status_code: '200',
        form_path: formPath,
        workflow_id: form.id,
      }),
    ).toBe(1);
    expect(
      sample(body, 'workflow_webhook_request_duration_seconds_count', {
        method: 'POST',
        status_code: '200',
        webhook_path: hookPath,
        workflow_id: hook.id,
      }),
    ).toBe(1);
    // the always-on family (test/api.test.ts pins it) still counts the same requests
    expect(body).toContain('workflow_webhook_duration_seconds_count');
    const stats = await scrapeUntil(
      (b) => (sample(b, 'workflow_statistics_production_executions') ?? 0) >= 1,
      'the production count',
    );
    expect(sample(stats, 'workflow_active_workflows')).toBeGreaterThanOrEqual(2);
  });

  it('a poll: the poll trigger counters by node type', async () => {
    const wf = await active(
      [node('Poller', 'test.poll', { pollTimes: { item: [{ mode: 'everyHour', minute: 59 }] } })],
      {},
    );
    const run = await latestRun(server, owner.tenant.id, wf.id);
    await waitForExecution(server.ctx, owner.tenant.id, run.id, ['success']);
    const body = await scrapeUntil(
      (b) =>
        (sample(b, 'workflow_poll_trigger_polls_total', { node_type: 'test.poll', result: 'ok' }) ?? 0) >= 1,
      'the poll counter',
    );
    expect(
      sample(body, 'workflow_poll_trigger_duration_seconds_count', { node_type: 'test.poll' }),
    ).toBeGreaterThanOrEqual(1);
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('the pool, the leader and the version', async () => {
    const body = await scrapeOf(server);
    expect(sample(body, 'workflow_db_pool_connections_total')).toBeGreaterThanOrEqual(1);
    expect(sample(body, 'workflow_db_pool_connections_idle')).toBeGreaterThanOrEqual(0);
    expect(sample(body, 'workflow_db_pool_connections_waiting')).toBeGreaterThanOrEqual(0);
    expect(sample(body, 'workflow_instance_role_leader')).toBe(1);
    expect(sample(body, 'workflow_version_info', { version: server.ctx.config.version })).toBe(1);
  });
});

describe('queue mode on Redis', () => {
  let server: TestServer;
  beforeAll(async () => {
    await flushRedis();
    server = await createTestServer({
      ...ALL_ON,
      EXECUTIONS_MODE: 'queue',
      REDIS_URL: TEST_REDIS,
      QUEUE_PREFIX: `wfmetrics${randomUUID().slice(0, 6)}`,
    });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('a queued job waits on Redis and shows in the waiting gauge; completed and failed come from events', async () => {
    await resetDatabase(server.ctx);
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const body = await waitFor(
      async () => {
        const text = await scrapeOf(server);
        return (sample(text, 'workflow_scaling_mode_queue_jobs_waiting') ?? 0) >= 1 ? text : undefined;
      },
      { message: 'the waiting gauge', timeout: 15_000 },
    );
    expect(sample(body, 'workflow_scaling_mode_queue_jobs_active')).toBe(0);
    server.ctx.events.emit(tenant.id, 'queue.job.completed', {
      executionId: 'e1',
      workflowId: wf.id,
      jobId: '1',
    });
    server.ctx.events.emit(tenant.id, 'queue.job.failed', {
      executionId: 'e2',
      workflowId: wf.id,
      jobId: '2',
    });
    server.ctx.events.emit(tenant.id, 'queue.job.failed', {
      executionId: 'e3',
      workflowId: wf.id,
      jobId: '3',
    });
    const end = await scrapeOf(server);
    expect(sample(end, 'workflow_scaling_mode_queue_jobs_completed')).toBe(1);
    expect(sample(end, 'workflow_scaling_mode_queue_jobs_failed')).toBe(2);
    expect(sample(end, 'workflow_queue_depth')).toBeGreaterThanOrEqual(1);
  });
});
