/**
 * Incoming webhook calls (ARCHITECTURE.md §11): production `/webhook/<tenantSlug>/<path>`,
 * test `/webhook-test/<tenantSlug>/<path>` and resume `/webhook-waiting/<executionId>/<signature>`.
 * Forms use the same handlers at `/form/...`, `/form-test/...` and `/form-waiting/...` (`kind: 'form'`).
 *
 * Multi-page forms: a submission with a form page after it answers `{ formWaitingUrl }` or
 * `{ redirectURL }`; the page polls `<formWaitingUrl>/n8n-execution-status` and goes on by itself.
 *
 * Response modes: `onReceived` (answer at once), `lastNode` (answer with the last node's data),
 * `responseNode` (hold the request until a Respond to Webhook node answers or the run ends).
 *
 * Platform extension: an `Idempotency-Key` header on production calls deduplicates deliveries
 * per workflow for 24 hours; repeats replay the first response without running the workflow again.
 *
 * CORS: every reply produced once the node is known (results, errors, unreadable bodies, the
 * OPTIONS preflight) carries `Access-Control-Allow-Origin` when the caller's Origin is in the
 * node's `allowedOrigins` option (trailing slashes and case ignored; an expression is evaluated the
 * way the node evaluates it).
 */
import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import {
  createWebhookContext,
  type ExecutionServices,
  getResolvedParameters,
  type NodeTypes,
  reviewNodeKey,
} from '@workflow/core';
import {
  type DataObject,
  type ExecutionMode,
  type ExecutionState,
  ExpressionEvaluator,
  type FormAuthHelper,
  type Item,
  isExpression,
  isHitlVariant,
  isPlainObject,
  type NodeType,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookResponseData,
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
import { loadPublishedDefinition } from './published-workflow';
import { findTestWebhook, type TestWebhookStore } from './test-webhooks';
import {
  evaluateDescriptionValue,
  matchDynamic,
  type NodeWebhook,
  nodeWebhooks,
  sortDynamic,
  webhookUrlBase,
} from './webhook-paths';

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
  /** request headers, available before the body is read */
  headers: WebhookRequest['headers'];
  /**
   * reads and parses the body; called only once the webhook is found, so unknown paths are never
   * parsed. A body that cannot be read rejects with a `WebhookBodyError`.
   */
  read(): Promise<WebhookRequest>;
}

