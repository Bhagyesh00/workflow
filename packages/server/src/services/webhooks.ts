/**
 * Incoming webhook calls (ARCHITECTURE.md §11): production `/webhook/<tenantSlug>/<path>`,
 * test `/webhook-test/<tenantSlug>/<path>` and resume `/webhook-waiting/<executionId>`.
 *
 * Response modes: `onReceived` (answer at once), `lastNode` (answer with the last node's data),
 * `responseNode` (hold the request until a Respond to Webhook node answers or the run ends).
 *
 * Platform extension: an `Idempotency-Key` header on production calls deduplicates deliveries
 * per workflow for 24 hours; repeats replay the first response without running the workflow again.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { createWebhookContext, getResolvedParameters, type NodeTypes } from '@workflow/core';
import {
  type DataObject,
  type ExecutionState,
  ExpressionEvaluator,
  type Item,
  isPlainObject,
  type WebhookRequest,
  type WebhookResponse,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { Config } from '../config';
import type { TenantRow } from '../db/schema';
import { ApiError, errorBody } from '../http/errors';
import type { PinoLogger } from '../logger';
import type { Repositories } from '../repositories';
import type { PushService } from './bus';
import type { ExecutionObserver, ExecutionOutcome, ExecutionService, StartedExecution } from './executions';
import type { Metrics } from './metrics';
import { findTestWebhook, type TestWebhookStore } from './test-webhooks';
import {
  evaluateDescriptionValue,
  matchDynamic,
  type NodeWebhook,
  nodeWebhooks,
  sortDynamic,
} from './webhook-paths';
import { toDefinition } from './workflow-model';

export interface WebhookReply {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  binary?: { data: Uint8Array; mimeType: string; fileName?: string };
  /** streaming response mode: NDJSON lines written while the workflow runs */
  stream?: Readable;
}

export interface IncomingWebhook {
  method: string;
  path: string;
  /** reads and parses the body; called only once the webhook is found, so unknown paths are never parsed */
  read(): Promise<WebhookRequest>;
}

/** an incoming webhook whose body has been read */
interface ReceivedWebhook {
  method: string;
  path: string;
  request: WebhookRequest;
}

const receive = async (incoming: IncomingWebhook): Promise<ReceivedWebhook> => ({
  method: incoming.method,
  path: incoming.path,
  request: await incoming.read(),
});

const IDEMPOTENCY_MAX_BINARY = 1024 * 1024;

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): WebhookReply => ({
  statusCode,
  headers,
  body,
});

const notRegistered = (method: string, path: string) =>
  json(404, errorBody('not_found', `The webhook "${method} ${path}" is not registered`));

export interface WebhookServiceDeps {
  config: Config;
  repos: Repositories;
  nodeTypes: NodeTypes;
  executions: ExecutionService;
  testWebhooks: TestWebhookStore;
  push: PushService;
  metrics: Metrics;
  logger: PinoLogger;
}

interface RunInput {
  tenant: TenantRow;
  definition: WorkflowDefinition;
  workflowId: string;
  node: WorkflowNode;
  hook: NodeWebhook;
  mode: 'webhook' | 'manual';
  incoming: ReceivedWebhook;
  params: Record<string, string>;
  userId?: string;
  onStarted?: (executionId: string) => void;
}

