# Product Specification: parity with n8n plus what users asked for

**Status:** living document. Update the status column in the same change that ships a capability.
**Inputs:** the n8n capability inventory and user research in [research/USER-RESEARCH.md](research/USER-RESEARCH.md) (233 sourced findings from reviews, forums, feature requests, competitors, changelogs and 37 CVE records), and the contracts in [ARCHITECTURE.md](ARCHITECTURE.md).

## 0. Ground rules

1. **Clean room.** We rebuild functionality. We do not copy n8n source code (Sustainable Use License forbids hosting or white-labelling it), documentation text, branding or icons. Workflow JSON _format compatibility_ is fine and is a feature (import from n8n).
2. **Multi-tenant SaaS and white-label first.** Anything n8n puts behind an enterprise licence that a SaaS tenant needs (variables, SSO, Git, environments, log streaming, audit) is a normal feature for us.
3. **Safe by default.** Security rules derived from n8n's CVE history (section 4) override convenience.

**Status legend:** ✅ built and tested in this repo · 🔨 milestone 1, building now · 📋 planned (M2 next, M3 later) · ⛔ deliberately excluded

**Milestones:**
- **M1** is the core platform: everything a team needs to build, run and operate production workflows on a hosted multi-tenant service, plus the core and top integrations and AI agents.
- **M2** adds depth and the strongest differentiators.
- **M3** covers scale, ecosystem and enterprise.

## 1. Parity matrix

### 1.1 Editor and canvas

| Capability                                                                                                                          | M   | Status                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------- |
| Node-graph canvas, drag-to-connect, multiple inputs/outputs, AI ports                                                               | M1  | 🔨                                    |
| Node creator: search, categories, aliases, trigger-first, resource/operation actions                                                | M1  | 🔨                                    |
| Node details view: input/output panes with table, JSON and schema views; drag fields into parameters                                | M1  | 🔨                                    |
| Parameter form for every property type (options, collections, fixed collections, resource locator, filter, assignments, code, JSON) | M1  | 🔨                                    |
| Expression editor with autocomplete and live preview using the same interpreter as the server                                       | M1  | ✅ engine · 🔨 UI                     |
| Sticky notes (markdown), copy/paste as JSON, import/export JSON, undo/redo, shortcuts, minimap, zoom-to-fit, disable node           | M1  | 🔨                                    |
| Rename node rewrites `$('Name')` / `$node["Name"]` references                                                                       | M1  | ✅ (`renameNodeInDefinition`) · 🔨 UI |
| Tags, workflow settings modal, version history panel with restore                                                                   | M1  | 🔨                                    |
| Dark theme, white-label theming from tenant settings                                                                                | M1  | 🔨                                    |
| Command bar (Cmd/Ctrl+K), context menu, auto-layout ("tidy up")                                                                     | M2  | ✅                                    |
| Canvas groups, convert selection to sub-workflow                                                                                    | M2  | ✅                                    |
| Dirty-node tracking so partial runs restart from the first changed node                                                             | M2  | ✅                                    |
| Folders, favorites, archive (soft delete)                                                                                           | M2  | ✅                                    |
| Folder tags                                                                                                                         | M2  | ✅                                    |
| Binary previews in NDV: image, PDF, audio, video, JSON, text, markdown, sandboxed HTML                                              | M2  | ✅                                    |
| Import a workflow from a URL (fetched by the server, SSRF-guarded)                                                                  | M2  | ✅                                    |
| Autosave of the draft                                                                                                               | M2  | ✅                                    |
| UI localisation                                                                                                                     | M3  | 📋                                    |
| Real-time co-editing; meanwhile a read-only lock while another user edits                                                           | M3  | 📋                                    |

### 1.2 Data model and expressions

