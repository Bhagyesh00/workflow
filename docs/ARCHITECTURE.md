# Architecture

This document is the contract between packages. If code and this document disagree, fix one of them in the same change.

## 1. Goals

| Goal                                                           | Consequence                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Functional parity with node-graph automation tools (n8n-style) | Item-based data model, `{{ }}` JS expressions, node graph with branches/merges/loops, sub-workflows, error workflows, AI cluster nodes           |
| Multi-tenant SaaS, white-label                                 | Every row is tenant-scoped; branding is configuration; webhook URLs are tenant-namespaced; no per-tenant processes required                      |
| Safe by default                                                | Expressions never reach `eval`; user code runs in V8 isolates; SSRF guard on all node HTTP; credentials encrypted per tenant; run data immutable |
| Fast                                                           | Node.js event loop for I/O-bound work; queue workers scale horizontally; expression ASTs cached; isolates disposed per run                       |

## 2. Stack

| Layer           | Choice                                                                                      | Why                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | TypeScript 7 (strict), Node.js 24 LTS (22.19+ supported)                                    | Integration breadth: every SaaS ships a JS SDK; users write JS expressions, so the engine speaking JS avoids an embedded interpreter boundary |
| API server      | Fastify 5 + Zod 4                                                                           | Fastest mainstream Node framework, schema-validated routes                                                                                    |
| Database        | PostgreSQL 16 + Drizzle ORM                                                                 | JSONB for workflow graphs and run data, row-level security available, transactional                                                           |
| Queue / pub-sub | Redis 7 + BullMQ                                                                            | Horizontal workers, delayed jobs (Wait resume), retries, pub/sub for live editor events                                                       |
| Editor          | React 19 + Vite 8 + @xyflow/react 12 + Zustand + TanStack Query + Tailwind 4 + CodeMirror 6 | Mature node-canvas library; small, fast bundles                                                                                               |
| Expressions     | acorn parser + custom tree-walking interpreter (`@workflow/workflow`)                       | No `eval`/`vm`: nothing to escape from                                                                                                        |
| Code node       | isolated-vm (separate V8 isolate, memory cap, wall-clock cap)                               | Real isolation for arbitrary user code                                                                                                        |
| HTTP            | undici with connect-time IP policy                                                          | SSRF protection that survives DNS rebinding and redirects                                                                                     |
| Tests           | Vitest 5, Playwright for E2E                                                                |                                                                                                                                               |
| Lint/format     | Biome 2                                                                                     | One fast tool                                                                                                                                 |

## 3. Repository layout

```
packages/
  workflow/    isomorphic model: types, graph, parameters, expression language   (browser + server)
  core/        execution engine, node contexts, credentials crypto, HTTP, code sandbox, registries
  nodes-base/  core nodes + app integrations + credential types
  nodes-ai/    AI cluster nodes (agent, chains, chat models, memory, tools, vector stores)
  server/      Fastify API, auth, multi-tenancy, persistence, webhooks, triggers, queue workers
  editor/      React SPA (canvas, node details view, executions, credentials, settings)
docs/          ARCHITECTURE.md (this), SPEC.md (feature parity + new features), research/
```

Packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`). Vite (editor), Vitest and `tsx` (server dev) consume source directly; the server is bundled for production.

Dependency direction: `workflow` ← `core` ← `nodes-*` ← `server`; `editor` depends only on `workflow`.

## 4. Runtime topology

```
            ┌──────────── browser (editor SPA) ────────────┐
            │  REST /rest/*   SSE /rest/push               │
            └───────────────┬──────────────────────────────┘
                            │
  external callers ──► main process(es): Fastify
                         ├─ REST API, public API /api/v1
                         ├─ webhooks /webhook/:tenant/*, /webhook-test/*, /webhook-waiting/:id
                         ├─ trigger manager (leader only): cron, pollers, trigger nodes
                         ├─ wait tracker (leader only): resumes waiting executions
                         └─ in regular mode: runs executions in-process
                            │ enqueue {executionId}            ▲ push events (Redis pub/sub)
                            ▼                                  │
                       Redis/BullMQ  ───────────────►  worker processes: load execution, run WorkflowExecute,
                                                        persist result, publish events
                            │
                       PostgreSQL (all state)
```

- `EXECUTIONS_MODE=regular`: single process, no Redis required (development, small self-hosting).
- `EXECUTIONS_MODE=queue`: mains enqueue, workers execute. Leader election for triggers via a Redis lock with TTL renewal.
- Manual (editor) executions run on the main that received the request in regular mode, and on workers in queue mode; events reach the browser through Redis pub/sub channel `push:<tenantId>`.

## 5. Data model (PostgreSQL)

All tables except `users` carry `tenant_id` and every query filters by it (repository layer enforces; RLS policies are defined as defence in depth, see §10).

| Table                   | Key columns                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`               | `id uuid pk`, `name`, `slug unique`, `plan`, `settings jsonb` (brand, timezone, limits), `created_at`                                                                                                         |
| `users`                 | `id uuid pk`, `email unique (lower)`, `name`, `password_hash` (argon2id), `created_at`, `last_login_at`                                                                                                       |
| `memberships`           | `tenant_id`, `user_id`, `role` (`owner`/`admin`/`editor`/`viewer`), pk(tenant_id,user_id)                                                                                                                     |
| `sessions`              | `id` = sha256(token) pk, `user_id`, `tenant_id`, `expires_at`, `ip`, `user_agent`                                                                                                                             |
| `invitations`           | `id`, `tenant_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at`                                                                                                                                 |
| `api_keys`              | `id`, `tenant_id`, `user_id`, `name`, `prefix`, `key_hash` (sha256), `scopes text[]`, `last_used_at`                                                                                                          |
| `workflows`             | `id uuid`, `tenant_id`, `name`, `nodes jsonb`, `connections jsonb`, `settings jsonb`, `pin_data jsonb`, `static_data jsonb`, `sticky_notes jsonb`, `active bool`, `version_id uuid`, `created_by`, timestamps |
| `workflow_versions`     | `id` (= version_id), `workflow_id`, `tenant_id`, snapshot (`nodes`, `connections`, `settings`, `name`), `author_id`, `message`, `created_at`                                                                  |
| `tags`, `workflow_tags` | per-tenant unique tag names                                                                                                                                                                                   |
| `credentials`           | `id uuid`, `tenant_id`, `name`, `type`, `data_enc text`, `created_by`, timestamps                                                                                                                             |
| `executions`            | `id uuid`, `tenant_id`, `workflow_id`, `mode`, `status`, `started_at`, `stopped_at`, `wait_till`, `retry_of`, `custom_data jsonb`, `error_message`, `error_node`                                              |
| `execution_data`        | `execution_id pk`, `workflow_data jsonb` (snapshot used to run), `state jsonb` (`ExecutionState`)                                                                                                             |
| `webhooks`              | `tenant_id`, `workflow_id`, `node_name`, `method`, `path`, `is_dynamic`, `segments int`, pk(tenant_id, method, path)                                                                                          |
| `variables`             | `id`, `tenant_id`, `key` unique per tenant, `value`                                                                                                                                                           |
| `audit_log`             | `tenant_id`, `user_id`, `action`, `resource_type`, `resource_id`, `metadata jsonb`, `ip`, `created_at`                                                                                                        |
| `usage_counters`        | `tenant_id`, `period` (YYYY-MM), `executions`, `execution_ms`                                                                                                                                                 |

Execution data is split from the execution row so listing executions never loads run data. Pruning deletes executions older than `EXECUTIONS_PRUNE_DAYS` (per-plan override).

## 6. Execution model (`@workflow/core` `WorkflowExecute`)

Data: an **item** is `{ json, binary?, pairedItem?, error? }`. A node receives items per input and returns `Item[][]` (one array per output). `null` stops a branch.

1. The start node (trigger, or manual trigger) is pushed with the trigger items. Trigger/webhook/poll node types without `execute` pass their emitted items through.
2. **Depth-first order.** After a node runs, its children are placed at the front of the stack ordered by canvas position (y, then x). A branch finishes before the next starts.
3. **Multi-input nodes** (e.g. Merge) wait until every connected input has data. When the stack is empty, waiting nodes run with what they have, choosing nodes with no waiting ancestor first.
4. **Empty outputs** do not trigger children, unless the node has `alwaysOutputData` (then one empty item is emitted).
5. **Paired items.** Nodes set `pairedItem: { item, input? }` per output item. The engine fills it when unambiguous (one input item, or equal counts). `$('Node').item` follows these links back through run data.
6. **Immutability.** Outputs are deep-frozen when recorded. Nodes must copy (`deepCopy`) before modifying input items.
7. **Errors.** Per node `onError`:
   - `stopWorkflow` (default): the execution fails and the error workflow runs, if one is configured.
   - `continueRegularOutput`: the node emits `[{ json: { error } }]`.
   - `continueErrorOutput`: an extra error output (index = number of regular outputs) receives the failed items. Items a node returns with `item.error` set are moved there automatically.
   - `retryOnFail` retries up to `maxTries` (capped at 5), waiting `waitBetweenTries` ms (capped at 5000) between attempts.
8. **Pinned data** replaces a node's execution in manual runs. **Disabled** nodes pass input 0 through to output 0.
9. **Partial execution** (`destinationNode`) runs only that node and its ancestors, then stops.
10. **Wait.** `ctx.putExecutionToWait(date)` records the node with status `waiting` and sets `state.waitTill`; the engine returns `status: 'waiting'`. `resume({ output? })` continues in any process from the serialized `ExecutionState`.
11. **Cancellation / timeout** propagate through `ctx.signal`. Hitting the timeout yields `ExecutionTimeoutError`.
12. **Loops** use per-node context (`ctx.getContext('node')`), which persists across runs of the same node within an execution. A hard cap of 100,000 node runs stops runaway loops.
13. **AI sub-nodes.** Non-`main` connections (`ai_languageModel`, `ai_tool`, `ai_memory`, ...) are not executed in the main flow. A root node calls `ctx.getInputConnectionData(type, itemIndex)`, the engine calls each attached sub-node's `supplyData()`, and the result is the response object, or an array when `maxConnections !== 1`. Sub-nodes record their invocations with `ctx.logSubNodeRun()` so the editor can show AI logs.

`ExecutionState` is fully JSON-serializable (stack, waiting inputs, run data, context data).

Durability and limits (new features, see SPEC §2.1):

- **Retry from the failed node (NF-01).** When a node stops the execution, its inputs are stored in `state.executionData.failedExecuteData`. `WorkflowExecute.retryFromFailure()` re-runs only that node and its successors. It can run on a new engine built from the persisted state, optionally with the current workflow version. Upstream outputs are reused, so completed side effects are not repeated. `continueExecution()` resumes from persisted progress after a crash (`saveExecutionProgress`).
- **Backoff (NF-02).** `node.retryBackoff = 'exponential'` doubles `waitBetweenTries` per attempt with ±20% jitter. Both modes honour a server's `Retry-After`, capped at 60 s per wait.
- **Quotas (NF-20).** `limits.maxItemsPerOutput` (default 1,000,000) and `limits.maxNodeRuns` (default 100,000) fail the execution with `QUOTA_EXCEEDED` instead of exhausting a worker.
- **Error catalogue (NF-15).** `serializeError` adds a stable `code` (`HTTP_401`, `EXPRESSION_REFERENCE`, `SSRF_BLOCKED`, `TIMEOUT`, `CODE_MEMORY`, `QUOTA_EXCEEDED`, ...) and a plain-language `hint`. API errors carry `request {method,url}` (no query string) and a secret-scrubbed `response.body` excerpt.
- **Semantic diff (NF-10).** `diffWorkflows(a, b)` in `@workflow/workflow` reports added, removed, renamed and changed nodes, rewiring and settings changes, ignoring layout. The editor uses it for version history, and the server for restore previews.

## 7. Expression language & security

A parameter value is an expression when it is a string starting with `=`; `{{ }}` segments are JavaScript. A template containing only one segment returns the raw value; otherwise the result is a string.

Available: `$json`, `$binary`, `$input` (`item`, `all()`, `first()`, `last()`, `params`), `$('Node')` (`item`, `itemMatching(i)`, `first()`, `last()`, `all()`, `params`, `isExecuted`), `$node[...]` (legacy), `$items()`, `$prevNode`, `$parameter`, `$runIndex`, `$itemIndex`, `$now`, `$today`, `$vars`, `$execution` (`id`, `mode`, `resumeUrl`, `customData.set/get/getAll/setAll`), `$workflow`, `$jmespath`, `$if`, `$ifEmpty`, `$min`, `$max`, `DateTime`/`Duration`/`Interval` (Luxon), plus safe facades of `Math`, `JSON`, `Object`, `Array`, `Number`, `String`, `Boolean`, `Date`, `RegExp`, `Map`, `Set`, `URL`, `URLSearchParams`, `Intl`. Data-transformation methods such as `.isEmail()`, `.unique()`, `.toTitleCase()`, `.round(2)` and `.format()` resolve only when the native method does not exist (no prototype patching).

The interpreter's security rules are in `packages/workflow/src/expression/interpreter.ts`, and every rule has a test in `packages/workflow/test/expression.test.ts`:

1. Prototype keys (`constructor`, `__proto__`, `prototype`, `__defineGetter__`, ...) can never be read, written, destructured or used as object-literal keys.
2. Dangerous host values (`Function`, `eval`, `Reflect`, `Proxy`, `process`, `globalThis`, timers, `fetch`, ...) can never be called or returned.
3. Writes and `delete` work only on unfrozen plain objects and arrays, i.e. data the expression created. Shared facades and run data are frozen, so one tenant can never mutate state another tenant observes.
4. Budgets: 1,000,000 AST steps and a 1 s wall clock per expression by default; strings capped at 32 MB and arrays at 10M elements. `try/catch` cannot swallow budget errors.
5. `$env` throws. Tenants use `$vars`.
6. No `async`, generators, getters/setters, classes, `with`, `import()`.

## 8. Code node sandbox

`IsolatedVmCodeRunner`: a fresh V8 isolate per run (default 128 MB heap, 30 s wall clock), disposed afterwards. Input travels in as one JSON string and the result comes back as one JSON string. No host references are shared except a string-only `console` sink. There is no network, filesystem, `require` or `process`. Luxon is preloaded, and V8 code cache makes the preload cheap. The process must start with `node --no-node-snapshot`.

## 9. Credentials

- `CredentialCipher`: AES-256-GCM. Per-tenant keys are derived with HKDF from master keys (`ENCRYPTION_KEYS="k2:<b64>,k1:<b64>"`; the first key encrypts, all keys decrypt). The AAD is `tenantId:credentialId`. Format: `v1.<keyId>.<iv>.<tag>.<ct>`.
- The API never returns secret fields. Properties with `typeOptions.password` come back as `__REDACTED__`; on update, the sentinel keeps the stored value (`mergeRedacted`).
- OAuth2: authorization-code flow with server-side `state` (signed, tenant-bound, 10 min TTL) and PKCE when the type asks for it. Tokens are refreshed automatically when expired or on a 401 (`oauth2Request`), and refreshed tokens are persisted.
- Generic auth templates (`={{$credentials.x}}`) resolve keys and values.
- **Credential slots (NF-05).** A node's credential reference may have an expression id (`{ id: '={{ $json.customer.credentialId }}', name: 'Customer CRM' }`), resolved per item (`getCredentials(type, itemIndex)`, `httpRequestWithAuthentication(type, options, itemIndex)`). The `CredentialsProvider` must load the id **within the execution's tenant only** and verify the stored credential's `type` matches the requested type.

## 10. Multi-tenancy, auth, authorization

- **Sessions:** a 32-byte random token goes in the `wf_session` cookie (httpOnly, `SameSite=Lax`, `Secure` behind HTTPS). Only sha256(token) is stored. 14-day sliding expiry.
- **CSRF:** mutating `/rest` requests require `content-type: application/json`, and the `Origin` header must match `BASE_URL` (or `CORS_ORIGINS`).
- **Passwords:** argon2id; at least 8 characters with a letter and a digit. Login is rate-limited per IP and per email.
- **Roles per tenant:** `owner` (billing, delete tenant), `admin` (members, all resources), `editor` (workflows, credentials, executions), `viewer` (read-only, cannot read credentials).
- **API keys:** `wfk_<prefix>_<secret>`, only the sha256 is stored, shown once. Sent as the `X-API-KEY` header to `/api/v1`.
- **Tenant isolation:** every repository function takes `tenantId` first; there are no cross-tenant queries outside admin tooling. Webhook paths are namespaced by tenant slug. Binary files are stored under `<tenantId>/...` and access is checked.
- **Audit log** for auth events, credential reads/updates, workflow activation, member changes.
- **Plan limits** (`tenants.settings.limits`): active workflows, executions per month, execution timeout max, concurrent executions.

## 11. Triggers & webhooks

- Webhook URLs: production `{BASE_URL}/webhook/{tenantSlug}/{path}`, test `{BASE_URL}/webhook-test/{tenantSlug}/{path}`, resume `{BASE_URL}/webhook-waiting/{executionId}`. An empty `path` defaults to the node's `webhookId`. Dynamic segments (`users/:id`) match after static paths, with fewer dynamic segments preferred.
- Activation validates the workflow (unique paths, required credentials, known node types), registers webhooks in the `webhooks` table, starts trigger nodes (`trigger()`), schedules pollers (`poll()`), and calls `webhookMethods.create` for third-party registrations.
- Response modes: `onReceived` (immediate `{ message: 'Workflow was started' }` or the configured code), `lastNode` (data of the last executed node), `responseNode` (the first `Respond to Webhook` node; the request is held until it responds or the execution ends).
- Test webhooks: the editor's "Listen for test event" registers an in-memory (Redis in queue mode) listener for 2 minutes. The first call runs the workflow in manual mode and streams to the editor.
- **User-authored responses are sandboxed (security rule S8).** Every response from `/webhook*`, `/form*` and the chat pages carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` (no `allow-same-origin`) and `X-Content-Type-Options: nosniff`. A tenant can therefore never serve script that runs with the editor's origin, cookies or API access. Binary previews in the editor are served the same way.
- Error workflow: when `settings.errorWorkflow` is set and an execution fails (non-manual), the error workflow runs with `{ execution: { id, url, error, lastNodeExecuted, mode }, workflow: { id, name } }` through its Error Trigger node.

## 12. Outbound HTTP & SSRF

All node HTTP goes through `HttpClient`. Every TCP connection is resolved and checked: only public unicast addresses are allowed. Loopback, private, link-local (cloud metadata), CGNAT, ULA and IPv4-mapped variants are all blocked. `SSRF_PROTECTION=false` (single-tenant self-host only) and `SSRF_ALLOW` (hosts/CIDRs) adjust this. Responses are capped at 100 MB, and timeouts default to 300 s. Only `http`/`https` URLs are accepted.

## 13. Node SDK (contract in `packages/workflow/src/node-types.ts`)

- **Naming:** type ids are `core.<camel>` for core nodes, `app.<camel>` for integrations (`app.slack`) and `ai.<camel>` for AI nodes (`ai.agent`, `ai.lmChatOpenAi`). Credential type names are camelCase (`slackApi`, `googleOAuth2Api`).
- **Exports:** a package exports `nodes: NodeType[]` and `credentials: CredentialType[]`.
- **Implementations:**
  - Never mutate input items.
  - Set `pairedItem` on every output item.
  - On a per-item failure, check `ctx.continueOnFail()`. If true, push `{ json: { error: message }, error: { message }, pairedItem: { item: i } }` and continue; otherwise throw `NodeOperationError` with `{ itemIndex }`.
  - Wrap API failures in `NodeApiError` (the helpers do this).
  - Use `ctx.helpers.httpRequest` or `httpRequestWithAuthentication`. Never use global `fetch` or SDK clients that bypass the SSRF guard. Database nodes (Postgres/MySQL) must resolve the host and apply `isAddressAllowed` before connecting.
  - Read parameters with `ctx.getNodeParameter(name, itemIndex, fallback?)`. Expressions are resolved per item.
  - Binary data goes through `ctx.helpers.prepareBinaryData` / `getBinaryDataBuffer`.
- **Resource/operation pattern** for integrations: a `resource` options param, then `operation` per resource (`displayOptions.show`), with an `action` text on each operation option for the node creator.
- **Tests:** every node has Vitest tests using the engine harness (`packages/nodes-base/test/harness.ts`). HTTP is mocked with an undici `MockAgent` or an in-process HTTP server, plus SSRF policy overrides.

## 14. REST API (editor ↔ server)

Base `/rest`. Bodies are JSON. Success responses are `{ "data": ... }` (lists add `"nextCursor"`); errors are `{ "error": { "code": "...", "message": "...", "details"?: ... } }` with a matching HTTP status. Auth uses the session cookie. Lists use cursor pagination: `?limit=50&cursor=<opaque>`.

| Method & path                                                                                                       | Body / query                                                                                    | Returns                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/signup`                                                                                                 | `{email,password,name,workspaceName}`                                                           | `{user,tenant,role}` + cookie                                                                                      |
| `POST /auth/login`                                                                                                  | `{email,password}`                                                                              | `{user,tenant,role}` + cookie                                                                                      |
| `POST /auth/logout`                                                                                                 |                                                                                                 | `{ok:true}`                                                                                                        |
| `GET /auth/me`                                                                                                      |                                                                                                 | `{user,tenant,role,tenants:[{id,name,slug,role}]}`                                                                 |
| `POST /auth/switch-tenant`                                                                                          | `{tenantId}`                                                                                    | `{user,tenant,role}`                                                                                               |
| `GET /settings`                                                                                                     |                                                                                                 | `{brand:{name,logoUrl,primaryColor},baseUrl,webhookBaseUrl,timezone,limits,features}`                              |
| `GET /node-types`                                                                                                   |                                                                                                 | `NodeTypeDescription[]`                                                                                            |
| `GET /credential-types`                                                                                             |                                                                                                 | `CredentialTypeDescription[]`                                                                                      |
| `POST /node-types/options`                                                                                          | `{nodeType,method,kind:'loadOptions'\|'listSearch',node:WorkflowNode,filter?,paginationToken?}` | `NodePropertyOption[]` or `ListSearchResult`                                                                       |
| `GET /workflows`                                                                                                    | `?search&tagId&active&limit&cursor`                                                             | `WorkflowSummary[]` `{id,name,active,tags,updatedAt,createdAt,nodeTypes:string[]}`                                 |
| `POST /workflows`                                                                                                   | `{name,nodes,connections,settings?,pinData?,stickyNotes?,tagIds?}`                              | `WorkflowDTO`                                                                                                      |
| `GET /workflows/:id`                                                                                                |                                                                                                 | `WorkflowDTO` `{id,name,nodes,connections,settings,pinData,stickyNotes,active,versionId,tags,createdAt,updatedAt}` |
| `PATCH /workflows/:id`                                                                                              | partial `WorkflowDTO` + `versionId` (409 on mismatch)                                           | `WorkflowDTO` (new `versionId`)                                                                                    |
| `DELETE /workflows/:id`                                                                                             |                                                                                                 | `{ok:true}`                                                                                                        |
| `POST /workflows/:id/activate` / `deactivate`                                                                       |                                                                                                 | `WorkflowDTO`; 400 `{details:[{node,message}]}` on validation errors                                               |
| `POST /workflows/:id/run`                                                                                           | `{workflowData?,startNode?,destinationNode?,pinData?,triggerItems?}`                            | `{executionId}` (progress over SSE)                                                                                |
| `POST /workflows/:id/listen-test-webhook`                                                                           | `{nodeName}`                                                                                    | `{testUrl,expiresAt}`                                                                                              |
| `GET /workflows/:id/webhook-urls`                                                                                   |                                                                                                 | `[{nodeName,method,testUrl,productionUrl}]`                                                                        |
| `GET /workflows/:id/versions`                                                                                       |                                                                                                 | `[{versionId,authorName,message,createdAt}]`                                                                       |
| `GET /workflows/:id/versions/:versionId`                                                                            |                                                                                                 | snapshot                                                                                                           |
| `POST /workflows/:id/versions/:versionId/restore`                                                                   |                                                                                                 | `WorkflowDTO`                                                                                                      |
| `GET /executions`                                                                                                   | `?workflowId&status&limit&cursor`                                                               | `[{id,workflowId,workflowName,mode,status,startedAt,stoppedAt,durationMs,errorMessage,customData}]`                |
| `GET /executions/:id`                                                                                               |                                                                                                 | summary + `{workflowData, state: ExecutionState}`                                                                  |
| `POST /executions/:id/retry`                                                                                        | `{useCurrentWorkflow?:boolean}`                                                                 | `{executionId}`                                                                                                    |
| `POST /executions/:id/stop`                                                                                         |                                                                                                 | `{status}`                                                                                                         |
| `DELETE /executions/:id`                                                                                            |                                                                                                 | `{ok:true}`                                                                                                        |
| `GET /credentials`                                                                                                  | `?type`                                                                                         | `[{id,name,type,createdAt,updatedAt}]`                                                                             |
| `POST /credentials`                                                                                                 | `{name,type,data}`                                                                              | `{id,name,type}`                                                                                                   |
| `GET /credentials/:id`                                                                                              |                                                                                                 | `{id,name,type,data}` (secrets redacted)                                                                           |
| `PATCH /credentials/:id`                                                                                            | `{name?,data?}`                                                                                 | `{id,name,type}`                                                                                                   |
| `DELETE /credentials/:id`                                                                                           |                                                                                                 | `{ok:true}`                                                                                                        |
| `POST /credentials/test`                                                                                            | `{type,data,id?}`                                                                               | `{status:'OK'\|'Error',message}`                                                                                   |
| `GET /oauth2/authorize?credentialId=`                                                                               |                                                                                                 | `{url}`                                                                                                            |
| `GET /oauth2/callback?code&state`                                                                                   |                                                                                                 | HTML that posts a message to the opener and closes                                                                 |
| `GET/POST/PATCH/DELETE /tags[/:id]`                                                                                 | `{name}`                                                                                        | `Tag`                                                                                                              |
| `GET/POST/PATCH/DELETE /variables[/:id]`                                                                            | `{key,value}`                                                                                   | `Variable`                                                                                                         |
| `GET /members`, `POST /members/invite` `{email,role}`, `PATCH /members/:userId` `{role}`, `DELETE /members/:userId` |                                                                                                 |                                                                                                                    |
| `POST /invitations/:token/accept`                                                                                   | `{name,password}`                                                                               | `{user,tenant,role}` + cookie                                                                                      |
| `GET/POST/DELETE /api-keys[/:id]`                                                                                   | `{name}`                                                                                        | POST returns `{id,name,key}` once                                                                                  |
| `GET /push`                                                                                                         | SSE                                                                                             | events below                                                                                                       |

Push events are sent as `event: <type>` with `data: <json>`: `executionStarted {executionId,workflowId,mode}`, `nodeExecuteBefore {executionId,nodeName}`, `nodeExecuteAfter {executionId,nodeName,runIndex,taskData}`, `executionFinished {executionId,workflowId,status,error?}`, `consoleMessage {executionId,nodeName,args}`, `testWebhookReceived {workflowId,executionId}`, plus a `ping` every 25 s.

Public API `/api/v1` (`X-API-KEY`): `workflows` (list/get/create/update/delete/activate/deactivate), `executions` (list/get/delete/retry), `credentials` (create/delete, schema), `tags`, `variables`. It uses the same DTOs and an OpenAPI document at `/api/v1/openapi.json`.

## 15. Configuration (server env)

| Var                                                       | Default                 |                                                                   |
| --------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `PORT`                                                    | `5678`                  |                                                                   |
| `BASE_URL`                                                | `http://localhost:5678` | public URL; used for webhooks, OAuth callbacks, CSRF origin check |
| `DATABASE_URL`                                            | —                       | Postgres                                                          |
| `REDIS_URL`                                               | —                       | required when `EXECUTIONS_MODE=queue`                             |
| `EXECUTIONS_MODE`                                         | `regular`               | `regular` \| `queue`                                              |
| `ENCRYPTION_KEYS`                                         | —                       | `id:base64(32 bytes)[,id:...]`                                    |
| `BINARY_DATA_MODE`                                        | `filesystem`            | `inline` \| `filesystem` \| `s3`                                  |
| `BINARY_DATA_DIR`                                         | `./data/binary`         |                                                                   |
| `SSRF_PROTECTION` / `SSRF_ALLOW` / `SSRF_DENY`            | `true` / `/`            |                                                                   |
| `CODE_MEMORY_MB` / `CODE_TIMEOUT_MS`                      | `128` / `30000`         |                                                                   |
| `EXECUTION_TIMEOUT_DEFAULT_S` / `EXECUTION_TIMEOUT_MAX_S` | `300` / `3600`          |                                                                   |
| `EXECUTIONS_PRUNE_DAYS`                                   | `14`                    |                                                                   |
| `SIGNUP_ENABLED`                                          | `true`                  |                                                                   |
| `BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`     | `Workflow`              | white-label defaults; tenants can override                        |
| `LOG_LEVEL`                                               | `info`                  |                                                                   |
| `CORS_ORIGINS`                                            | ``                      | extra allowed origins                                             |

## 16. Observability

- Structured JSON logs (pino) with `tenantId`, `workflowId`, `executionId`, `node`.
- `GET /healthz` (liveness), `GET /healthz/readiness` (DB + Redis).
- `GET /metrics` (Prometheus): executions by status/mode, execution duration histogram, queue depth, active workflows, webhook latency.

## 17. Testing strategy

- Unit: interpreter security matrix, engine semantics, node behaviour with mocked HTTP.
- Integration: server against real Postgres and Redis (local services in CI), covering auth, tenant isolation, webhook flows, activation and queue mode.
- E2E: Playwright drives the editor to build, run and inspect a workflow.
