# Observability (Phase 6, stage 5)

This page covers log streaming, OpenTelemetry traces and Prometheus metrics. It lists our names next to n8n's, the decisions behind them and where we differ from n8n on purpose.

## What S5 adds

**Event stream.** One lifecycle observer turns runs, nodes, queue jobs, workers, runner tasks, audit actions and AI sub-node calls into events. Names follow n8n's. Code: `packages/server/src/services/events/` (`execution-events.ts`, `queue-events.ts`, `runner-events.ts`, `audit-events.ts`, `ai-events.ts`, `stream.ts`). The catalog is `packages/workflow/src/event-catalog.ts`.

**Log streaming destinations.** A workspace admin adds destinations of type `webhook`, `syslog` or `sentry`. Each one picks its events and can anonymize. A webhook takes a URL, method, credential, query and headers. Syslog sends RFC 5424 over UDP, TCP or TLS. Sentry takes a DSN and sends an envelope. A circuit breaker guards each destination. Code: `services/log-streaming/` (`manager.ts`, `breaker.ts`, `anonymize.ts`, `destinations/`).

**Failed event store and replay.** An event a destination could not send is kept and replayed in order after the destination recovers. The store is bounded and old rows are pruned. Code: `services/log-streaming/failed-store.ts`.

**OpenTelemetry tracing.** Each workspace sets its own collector. We export over OTLP HTTP (protobuf) and OTLP gRPC. A run is one `workflow.execute` span and each node is one `node.execute` span. A wait ends the first segment and the resume starts a new one with a link back. Sub-workflows and error workflows keep their parent. A crashed run gets a crash span. Inbound and outbound W3C trace headers carry the trace across calls. Model calls get `gen_ai.*` attributes and never hold prompts. Project, workflow and node telemetry tags become custom attributes. Code: `services/tracing/` (`subscriber.ts`, `tracer.ts`, `exporter.ts`, `exporter-grpc.ts`, `propagation.ts`, `gen-ai.ts`, `custom-attributes.ts`).

**Prometheus metrics.** `/metrics` serves n8n's families behind env toggles, with the prefix `workflow_`. In queue mode the worker serves its own `/metrics` and health path. Code: `services/metrics.ts`, `services/metrics-collectors.ts`, `services/worker-server.ts`.

## Name mapping from n8n to ours

Our rule: n8n's name with the `n8n.` prefix removed. Metrics use `workflow_` where n8n uses `n8n_`.

### Events

| Family | n8n name | Our name |
| --- | --- | --- |
| Workflow | `n8n.workflow.started`, `.success`, `.failed`, `.cancelled` | `workflow.started`, `workflow.success`, `workflow.failed`, `workflow.cancelled` |
| Node | `n8n.node.started`, `n8n.node.finished` | `node.started`, `node.finished` |
| Queue | `n8n.queue.job.enqueued`, `.dequeued`, `.completed`, `.failed`, `.stalled` | `queue.job.enqueued`, `queue.job.dequeued`, `queue.job.completed`, `queue.job.failed`, `queue.job.stalled` |
| Worker | `n8n.worker.started`, `n8n.worker.stopped` | `worker.started`, `worker.stopped` |
| Runner | `n8n.runner.task.requested`, `n8n.runner.response.received` | `runner.task.requested`, `runner.response.received` |
| AI | `n8n.ai.memory.get.messages`, `.memory.added.message`, `.output.parser.parsed`, `.retriever.get.relevant.documents`, `.embeddings.embedded.document`, `.embeddings.embedded.query`, `.document.processed`, `.text.splitter.split`, `.tool.called`, `.vector.store.searched`, `.llm.generated`, `.llm.error`, `.vector.store.populated`, `.vector.store.updated` | the same 14 names without `n8n.`, for example `ai.llm.generated` |

### Audit events

Every audit name is `n8n.audit.*` in n8n and `audit.*` here.