| Capability                                                                                                                                                                               | M   | Status                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------- |
| Items `{json, binary, pairedItem}`, per-input/output arrays, multiple runs per node                                                                                                      | M1  | ✅                                      |
| Execute Once, Always Output Data                                                                                                                                                         | M1  | ✅                                      |
| Automatic and explicit paired items; `$('Node').item` resolution across branches                                                                                                         | M1  | ✅                                      |
| `{{ }}` JavaScript expressions in every parameter, fixed/expression toggle                                                                                                               | M1  | ✅                                      |
| Built-ins: `$json $binary $input $() $node $items $prevNode $parameter $runIndex $itemIndex $now $today $vars $execution(.customData) $workflow $jmespath $if $ifEmpty $min $max`, Luxon | M1  | ✅                                      |
| Data transformation methods (strings, numbers, arrays, objects, booleans, dates)                                                                                                         | M1  | ✅ (~80)                                |
| Sandboxed evaluation: no eval/vm, per-expression step and time budget, frozen shared state                                                                                               | M1  | ✅                                      |
| `$secrets` (external vaults)                                                                                                                                                             | M2  | ✅                                      |
| `$fromAI()` for agent tool parameters                                                                                                                                                    | M2  | ✅                                      |
| `$getWorkflowStaticData` in the Code node (as in n8n), saved after runs from active triggers                                                                                             | M2  | ✅                                      |
| Execution order v1 (depth-first by position)                                                                                                                                             | M1  | ✅ (the legacy v0 order is ⛔)          |

### 1.3 Flow logic and core nodes

| Capability                                                                                        | M   | Status                                                 |
| ------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------ |
| Manual Trigger, Webhook, Schedule, Code (JS), Edit Fields, No Op, Respond to Webhook              | M1  | ✅                                                     |
| IF, Switch (rules/expression, dynamic outputs, fallback), Filter                                  | M1  | 🔨                                                     |
| Merge (append, combine by fields/position/all combinations, choose branch, 2-10 inputs)           | M1  | 🔨                                                     |
| Loop Over Items, Wait (interval, date, webhook resume), Stop and Error, Limit                     | M1  | 🔨 (engine wait/resume ✅)                             |
| Aggregate, Split Out, Sort, Remove Duplicates, Summarize, Rename Keys, Compare Datasets           | M1  | 🔨                                                     |
| Date & Time, Crypto, HTML, XML, Markdown, Convert to File, Extract from File (CSV/JSON/text/HTML) | M1  | 🔨                                                     |
| HTTP Request (all auth modes, body types, pagination, batching, full response, file output)       | M1  | 🔨                                                     |
| GraphQL, RSS Read, Send Email (SMTP)                                                              | M1  | 🔨                                                     |
| Execute Workflow / Execute Workflow Trigger, Error Trigger                                        | M1  | 🔨                                                     |
| JWT, TOTP, Compression, XLSX/PDF extract, Edit Image                                              | M2  | ✅                                                     |
| Form Trigger + Form node (multi-step, hosted on the sandbox origin)                               | M2  | ✅                                                     |
| Form user auth (basic auth, or sign-in with a form-only cookie)                                   | M2  | ✅                                                     |
| Send and wait (Slack, Telegram, Email and others: approval and free-text replies)                 | M2  | ✅                                                     |
| Data tables + Data Table node                                                                     | M2  | ✅                                                     |
| Data table public API (REST, scoped API keys)                                                     | M2  | ✅                                                     |
| FTP/SFTP, SSH to remote hosts (SSRF-guarded)                                                      | M2  | ✅                                                     |
| Execute Command, Read/Write Files from Disk, local Git, local file trigger                        | —   | ⛔ host access is unsafe in multi-tenant SaaS (see §4) |

### 1.4 Triggers