/** the request body is malformed (400) or too large (413) */
export class WebhookBodyError extends Error {
  constructor(
    readonly statusCode: 400 | 413,
    readonly code: 'bad_request' | 'payload_too_large',
    message: string,
  ) {
    super(message);
  }
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

/** which URL family a request came in on: `/webhook*` or `/form*` */
export type WebhookKind = 'webhook' | 'form';

const FORM_TOO_LARGE =
  'The files you are trying to upload are too large. Please reduce the total size and try again.';
const FORM_NOT_LISTENING = {
  title: "Form Trigger isn't listening yet",
  message: 'Click the "Listen for test event" button in your Form Trigger',
};
const FORM_NOT_FOUND = {
  title: 'Problem loading form',
  message: 'This usually occurs if the workflow serving this form is deactivated or no longer exists',
};
const FORM_INVALID = { title: 'Problem loading form', message: 'This form link is not valid' };
const FORM_BUSY = {
  title: 'Problem loading form',
  message: 'The workflow is still working on this form. Try again in a moment.',
};
const FORM_STOPPED = {
  title: 'Problem loading form',
  message: 'The workflow stopped before this form was finished',
};
const FORM_FINISHED = { title: 'Form Submitted', message: 'Your response has been recorded' };
/** after the signed part of a `/form-waiting` URL: how far the run is */
const FORM_STATUS_SUFFIX = 'n8n-execution-status';
/** the run has persisted its wait well before this; a lost worker must not hold the page */
const FORM_PAGE_READY_MS = 10_000;
const WAITING_MESSAGE = 'Workflow is waiting';
/** the link of a Send and Wait node ends in this (nodes-base send-and-wait/descriptions.ts) */
const ANSWER_SUFFIX = 'answer';
const ANSWER_CLOSED = {
  title: 'Nothing more to do',
  message: 'This request was already answered, or it has closed.',
};

/** a node that shows a form page while the run waits at it */
const isFormPage = (node: WorkflowNode | undefined): boolean => {
  if (!node || node.disabled) return false;
  return node.type === 'core.form' || (node.type === 'core.wait' && node.parameters.resume === 'form');
};

const formPageFollows = (workflow: Workflow, node: WorkflowNode): boolean =>
  workflow.getChildNodes(node.name).some((name) => isFormPage(workflow.getNode(name)));

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * A later form page asks for the login of its Form Trigger: its webhook context reads that
 * credential as its own. A credential of its own (Wait) stays.
 */
function withTriggerLogin(workflow: Workflow, node: WorkflowNode): WorkflowNode {
  if (node.credentials?.httpBasicAuth) return node;
  const trigger = workflow
    .getParentNodes(node.name)
    .map((name) => workflow.getNode(name))
    .find((parent) => parent?.type === 'core.formTrigger');
  const login = trigger?.credentials?.httpBasicAuth;
  return login ? { ...node, credentials: { ...node.credentials, httpBasicAuth: login } } : node;
}

/** the headers of a preflight answer; requested headers are listed by name, `*` never covers `Authorization` */
function preflightHeaders(methods: string[], requestHeaders: WebhookRequest['headers']) {
  const reply: Record<string, string> = {
    'access-control-allow-methods': [...new Set([...methods, 'OPTIONS'])].join(', '),
    'access-control-max-age': '300',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
  const requested = headerNames(header(requestHeaders, 'access-control-request-headers'));
  if (requested.length) reply['access-control-allow-headers'] = requested.join(', ');
  return reply;
}

/** fixed texts only: nothing of the request or a workflow goes in this page */
const formErrorPage = (statusCode: number, page: { title: string; message: string }): WebhookReply => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Form</title><style>body{margin:0;padding:32px 16px;background:#f5f5f7;color:#1f1f24;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:520px;margin:0 auto;padding:24px;background:#fff;border:1px solid #e3e3e8;border-radius:10px}h1{margin:0 0 8px;font-size:22px}p{margin:0;color:#55555f}</style></head><body><main><h1>${escapeFixedText(page.title)}</h1><p>${escapeFixedText(page.message)}</p></main></body></html>`,
});

const escapeFixedText = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** a browser opening a form URL gets a page; any other caller keeps the JSON */
function formErrorFor(
  kind: WebhookKind,
  headers: WebhookRequest['headers'],
  reply: WebhookReply,
  page: { title: string; message: string },
): WebhookReply {
  if (kind !== 'form' || !header(headers, 'accept')?.includes('text/html')) return reply;
  return formErrorPage(reply.statusCode, page);
}

/**
 * The node as the run's links know it. At a human review the key holds the wait (`reviewNodeKey`), so the link of
 * an answered review does not answer the next one on the same node.
 */
function asLinkedNode(
  node: WorkflowNode | undefined,
  type: NodeType | undefined,
  state: ExecutionState | null,
): WorkflowNode | undefined {
  const suspended = state?.executionData.suspended;
  if (!node || !type || suspended?.toolNode !== node.name || !isHitlVariant(type.description)) return node;
  return { ...node, webhookId: reviewNodeKey(node, suspended.toolRunIndex) };
}

/** a browser on the link of a Send and Wait node the run no longer stands at gets a page, not JSON */
function closedAnswerPage(
  kind: WebhookKind,
  incoming: IncomingWebhook,
  workflow: Workflow,
  path: string,
): WebhookReply | undefined {
  if (kind !== 'webhook' || incoming.method !== 'GET') return undefined;
  if (!header(incoming.headers, 'accept')?.includes('text/html')) return undefined;
  const [nodeKey, suffix, ...more] = path.split('/');
  if (suffix !== ANSWER_SUFFIX || more.length) return undefined;
  const node = workflow.definition.nodes.find((n) => {
    const key = n.webhookId || n.id;
    return nodeKey === key || nodeKey?.startsWith(`${key}-`);
  });
  // read with defaults: on a human review node the operation is a hidden default
  return node && getResolvedParameters(workflow, node).operation === 'sendAndWait'
    ? formErrorPage(409, ANSWER_CLOSED)
    : undefined;
}

export interface WebhookServiceDeps {
  config: Config;
  repos: Repositories;
  nodeTypes: NodeTypes;
  executions: ExecutionService;
  testWebhooks: TestWebhookStore;
  push: PushService;
  metrics: Metrics;
  logger: PinoLogger;
  formTokens: NonNullable<ExecutionServices['formTokens']>;
  formAuth: FormAuthHelper;
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
  /** takes the test registration once the node accepted the request; a reply means another request took it */
  claim?: () => Promise<WebhookReply | undefined>;
}

/** the node whose `allowedOrigins` option grants CORS, and the run settings its expressions resolve with */
interface CorsSource {
  tenant: TenantRow;
  mode: ExecutionMode;
  workflowId?: string;
  workflow: Workflow;
  node: WorkflowNode;
}

export class WebhookService {
  private readonly evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });

  constructor(private readonly deps: WebhookServiceDeps) {}

  // -------------------------------------------------------------------------------------------
  // production

  async handleProduction(
    tenantSlug: string,
    incoming: IncomingWebhook,
    kind: WebhookKind = 'webhook',
  ): Promise<WebhookReply> {
    const { repos } = this.deps;
    const missing = () =>
      formErrorFor(kind, incoming.headers, notRegistered(incoming.method, incoming.path), FORM_NOT_FOUND);
    const tenant = await repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return missing();
    const found = await this.findWebhook(tenant.id, incoming.method, incoming.path);
    if (!found) return missing();
    const row = await repos.workflows.get(tenant.id, found.workflowId);
    if (!row?.active) return missing();
    // production serves the published version (P3-10), never the saved draft
    const definition = await loadPublishedDefinition(repos, tenant.id, row);
    if (!definition) return missing();
    const node = definition.nodes.find((n) => n.name === found.nodeName);
    if (!node) return missing();
    const hook = this.hookOf(definition, node, found.webhookName);
    // /form serves only form hooks, /webhook none
    if (!hook || webhookUrlBase(hook.description) !== kind) return missing();
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const source: CorsSource = { tenant, mode: 'webhook', workflowId: row.id, workflow, node };
    const cors = (reply: WebhookReply) => this.decorate(reply, source, incoming.headers);
    let received: ReceivedWebhook;
    try {
      received = await receive(incoming);
    } catch (error) {
      return cors(bodyErrorReply(error, kind));
    }

    const key = header(received.request.headers, 'idempotency-key');
    if (key) {
      if (key.length > 255)
        return cors(json(400, errorBody('bad_request', 'The Idempotency-Key header is too long')));
      const claimed = await repos.idempotency.claim(tenant.id, row.id, key);
      if (!claimed) {
        const existing = await repos.idempotency.get(tenant.id, row.id, key);
        if (existing?.response) return cors(replayStored(existing.response, existing.executionId));
        return cors(
          json(
            409,
            errorBody('idempotency_in_progress', 'A request with this Idempotency-Key is in progress'),
          ),
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

  /**
   * CORS preflight for a registered webhook path. The origin is checked against the
   * `allowedOrigins` option of the node registered for the requested method; requested headers are
   * listed by name, since `*` never covers `Authorization`.
   */
  async handlePreflight(
    tenantSlug: string,
    path: string,
    headers: WebhookRequest['headers'],
    test = false,
  ): Promise<WebhookReply> {
    const { repos, testWebhooks, nodeTypes } = this.deps;
    const tenant = await repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return notRegistered('OPTIONS', path);
    const requested = header(headers, 'access-control-request-method')?.toUpperCase();
    let methods: string[];
    let target: { definition: WorkflowDefinition; nodeName: string; workflowId: string } | undefined;
    if (test) {
      const registrations = (await testWebhooks.list(tenant.id)).filter((r) => r.path === path);
      methods = registrations.map((r) => r.method);
      const registration = registrations.find((r) => r.method === requested) ?? registrations[0];
      if (registration) {
        target = {
          definition: registration.workflow,
          nodeName: registration.nodeName,
          workflowId: registration.workflowId,
        };
      }
    } else {
      methods = await repos.webhooks.methodsForPath(tenant.id, path);
      const method = requested && methods.includes(requested) ? requested : methods[0];
      const found = method ? await this.findWebhook(tenant.id, method, path) : undefined;
      const row = found ? await repos.workflows.get(tenant.id, found.workflowId) : undefined;
      const definition = row?.active ? await loadPublishedDefinition(repos, tenant.id, row) : null;
      if (found && row && definition) target = { definition, nodeName: found.nodeName, workflowId: row.id };
    }
    if (!methods.length) return notRegistered('OPTIONS', path);
    const reply = preflightHeaders(methods, headers);
    const nodeName = target?.nodeName;
    const node = target?.definition.nodes.find((n) => n.name === nodeName);
    if (!target || !node) return { statusCode: 204, headers: reply };
    const allowedOrigins = await this.allowedOrigins({
      tenant,
      mode: test ? 'manual' : 'webhook',
      workflowId: target.workflowId,
      workflow: new Workflow(target.definition, nodeTypes),
      node,
    });
    return { statusCode: 204, headers: withCors(reply, allowedOrigins, headers) };
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

  async handleTest(
    tenantSlug: string,
    incoming: IncomingWebhook,
    kind: WebhookKind = 'webhook',
  ): Promise<WebhookReply> {
    const { repos, testWebhooks, push } = this.deps;
    const notListening = () =>
      formErrorFor(
        kind,
        incoming.headers,
        json(
          404,
          errorBody(
            'not_found',
            `The test webhook "${incoming.method} ${incoming.path}" is not registered. Click "Listen for test event" in the editor first.`,
          ),
        ),
        FORM_NOT_LISTENING,
      );
    const missing = () =>
      formErrorFor(kind, incoming.headers, notRegistered(incoming.method, incoming.path), FORM_NOT_LISTENING);
    const tenant = await repos.tenants.getBySlug(tenantSlug);
    if (!tenant) return missing();
    const found = await findTestWebhook(testWebhooks, tenant.id, incoming.method, incoming.path);
    if (!found) return notListening();
    const { registration } = found;
    const definition = registration.workflow;
    const node = definition.nodes.find((n) => n.name === registration.nodeName);
    if (!node) return missing();
    const type = this.deps.nodeTypes.get(node.type);
    const hook = type
      ? nodeWebhooks(new Workflow(definition, this.deps.nodeTypes), node, type).find(
          (h) => h.method === registration.method && h.path === registration.path,
        )
      : undefined;
    // /form-test serves only form hooks, /webhook-test none
    if (!hook || webhookUrlBase(hook.description) !== kind) return missing();
    // a body that cannot be read (too large, malformed) leaves the registration in place
    let received: ReceivedWebhook;
    try {
      received = await receive(incoming);
    } catch (error) {
      const workflow = new Workflow(definition, this.deps.nodeTypes);
      const source: CorsSource = {
        tenant,
        mode: 'manual',
        workflowId: registration.workflowId,
        workflow,
        node,
      };
      return this.decorate(bodyErrorReply(error, kind), source, incoming.headers);
    }
    // one-shot: the first call consumes the registration. A form uses it up only with an accepted
    // submission, and then for both of its hooks: its page and a refused POST leave it listening.
    if (kind !== 'form' && !(await testWebhooks.remove(registration))) return missing();
    const claim = async () => {
      if (!(await testWebhooks.remove(registration))) return missing();
      await testWebhooks.removeForNode(tenant.id, registration.workflowId, registration.nodeName);
      return undefined;
    };
    return this.run({
      claim: kind === 'form' ? claim : undefined,
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

  async handleWaiting(
    executionId: string,
    incoming: IncomingWebhook,
    kind: WebhookKind = 'webhook',
  ): Promise<WebhookReply> {
    const { repos, nodeTypes, executions, logger } = this.deps;
    const notFound = (message: string) =>
      formErrorFor(kind, incoming.headers, json(404, errorBody('not_found', message)), FORM_INVALID);
    // `<signature>[/<suffix>]`: an unsigned or forged URL is answered like an unknown execution
    const [signature = '', ...rest] = incoming.path.split('/');
    if (!executions.verifyResumeSignature(executionId, signature, kind)) {
      return notFound('Execution not found');
    }
    const path = rest.join('/');
    const tenantId = await repos.executions.findTenantOf(executionId);
    if (!tenantId) return notFound('Execution not found');
    // every query below is scoped to the execution's own tenant
    const row = await repos.executions.get(tenantId, executionId);
    const data = await repos.executions.getData(tenantId, executionId);
    const tenant = await repos.tenants.get(tenantId);
    if (!row || !data || !tenant) return notFound('Execution not found');

    const definition = data.workflowData as unknown as WorkflowDefinition;
    const state = data.state as unknown as ExecutionState | null;
    const nodeName = state?.resultData.lastNodeExecuted;
    const stored = definition.nodes.find((n) => n.name === nodeName);
    const type = stored ? nodeTypes.get(stored.type) : undefined;
    const node = asLinkedNode(stored, type, state);

    if (kind === 'form' && path === FORM_STATUS_SUFFIX) {
      const word = row.status === 'waiting' && isFormPage(node) ? 'form-waiting' : row.status;
      // the page runs in the sandbox, with an opaque origin; the signature is what guards this
      const headers = withCors(
        { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        '*',
        incoming.headers,
      );
      return { statusCode: 200, headers, body: word };
    }
    const workflow = new Workflow(definition, nodeTypes);
    const closedPage = () => closedAnswerPage(kind, incoming, workflow, path);
    if (row.status !== 'waiting') return closedPage() ?? this.notWaitingReply(kind, incoming, row.status);

    const hooks = node && type ? nodeWebhooks(workflow, node, type, { restart: true }) : [];
    // a Wait has hooks of both families and serves the one its Resume parameter picks
    const family: WebhookKind | undefined =
      node?.type === 'core.wait'
        ? isFormPage(node)
          ? 'form'
          : 'webhook'
        : hooks[0] && webhookUrlBase(hooks[0].description);
    if (kind === 'form' ? family !== 'form' : family === 'form') {
      return notFound('This execution does not resume on this path');
    }
    const own = hooks.filter((h) => webhookUrlBase(h.description) === kind);
    const hook = own.find((h) => h.method === incoming.method) ?? own[0];
    const source: CorsSource | undefined = node
      ? { tenant, mode: row.mode as ExecutionMode, workflowId: row.workflowId ?? undefined, workflow, node }
      : undefined;
    const cors = async (reply: WebhookReply) =>
      source ? this.decorate(reply, source, incoming.headers) : reply;

    if (hook && incoming.method === 'OPTIONS') {
      const methods = own.map((h) => h.method);
      return cors({ statusCode: 204, headers: preflightHeaders(methods, incoming.headers) });
    }
    if (hook && hook.method !== incoming.method) {
      return cors(json(404, errorBody('not_found', `This execution resumes on ${hook.method} requests`)));
    }
    // a hook without its own path falls back to the node id; the resume URL then has no suffix
    const suffix = hook && hook.path !== (node?.webhookId || node?.id) ? hook.path : '';
    // the page that follows another goes to the bare form URL, whatever suffix its Wait has
    if (hook && path !== suffix && !(kind === 'form' && !path)) {
      return cors(
        closedPage() ?? json(404, errorBody('not_found', 'This execution does not resume on this path')),
      );
    }
    let request: WebhookRequest;
    try {
      ({ request } = await receive(incoming));
    } catch (error) {
      return cors(bodyErrorReply(error, kind));
    }

    let output: Item[][];
    let answer: WebhookResponse | undefined;
    if (node && type?.webhook && hook) {
      const services = await this.contextServices({
        tenant,
        executionId,
        mode: row.mode as never,
        workflowId: row.workflowId ?? undefined,
      });
      // the context sees what the node saw when it stopped: a page can read earlier nodes and its input
      const runs = state?.resultData.runData[node.name];
      const task = runs?.[runs.length - 1];
      // a tool that waits has no input of its own: it sees what its agent saw
      const suspended = state?.executionData.suspended;
      const ctx = createWebhookContext(
        {
          workflow,
          node: kind === 'form' ? withTriggerLogin(workflow, node) : node,
          services,
          evaluator: this.evaluator,
          signal: AbortSignal.timeout(60_000),
          state: state ?? undefined,
          runIndex: runs ? runs.length - 1 : undefined,
          executeData: suspended
            ? { node: node.name, data: suspended.exec.data, source: suspended.exec.source }
            : task
              ? {
                  node: node.name,
                  data: { main: [task.data?.main?.[0] ?? []] },
                  source: { main: task.source ?? [] },
                }
              : undefined,
        },
        request,
        hook.webhookName,
      );
      let result: WebhookResponseData;
      try {
        result = await type.webhook(ctx);
      } catch (error) {
        if (kind !== 'form') throw error;
        logger.warn({ err: error, tenantId, executionId, node: node.name }, 'Form page failed');
        const message = row.mode === 'manual' ? (error as Error).message : 'The form could not be processed';
        return cors(
          formErrorFor(kind, incoming.headers, json(500, errorBody('webhook_error', message)), {
            title: 'Problem loading form',
            message,
          }),
        );
      }
      if (!result.workflowData)
        return cors(fromWebhookResponse(result.webhookResponse ?? { statusCode: 200 }));
      output = result.workflowData;
      answer = result.webhookResponse;
    } else {
      const body = request.body;
      output = [[{ json: isPlainObject(body) ? body : body === undefined || body === '' ? {} : { body } }]];
    }

    // a submitted page with another page after it answers once the run stands there
    const isFormSubmit = kind === 'form' && incoming.method === 'POST';
    const pagesFollow = isFormSubmit && node !== undefined && formPageFollows(workflow, node);
    const responseMode = pagesFollow
      ? 'responseNode'
      : hook?.responseMode === 'streaming'
        ? 'lastNode'
        : (hook?.responseMode ?? 'onReceived');
    const handle = this.responseHandle(responseMode);
    const resumed = await executions.resume(tenantId, executionId, output, {
      wait: responseMode !== 'onReceived',
      observer: responseMode === 'onReceived' ? undefined : handle.observer,
    });
    if (!resumed) {
      return cors(closedPage() ?? json(409, errorBody('not_waiting', 'The execution is not waiting')));
    }
    if (responseMode === 'onReceived') {
      return cors(answer ? fromWebhookResponse(answer) : json(200, { message: 'Workflow was resumed' }));
    }
    const reply = await this.awaitResponse(
      tenant,
      workflow,
      node!,
      { ...hook!, responseMode },
      resumed,
      handle,
    );
    return cors(isFormSubmit ? await this.formSubmitReply(reply, resumed) : reply);
  }

  /** a form URL of a run that does not stand at a page: a finished run was answered, the rest cannot be */
  private notWaitingReply(kind: WebhookKind, incoming: IncomingWebhook, status: string): WebhookReply {
    const reply = json(409, errorBody('not_waiting', 'The execution is not waiting'));
    if (kind !== 'form') return reply;
    if (incoming.method === 'GET' && status === 'success') return formErrorPage(200, FORM_FINISHED);
    const busy = status === 'new' || status === 'running';
    return formErrorFor(kind, incoming.headers, reply, busy ? FORM_BUSY : FORM_STOPPED);
  }

  /**
   * The page of a submit reads its answer with fetch, which would follow a 3xx with the same POST:
   * a redirect becomes `{ redirectURL }`, a run that waits elsewhere first `{ formWaitingUrl }`.
   */
  private async formSubmitReply(reply: WebhookReply, execution: StartedExecution): Promise<WebhookReply> {
    const formUrl = this.deps.executions.resumeFormUrl(execution.executionId);
    if (
      reply.statusCode === 202 &&
      (reply.body as { message?: string } | undefined)?.message === WAITING_MESSAGE
    ) {
      return json(200, { formWaitingUrl: formUrl });
    }
    if (reply.statusCode < 300 || reply.statusCode >= 400) return reply;
    const { location, ...headers } = reply.headers;
    if (!location || !isHttpUrl(location)) {
      return json(500, errorBody('bad_redirect', 'The form response has an invalid redirect URL'));
    }
    // the node asked for its own page before the engine stored the wait: that page opens only after it
    if (location === formUrl) await this.settled(execution);
    return { statusCode: 200, headers, body: { redirectURL: location } };
  }

  private async settled(execution: StartedExecution): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FORM_PAGE_READY_MS);
      timer.unref();
    });
    try {
      await Promise.race([execution.finished, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------------------------
  // shared run logic

  /** what a webhook context runs on: the execution's services with this service's form helpers */
  private async contextServices(
    input: Parameters<ExecutionService['buildServices']>[0],
  ): Promise<ExecutionServices> {
    const services = await this.deps.executions.buildServices(input);
    return { ...services, formTokens: this.deps.formTokens, formAuth: this.deps.formAuth };
  }

  private async run(input: RunInput): Promise<WebhookReply> {
    const { executions, metrics, logger } = this.deps;
    const started = Date.now();
    const { tenant, definition, node, hook, incoming } = input;
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const type = workflow.getNodeType(node);
    const executionId = randomUUID();
    const request: WebhookRequest = { ...incoming.request, params: { ...input.params } };
    const source: CorsSource = { tenant, mode: input.mode, workflowId: input.workflowId, workflow, node };

    let reply: WebhookReply;
    let executionStarted = false;
    try {
      const services = await this.contextServices({
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
        const lost = await input.claim?.();
        if (lost) return lost;
        // the submitter follows the run to its next page by polling, not on this request
        const pagesFollow =
          webhookUrlBase(hook.description) === 'form' &&
          incoming.method === 'POST' &&
          formPageFollows(workflow, node);
        const responseMode = pagesFollow ? 'onReceived' : hook.responseMode;
        const streaming = responseMode === 'streaming' ? this.streamHandle(tenant) : undefined;
        const handle = this.responseHandle(responseMode);
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
            wait: responseMode !== 'onReceived',
            observer: streaming?.observer ?? (responseMode === 'onReceived' ? undefined : handle.observer),
          });
        } catch (error) {
          if (error instanceof ApiError) {
            reply = json(error.statusCode, errorBody(error.code, error.message));
            return this.decorate(reply, source, incoming.request.headers);
          }
          throw error;
        }
        executionStarted = true;
        input.onStarted?.(execution.executionId);
        if (streaming) {
          reply = streaming.attach(execution);
        } else if (pagesFollow) {
          reply = fromWebhookResponse({
            ...result.webhookResponse,
            body: { formWaitingUrl: executions.resumeFormUrl(execution.executionId) },
          });
        } else if (responseMode === 'onReceived') {
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
      reply = formErrorFor(
        webhookUrlBase(hook.description),
        incoming.request.headers,
        json(500, errorBody('webhook_error', message)),
        { title: 'Problem loading form', message },
      );
    } finally {
      // uploads the node stored for an execution that never started belong to no row and would never be pruned
      if (!executionStarted) await executions.removeBinaryData(tenant.id, executionId);
    }
    metrics.webhookDuration.observe({ status: String(reply.statusCode) }, (Date.now() - started) / 1000);
    return this.decorate(reply, source, incoming.request.headers);
  }

  /**
   * Streaming mode, the one wire protocol for streamed answers: every `ctx.sendChunk(x)` becomes
   * the NDJSON line `{"type":"item","content":x}` (nodes send plain content, AI agents text deltas);
   * the stream ends with `{"type":"end"}` or `{"type":"error","message":...}`. A run that succeeds
   * without sending any chunk still answers: its last node's output becomes one item first.
   * A client that closes the stream before the end stops the run, so no model is called for nobody.
   */
  private streamHandle(tenant: TenantRow) {
    const stream = new PassThrough();
    let chunks = 0;
    const write = (line: unknown) => {
      if (!stream.writableEnded) stream.write(`${JSON.stringify(line)}\n`);
    };
    const observer: ExecutionObserver = {
      onChunk: (content) => {
        chunks++;
        write({ type: 'item', content });
      },
    };
    const attach = (execution: StartedExecution): WebhookReply => {
      const limitMs = (this.deps.config.executionTimeout.maxS + 30) * 1000;
      const timer = setTimeout(() => {
        this.deps.executions.discardWaiter(execution.executionId);
        write({ type: 'error', message: 'The workflow did not finish in time' });
        stream.end();
      }, limitMs);
      timer.unref();
      stream.once('close', () => {
        if (stream.writableFinished) return;
        clearTimeout(timer);
        const { executions, logger } = this.deps;
        executions.discardWaiter(execution.executionId);
        executions.stop(tenant.id, execution.executionId).catch((error: unknown) => {
          logger.warn(
            { err: error, executionId: execution.executionId },
            'Could not stop an abandoned stream',
          );
        });
      });
      void execution.finished?.then((outcome) => {
        clearTimeout(timer);
        if (outcome.status === 'success' && !chunks) {
          const answer = finalAnswer(outcome);
          if (answer !== undefined) write({ type: 'item', content: answer });
        }
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
    if (outcome.status === 'waiting') return json(202, { message: WAITING_MESSAGE });
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
    if (outcome.status === 'waiting') return json(202, { message: WAITING_MESSAGE });
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
  private async decorate(
    reply: WebhookReply,
    source: CorsSource,
    requestHeaders: WebhookRequest['headers'],
  ): Promise<WebhookReply> {
    const options = nodeOptions(source.workflow, source.node);
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
    const allowedOrigins = await this.allowedOrigins(source);
    return { ...reply, headers: withCors(headers, allowedOrigins, requestHeaders) };
  }

  /**
   * The `allowedOrigins` option as the node reads it: an expression (e.g. `{{ $vars.CHAT_ORIGINS }}`)
   * is evaluated without item data, like the node's own check. One that fails allows no origin (`false`).
   */
  private async allowedOrigins(source: CorsSource): Promise<unknown> {
    const { tenant, mode, workflowId, workflow, node } = source;
    const value = nodeOptions(workflow, node).allowedOrigins;
    if (!isExpression(value)) return value;
    try {
      const services = await this.deps.executions.buildServices({
        tenant,
        executionId: '',
        mode,
        workflowId,
      });
      const request: WebhookRequest = { method: 'OPTIONS', headers: {}, query: {}, params: {}, body: {} };
      const ctx = createWebhookContext(
        { workflow, node, services, evaluator: this.evaluator, signal: AbortSignal.timeout(60_000) },
        request,
        '',
      );
      return ctx.getNodeParameter('options.allowedOrigins', 0, '*');
    } catch (error) {
      this.deps.logger.warn({ err: error, tenantId: tenant.id, node: node.name }, 'Allowed origins failed');
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------

function nodeOptions(workflow: Workflow, node: WorkflowNode): DataObject {
  const parameters = getResolvedParameters(workflow, node) as DataObject;
  return (parameters.options ?? {}) as DataObject;
}

/** origins compare by scheme, host and port: case and trailing slashes do not matter */
const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Adds `Access-Control-Allow-Origin` when the caller's Origin is allowed: `*` (or an empty list)
 * allows any origin, `false` none, otherwise the matching Origin is echoed. Headers the reply already set win.
 */
function withCors(
  headers: Record<string, string>,
  allowedOrigins: unknown,
  requestHeaders: WebhookRequest['headers'],
): Record<string, string> {
  const origin = header(requestHeaders, 'origin');
  if (!origin || allowedOrigins === false) return headers;
  const allowed = String(allowedOrigins ?? '*')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  const any = !allowed.length || allowed.includes('*');
  if (!any && !allowed.includes(normalizeOrigin(origin))) return headers;
  const out = { ...headers };
  out['access-control-allow-origin'] ??= any ? '*' : origin;
  if (out['access-control-allow-origin'] !== '*') out.vary = withVary(out.vary, 'Origin');
  return out;
}

function withVary(vary: string | undefined, name: string): string {
  const names = (vary ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!names.some((v) => v.toLowerCase() === name.toLowerCase())) names.push(name);
  return names.join(', ');
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** the header names of an `Access-Control-Request-Headers` value; invalid names and `*` are dropped */
function headerNames(value: string | undefined): string[] {
  const names = (value ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n && n !== '*' && HEADER_NAME.test(n));
  return [...new Set(names)];
}

function bodyErrorReply(error: unknown, kind: WebhookKind): WebhookReply {
  if (!(error instanceof WebhookBodyError)) throw error;
  const message = kind === 'form' && error.statusCode === 413 ? FORM_TOO_LARGE : error.message;
  return json(error.statusCode, errorBody(error.code, message));
}

/**
 * The answer of a run that streamed nothing: the last node's first item, or its `output` text when
 * it has one (AI agents and chains), so chat clients get the text.
 */
function finalAnswer(outcome: ExecutionOutcome): unknown {
  const items = (outcome.lastNodeOutput ?? []).find((o) => o?.length) ?? [];
  const first = items[0]?.json;
  if (!first) return undefined;
  return typeof first.output === 'string' ? first.output : first;
}

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
  // CORS belongs to each caller's Origin: a replay is decorated again
  const { 'access-control-allow-origin': _origin, ...headers } = reply.headers;
  const stored: Record<string, unknown> = { statusCode: reply.statusCode, headers };
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