| Group | Our names |
| --- | --- |
| User and sign-in | `audit.user.login.success`, `.login.failed`, `.signedup`, `.updated`, `.deleted`, `.invited`, `.invitation.accepted`, `.reinvited`, `.reset`, `.reset.requested`, `.mfa.enabled`, `.mfa.disabled`, `.api.created`, `.api.deleted`, `.api.rotated`, `.execution.deleted` |
| Credentials | `audit.user.credentials.created`, `.updated`, `.deleted`, `.shared`, `.userDisconnected` |
| Workflow | `audit.workflow.created`, `.updated`, `.deleted`, `.archived`, `.unarchived`, `.activated`, `.deactivated`, `.version.updated`, `.executed`, `.resumed`, `.waiting` |
| Variables | `audit.variable.created`, `.updated`, `.deleted` |
| Execution data | `audit.execution.data.revealed`, `audit.execution.data.reveal_failure` |
| MCP | `audit.mcp.tool.called`, `audit.mcp.oauth.completed`, `audit.mcp.access.updated` |
| External secrets | `audit.external-secrets.connection.created`, `.updated`, `.deleted`, `.tested`, `.reloaded` |
| Workflow reviews | `audit.workflow-review.requested`, `.version-updated`, `.approved`, `.changes-requested`, `.closed`, `audit.workflow-reviews.enabled`, `.disabled` |
| Node type policy | `audit.node-type-policy.scope.updated`, `.document.created`, `.document.updated`, `.document.deleted`, `.attachments.updated`, `audit.policy.decision.blocked` |
| Workspace settings | `audit.redaction-enforcement.updated`, `audit.public-api-rate-limit.enabled` and `.disabled`, `audit.personal-publishing-restricted.enabled` and `.disabled`, `audit.personal-sharing-restricted.enabled` and `.disabled`, `audit.2fa-enforcement.enabled` and `.disabled` |
| SSO role mapping | `audit.role-mapping.rule.created`, `.rule.updated`, `.rule.deleted`, `.rules.bulk-deleted`, `.roles-resolved` |

### Spans and attributes

| n8n | Ours |
| --- | --- |
| `n8n.workflow.execute` span | `workflow.execute` |
| `n8n.node.execute` span | `node.execute` |
| `n8n.workflow.id`, `.name`, `.version_id`, `.node_count` | `workflow.id`, `workflow.name`, `workflow.version_id`, `workflow.node_count` |
| `n8n.execution.id`, `.mode`, `.status`, `.is_retry`, `.retry_of`, `.error_type` | `execution.id`, `execution.mode`, `execution.status`, `execution.is_retry`, `execution.retry_of`, `execution.error_type` |
| `n8n.node.id`, `.name`, `.type`, `.type_version`, `.items.input`, `.items.output` | `node.id`, `node.name`, `node.type`, `node.type_version`, `node.items.input`, `node.items.output` |
| `n8n.node.termination_reason` | `node.termination_reason` |
| `n8n.project.custom.*`, `n8n.workflow.custom.*`, `n8n.node.custom.*` | `project.custom.*`, `workflow.custom.*`, `node.custom.*` |
| `gen_ai.*` (already standard) | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.agent.id`, `gen_ai.agent.name` |

The resume link carries `continuation.reason` = `resume`.

### Metrics

n8n's `n8n_` prefix becomes `workflow_`. Families built here include `workflow_executions_total`, `workflow_execution_duration_seconds`, `workflow_active_workflows`, `workflow_version_info`, `workflow_instance_role_leader`, `workflow_http_request_duration_seconds`, `workflow_webhook_request_duration_seconds`, `workflow_form_submission_duration_seconds`, `workflow_scaling_mode_queue_jobs_waiting`, `_active`, `_completed` and `_failed`, `workflow_db_pool_connections_active`, `_idle` and `workflow_db_pool_requests_pending`, `workflow_ssrf_checks_total`, `workflow_production_executions`, `_manual_executions`, `workflow_users`, `workflow_workflows` and `workflow_credentials`. Node.js default metrics use the same prefix.

## Decisions

- No platform env sends tenant data out. Destinations and collectors belong to the workspace and its admin sets them. There is no env tier and no env-managed destination.
- `/metrics` stays always on behind its bearer token. Families are opt-in per env toggle. Labels that name a workspace's workflows, nodes or credentials are off by default. There is no workflow info metric.
- Only admins can list and test destinations. They show where audit data goes.
- A destination credential must be in the workspace and be one of five generic types. The caller needs read access to it, checked on every save that ends with a credential and on test. An API key acts as its user, so its scopes are not added.
- A run whose redaction applies sends no error text, node tag value or AI `msg`.
- Anonymize is read from the destination's current setting at send time and at replay.
- Wire formats (OTLP protobuf, gRPC unary, Sentry envelope, syslog) are written here on the guarded HTTP client and sockets. No OpenTelemetry SDK, gRPC library or Sentry SDK is used.
- A resumed run keeps `continuation.reason` = `resume` on a link and a child span, as n8n does.
- A node span still open when a run ends is closed with ERROR. A canceled run's workflow span ends OK. Only error and crashed runs end ERROR.
- Model runs: provider comes from the node type with n8n's provider strings (`aws.bedrock`, `azure.ai.openai`, `gcp.gemini`, `gcp.vertex_ai`, `x_ai`, `moonshot_ai`). Only chat calls count. Provider and model come from the first call. A call without usage sets a usage-not-reported flag. There is no `ai.agentTool` type.
- A URL with a user name and password becomes Basic auth. Error text never carries a `scheme://` URL.
- A GET test or event send carries no body.
- Invitation events send the actor and target ids, not the invitee's email. Mapped audit events send an allow list of fields.
- Credential events carry `credentialType`. The `credential_type` metric label defaults to `unknown` and sits only on the credential event counters.
- Queue counters `scaling_mode_queue_jobs_completed` and `_failed` are counted on the main from the queue's global events.
- A project, workflow or node page disables Save while telemetry tags are invalid.
- Dropped: `execution.throttled`, started-during-bootup and cluster events, log file settings, instance Sentry, PostHog diagnostics, other tracers, expression observability, `otel.configure` hook.