| Capability                                                                                                           | M   | Status              |
| -------------------------------------------------------------------------------------------------------------------- | --- | ------------------- |
| Webhook: test and production URLs, methods, path params, raw/binary/multipart, Basic/Header auth, IP allowlist, CORS | M1  | ✅ node · 🔨 server |
| Response modes: immediately, last node, Respond to Webhook node                                                      | M1  | 🔨                  |
| Streaming responses                                                                                                  | M2  | 📋                  |
| Schedule (seconds to months, cron, workflow timezone)                                                                | M1  | ✅ node · 🔨 server |
| Polling triggers (Gmail) with persisted cursor                                                                       | M1  | 🔨                  |
| Third-party webhook registration lifecycle (Telegram)                                                                | M1  | 🔨                  |
| Chat Trigger (public or authenticated, allowed origins, streaming)                                                   | M1  | ✅                  |
| Event/stream triggers: Postgres LISTEN, Redis, Kafka, RabbitMQ, MQTT, IMAP, SSE                                      | M2  | ✅                  |
| Trigger restart with backoff and test listen (up to 120 s) for event triggers                                        | M2  | ✅                  |
| RSS Feed Trigger                                                                                                     | M2  | ✅                  |
| Redis, Kafka, RabbitMQ and MQTT nodes                                                                                | M2  | ✅                  |
| AMQP Trigger and Sender                                                                                              | M2  | ✅                  |
| Missed-schedule policy (catch-up), durable scheduler leases                                                          | M2  | ✅                  |
| MCP Server Trigger (expose a workflow as MCP tools)                                                                  | M2  | 📋                  |

### 1.5 Executions and debugging

| Capability                                                                                                  | M   | Status                        |
| ----------------------------------------------------------------------------------------------------------- | --- | ----------------------------- |
| Manual full runs, partial runs up to a node, pinned data                                                    | M1  | ✅ engine · 🔨 UI             |
| Production executions from active triggers                                                                  | M1  | 🔨                            |
| Execution list (filters: workflow, status), detail view with run data, retry, stop, delete                  | M1  | 🔨                            |
| Custom execution data (10 keys)                                                                             | M1  | ✅                            |
| Per-workflow settings: save success/error/manual/progress, timeout, timezone, error workflow, caller policy | M1  | ✅ engine · 🔨 server         |
| Cancellation and timeouts through the whole stack (including the Code sandbox)                              | M1  | ✅                            |
| Debug a past run in the editor (load its data as pinned data)                                               | M2  | 📋                            |
| Execution annotations (tags, rating), redaction policies                                                    | M2  | ✅ annotations · 📋 redaction |

### 1.6 Error handling

| Capability                                                                             | M   | Status |
| -------------------------------------------------------------------------------------- | --- | ------ |
| Retry on fail (max tries, wait)                                                        | M1  | ✅     |
| On error: stop / continue / continue via error output (items with `error` auto-routed) | M1  | ✅     |
| Error workflow + Error Trigger with failed-run context                                 | M1  | 🔨     |
| Stop and Error node                                                                    | M1  | 🔨     |

### 1.7 Sub-workflows

| Capability                                                                                               | M   | Status |
| -------------------------------------------------------------------------------------------------------- | --- | ------ |
| Execute sub-workflow from the database or inline JSON; once for all or per item; wait or fire-and-forget | M1  | 🔨     |
| Caller policy                                                                                            | M1  | 🔨     |
| Sub-workflow as an AI agent tool                                                                         | M1  | 🔨     |
| Typed input schema on Execute Workflow Trigger                                                           | M1  | 🔨     |

### 1.8 Code

| Capability                                                                                                                                | M   | Status                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------- |
| Code node (JavaScript, all-items / per-item, `$input`, `$()`, `$vars`, Luxon, console to editor) in isolated-vm with memory and time caps | M1  | ✅                          |
| Code tool for agents                                                                                                                      | M1  | 🔨                          |
| Runner moved to a separate, unprivileged process or container (defence in depth)                                                          | M2  | 📋                          |
| Python                                                                                                                                    | M2  | ✅ (Pyodide in the sandbox) |
| Python Code tool for agents                                                                                                               | M2  | ✅                          |
| Python packages (Pyodide or pure-Python wheels from a server folder)                                                                      | M2  | ✅                          |
| Allowlisted npm packages per tenant                                                                                                       | M3  | 📋 (NF-32)                  |

### 1.9 Credentials and secrets

