# Remaining plan

**Branch:** `main` (the only branch; push every commit there). **Baseline:** commit `bcaef40` (2026-10-30).
**Read first:** [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) (binding contracts) and [`docs/SPEC.md`](../docs/SPEC.md) (parity matrix, new features, security rules S1–S18). The user research behind the new features is in [`docs/research/USER-RESEARCH.md`](../docs/research/USER-RESEARCH.md).

Work through the phases in order. Each task has an acceptance check. Do not mark a task done until its tests pass.

---

## ▶ RESUME POINT (read this first in every session)

> **Every session starts here and ends by updating this block.** It is the single source of truth for where work stopped.

| Field                | Value                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current phase**    | A — verify and fix the review findings                                                                                                                                                                                                                                                                                                    |
| **Next action**      | Start A1 with **R02**: SSRF guard bypassed by an HTTP redirect to a literal IP (`packages/core/src/http/http-client.ts`). Write a failing test (redirect from an allowed host to `http://169.254.169.254/` and `http://127.0.0.1/`), then fix by validating every redirect hop or following redirects manually through the guarded agent. |
| **Last completed**   | Plan created; review stopped before verification (no fixes applied yet)                                                                                                                                                                                                                                                                   |
| **Last commit**      | `bcaef40` + the commit that added this resume point                                                                                                                                                                                                                                                                                       |
| **Updated**          | 2026-10-30                                                                                                                                                                                                                                                                                                                                |
| **Blockers / notes** | None. Postgres (pgvector) and Redis are required for server, nodes-base and nodes-ai tests (see §1).                                                                                                                                                                                                                                      |

### Resume protocol

**At the start of a session:**
1. `git pull origin main`, then set up the environment as in §1 if needed.
2. Read this RESUME POINT. Do exactly the **Next action**, then continue down the progress checklist from the first unchecked `[ ]` item.

**After finishing each checklist item:**
1. Run the affected package's `npx vitest run`, `npx tsc -p tsconfig.json` and `npx biome check`.
2. Tick the item (`[x]`) and append the short commit hash.
3. For an `R..` item, set its Status in [`review-findings.md`](review-findings.md) to `fixed (<hash>)` or `refuted (<reason>)`.
4. Update the RESUME POINT table: **Next action** = the next unchecked item, written as a concrete instruction; also **Last completed**, **Last commit** and **Updated**.
5. Commit the code and the plan together, push to `main`: `git push origin main`.

**If a session must stop mid-item** (credits, time): commit work in progress with a `WIP:` prefix, write the exact stopping point and the next step into **Next action** and **Blockers / notes**, then push.

**Generic resume prompt for any session or account:**
> Read plan/REMAINING-PLAN.md, follow its Resume protocol, and continue from the RESUME POINT. After each checklist item, update the plan and push to main.

### Progress checklist

#### Phase A — verify and fix review findings (§2)

**A1. High-severity findings (security first)**

