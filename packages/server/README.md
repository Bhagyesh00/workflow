# @workflow/server

Fastify 5 backend of the workflow platform: REST API for the editor, public API, authentication and multi-tenancy, persistence (PostgreSQL + Drizzle), the execution service (in-process or BullMQ queue workers), webhooks, triggers and pollers, push events over SSE, health and metrics. The contract is [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) (sections 4, 5, 9–11 and 14–16).

## Commands

All commands run the TypeScript sources with `node --no-node-snapshot --import tsx` (the code sandbox, isolated-vm, needs `--no-node-snapshot`). `src/register-hooks.mjs` adds a resolve hook so tsx can load node packages that use `*.node` import specifiers.

| Script             | What it does                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`         | Like `start`, restarting on source changes; development defaults (local Postgres `workflow_dev`, dev encryption key) |
| `pnpm start`       | Start a main process: HTTP API, webhooks, triggers (leader), executions in regular mode                              |
| `pnpm worker`      | Start a queue worker (`EXECUTIONS_MODE=queue`)                                                                       |
| `pnpm migrate`     | Apply database migrations (also applied automatically on start, under an advisory lock)                              |
| `pnpm seed`        | Create a demo workspace, its owner (email and password are printed) and a sample workflow                            |
| `pnpm db:generate` | Generate a SQL migration into `migrations/` after changing `src/db/schema.ts` (drizzle-kit)                          |
| `pnpm test`        | Integration tests against Postgres `workflow_test` and Redis db 1                                                    |
| `pnpm typecheck`   | `tsc -p tsconfig.json`                                                                                               |

Quick start (regular mode):

```bash
pnpm install
pnpm --filter @workflow/server seed     # prints the demo login
pnpm --filter @workflow/server dev      # http://localhost:5678
```

Without a built editor, `/` shows a status page with links to the API reference (`/api/v1/docs`), the OpenAPI document and the readiness check. When `packages/editor/dist` exists it is served at `/` with an SPA fallback that never answers `/rest`, `/api`, `/webhook*`, `/healthz` or `/metrics`.

### Docker

`docker/Dockerfile` builds one image (node:24-slim, non-root user, `--no-node-snapshot`) for mains and workers; `docker/docker-compose.yml` runs Postgres 16 with pgvector, Redis 7, one main and one worker in queue mode:

```bash
export ENCRYPTION_KEYS="k1:$(openssl rand -base64 32)"
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml exec main \
  node --no-node-snapshot --import tsx --import ./src/register-hooks.mjs src/cli.ts seed
```

Mains and workers must share `BINARY_DATA_DIR` (the compose file mounts one volume into both).

## Configuration

Read from the environment and validated with zod (`src/config.ts`). In production (`NODE_ENV=production`) the server refuses to start without `DATABASE_URL` and `ENCRYPTION_KEYS`; development falls back to the local `workflow_dev` database and a fixed, clearly labelled dev key.

| Variable                                                  | Default                        | Notes                                                                                     |
| --------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `development`                  | `development` / `production` / `test`                                                     |
| `PORT`, `HOST`                                            | `5678`, `0.0.0.0`              |                                                                                           |
| `BASE_URL`                                                | `http://localhost:5678`        | public URL: webhook URLs, OAuth2 callback, CSRF origin; `https://` makes cookies `Secure` |
| `DATABASE_URL`                                            | (dev: `workflow_dev`)          | PostgreSQL 16                                                                             |
| `REDIS_URL`                                               | —                              | required when `EXECUTIONS_MODE=queue`                                                     |
| `EXECUTIONS_MODE`                                         | `regular`                      | `regular` (in-process) or `queue` (BullMQ workers)                                        |
| `ENCRYPTION_KEYS`                                         | (dev key)                      | `id:base64(32 bytes)[,id:...]`; the first key encrypts, all decrypt (rotation)            |
| `BINARY_DATA_MODE` / `BINARY_DATA_DIR`                    | `filesystem` / `./data/binary` | `inline` keeps binaries in run data; `s3` is not available in this build                  |
| `SSRF_PROTECTION` / `SSRF_ALLOW` / `SSRF_DENY`            | `true` / — / —                 | comma-separated hosts or CIDRs                                                            |
| `CODE_MEMORY_MB` / `CODE_TIMEOUT_MS`                      | `128` / `30000`                | Code node isolate limits                                                                  |
| `EXECUTION_TIMEOUT_DEFAULT_S` / `EXECUTION_TIMEOUT_MAX_S` | `300` / `3600`                 | per-workflow `executionTimeout` is capped by the plan and the maximum                     |
| `EXECUTIONS_PRUNE_DAYS`                                   | `14`                           | plans may override (`limits.pruneDays`)                                                   |
| `SIGNUP_ENABLED`                                          | `true`                         | `seed` works regardless                                                                   |
| `BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`     | `Workflow`, —, `#4f46e5`       | white-label defaults; tenants override with `PATCH /rest/settings`                        |
| `DEFAULT_TIMEZONE`, `DEFAULT_PLAN`                        | `UTC`, `unlimited`             | plans: `starter`, `pro`, `unlimited` (`src/plans.ts`)                                     |
| `LOG_LEVEL`                                               | `info`                         | pino levels, `silent` disables logging                                                    |
| `CORS_ORIGINS`                                            | —                              | extra origins allowed by the CSRF check                                                   |
| `BODY_LIMIT_MB`                                           | `16`                           | request body limit (REST and webhooks)                                                    |
| `QUEUE_CONCURRENCY`, `QUEUE_PREFIX`                       | `10`, `wf`                     | worker concurrency; Redis key prefix                                                      |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`      | `10`, `60000`                  | login attempts per IP + email                                                             |
| `WAIT_TRACKER_INTERVAL_MS`                                | `5000`                         | how often the leader resumes due waits                                                    |
| `METRICS_TOKEN`                                           | —                              | when set, `GET /metrics` requires `Authorization: Bearer <token>`                         |
| `EDITOR_DIST`                                             | `../editor/dist`               | built editor SPA                                                                          |
| `TRUST_PROXY`                                             | `false`                        | trust `X-Forwarded-*` (rate limits and audit IPs behind a proxy)                          |

## Layout

```
src/
  cli.ts                 start | worker | migrate | seed
  config.ts, plans.ts    environment config, plan limits
  context.ts             wires db, Redis, registries and services for one process
  app.ts                 Fastify app (helmet, cookies, rate limits, routes)
  node-packages.ts       loadNodePackages(): nodes-base + optional @workflow/nodes-ai
  db/                    drizzle schema, pool, migration runner
  repositories/          tenant-scoped data access (tenantId first)
  services/              auth, credentials, OAuth2, executions, activation, webhooks,
                         test webhooks, wait tracker + pruning, queue + leader election, bus/push, metrics
  routes/                REST (/rest), public API (/api/v1), webhooks, push (SSE), health/metrics/editor