| Capability                                                                                                         | M     | Status                                             |
| ------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------- |
| Typed credential schemas, AES-256-GCM per-tenant encryption bound to tenant+credential, key rotation               | M1    | ✅                                                 |
| Redacted API output, merge-on-update                                                                               | M1    | ✅ helpers · 🔨 server                             |
| Credential test                                                                                                    | M1    | 🔨                                                 |
| Credential tests for every credential type                                                                         | M2    | ✅                                                 |
| Postgres and MySQL SSL and SSH tunnel                                                                              | M2    | ✅                                                 |
| Generic auth: Basic, Header, Query, Bearer, Custom JSON, OAuth2 (auth code, client credentials, PKCE) with refresh | M1    | ✅ OAuth2 refresh · 🔨 types and flow              |
| Reuse any integration credential in HTTP Request                                                                   | M1    | 🔨                                                 |
| Allowed domains per credential                                                                                     | M2    | ✅                                                 |
| OAuth1, Digest auth                                                                                                | M2    | ✅                                                 |
| External secret vaults (AWS, GCP, Azure, Vault, 1Password), `$secrets`                                             | M2    | ✅                                                 |
| End-user credentials / per-customer credential slots (see NF-05)                                                   | M1/M2 | 📋                                                 |
| Credential sharing between users/projects                                                                          | M2    | 📋 (tenants share by default; projects come in M2) |

### 1.10 Integrations

| Capability                                                                                                                                                                                                                                                                                                                       | M   | Status                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------- |
| Slack, Gmail (+ trigger), Google Sheets, Postgres, MySQL, Notion, Airtable, Telegram (+ trigger)                                                                                                                                                                                                                                 | M1  | 🔨                                           |
| Next wave (by request volume): Microsoft 365/Outlook/Teams/Excel, Google Drive/Calendar/Docs, HubSpot, Salesforce, Stripe, Shopify, GitHub, GitLab, Jira, Linear, Trello, Asana, Discord, WhatsApp Business, Twilio, SendGrid, Mailchimp, Dropbox, OneDrive, S3, MongoDB, Redis, Supabase, Typeform, Calendly, Zendesk, Intercom | M2  | 📋                                           |
| Connector factory: generate declarative connectors from OpenAPI, Postman or cURL (NF-38), so the long tail of 400+ services comes from specs rather than hand-written nodes                                                                                                                                                      | M2  | 📋                                           |
| Node type versions (old workflows keep old behaviour)                                                                                                                                                                                                                                                                            | M1  | ✅ `typeVersion` + `@version` displayOptions |
| Community/private node packages, signed and sandboxed with declared capabilities                                                                                                                                                                                                                                                 | M3  | 📋                                           |
| Node blocking per tenant (policy packs)                                                                                                                                                                                                                                                                                          | M2  | 📋                                           |

### 1.11 Binary data

| Capability                                                                      | M   | Status |
| ------------------------------------------------------------------------------- | --- | ------ |
| Named binary properties, inline and filesystem stores, tenant-scoped references | M1  | ✅     |
| S3-compatible store; streaming to/from object storage (NF-20)                   | M2  | 📋     |

### 1.12 AI