- [ ] R02 (high, core): SSRF guard bypassed by an HTTP redirect to a literal IP address (metadata, loopback, private network)
- [ ] R04 (high, nodes-ai): In-memory stores (Simple Vector Store, Simple Memory) cap entry counts, not bytes, so one tenant can fill a sh
- [ ] R06 (high, nodes-base): Postgres, MySQL and SMTP nodes resolve the host again after the SSRF check (DNS rebinding reaches the platform
- [ ] R07 (high, nodes-base): Postgres, MySQL and Send Email SSRF check is bypassable by DNS rebinding: the host is resolved for the check a
- [ ] R11 (high, server): A tab still showing workspace A writes into workspace B after the tenant is switched in another tab (secrets l
- [ ] R14 (high, server): Unauthenticated multipart bodies bypass BODY_LIMIT and are buffered before the webhook path is looked up
- [ ] R19 (high, workflow): Expression time and memory budgets do not bound native work: a viewer can freeze or crash the shared server pr
- [ ] R20 (high, workflow): Expressions can mutate luxon's process-wide state and change other tenants' date math (Duration matrix, week i
- [ ] R01 (high, core): logSubNodeRun fires nodeExecuteAfter without awaiting or catching it; a failed progress save crashes the proce
- [ ] R03 (high, editor): HTTP Request / GraphQL 'Predefined Credential Type' never shows a credential picker, so the option is unusable
- [ ] R05 (high, nodes-base): Google Sheets Update / Append-or-Update rewrites every column of the matched row, replacing formulas with thei
- [ ] R08 (high, nodes-base): Pass-through nodes (No Op, Wait, Respond to Webhook, Code returning $input.all()) keep upstream pairedItem, so
- [ ] R09 (high, nodes-base): IF/Filter/Switch: strict type validation (the default) rejects every number or boolean comparison value typed
- [ ] R10 (high, server): OAuth2 'Connect account' never reports success or failure: COOP same-origin cuts the popup off from its opener
- [ ] R12 (high, server): A NUL character in a webhook payload leaves permanent 'new' execution rows that use up the concurrency limit
- [ ] R13 (high, server): Invitation links point to /invitations/<token> but the editor only routes /invitation/:token, so invitees cann
- [ ] R15 (high, server): Concurrent startTriggers calls orphan a running trigger that keeps firing after deactivation
- [ ] R16 (high, server): Saving the OAuth2 credential modal again after connecting wipes the stored tokens (modal sends oauthTokenData:
- [ ] R17 (high, server): Error workflows that name each other loop forever with no plan limits applied
- [ ] R18 (high, server): Files uploaded to a webhook are left on disk forever when the execution cannot be created

**A2. Known integration items**

- [ ] K1 server: retry uses engine retryFromFailure
- [ ] K2 server: credentials provider checks tenant + type
- [ ] K3 server: merge credential type defaults (hidden OAuth URLs/scopes)
- [ ] K4 server: credential test resolves $credentials templates
- [ ] K5 server: Chat Trigger CORS + preflight on server responses
- [ ] K6 server + nodes-ai: single streaming protocol (no double wrapping)
- [ ] K7 server: listSearch searchWorkflows
- [ ] K8 docs: ARCHITECTURE §11/§14 updated with server additions
- [ ] K9 nodes-base: redis credential, postgres/httpBearerAuth field alignment
- [ ] K10 editor: neutral expression preview without input, show code + hint
- [ ] K11 editor: version diff before restore, retry-from-failed-node button

**A3. Medium-severity findings**

- [ ] R21 (medium, core): Binary data from pollers and manual trigger runs is stored under '<tenant>/activation' and never pruned
- [ ] R22 (medium, editor): Resource locator in 'From List' mode cannot be switched to an expression: toggling 'Expression' shows an unusa
- [ ] R23 (medium, editor): Saving or restoring an active workflow can silently deactivate it: the editor ignores the server's activationE
- [ ] R24 (medium, editor): Expression preview shows a red error for normal expressions when the node has no input data yet
- [ ] R25 (medium, editor): Duplicate and Import keep the nodes' webhookId, so copies collide on webhook paths (activation fails, test lis
- [ ] R26 (medium, editor): While starting a run or listening for a test event, the editor adopts any execution of the workflow, including
- [ ] R27 (medium, nodes-ai): Streaming response mode with a model that cannot stream (Ollama, or agent 'Enable Streaming' off) delivers no
- [ ] R28 (medium, nodes-ai): Agent stream chunks are wrapped twice: the server's NDJSON stream carries `{type:'item', content:{type:'begin'
- [ ] R29 (medium, nodes-ai): Agent output-parser retry drops `tools` while the history still holds tool_use/tool_result (and thinking) bloc
- [ ] R30 (medium, nodes-ai): Postgres chat-memory table cache is process-global and keyed only by host:database:table, so a dropped table,
- [ ] R31 (medium, nodes-ai): In-process AI stores cap entry counts, not bytes, so one tenant can exhaust a shared worker's heap
- [ ] R32 (medium, nodes-ai): Mid-stream provider errors (Anthropic `overloaded_error` SSE event, OpenAI/Gemini stream `error`) bypass maxRe
- [ ] R33 (medium, nodes-base): HTTP Request pagination sends the first request without the pagination parameters, silently skipping records
- [ ] R34 (medium, nodes-base): Schedule Trigger ignores 'Weeks Between Triggers' (every N weeks runs every week)
- [ ] R35 (medium, nodes-base): Loop Over Items: $('Node before the loop').item fails from the second batch onward, and on the done output
- [ ] R36 (medium, nodes-base): Wait node accepts resume webhooks while waiting for a time interval or date: early resume with attacker-suppli
- [ ] R37 (medium, nodes-base): Edit Fields (Set) fails when an assignment writes into an object taken from input data
- [ ] R38 (medium, nodes-base): IF/Filter/Switch date comparisons ignore the workflow timezone for dates without an offset
- [ ] R39 (medium, server): Push (SSE) streams outlive logout and member removal: an ex-member keeps receiving the tenant's live run data
- [ ] R40 (medium, server): Invitation link generated by the server points to a route the editor does not have
- [ ] R41 (medium, server): Saving an active workflow never unregisters third-party webhooks of the previous version
- [ ] R42 (medium, server): Executions marked 'crashed' after a worker dies do not run the error workflow
- [ ] R43 (medium, server): An execution whose result cannot be persisted stays 'running' forever
- [ ] R44 (medium, server): lastNode 'First Entry Binary' responses and sub-workflow binary outputs fail when the execution is not saved
- [ ] R45 (medium, server): Stopping or timing out a parent does not stop a sub-workflow it is waiting for, and the stop request blocks un
- [ ] R46 (medium, server): Retrying a timed-out or stopped execution re-runs the last node that already succeeded
- [ ] R47 (medium, server): Webhook CORS preflight answers `Access-Control-Allow-Headers: *`, which never covers `Authorization`, so a bro
- [ ] R48 (medium, server): Anyone holding an execution id can resume time-based Wait executions early with their own data (and public web
- [ ] R49 (medium, server): Listen for test event on app triggers with webhookMethods (Telegram Trigger) never registers the test URL with
- [ ] R50 (medium, workflow): Integrations: choosing a non-first resource without explicitly re-selecting the operation hides and drops that

**A4. Low-severity findings**

- [ ] R51 (low, editor): Version history shows only the newest 50 versions (no pagination in the editor)
- [ ] R52 (low, editor): listSearch results are cached without the parameters they depend on, so the list is stale after changing the p
- [ ] R53 (low, editor): 'Stop listening' only clears editor state; the server-side test webhook stays registered for up to 2 minutes
- [ ] R54 (low, editor): Vector store nodes are not offered in 'What happens next?' because the catalog evaluates dynamic ports with em
- [ ] R55 (low, editor): Execution detail hides Retry for stopped (canceled) executions although the server allows retrying them
- [ ] R56 (low, nodes-ai): OpenAI streaming parser ignores `delta.refusal` and `finish_reason: content_filter`, so a refusal becomes an e
- [ ] R57 (low, nodes-ai): Model 'streaming' is fully buffered: no delta is emitted until the whole provider response has downloaded
- [ ] R58 (low, nodes-base): HTTP Request multipart body fields are dropped when a JSON 'Specify Body' choice is still stored
- [ ] R59 (low, nodes-base): Merge 'Always Add Input Number to Field Names' suffixes only clashing keys, using the wrong input number
- [ ] R60 (low, nodes-base): Merge 'Keep Non-Matches of Input 2' / outer join with 'Include First Match Only' report matched input-2 items
- [ ] R61 (low, nodes-base): Split Out fails the whole node when any single item lacks the list field
- [ ] R62 (low, nodes-base): HTTP Request: query parameters with the same name collapse to the last value
- [ ] R63 (low, server): Invitation tokens are written to request logs when the invite link is opened
- [ ] R64 (low, server): Queue mode: activation on a non-leader main reports success when the trigger fails to start
- [ ] R65 (low, server): Allowed-origin trailing slash is normalized by Chat Trigger but not by the server's CORS decoration, so the re

**A5. Phase A exit:** all package tests + E2E smoke green; short security re-review finds no new high

- [ ] A5 done

#### Phase B — M1 new features, second wave (§3)

- [ ] NF-01 retry-from-failed-node endpoint + editor button + crash recovery on startup
- [ ] NF-02 retryBackoff setting in UI; Idempotency-Key on public API POSTs
- [ ] NF-04 cost metering + budgets
- [ ] NF-05 credential slots in the editor
- [ ] NF-08 per-workflow concurrency + priority
- [ ] NF-10 named versions + diff UI + version shown on executions
- [ ] NF-15 structured error panel
- [ ] NF-18 alert rules, heartbeats, tenant default error workflow
- [ ] NF-19 retention per outcome
- [ ] NF-20 plan quotas exposed
- [ ] NF-21 async webhook jobs
- [ ] Update docs/SPEC.md status columns for Phase B

#### Phase C — production readiness (§4)

- [ ] C1 GitHub Actions CI (lint, typecheck, tests with Postgres+pgvector and Redis, E2E)
- [ ] C2 Docker image + compose verified (regular and queue mode)
- [ ] C3 bundle the server; remove register-hooks.mjs
- [ ] C4 S3 binary data store
- [ ] C5 security hardening: S3 runner process, S7 ingress split, S10 KMS, S16 Postgres leases
- [ ] C6 email transport, password reset, TOTP 2FA
- [ ] C7 load test (1k webhooks per second, queue mode)
- [ ] C8 SPEC status columns brought up to date
- [ ] C9 README quick start + deploy guide

#### Phase D — M2 (§5) and Phase E — M3 (§6)

- [ ] D: work through the §5 list in order, ticking each NF / parity item here as `- [x] NF-xx (<hash>)`
- [ ] E: work through the §6 list in order

---

## 0. Where things stand

| Package               | What it is                                                                                                                                                                                                                                                                                                                                                                                                   | Tests  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `packages/workflow`   | Isomorphic model, sandboxed expression interpreter (no eval), semantic diff, error catalogue                                                                                                                                                                                                                                                                                                                 | 48 ✅  |
| `packages/core`       | Execution engine (depth-first, merges, loops, retries with backoff, error outputs, wait/resume, retry-from-failed-node, quotas, AI sub-nodes), isolated-vm Code sandbox, SSRF-guarded HTTP, AES-256-GCM per-tenant credentials, OAuth2 refresh                                                                                                                                                               | 48 ✅  |
| `packages/nodes-base` | 36 core nodes + Slack, Gmail (+trigger), Google Sheets, Postgres, MySQL, Notion, Airtable, Telegram (+trigger); 20 credential types                                                                                                                                                                                                                                                                          | 348 ✅ |
| `packages/nodes-ai`   | AI Agent, LLM chain, extractor, classifier, sentiment, summarization, retrieval QA, chat trigger; OpenAI/Anthropic/Gemini/Ollama/OpenAI-compatible models; memory (window/Postgres/Redis); tools (calculator, code, HTTP, workflow, think, vector store, MCP client); embeddings; vector stores (in-memory, PGVector, Qdrant); loaders, splitters, output parsers                                            | 131 ✅ |
| `packages/server`     | Fastify API (all of ARCHITECTURE §14), Postgres + Drizzle migrations + RLS, auth/sessions/CSRF/roles/invites/API keys/audit, credentials + OAuth2, executions (regular + BullMQ queue), SSE push, activation, webhooks (onReceived/lastNode/responseNode/streaming, CSP sandbox, idempotency), wait tracker, sub-workflows, error workflows, pruning, public API + OpenAPI, health and metrics, Docker files | 77 ✅  |
| `packages/editor`     | React SPA: canvas, node creator, node details view (every parameter type, expression editor with live preview), executions, credentials (OAuth popup), settings, version history, white-label theming, dark mode                                                                                                                                                                                             | 114 ✅ |

**Verified end to end** against a running server:
- A Playwright smoke test: sign up, build a workflow on the canvas, run it and read the output.
- A production webhook flow with a Respond node.
- CSP sandbox headers on webhook responses.
- "Data is never code" (runtime values are never evaluated).
- Cross-tenant 404s, CSRF 403, credential redaction.

**Not done yet:** this file.

---

## 1. Set up a new session or account

1. Clone and install:

   ```bash
   git clone https://github.com/Bhagyesh00/workflow.git && cd workflow
   pnpm install          # Node 22.19+ (24 LTS recommended), pnpm 10
   ```
2. Services: PostgreSQL 16 with **pgvector** and Redis 7. On Ubuntu:

   ```bash
   apt-get update && apt-get install -y postgresql-16-pgvector && service postgresql start && redis-server --daemonize yes
   su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
   for db in workflow_dev workflow_test nodes_test ai_test; do su postgres -c "psql -c 'CREATE DATABASE $db;'"; done
   for db in workflow_test ai_test; do su postgres -c "psql -d $db -c 'CREATE EXTENSION IF NOT EXISTS vector;'"; done
   ```

   Or, with Docker and GNU Make (also on Windows): `make i` installs, `make db-migrate` starts Postgres (pgvector) + Redis from `docker/docker-compose.dev.yml` (creates the four databases and the vector extension on first start) and migrates, `make start` also builds the editor if missing and runs the dev server, `make stop` stops the services. `make` alone lists all targets.
3. Verify everything is green. Server tests must not run concurrently with another server test run, because they share `workflow_test`.

   ```bash
   for p in workflow core nodes-base nodes-ai server editor; do (cd packages/$p && npx vitest run && npx tsc -p tsconfig.json); done
   npx biome check .
   ```
4. Run the app:

   ```bash
   cd packages/editor && npx vite build && cd ../server
   pnpm seed     # prints a demo login
   pnpm dev      # http://localhost:5678
   ```

   E2E: `cd packages/editor && E2E_BASE_URL=http://localhost:5678 CHROMIUM_PATH=<chrome binary> npx playwright test`.
5. Network: in Claude Code cloud sessions, add `docs.n8n.io` to the environment's allowed domains if you want agents to check parity against n8n's documentation.
6. The process must run with `node --no-node-snapshot` (isolated-vm). The server scripts already do this.

---

## 2. Phase A — verify and fix the review findings (highest priority)

The review was stopped before verification. [`review-findings.md`](review-findings.md) lists **65 unverified findings: 20 high, 30 medium, 15 low**, each with file:line, scenario, evidence and proposed fix. Process for each one:
1. Reproduce it with a failing test. If you can't reproduce it, mark it refuted in that file with the reason.
2. Fix it and keep the test.
3. Run the package tests, `tsc` and `biome check`.

Suggested order:
1. **Security highs:**
   - SSRF through redirect to a literal IP (core `http-client.ts`).
   - DNS rebinding in Postgres/MySQL/SMTP: pin the connection to the checked IP.
   - Luxon global state mutable from expressions: freeze or wrap `Settings`, and block static setters on `DateTime`/`Duration`/`Interval` from user code.
   - Native work inside expressions not bounded (regex/JSON/sort on huge inputs): run expressions on a worker thread with a hard timeout, or cap input sizes.
   - Unauthenticated multipart buffered before the webhook path lookup.
   - Cross-tab tenant switch writing into the wrong tenant: bind the request tenant to an explicit header and reject on mismatch.
   - Push streams surviving logout or member removal.
   - In-memory AI stores capped by count rather than bytes.
2. **Data-loss and correctness highs:**
   - Orphaned triggers after concurrent `startTriggers`.
   - Error-workflow loops.
   - NUL bytes in webhook payloads leaving `new` rows (strip `\u0000` before JSONB insert).
   - `logSubNodeRun` not awaiting hooks.
   - Webhook upload leak.
   - OAuth popup blocked by COOP: use `same-origin-allow-popups` on the editor page.
   - OAuth tokens wiped on modal re-save.
   - Invitation link route mismatch (`/invitations/` vs `/invitation/`).
   - Predefined credential picker in HTTP Request/GraphQL.
   - Filter strict type validation rejecting numbers typed in UI fields: coerce numeric strings from fixed UI inputs.
   - Pass-through nodes keeping upstream pairedItem.
   - Google Sheets update overwriting formulas: only write changed columns.
3. Then the mediums and lows.

**Known integration items** from the build notes. They are not in `review-findings.md`, so do them in this phase too:

| ID  | Package           | Task                                                                                                                                                             | Acceptance                                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| K1  | server            | Retry-from-failed-node uses `WorkflowExecute.retryFromFailure()` (state has `failedExecuteData`); fall back to the current pinning approach for older executions | Test: a node fails, the retry re-runs only that node and its successors |
| K2  | server            | `CredentialsProvider` loads strictly by tenant and checks that the stored type equals, or extends, the requested type; expression credential ids (NF-05) work    | Tests: cross-tenant id → error; wrong type → error                      |
| K3  | server            | Merge credential type property defaults (including hidden fixed Google URLs and scopes) into decrypted data before nodes, OAuth and tests use it                 | Google OAuth2 credential with only client id/secret can connect         |
| K4  | server            | Credential test resolves `={{$credentials.x}}` templates in `test.request`                                                                                       | The OpenAI/Anthropic test hits `{baseUrl}/models`                       |
| K5  | server            | Chat Trigger responses produced by the server: CORS from `allowedOrigins`, OPTIONS preflight, S8 headers kept                                                    | Browser chat widget on another origin works                             |
| K6  | server + nodes-ai | One streaming protocol: AI `sendChunk({type:begin\|item\|end})` must not be double-wrapped in NDJSON (see the review finding on double wrapping)                 | Streaming test with an AI agent                                         |
| K7  | server            | `listSearch: searchWorkflows` for the Execute Workflow resource locator                                                                                          | Picker lists the tenant's workflows                                     |
| K8  | docs              | ARCHITECTURE §11/§14: add the server's extra endpoints, cookie `Path=/rest`, Idempotency-Key, streaming mode, `pollTimes` format                                 | Docs match the code                                                     |
| K9  | nodes-base        | Add a `redis` credential type; align the `postgres` and `httpBearerAuth` fields with what nodes-ai reads                                                         | Redis memory node works with a saved credential                         |
| K10 | editor            | Expression preview: show a neutral "no input data yet" state instead of a red error; show error `code` and `hint`                                                | Visual check plus a unit test                                           |
| K11 | editor            | Version history shows the semantic diff before restore; execution detail shows code and hint plus "Retry from failed node"                                       | E2E                                                                     |

**Exit criteria for Phase A:** every high finding fixed or refuted, all package tests green, the E2E smoke test green, and a second short review pass (security-only) finds no new high.

---

## 3. Phase B — M1 new features, second wave (server + editor wiring)

The engine parts are already built (see SPEC §2.1). This phase wires them through the server and the UI.

| ID    | Feature                             | Work                                                                                                                                                   | Acceptance                                     |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| NF-01 | Retry from failed node              | Server endpoint (K1) + editor button; crash recovery: on startup, executions stuck in `running` with `saveExecutionProgress` use `continueExecution()` | Kill the worker mid-run; the execution resumes |
| NF-02 | Backoff + idempotency               | Settings UI for `retryBackoff`; Idempotency-Key on public API POSTs                                                                                    | UI test; API test                              |
| NF-04 | Cost metering and guardrails        | Meter execution ms per tenant/workflow and LLM tokens per model (nodes-ai already reports usage); budgets with warn/pause/stop; usage page             | Exceeding the budget pauses the workflow       |
| NF-05 | Credential slots                    | Editor: allow an expression in the credential selector; docs                                                                                           | E2E with two customers                         |
| NF-08 | Per-workflow concurrency + priority | Workflow setting `maxConcurrency`, BullMQ priority                                                                                                     | Third concurrent run queues                    |
| NF-10 | Versions                            | Named versions, diff UI (K11), executions show the version they ran                                                                                    | E2E                                            |
| NF-15 | Structured errors                   | Error panel with code, hint, request/response excerpt, item index                                                                                      | Visual check                                   |
| NF-18 | Alerts and heartbeats               | Alert rules (failure, failure rate, no success in N hours) → email/Slack/webhook with dedup and mute; tenant default error workflow                    | Rule fires once per incident                   |
| NF-19 | Retention per outcome               | Settings + pruning job by outcome; storage use per workflow                                                                                            | Pruning test                                   |
| NF-20 | Quotas                              | Expose `limits` per plan (items per output, node runs, run-data bytes); fail cleanly                                                                   | Test                                           |
| NF-21 | Async webhook jobs                  | Response mode `async`: 202 + job id, status/result endpoints, optional callback                                                                        | Test                                           |

---

## 4. Phase C — production readiness

1. **CI:** a GitHub Actions workflow with Postgres+pgvector and Redis services that runs install, lint, typecheck, all tests, and the E2E smoke test against a built server.
2. **Docker:** build and run `docker/Dockerfile` and `docker/docker-compose.yml` (never built so far; no daemon was available) in regular and queue mode.
3. **Bundle the server** (tsdown/esbuild) instead of running TS through tsx in production; remove `register-hooks.mjs` by using explicit `.ts`-free import paths in nodes-base.
4. **S3-compatible binary data store** (`BINARY_DATA_MODE=s3`); config currently refuses s3.
5. **Security hardening from SPEC §4:**
   - S3: run the Code sandbox in a separate unprivileged runner process.
   - S7: split public ingress (webhooks/forms/chat) into its own service without DB keys.
   - S10: KMS-wrapped tenant keys.
   - S16: Postgres `SKIP LOCKED` leases instead of Redis leader election for triggers, timers and waits.
6. **Email transport** (SMTP) for invitations, password reset and alerts; add **password reset** and **TOTP 2FA**.
7. **Load test:** 1k webhook requests per second in queue mode with 4 workers; record p95 latency and memory.
8. **Update `docs/SPEC.md` status columns.** Many 🔨 rows are now ✅ (see the build notes in this file's history).
9. **README:** quick start, screenshots, deploy guide.

---

## 5. Phase D — M2 (differentiators and depth)

From SPEC §2.2. Suggested order by user impact:
1. NF-14 step debugger.
2. NF-12 workflow test suites + HTTP record/replay.
3. NF-11 workflow-as-code SDK + Git sync.
4. NF-03 bulk replay.
5. NF-22 webhook inbox.
6. NF-23/24 approvals and wait-for-event.
7. NF-25 reliable agent runtime.
8. NF-26 AI copilot (drafts + diff + dry run).
9. NF-27 parallel branches + loop containers.
10. NF-29 component library.
11. NF-30 state store.
12. NF-31 schedule centre.
13. NF-17 credential health.
14. NF-16 guided mapping / simple mode.
15. NF-06/07 white-label kit, embed SDK, agency portal.
16. NF-08 keyed flow control (full).
17. NF-09 shared rate limiter.
18. NF-35 health panel.
19. NF-36 hybrid runners.
20. NF-37 snapshots.
21. NF-38 connector factory (OpenAPI/Postman/cURL → connector). This is the route to n8n's 400+ integrations.
22. NF-39 execution search.
23. NF-41 reseller policy hooks.

Parity items also in M2:
- Form Trigger + Form node.
- Data tables.
- Python in the sandbox.
- External secret vaults.
- SSO (SAML/OIDC) + SCIM.
- Projects and custom roles.
- Event triggers (Kafka, RabbitMQ, MQTT, IMAP, Postgres LISTEN).
- Hosted chat widget.
- Any node as an AI tool + `$fromAI()`.
- Guardrails node, evaluations, MCP server trigger.
- Insights dashboard, OpenTelemetry, log streaming.
- Command bar, canvas groups, folders.
- Templates gallery and n8n JSON import.
- The next 30 integrations listed in SPEC §1.10.

## 6. Phase E — M3

From SPEC §2.3:
- NF-13 workspace forks.
- NF-32 package-enabled code.
- NF-33 multiplayer editing.
- NF-34 upgrade shadow runs.
- NF-40 data residency.
- Signed community node marketplace (S11).
- Helm chart.
- Workflow reviews before publish.
- UI localisation.

---

## 7. How to continue with Claude Code

Paste one of these into a new session on `main`. The generic resume prompt in the RESUME POINT section works for any phase.

- **Phase A:**
  > Read plan/REMAINING-PLAN.md and plan/review-findings.md. Do Phase A: for every high finding, reproduce it with a failing test, fix it or mark it refuted, then do K1–K11. Run all package tests, tsc and biome; run the E2E smoke test; commit after each item and push to `main`.
- **Phase B:**
  > Do Phase B of plan/REMAINING-PLAN.md, one feature per commit, with tests, and update docs/SPEC.md statuses.
  > Cost tip: Phase A is the most valuable per credit. Parallel agents (one per package, each in its own git worktree) worked well for building. Run at most two at a time on a 4-CPU machine.