export class WebhookService {
  private readonly evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });

  constructor(private readonly deps: WebhookServiceDeps) {}

  // -------------------------------------------------------------------------------------------
  // production

  async handleProduction(tenantSlug: string, incoming: IncomingWebhook): Promise<WebhookReply> {
    const { repos } = this.deps;
    const tenant = await repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return notRegistered(incoming.method, incoming.path);
    const found = await this.findWebhook(tenant.id, incoming.method, incoming.path);
    if (!found) return notRegistered(incoming.method, incoming.path);
    const row = await repos.workflows.get(tenant.id, found.workflowId);
    if (!row?.active) return notRegistered(incoming.method, incoming.path);
    const definition = toDefinition(row);
    const node = definition.nodes.find((n) => n.name === found.nodeName);
    if (!node) return notRegistered(incoming.method, incoming.path);
    const hook = this.hookOf(definition, node, found.webhookName);
    if (!hook) return notRegistered(incoming.method, incoming.path);
    const received = await receive(incoming);

    const key = header(received.request.headers, 'idempotency-key');
    if (key) {
      if (key.length > 255)
        return json(400, errorBody('bad_request', 'The Idempotency-Key header is too long'));
      const claimed = await repos.idempotency.claim(tenant.id, row.id, key);
      if (!claimed) {
        const existing = await repos.idempotency.get(tenant.id, row.id, key);
        if (existing?.response) return replayStored(existing.response, existing.executionId);
        return json(
          409,
          errorBody('idempotency_in_progress', 'A request with this Idempotency-Key is in progress'),
        );
      }
      let executionId: string | null = null;
      try {
        const reply = await this.run({
          tenant,
          definition,
          workflowId: row.id,
          node,
          hook,
          mode: 'webhook',
          incoming: received,
          params: found.params,
          onStarted: (id) => {
            executionId = id;
          },
        });
        if (!executionId) await repos.idempotency.release(tenant.id, row.id, key);
        else await repos.idempotency.complete(tenant.id, row.id, key, executionId, storeReply(reply));
        return reply;
      } catch (error) {
        if (!executionId) await repos.idempotency.release(tenant.id, row.id, key);
        throw error;
      }
    }

    return this.run({
      tenant,
      definition,
      workflowId: row.id,
      node,
      hook,
      mode: 'webhook',
      incoming: received,
      params: found.params,
    });
  }

  /** CORS preflight for a registered webhook path */
  async handlePreflight(
    tenantSlug: string,
    path: string,
    origin: string | undefined,
    test = false,
  ): Promise<WebhookReply> {
    const tenant = await this.deps.repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return notRegistered('OPTIONS', path);
    let methods: string[];
    if (test) {
      methods = (await this.deps.testWebhooks.list(tenant.id))
        .filter((r) => r.path === path)
        .map((r) => r.method);
    } else {
      methods = await this.deps.repos.webhooks.methodsForPath(tenant.id, path);
    }
    if (!methods.length) return notRegistered('OPTIONS', path);
    return {
      statusCode: 204,
      headers: {
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-methods': [...new Set([...methods, 'OPTIONS'])].join(', '),
        'access-control-allow-headers': '*',
        'access-control-max-age': '300',
      },
    };
  }

  private async findWebhook(tenantId: string, method: string, path: string) {
    const { repos } = this.deps;
    const exact = await repos.webhooks.findStatic(tenantId, method, path);
    if (exact) return { ...exact, params: {} as Record<string, string> };
    const candidates = sortDynamic(
      await repos.webhooks.listDynamic(tenantId, method, path.split('/').length),
    );
    for (const candidate of candidates) {
      const params = matchDynamic(candidate.path, path);
      if (params) return { ...candidate, params };
    }
    return undefined;
  }

  private hookOf(
    definition: WorkflowDefinition,
    node: WorkflowNode,
    webhookName: string,
  ): NodeWebhook | undefined {
    const type = this.deps.nodeTypes.get(node.type);
    if (!type) return undefined;
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    return nodeWebhooks(workflow, node, type).find((h) => h.webhookName === webhookName);
  }

  // -------------------------------------------------------------------------------------------
  // test webhooks

  async handleTest(tenantSlug: string, incoming: IncomingWebhook): Promise<WebhookReply> {
    const { repos, testWebhooks, push } = this.deps;
    const tenant = await repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return notRegistered(incoming.method, incoming.path);
    const found = await findTestWebhook(testWebhooks, tenant.id, incoming.method, incoming.path);
    if (!found) {
      return json(
        404,
        errorBody(
          'not_found',
          `The test webhook "${incoming.method} ${incoming.path}" is not registered. Click "Listen for test event" in the editor first.`,
        ),
      );
    }
    // a body that cannot be read (too large, malformed) leaves the registration in place
    const received = await receive(incoming);
    // one-shot: the first call consumes the registration
    if (!(await testWebhooks.remove(found.registration)))
      return notRegistered(incoming.method, incoming.path);
    const { registration } = found;
    const definition = registration.workflow;
    const node = definition.nodes.find((n) => n.name === registration.nodeName);
    if (!node) return notRegistered(incoming.method, incoming.path);
    const type = this.deps.nodeTypes.get(node.type);
    const hook = type
      ? nodeWebhooks(new Workflow(definition, this.deps.nodeTypes), node, type).find(
          (h) => h.method === registration.method && h.path === registration.path,
        )
      : undefined;
    if (!hook) return notRegistered(incoming.method, incoming.path);
    return this.run({
      tenant,
      definition,
      workflowId: registration.workflowId,
      node,
      hook,
      mode: 'manual',
      incoming: received,
      params: found.params,
      userId: registration.userId,
      onStarted: (executionId) =>
        push.send(tenant.id, 'testWebhookReceived', { workflowId: registration.workflowId, executionId }),
    });
  }

  // -------------------------------------------------------------------------------------------
  // resume webhooks

  async handleWaiting(executionId: string, incoming: IncomingWebhook): Promise<WebhookReply> {
    const { repos, nodeTypes, executions } = this.deps;
    const tenantId = await repos.executions.findTenantOf(executionId);
    if (!tenantId) return json(404, errorBody('not_found', 'Execution not found'));
    // every query below is scoped to the execution's own tenant
    const row = await repos.executions.get(tenantId, executionId);
    const data = await repos.executions.getData(tenantId, executionId);
    const tenant = await repos.tenants.get(tenantId);
    if (!row || !data || !tenant) return json(404, errorBody('not_found', 'Execution not found'));
    if (row.status !== 'waiting') return json(409, errorBody('not_waiting', 'The execution is not waiting'));

    const definition = data.workflowData as unknown as WorkflowDefinition;
    const state = data.state as unknown as ExecutionState | null;
    const nodeName = state?.resultData.lastNodeExecuted;
    const node = definition.nodes.find((n) => n.name === nodeName);
    const type = node ? nodeTypes.get(node.type) : undefined;
    const workflow = new Workflow(definition, nodeTypes);
    const hook = node && type ? nodeWebhooks(workflow, node, type, { restart: true })[0] : undefined;
    if (hook && hook.method !== incoming.method) {
      return json(404, errorBody('not_found', `This execution resumes on ${hook.method} requests`));
    }
    const { request } = await receive(incoming);

    let output: Item[][];
    if (node && type?.webhook && hook) {
      const services = await executions.buildServices({
        tenant,
        executionId,
        mode: row.mode as never,
        workflowId: row.workflowId ?? undefined,
      });
      const ctx = createWebhookContext(
        { workflow, node, services, evaluator: this.evaluator, signal: AbortSignal.timeout(60_000) },
        request,
        hook.webhookName,
      );
      const result = await type.webhook(ctx);
      if (!result.workflowData) return fromWebhookResponse(result.webhookResponse ?? { statusCode: 200 });
      output = result.workflowData;
    } else {
      const body = request.body;
      output = [[{ json: isPlainObject(body) ? body : body === undefined || body === '' ? {} : { body } }]];
    }

    const responseMode =
      hook?.responseMode === 'streaming' ? 'lastNode' : (hook?.responseMode ?? 'onReceived');
    const handle = this.responseHandle(responseMode);
    const resumed = await executions.resume(tenantId, executionId, output, {
      wait: responseMode !== 'onReceived',
      observer: responseMode === 'onReceived' ? undefined : handle.observer,
    });
    if (!resumed) return json(409, errorBody('not_waiting', 'The execution is not waiting'));
    if (responseMode === 'onReceived') return json(200, { message: 'Workflow was resumed' });
    return this.awaitResponse(tenant, workflow, node!, hook!, resumed, handle);
  }

  // -------------------------------------------------------------------------------------------
  // shared run logic

  private async run(input: RunInput): Promise<WebhookReply> {
    const { executions, metrics, logger } = this.deps;
    const started = Date.now();
    const { tenant, definition, node, hook, incoming } = input;
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const type = workflow.getNodeType(node);
    const executionId = randomUUID();
    const request: WebhookRequest = { ...incoming.request, params: { ...input.params } };

    let reply: WebhookReply;
    let executionStarted = false;
    try {
      const services = await executions.buildServices({
        tenant,
        executionId,
        mode: input.mode,
        workflowId: input.workflowId,
      });
      const ctx = createWebhookContext(
        { workflow, node, services, evaluator: this.evaluator, signal: AbortSignal.timeout(60_000) },
        request,
        hook.webhookName,
      );
      const result = type.webhook
        ? await type.webhook(ctx)
        : {
            workflowData: [
              [
                {
                  json: {
                    headers: request.headers,
                    params: request.params,
                    query: request.query,
                    body: request.body ?? {},
                  } as DataObject,
                },
              ],
            ],
          };

      if (!result.workflowData) {
        reply = fromWebhookResponse(result.webhookResponse ?? { statusCode: 200, body: {} });
      } else {
        const streaming = hook.responseMode === 'streaming' ? this.streamHandle() : undefined;
        const handle = this.responseHandle(hook.responseMode);
        let execution: StartedExecution;
        try {
          execution = await executions.start({
            tenantId: tenant.id,
            workflow: definition,
            workflowId: input.workflowId,
            mode: input.mode,
            startNode: node.name,
            triggerItems: JSON.parse(JSON.stringify(result.workflowData[0] ?? [])),
            executionId,
            userId: input.userId,
            // test runs use pinned data like other manual runs (the webhook's own output excluded)
            pinData: input.mode === 'manual' ? manualPinData(definition, node.name) : undefined,
            wait: hook.responseMode !== 'onReceived',
            observer:
              streaming?.observer ?? (hook.responseMode === 'onReceived' ? undefined : handle.observer),
          });
        } catch (error) {
          if (error instanceof ApiError) {
            reply = json(error.statusCode, errorBody(error.code, error.message));
            return this.decorate(reply, workflow, node, incoming);
          }
          throw error;
        }
        executionStarted = true;
        input.onStarted?.(execution.executionId);
        if (streaming) {
          reply = streaming.attach(execution);
        } else if (hook.responseMode === 'onReceived') {
          reply = result.webhookResponse
            ? fromWebhookResponse(result.webhookResponse)
            : json(this.responseCode(workflow, node), { message: 'Workflow was started' });
        } else {
          reply = await this.awaitResponse(tenant, workflow, node, hook, execution, handle);
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, tenantId: tenant.id, workflowId: input.workflowId, node: node.name },
        'Webhook failed',
      );
      // details help while testing in the editor; production callers get a generic message
      const message =
        input.mode === 'manual'
          ? (error as Error).message || 'The webhook failed'
          : 'The webhook could not be processed';
      reply = json(500, errorBody('webhook_error', message));
    } finally {
      // uploads the node stored for an execution that never started belong to no row and would never be pruned
      if (!executionStarted) await executions.removeBinaryData(tenant.id, executionId);
    }
    metrics.webhookDuration.observe({ status: String(reply.statusCode) }, (Date.now() - started) / 1000);
    return this.decorate(reply, workflow, node, incoming);
  }

  /**
   * Streaming mode: every `ctx.sendChunk(x)` becomes a line `{"type":"item","content":x}`; the
   * stream ends with `{"type":"end"}` (or `{"type":"error","message":...}`).
   */
  private streamHandle() {
    const stream = new PassThrough();
    const write = (line: unknown) => {
      if (!stream.writableEnded) stream.write(`${JSON.stringify(line)}\n`);
    };
    const observer: ExecutionObserver = { onChunk: (content) => write({ type: 'item', content }) };
    const attach = (execution: StartedExecution): WebhookReply => {
      const limitMs = (this.deps.config.executionTimeout.maxS + 30) * 1000;
      const timer = setTimeout(() => {
        this.deps.executions.discardWaiter(execution.executionId);
        write({ type: 'error', message: 'The workflow did not finish in time' });
        stream.end();
      }, limitMs);
      timer.unref();
      void execution.finished?.then((outcome) => {
        clearTimeout(timer);
        if (outcome.status === 'success' || outcome.status === 'waiting') write({ type: 'end' });
        else write({ type: 'error', message: 'Error in workflow' });
        stream.end();
      });
      return {
        statusCode: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        },
        stream,
      };
    };
    return { observer, attach };
  }

  private responseHandle(mode: string) {
    let respond!: (response: WebhookResponse) => void;
    const response = new Promise<WebhookResponse>((resolve) => {
      respond = resolve;
    });
    let answered = false;
    const observer: ExecutionObserver = {
      onResponse: (r) => {
        if (mode !== 'responseNode' || answered) return;
        answered = true;
        respond(r);
      },
    };
    return { observer, response };
  }

  private async awaitResponse(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    hook: NodeWebhook,
    execution: StartedExecution,
    handle: { response: Promise<WebhookResponse> },
  ): Promise<WebhookReply> {
    // a held request never outlives the longest possible execution (e.g. a worker crashed)
    const limitMs = (this.deps.config.executionTimeout.maxS + 30) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limitMs);
      timer.unref();
    });
    try {
      const result = await Promise.race([
        this.awaitOutcome(tenant, workflow, node, hook, execution, handle),
        timeout,
      ]);
      if (result !== 'timeout') return result;
      this.deps.executions.discardWaiter(execution.executionId);
      return json(504, errorBody('timeout', 'The workflow did not respond in time'));
    } finally {
      clearTimeout(timer);
    }
  }

  private async awaitOutcome(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    hook: NodeWebhook,
    execution: StartedExecution,
    handle: { response: Promise<WebhookResponse> },
  ): Promise<WebhookReply> {
    const finished = execution.finished!;
    if (hook.responseMode === 'responseNode') {
      const first = await Promise.race([
        handle.response.then((r) => ({ kind: 'response' as const, r })),
        finished.then((o) => ({ kind: 'finished' as const, o })),
      ]);
      if (first.kind === 'response') return fromWebhookResponse(first.r);
      // the Respond to Webhook node may have answered just before the run ended
      const late = await Promise.race([
        handle.response,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 0)),
      ]);
      if (late) return fromWebhookResponse(late);
      return this.finishedWithoutResponse(first.o);
    }
    return this.lastNodeReply(tenant, workflow, node, hook, await finished);
  }

  private finishedWithoutResponse(outcome: ExecutionOutcome): WebhookReply {
    if (outcome.status === 'waiting')
      return json(202, { message: 'Workflow is waiting', executionId: outcome.executionId });
    if (outcome.status !== 'success') return json(500, errorBody('workflow_error', 'Error in workflow'));
    return json(200, { message: 'Workflow finished without a response' });
  }

  private async lastNodeReply(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    hook: NodeWebhook,
    outcome: ExecutionOutcome,
  ): Promise<WebhookReply> {
    if (outcome.status === 'waiting')
      return json(202, { message: 'Workflow is waiting', executionId: outcome.executionId });
    if (outcome.status !== 'success') return json(500, errorBody('workflow_error', 'Error in workflow'));
    const statusCode = this.responseCode(workflow, node);
    const items = (outcome.lastNodeOutput ?? []).find((o) => o?.length) ?? [];
    switch (hook.responseData) {
      case 'allEntries':
        return json(
          statusCode,
          items.map((i) => i.json),
        );
      case 'noData':
        return { statusCode, headers: {} };
      case 'firstEntryBinary': {
        const parameters = getResolvedParameters(workflow, node) as DataObject;
        const property = String(parameters.responseBinaryPropertyName ?? 'data');
        const binary = items[0]?.binary?.[property];
        if (!binary)
          return json(500, errorBody('no_binary_data', `No binary data property "${property}" was found`));
        const data = await this.deps.executions.binaryStore(tenant.id).getBuffer(binary);
        return {
          statusCode,
          headers: {},
          binary: { data, mimeType: binary.mimeType, fileName: binary.fileName },
        };
      }
      default: {
        if (!items.length) return json(500, errorBody('no_data', 'No item to return was found'));
        return json(statusCode, items[0].json);
      }
    }
  }

  private responseCode(workflow: Workflow, node: WorkflowNode): number {
    const parameters = getResolvedParameters(workflow, node) as DataObject;
    const code = Number(evaluateDescriptionValue(String(parameters.responseCode ?? 200), parameters));
    return Number.isInteger(code) && code >= 100 && code <= 599 ? code : 200;
  }

  /** response headers and CORS from the node's options */
  private decorate(reply: WebhookReply, workflow: Workflow, node: WorkflowNode, incoming: ReceivedWebhook) {
    const parameters = getResolvedParameters(workflow, node) as DataObject;
    const options = (parameters.options ?? {}) as DataObject;
    const headers = { ...reply.headers };
    if (options.responseHeaders && reply.statusCode < 400) {
      try {
        const extra =
          typeof options.responseHeaders === 'string'
            ? (JSON.parse(options.responseHeaders) as DataObject)
            : (options.responseHeaders as DataObject);
        for (const [k, v] of Object.entries(extra ?? {})) headers[k.toLowerCase()] ??= String(v);
      } catch {
        /* invalid JSON in the node option: ignore */
      }
    }
    const origin = header(incoming.request.headers, 'origin');
    if (origin) {
      const allowed = String(options.allowedOrigins ?? '*')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.includes('*')) headers['access-control-allow-origin'] ??= '*';
      else if (allowed.includes(origin)) {
        headers['access-control-allow-origin'] ??= origin;
        headers.vary = 'Origin';
      }
    }
    return { ...reply, headers };
  }
}