| Capability                                                                                                                | M   | Status                         |
| ------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------ |
| AI Agent (tools agent): memory, tools, output parser, max iterations, streaming                                           | M1  | ✅                             |
| Chains: Basic LLM, Information Extractor, Text Classifier, Sentiment, Summarization, Retrieval QA                         | M1  | ✅                             |
| Chat models: OpenAI, Anthropic, Gemini, Ollama, any OpenAI-compatible (OpenRouter, Groq, Mistral, DeepSeek, xAI...)       | M1  | ✅                             |
| Memory: window, Postgres, Redis                                                                                           | M1  | ✅                             |
| Tools: Calculator, Code, HTTP Request, Call Workflow, Think, Vector Store, MCP Client                                     | M1  | 🔨 (all but MCP Client ✅)        |
| RAG: embeddings (OpenAI, Gemini, Ollama), vector stores (in-memory, PGVector, Qdrant), loaders, splitters, output parsers | M1  | ✅                             |
| Chat Trigger                                                                                                              | M1  | ✅                             |
| Hosted/embeddable chat widget (sandbox origin)                                                                            | M2  | ✅                             |
| Any node usable as an agent tool, `$fromAI()`                                                                             | M2  | ✅                             |
| Guardrails node (PII, jailbreak, secrets, URLs)                                                                           | M2  | ✅                             |
| Evaluations (datasets, metrics, AI judge)                                                                                 | M2  | ✅                             |
| More vector stores, rerankers                                                                                             | M2  | ✅                             |
| Bedrock, Vertex AI, Azure OpenAI and Foundry, Mistral, Cohere and named OpenAI-compatible models                          | M2  | ✅                             |
| Human review for agent tools, tools that wait, `$tool`                                                                    | M2  | ✅                             |
| Test a tool with typed values (tool executor run)                                                                         | M2  | ✅                             |
| Resource mapper control (Call Workflow Tool inputs)                                                                       | M2  | ✅                             |
| Model Selector                                                                                                            | M2  | ✅                             |
| Text completion models (Cohere, Ollama, Hugging Face and others)                                                          | M2  | ✅                             |
| Vendor nodes: OpenAI, Anthropic, Google Gemini, Ollama, Moonshot Kimi, Alibaba Cloud, MiniMax, Databricks AI Agent        | M2  | ✅                             |
| Chat Memory Manager                                                                                                       | M2  | ✅                             |
| Memory: MongoDB, Xata, Databricks Lakebase                                                                                | M2  | ✅                             |
| Retrievers: vector store, contextual compression, multi query, workflow                                                   | M2  | ✅                             |
| Search tools: SearXNG, Wikipedia, Wolfram Alpha                                                                           | M2  | ✅                             |
| Chat node: Send Message, Send and Wait in the chat, approval for tools                                                    | M2  | ✅                             |
| Canvas chat and embed snippets (hosted page, widget, script tag)                                                          | M2  | ✅                             |
| Logs tree: sub-node runs, details, token counts, pop-out window                                                           | M2  | ✅                             |
| Execution Data node and the highlighted-data filter on executions                                                         | M2  | ✅                             |
| Evaluations page: test runs, run detail, metric chart, run in parallel                                                    | M2  | ✅                             |
| Test run public API (start, list, cancel, cases) with scopes                                                              | M2  | ✅                             |
| AI workflow copilot that produces reviewable drafts (NF-26)                                                               | M2  | 📋                             |
| MCP server for the tenant (search/run/build workflows)                                                                    | M2  | 📋                             |

### 1.13 Users, access and authentication

| Capability                                                                          | M   | Status |
| ----------------------------------------------------------------------------------- | --- | ------ |
| Tenants (workspaces), owner/admin/editor/viewer roles, invitations, tenant switcher | M1  | 🔨     |
| Email + password (argon2id), sessions, CSRF origin checks, login rate limits        | M1  | 🔨     |
| API keys for the public API                                                         | M1  | 🔨     |
| Audit log (append-only, every tier)                                                 | M1  | 🔨     |
| Password reset, TOTP 2FA (enforceable)                                              | M2  | 📋     |
| Projects inside a tenant with project roles, custom roles                           | M2  | 📋     |
| SSO: SAML, OIDC; SCIM; role provisioning from IdP claims                            | M2  | 📋     |

### 1.14 Lifecycle and governance

| Capability                                                                        | M   | Status |
| --------------------------------------------------------------------------------- | --- | ------ |
| Version on every save, restore, optimistic concurrency (409)                      | M1  | 🔨     |
| Semantic diff, named versions, publish vs save, in-flight version pinning (NF-10) | M1  | ✅     |
| Git sync, workflow-as-code SDK and CLI (NF-11)                                    | M2  | 📋     |
| Environments / workspace forks with credential bindings (NF-13)                   | M3  | 📋     |
| Workflow reviews/approvals before publish                                         | M3  | ✅     |
| Publish timeline                                                                  | M2  | ✅     |
| Version history compaction (hourly optimize, daily trim)                          | M2  | ✅     |

### 1.15 Observability, scaling, APIs