## Named deviations from n8n

1. Event, span and attribute names have no `n8n.` prefix. The mapping table above is the key.
2. The stack trace is left out of spans. It shows platform paths to tenants.
3. Listing and testing destinations is admin only. In n8n members can.
4. The test send is POST, not GET.
5. No credential, query or header secret goes over plain `http://` on a webhook, and no OTLP headers go to an `http://` endpoint.
6. Syslog sends the facility as set. n8n always sends Local0. We send no host name.
7. Webhook proxy and socket options are dropped. They are an SSRF path.
8. `/metrics` has no `METRICS` switch. It is always on with its token. The prefix stays `workflow_`.
9. The DNS family counts the guard's lookups, because our client has no DNS cache.
10. The OTel endpoint starts empty, not `http://localhost:4318`.
11. Telemetry tags are bounded: 20 pairs, key 64 characters, value 256.
12. The AI `msg` is cut at 256 KB.
13. Each destination's memory queue holds at most 2000 events and 16 MB. Its failed store holds at most 10000 rows and 50 MB. n8n bounds neither by bytes. One tenant's AI workflow could otherwise fill a shared process and Postgres.
14. The failed store drops rows older than 7 days. n8n keeps its log file until sent.
15. A run whose redaction applies sends no error text, node tag value or AI `msg`. n8n sends them.
16. Stored destination secrets and OTLP header values are kept on a blank save only while scheme, host and port stay the same.
17. The existing `workflow_webhook_duration_seconds` stays always on beside n8n's opt-in webhook family.
18. Destination types are named `webhook`, `syslog` and `sentry` in our API.
19. A workspace has at most 20 log destinations. n8n is single tenant and has no cap.
20. Our webhook sender follows a redirect itself. It refuses a hop to plain `http://` when the request carries a secret. On an origin change it drops the header pairs and the credential headers. n8n strips only Authorization, Proxy-Authorization and Cookie.
21. A Sentry DSN over plain `http://` is accepted, as in n8n. The DSN key is public by Sentry's design and self-hosted Sentry often runs on `http://`.
22. The statistics gauges count execution rows (finished runs only), so execution pruning lowers them. n8n reads a monotonic statistics table.
23. `workflow_dns_lookups_*`, `workflow_poll_trigger_polls_total` and `workflow_scheduler_triggers_*` are additions with no n8n twin.
24. GenAI token sums match a model run to its agent run by time window, because our sub-node run data has no `previousNodeRun`.
25. In queue mode the worker serves `/metrics` and a health path (`/healthz`, `/healthz/readiness`) on its own port. It starts when `QUEUE_HEALTH_CHECK_ACTIVE` is on or any opt-in metrics family is on. The port is `QUEUE_HEALTH_CHECK_PORT`, default 5679, on the server's `HOST`. `/metrics` uses the same bearer token as the main.