// ---------------------------------------------------------------------------------------------

function manualPinData(definition: WorkflowDefinition, startNode: string) {
  const entries = Object.entries(definition.pinData ?? {}).filter(([name]) => name !== startNode);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function fromWebhookResponse(response: WebhookResponse): WebhookReply {
  const headers = Object.fromEntries(
    Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  const statusCode =
    Number.isInteger(response.statusCode) && response.statusCode! >= 100 && response.statusCode! <= 599
      ? response.statusCode!
      : 200;
  if (response.binary) {
    return {
      statusCode,
      headers,
      binary: {
        data: response.binary.data,
        mimeType: response.binary.mimeType,
        fileName: response.binary.fileName,
      },
    };
  }
  return { statusCode, headers, body: response.body };
}

function storeReply(reply: WebhookReply): Record<string, unknown> {
  const stored: Record<string, unknown> = { statusCode: reply.statusCode, headers: reply.headers };
  if (reply.stream) {
    // a stream cannot be replayed: repeats get the status only
    stored.body = null;
    stored.headers = { 'content-type': 'application/json; charset=utf-8' };
  } else if (reply.binary) {
    if (reply.binary.data.byteLength <= IDEMPOTENCY_MAX_BINARY) {
      stored.binary = { ...reply.binary, data: Buffer.from(reply.binary.data).toString('base64') };
    }
  } else stored.body = reply.body ?? null;
  return stored;
}

function replayStored(stored: Record<string, unknown>, executionId: string | null): WebhookReply {
  const headers: Record<string, string> = {
    ...((stored.headers as Record<string, string>) ?? {}),
    'idempotency-replayed': 'true',
  };
  if (executionId) headers['x-execution-id'] = executionId;
  const binary = stored.binary as { data: string; mimeType: string; fileName?: string } | undefined;
  if (binary) {
    return {
      statusCode: Number(stored.statusCode ?? 200),
      headers,
      binary: { ...binary, data: Buffer.from(binary.data, 'base64') },
    };
  }
  return { statusCode: Number(stored.statusCode ?? 200), headers, body: stored.body ?? undefined };
}