| Capability                                                               | M   | Status |
| ------------------------------------------------------------------------ | --- | ------ |
| Structured logs, `/healthz`, `/healthz/readiness`, Prometheus `/metrics` | M1  | 🔨     |
| Regular mode and queue mode (BullMQ workers), Redis pub/sub push         | M1  | 🔨     |
| Execution pruning                                                        | M1  | 🔨     |
| Public REST API `/api/v1` with OpenAPI document                          | M1  | 🔨     |
| Public API folder routes                                                 | M2  | ✅     |
| Docker image + docker-compose (Postgres+pgvector, Redis, main, worker)   | M1  | 🔨     |
| Insights dashboard (runs, failures, duration, time saved)                | M2  | 📋     |
| OpenTelemetry traces, log streaming (webhook/syslog/Sentry)              | M2  | 📋     |
| Webhook processor and ingress split, multi-main HA                       | M2  | 📋     |
| Helm chart                                                               | M3  | 📋     |
| Templates gallery + one-click import, import n8n workflow JSON           | M2  | 📋     |

## 2. New features (not in n8n), from user research

Each feature fixes a ranked user pain point (PP-xx in the research report). Milestone placement weighs impact, effort, and whether the core has to be designed for it from day one.

### 2.1 Milestone 1 (next wave, after the parity merge)

| ID    | Feature                                                                                 | Solves                            | Plan                                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NF-01 | **Resume from the failed node** using durable per-node checkpoints                      | PP-03 durability, PP-02 debugging | The engine already keeps a JSON-serializable state. On failure, store the failed node's execute data. "Retry from failure" re-runs that node with the same inputs, optionally on the latest version, and reuses all upstream outputs. Save progress after every node for crash recovery. |
| NF-02 | **Retry policies with exponential backoff, jitter and `Retry-After`; idempotency keys** | PP-03                             | Extend `retryOnFail` with `backoff: fixed\|exponential`, jitter, respect for 429 `Retry-After`. Expose `$execution.idempotencyKey(node,item)` and send `Idempotency-Key` on public API POSTs; dedupe webhook deliveries by a configurable key.                                           |
| NF-05 | **Credential slots resolved at run time**                                               | PP-07 agencies                    | A node credential reference may be an expression (`={{ $json.customer.crmCredentialId }}`) resolved per item. Tenant ownership is checked on every resolution. Tenancy itself is already native.                                                                                         |
| NF-10 | **Semantic diff, named versions, version pinning, one-click rollback**                  | PP-05, PP-18                      | `diffWorkflows(a,b)` in `@workflow/workflow` covers added, removed, changed, rewired and renamed nodes, ignoring positions. Each execution records its version; the editor shows the diff before a restore. Unlimited history in every plan.                                             |
| NF-15 | **Structured, actionable errors**                                                       | PP-02, PP-01                      | Errors carry `code`, `itemIndex`, `parameter`, the expression snippet, an HTTP request/response summary (secrets stripped), and a hint plus fix from an error catalogue.                                                                                                                 |
| NF-18 | **Alert rules, heartbeats, tenant-default error workflow**                              | PP-13                             | Rules for failure, failure rate and "no successful run in N h", routed to email, Slack or webhook with dedup and mute. One error workflow per tenant as the default.                                                                                                                     |
| NF-19 | **Per-outcome retention**                                                               | PP-20                             | Retention by workflow and outcome (e.g. failures 30 days, successes 1 day, metadata 1 year), with storage use shown per workflow.                                                                                                                                                        |
| NF-20 | **Per-execution resource quotas**                                                       | PP-09, PP-10                      | Caps on items per node output, run-data bytes and node runs. Breaching one fails that execution with a clear reason instead of killing a worker.                                                                                                                                         |
| NF-04 | **Cost metering and spend guardrails**                                                  | PP-15, PP-14                      | Meter execution time per tenant/workflow and LLM tokens per model. Budgets per workflow/tenant with warn, pause and stop actions. Loop circuit breakers already exist (100k node runs).                                                                                                  |
| NF-08 | **Per-workflow concurrency limits and priority** (key-based limits come in M2)          | PP-16                             | Per-workflow max concurrent executions and queue priority in queue mode.                                                                                                                                                                                                                 |
| NF-21 | **Async webhook jobs**                                                                  | PP-03                             | A response mode `async` returns 202 with a job id plus status/result endpoints and an optional callback URL.                                                                                                                                                                             |
| NF-28 | **Rename-safe references**                                                              | PP-12                             | ✅ Rename rewrites references in parameters (`renameNodeInDefinition`); M2 stores references by node id.                                                                                                                                                                                 |

### 2.2 Milestone 2