migrations/              generated SQL migrations (+ 0001: row-level security policies)
test/                    integration tests (real Postgres + Redis)
```

## Tenancy and security

- Every repository method takes `tenantId` first; webhook paths are namespaced by tenant slug; binary files live under `<BINARY_DATA_DIR>/<tenantId>/<executionId>` and reads are checked against the tenant.
- Row-level security is enabled on every tenant table as defence in depth. The application connects as the table owner and is not affected; any other database role only sees the tenant set with `SET app.tenant_id = '<uuid>'`.
- Credentials are encrypted with AES-256-GCM (`CredentialCipher`, per-tenant HKDF keys, AAD `tenantId:credentialId`); the API returns password fields and OAuth token data as `__REDACTED__`.
- Outbound HTTP from nodes, credential tests and OAuth2 token exchanges goes through the SSRF-guarded `HttpClient` (`SSRF_*` settings).

## Notes for API clients (editor)

- Success bodies are `{ data }` (lists add `nextCursor`), errors `{ error: { code, message, details? } }`.
- The session cookie `wf_session` is `HttpOnly`, `SameSite=Lax`, scoped to `Path=/rest` (it is never sent to webhook URLs) and slides for 14 days.
- Mutating `/rest` requests need an `Origin` header matching `BASE_URL` or `CORS_ORIGINS`, and `content-type: application/json` whenever they carry a body (bodyless `POST`s may omit it).
- `PATCH /rest/workflows/:id` needs the current `versionId`; a mismatch returns 409 with `details.currentVersionId`. Saving an active workflow re-registers its triggers; if that fails the workflow is deactivated and the response carries `activationError`.
- `POST /rest/workflows/:id/listen-test-webhook` also accepts `workflowData` to listen with unsaved changes. The first call to the test URL runs in manual mode and emits `testWebhookReceived`.
- Polling nodes read `parameters.pollTimes`: a cron string or `{ item: [{ mode: 'everyMinute' | 'everyHour' | 'everyDay' | 'everyWeek' | 'everyMonth' | 'everyX' | 'custom', hour?, minute?, weekday?, dayOfMonth?, value?, unit?: 'seconds' | 'minutes' | 'hours', cronExpression? }] }`. Default: every minute.
- The OAuth2 popup receives `postMessage({ type: 'oauth2-callback', status: 'success' | 'error', credentialId?, message? })` with the `BASE_URL` origin as target.
- An editor served from another origin (e.g. a Vite dev server) works when that origin is listed in `CORS_ORIGINS`: `/rest` then answers preflights and sends credentialed CORS headers for it.
- `POST /rest/members/invite` returns the invitation `token` and `inviteUrl` once (there is no mail transport); `GET`/`DELETE /rest/invitations[/:id]` list and revoke pending invitations; `GET /rest/audit-log` (admin) pages through the audit log.

## Beyond the usual feature set

- **Webhook idempotency keys.** Production webhook calls with an `Idempotency-Key` header are deduplicated per workflow for 24 hours: a repeat replays the first response (`Idempotency-Replayed: true`) without running the workflow again; a repeat while the first is still running gets 409.
- **Version diffs.** `GET /rest/workflows/:id/versions/:versionId/diff?against=<versionId|current>` returns added, removed and changed nodes (with the changed fields), connection changes and changed settings.
- **Activation dry run.** `POST /rest/workflows/:id/validate` (optionally with unsaved `workflowData`) returns the issues activation would report, without activating.
- **Sandboxed webhook responses.** Webhook responses are tenant-controlled but served from the platform origin, so `Set-Cookie` is dropped, the session cookie is stripped from forwarded request headers, and a `Content-Security-Policy: sandbox` header puts any HTML response into an opaque origin that cannot call the API.
- **Readable API reference.** `/api/v1/docs` renders the public API (from the same route table as the OpenAPI document) as a script-free HTML page.
- **Binary data endpoint.** `GET /rest/binary-data?id=<fs:...>&action=view|download&mimeType=&fileName=` serves files referenced from run data, checked against the caller's tenant. Only types that cannot run script are shown inline; everything else downloads, always with `CSP: sandbox`.
- **Crash detection in queue mode.** A job redelivered after its worker died marks the execution `crashed` instead of running it twice.
- **Usage in settings.** `GET /rest/settings` returns the tenant's effective limits and this month's production execution count.