| ID    | Feature                                                                                                                                      | Solves               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| NF-03 | Bulk replay of failed runs by filter (incident-named, rate-limited, linked to the originals)                                                 | PP-03, PP-13         |
| NF-06 | White-label kit and embed SDK: custom domains + TLS, theme tokens, email templates, signed-JWT embedded editor, "connect your account" pages | PP-08, PP-07         |
| NF-07 | Agency client portal: read-only runs, toggles, input forms, credential connect links, reports                                                | PP-07                |
| NF-08 | Keyed flow control: concurrency keys by expression, throttle, debounce, singleton, fair queues, worker pools                                 | PP-16, PP-10         |
| NF-09 | Shared rate limiter per credential/host (token bucket across workers)                                                                        | PP-16                |
| NF-11 | Workflow-as-code SDK, canonical diff-friendly format, CLI, free two-way Git sync                                                             | PP-05, PP-11         |
| NF-12 | Workflow test suites: fixtures, assertions, HTTP record/replay, CI gate before publish                                                       | PP-17, PP-18         |
| NF-14 | Step debugger: breakpoints, step over/into, sub-workflow drill-down, item lineage                                                            | PP-02, PP-21         |
| NF-16 | Guided data mapping and simple mode for non-coders                                                                                           | PP-01                |
| NF-17 | Credential health centre: scheduled checks, expiry alerts, dependent workflows                                                               | PP-19                |
| NF-22 | Webhook event inbox: durable storage before dispatch, provider signature presets, dedupe, replay                                             | PP-03                |
| NF-23 | Approval inbox: quorum/sequential approvals, SLAs, escalation, one-tap Slack/Teams/email                                                     | PP-25                |
| NF-24 | Wait-for-event correlation and cancel-on-event                                                                                               | PP-25                |
| NF-25 | Reliable agent runtime: transactional memory, per-tool error policy, approval for write tools, traces                                        | PP-14                |
| NF-26 | AI copilot producing reviewable drafts with diff and dry run; bring your own key                                                             | PP-14, PP-01         |
| NF-27 | Parallel branches with Join, scoped loop containers, item-lineage view                                                                       | PP-21                |
| NF-29 | Component library: snippets, shared functions, typed workflow components                                                                     | PP-12                |
| NF-30 | Workflow and per-entity state store with get/set/increment/lock nodes                                                                        | PP-12                |
| NF-31 | Schedule centre: timetable, next-run preview, calendars, overlap policy, backfill                                                            | PP-23                |
| NF-35 | Platform health panel and config doctor                                                                                                      | PP-10                |
| NF-36 | Hybrid runners in the customer's network (outbound mTLS, per-step credentials)                                                               | private connectivity |
| NF-37 | Tenant snapshots, point-in-time restore, portability                                                                                         | backups              |
| NF-38 | Connector factory: OpenAPI, Postman or cURL to a typed declarative connector                                                                 | integration breadth  |
| NF-39 | Execution search and business-key tracing across workflows                                                                                   | PP-13                |
| NF-41 | Reseller policy hooks and signed admin event webhooks                                                                                        | PP-07, PP-08         |

### 2.3 Milestone 3

| ID    | Feature                                                                                | Solves       |
| ----- | -------------------------------------------------------------------------------------- | ------------ |
| NF-13 | Workspace forks with their own credentials, promote/merge                              | PP-17, PP-22 |
| NF-32 | Package-enabled sandboxed code (per-tenant npm/PyPI allowlists, lockfiles, scanning)   | PP-24        |
| NF-33 | Multiplayer editing, node locks, execute-only role                                     | PP-22        |
| NF-34 | Upgrade shadow runs (replay recent inputs on the new version with side effects mocked) | PP-18        |
| NF-40 | Data residency per tenant and data-subject tooling (find/export/erase)                 | privacy      |

**Decided now so these features stay possible later:**
- Workers will talk to the control plane through an authenticated job API, not direct DB/Redis access (NF-36).
- Tenants get a `region` field and storage URIs are region-aware (NF-40).
- Executions record the workflow version they ran (NF-10).
- The execution state is serializable (NF-01).

## 3. What users praise (must not regress)

These come from the research, section 3.
- Visual canvas plus real code when needed.
- Self-hosting.
- Fair pricing per execution, not per step.
- Wide integration coverage, including the generic HTTP Request node.
- Strong AI agent building blocks.
- Active community and templates.

Our pricing model must stay per execution (not per node run), and "bring your own model key" must stay available.

## 4. Security design rules (from n8n CVE history)

Each rule maps to the research report, section 6. Status uses the legend above.

| #   | Rule                                                                                                                                                                                                          | Status                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S1  | Never evaluate expressions with `eval`/`new Function`/`vm`; block prototype access at the AST level; budget steps, time and size                                                                              | ✅ `Interpreter` + escape tests                                         |
| S2  | **Data is never code.** Only design-time parameters are parsed as expressions; runtime values (webhook bodies, API responses, LLM output, form fields) are never re-evaluated, whatever their first character | ✅ the engine resolves only `node.parameters`; regression test required |
| S3  | User code runs in a V8 isolate with memory/time caps and no host references. Next: a separate unprivileged runner process with no secrets in its environment                                                  | ✅ isolate · 📋 M2 runner process                                       |
| S4  | No ambient secrets: credentials are decrypted per call for the node that needs them, redacted from logs, run data and agent memory                                                                            | ✅ per-call decryption · 🔨 redaction in logs                           |
| S5  | No host filesystem/shell nodes in SaaS; binaries live in tenant-scoped storage behind opaque ids                                                                                                              | ✅ (no such nodes; tenant path check)                                   |
| S6  | Every embedded interpreter (SQL over items, templating) is a sandbox boundary                                                                                                                                 | ✅ policy (no SQL-over-items Merge mode in M1)                          |
| S7  | Public ingress (webhooks, forms, chat) runs as a separate service with no DB password or keys; strict body schemas and size limits; callers never reference files                                             | 🔨 limits · 📋 M2 separate service                                      |
| S8  | User-authored HTML (webhook HTML responses, forms, chat pages, previews) is served with `Content-Security-Policy: sandbox` or from a separate cookieless origin                                               | 🔨 required in server                                                   |
| S9  | One egress client with connect-time SSRF checks, re-checked after DNS and on every redirect; per-tenant allowlists; non-HTTP connections use `assertHostAllowed`                                              | ✅                                                                      |
| S10 | Envelope encryption: per-tenant keys, key id in every ciphertext, rotation; next: KMS-wrapped keys, no master key on workers                                                                                  | ✅ HKDF per tenant + key ids · 📋 KMS                                   |
| S11 | Third-party nodes come from a signed, pinned marketplace and run sandboxed with declared capabilities                                                                                                         | 📋 M3                                                                   |
| S12 | Treat every authenticated editor as a potential attacker; the sandbox, not RBAC, is the last line of defence                                                                                                  | ✅ design principle                                                     |
| S13 | Auth denies by default (no path-suffix exemptions); one redirect validator; SSO enforced on identity-changing APIs                                                                                            | 🔨                                                                      |
| S14 | Per-tenant policy packs: node/credential allowlists, MCP URL allowlists                                                                                                                                       | 📋 M2                                                                   |
| S15 | Resource limits are a security control (per-execution memory, CPU, payload, item count)                                                                                                                       | ✅ expressions/code · 📋 NF-20                                          |
| S16 | Use Postgres leases (`SKIP LOCKED`) for triggers, timers and waiting executions, and Redis only to wake workers                                                                                               | 📋 review M1 leader election                                            |
| S17 | One supported release line, fast patching, automatic updates                                                                                                                                                  | process                                                                 |
| S18 | Append-only per-tenant audit log in every tier                                                                                                                                                                | 🔨                                                                      |

## 5. Out of scope (with reasons)

- **Legacy execution order v0.** It is confusing and only kept for backwards compatibility.
- **Host-level nodes** (Execute Command, local files, local Git). See S5.
- **SQLite.** We run Postgres in every deployment because the multi-tenant guarantees rely on it.
- **Copying n8n's 400+ nodes one by one.** Breadth comes from the connector factory (NF-38), with the most requested services hand-built first.
