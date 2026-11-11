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
 * way the node evaluates it). A Chat Trigger adds two token grants (P5-56): `Origin: null` (the
 * sandboxed hosted page) only with a valid `x-chat-page` token, and a test chat's caller origin with a
 * valid `x-chat-test-token`; a literal `null` in its list grants nothing. Every other node keeps the list rule.
 *
 * Streaming chats answer NDJSON frames (`ChatFrame`): `begin`, `item` and `end` per node run that sent
 * chunks, each with the run's metadata, and one `error` frame when the run fails or times out.
 *
 * "Using Response Nodes" chats (P5-58) answer the same frames from the Respond to Chat nodes. A run that stops at
 * one of them to wait ends its stream with `{type:'wait', resumeUrl}`: the signed resume URL of the run, the
 * waiting node's key and `chat-reply`. The next chat message goes there and gets the frames of the resumed run;
 * an approval link fetched with `Accept: application/x-ndjson` does the same, a browser keeps the P4-17 page.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import {
  type ContextDeps,
  createWebhookContext,
  createWebhookSubNodes,
  type ExecutionServices,
  getResolvedParameters,
  type NodeTypes,
  reviewNodeKey,
} from '@workflow/core';
import {
  CHAT_PAGE_HEADER,
  CHAT_TEST_HEADER,
  CHAT_TOKEN_KINDS,
  CHAT_TRIGGER_TYPE,
  type ChatChunkMeta,
  type ChatFrame,
  type ChatFrameMetadata,
  type ChatTokenKind,
  credentialConnectionsRequiredBody,
  type DataObject,
  type ExecutionMode,
  type ExecutionState,
  ExpressionEvaluator,
  type FormAuthHelper,
  type Item,
  isExpression,
  isHitlVariant,
  isPlainObject,
  type McpAuthHelper,
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
import { mcpCorsHeaders } from '../http/mcp-http';
import type { PinoLogger } from '../logger';
import type { Repositories } from '../repositories';
import type { PushService } from './bus';
import type {
  ExecutionObserver,
  ExecutionOutcome,
  ExecutionService,
  StartedExecution,
  StoredRunOptions,
} from './executions';
import type { McpTriggerService } from './mcp-trigger';
import type { Metrics } from './metrics';
import { loadPublishedDefinition } from './published-workflow';
import { findTestWebhook, type TestWebhookStore } from './test-webhooks';
import { evaluateWorkflow } from './type-policies/enforce';
import { PolicyCheckFailedError, PolicyViolationError } from './type-policies/errors';
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

/** which URL family a request came in on: `/webhook*`, `/form*` or the MCP trigger's `/mcp*` (P5-03) */
export type WebhookKind = 'webhook' | 'form' | 'mcp';

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
/** a chat test token that does not name this registration (an earlier listen, or another chat) */
const STALE_TEST_TOKEN =
  "Couldn't start the test chat: its token is from an earlier listen. Send the message again.";
/** stream error frames: fixed texts, no error detail */
const STREAM_FAILED = 'Error in workflow';
const STREAM_TIMED_OUT = 'The workflow did not finish in time';
/** the link of a Send and Wait node ends in this (nodes-base send-and-wait/descriptions.ts) */
const ANSWER_SUFFIX = 'answer';
/** the restart webhook of Respond to Chat that takes the next chat message of a waiting run */
const CHAT_REPLY_HOOK = 'chatReply';
const NDJSON = 'application/x-ndjson';

/** a node that waits in a chat: its type (Respond to Chat, its tool and review copies) takes the chat reply */
const takesChatReply = (type: NodeType | undefined): boolean =>
  Boolean(type?.description.webhooks?.some((w) => w.restartWebhook && w.name === CHAT_REPLY_HOOK));
const ANSWER_CLOSED = {
  title: 'Nothing more to do',
  message: 'This request was already answered, or it has closed.',
};
const ANSWER_BUSY = {
  title: 'Still working',
  message: 'The workflow is still working on this request. Try again in a moment.',
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

/**
 * a browser opening a form URL gets a page; any other caller keeps the JSON. An MCP reply carries the MCP CORS
 * headers, so a browser client reads the 404 made before the hand-off to the MCP service.
 */
function formErrorFor(
  kind: WebhookKind,
  headers: WebhookRequest['headers'],
  reply: WebhookReply,
  page: { title: string; message: string },
): WebhookReply {
  if (kind === 'mcp') return { ...reply, headers: { ...mcpCorsHeaders(headers), ...reply.headers } };
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
  sign: (key: string) => string,
): WorkflowNode | undefined {
  const suspended = state?.executionData.suspended;
  if (!node || !type || suspended?.toolNode !== node.name || !isHitlVariant(type.description)) return node;
  return { ...node, webhookId: reviewNodeKey(node, suspended.toolRunIndex, sign) };
}

/**
 * A browser on the link of a Send and Wait node the run no longer stands at gets a page, not JSON. A run that is still
 * going may yet stop there: a review goes out before the other tools of its turn finish, so that page keeps the answer.
 */
function closedAnswerPage(
  kind: WebhookKind,
  incoming: IncomingWebhook,
  workflow: Workflow,
  path: string,
  status?: string,
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
    ? formErrorPage(409, status === 'new' || status === 'running' ? ANSWER_BUSY : ANSWER_CLOSED)
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
  /** P5-03 (L7): the MCP Server Trigger's transports, sessions and runs */
  mcpTrigger: McpTriggerService;
  /** P5-14 (L10): the trigger's workspace sign-in (`WebhookContext.getMcpAuth`) */
  mcpAuth: McpAuthHelper;
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
  /** P5-59 a test chat run from the canvas stops at this node (the registration's `destinationNode`) */
  destinationNode?: string;
  /** P5-56 the test registration's id, which a chat's `x-chat-test-token` must name */
  listenId?: string;
  onStarted?: (executionId: string) => void;
  /** takes the test registration once the node accepted the request; a reply means another request took it */
  claim?: () => Promise<WebhookReply | undefined>;
}

/** the node whose `allowedOrigins` option grants CORS, and the run settings its expressions resolve with */
interface CorsSource {
  tenant: TenantRow;
  mode: ExecutionMode;
  workflowId?: string;
  /** P6 S1: the stored project of a run with no workflow row (a resume page) */
  projectId?: string;
  workflow: Workflow;
  node: WorkflowNode;
  /** a chat test registration's id: its `x-chat-test-token` must name it */
  listenId?: string;
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
    // P5-03: the MCP Server Trigger owns its transports, sessions and runs; its body is read there
    if (kind === 'mcp') {
      return this.deps.mcpTrigger.handle({
        tenant,
        definition,
        workflowId: row.id,
        node,
        hook,
        mode: 'webhook',
        incoming,
        params: found.params,
      });
    }
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
    let target:
      | { definition: WorkflowDefinition; nodeName: string; workflowId: string; listenId?: string }
      | undefined;
    if (test) {
      const registrations = (await testWebhooks.list(tenant.id)).filter((r) => r.path === path);
      methods = registrations.map((r) => r.method);
      const registration = registrations.find((r) => r.method === requested) ?? registrations[0];
      if (registration) {
        target = {
          definition: registration.workflow,
          nodeName: registration.nodeName,
          workflowId: registration.workflowId,
          listenId: registration.listenId,
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
    const source: CorsSource = {
      tenant,
      mode: test ? 'manual' : 'webhook',
      workflowId: target.workflowId,
      workflow: new Workflow(target.definition, nodeTypes),
      node,
      listenId: target.listenId,
    };
    const allowedOrigins = await this.allowedOrigins(source);
    if (node.type === CHAT_TRIGGER_TYPE) {
      return { statusCode: 204, headers: this.chatCors(reply, allowedOrigins, headers, source, true) };
    }
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
    const chat = node.type === CHAT_TRIGGER_TYPE;
    const source: CorsSource = {
      tenant,
      mode: 'manual',
      workflowId: registration.workflowId,
      workflow: new Workflow(definition, this.deps.nodeTypes),
      node,
      listenId: registration.listenId,
    };
    // a chat test token of an earlier listen (or of another chat) is refused before the registration is
    // used: withholding a CORS header would not stop the run
    const testToken = header(incoming.headers, CHAT_TEST_HEADER);
    if (chat && testToken !== undefined && !this.chatTokenValid(testToken, CHAT_TOKEN_KINDS.test, source)) {
      return this.decorate(json(403, errorBody('forbidden', STALE_TEST_TOKEN)), source, incoming.headers);
    }
    // one-shot: the first call consumes the registration. A form or a chat uses it up only with an accepted
    // request, and then for all of its hooks: its page (setup) and a refused POST leave it listening. An MCP
    // Server Trigger uses it up with its first tool call (P5-03): initialize, lists and its stream leave it.
    const claimOnAccept = kind === 'form' || kind === 'mcp' || chat;
    // the claim takes only this listen's registrations: a listen that replaced them meanwhile keeps its own
    const claim = async () => {
      if (!(await testWebhooks.remove(registration))) return missing();
      await testWebhooks.removeForNode(
        tenant.id,
        registration.workflowId,
        registration.nodeName,
        registration,
      );
      return undefined;
    };
    if (kind === 'mcp') {
      return this.deps.mcpTrigger.handle({
        tenant,
        definition,
        workflowId: registration.workflowId,
        node,
        hook,
        mode: 'manual',
        incoming,
        params: found.params,
        userId: registration.userId,
        claim,
        onStarted: (executionId) =>
          push.send(
            tenant.id,
            'testWebhookReceived',
            { workflowId: registration.workflowId, executionId },
            { workflowId: registration.workflowId },
          ),
      });
    }
    // a body that cannot be read (too large, malformed) leaves the registration in place
    let received: ReceivedWebhook;
    try {
      received = await receive(incoming);
    } catch (error) {
      return this.decorate(bodyErrorReply(error, kind), source, incoming.headers);
    }
    if (!claimOnAccept && !(await testWebhooks.remove(registration))) return missing();
    return this.run({
      claim: claimOnAccept ? claim : undefined,
      tenant,
      definition,
      workflowId: registration.workflowId,
      node,
      hook,
      mode: 'manual',
      incoming: received,
      params: found.params,
      userId: registration.userId,
      destinationNode: registration.destinationNode,
      listenId: registration.listenId,
      onStarted: (executionId) =>
        push.send(
          tenant.id,
          'testWebhookReceived',
          { workflowId: registration.workflowId, executionId },
          { workflowId: registration.workflowId },
        ),
    });
  }

  // -------------------------------------------------------------------------------------------
  // resume webhooks

  async handleWaiting(
    executionId: string,
    incoming: IncomingWebhook,
    /** resume URLs exist for `/webhook-waiting` and `/form-waiting` only (an MCP trigger never waits) */
    kind: Exclude<WebhookKind, 'mcp'> = 'webhook',
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
    const node = asLinkedNode(stored, type, state, (key) =>
      executions.signReviewKey(executionId, key, rest[0]),
    );

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
    const closedPage = (status?: string) => closedAnswerPage(kind, incoming, workflow, path, status);
    if (row.status !== 'waiting') {
      return closedPage(row.status) ?? this.notWaitingReply(kind, incoming, row.status);
    }

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
    // Respond to Chat has two POST hooks (the answer form and the chat reply): the path tells them apart
    const hook =
      own.find((h) => h.method === incoming.method && h.path === path) ??
      own.find((h) => h.method === incoming.method) ??
      own[0];
    const storedProjectId = (data.runOptions as StoredRunOptions | null)?.projectId;
    const source: CorsSource | undefined = node
      ? {
          tenant,
          mode: row.mode as ExecutionMode,
          workflowId: row.workflowId ?? undefined,
          projectId: storedProjectId,
          workflow,
          node,
        }
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
    // highlighted data the node saves with the reply (a chat reply's `input_<node>`)
    let customData: Record<string, string> | undefined;
    if (node && type?.webhook && hook) {
      // P6 S1: the workflow row's project, else the one the run was started in
      const projectId = await this.deps.executions.projectFor(tenant.id, row.workflowId, storedProjectId);
      // P6-04: the type policy judges the run's workflow before the node's webhook runs (or decrypts)
      const refused = await this.policyRefusal(tenant.id, projectId, definition);
      if (refused) return cors(refused);
      const services = await this.contextServices({
        tenant,
        executionId,
        projectId,
        mode: row.mode as never,
        workflowId: row.workflowId ?? undefined,
      });
      // the context sees what the node saw when it stopped: a page can read earlier nodes and its input
      const runs = state?.resultData.runData[node.name];
      const task = runs?.[runs.length - 1];
      // a tool that waits has no input of its own: it sees what its agent saw
      const suspended = state?.executionData.suspended;
      const contextDeps: ContextDeps = {
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
      };
      // sub-nodes (a chat's memory) read the request as their item: `$json.sessionId` is the body's
      const subNodes = createWebhookSubNodes(contextDeps, requestItem(request));
      const ctx = createWebhookContext(contextDeps, request, hook.webhookName, subNodes.callbacks);
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
      } finally {
        await subNodes.close();
      }
      if (!result.workflowData)
        return cors(fromWebhookResponse(result.webhookResponse ?? { statusCode: 200 }));
      output = result.workflowData;
      customData = result.customData;
      answer = result.webhookResponse;
    } else {
      const body = request.body;
      output = [[{ json: isPlainObject(body) ? body : body === undefined || body === '' ? {} : { body } }]];
    }

    // a submitted page with another page after it answers once the run stands there
    const isFormSubmit = kind === 'form' && incoming.method === 'POST';
    const pagesFollow = isFormSubmit && node !== undefined && formPageFollows(workflow, node);
    // the chat reply, and an approval button the chat widget fetches, answer with the frames of the resumed run
    const chatStream =
      hook?.responseMode === 'responseNodes' ||
      (incoming.method === 'GET' &&
        takesChatReply(type) &&
        header(incoming.headers, 'accept')?.includes(NDJSON))
        ? this.streamHandle(tenant, workflow, 'responseNodes')
        : undefined;
    const responseMode = pagesFollow
      ? 'responseNode'
      : hook?.responseMode === 'streaming'
        ? 'lastNode'
        : (hook?.responseMode ?? 'onReceived');
    const handle = this.responseHandle(responseMode);
    const toolWait = state?.executionData.suspended;
    const resumed = await executions.resume(tenantId, executionId, output, {
      wait: Boolean(chatStream) || responseMode !== 'onReceived',
      observer: chatStream?.observer ?? (responseMode === 'onReceived' ? undefined : handle.observer),
      ...(toolWait ? { atWait: { toolNode: toolWait.toolNode, toolRunIndex: toolWait.toolRunIndex } } : {}),
      ...(customData ? { customData } : {}),
    });
    if (!resumed) {
      return cors(closedPage() ?? json(409, errorBody('not_waiting', 'The execution is not waiting')));
    }
    if (chatStream) return cors(chatStream.attach(resumed));
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
    return {
      ...services,
      formTokens: this.deps.formTokens,
      formAuth: this.deps.formAuth,
      mcpAuth: this.deps.mcpAuth,
    };
  }

  /**
   * P6-04: the type policy judges `definition` as a run start does, before the webhook phase (the node's
   * webhook, its sub-nodes and their credentials), which runs before any run starts. A refusal is 403
   * `policy_violation`, a check that failed or missed its deadline 503 `policy_check_failed`; null when the
   * request may go on. The deps are the server's (the MCP Server Trigger's service holds them).
   */
  private async policyRefusal(
    tenantId: string,
    projectId: string,
    definition: WorkflowDefinition,
  ): Promise<WebhookReply | null> {
    try {
      await evaluateWorkflow(this.deps.mcpTrigger.deps, 'workflowStart', {
        tenantId,
        projectId,
        workflow: definition,
      });
      return null;
    } catch (error) {
      if (error instanceof PolicyViolationError || error instanceof PolicyCheckFailedError) {
        return json(error.statusCode, errorBody(error.code, error.message));
      }
      throw error;
    }
  }

  /**
   * The credential gate of a run whose trigger identified a user (P6-87, n8n Form/utils/utils.ts): not ready is
   * 428 with the credentials to connect, a check that throws is 503 `credential_readiness_check_failed`. Null
   * when the run may start. No error text reaches the caller.
   */
  private async credentialGate(
    services: ExecutionServices,
    userId: string,
    tenantId: string,
    workflowId: string,
  ): Promise<WebhookReply | null> {
    try {
      // no gate on a run that built services with a definition cannot happen: refuse rather than run
      if (!services.credentialGate) throw new Error('The credential gate is missing');
      const result = await services.credentialGate.check(userId);
      if (result.readyToExecute) return null;
      return json(428, credentialConnectionsRequiredBody(result));
    } catch (error) {
      this.deps.logger.warn({ err: error, tenantId, workflowId }, 'Credential readiness check failed');
      return json(503, { status: 'credential_readiness_check_failed' });
    }
  }

  private async run(input: RunInput): Promise<WebhookReply> {
    const { executions, metrics, logger } = this.deps;
    const started = Date.now();
    const { tenant, definition, node, hook, incoming } = input;
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const type = workflow.getNodeType(node);
    const executionId = randomUUID();
    const request: WebhookRequest = { ...incoming.request, params: { ...input.params } };
    const source: CorsSource = {
      tenant,
      mode: input.mode,
      workflowId: input.workflowId,
      workflow,
      node,
      listenId: input.listenId,
    };

    let reply: WebhookReply;
    let executionStarted = false;
    try {
      const projectId = await executions.projectFor(tenant.id, input.workflowId);
      // P6-04: the type policy judges the workflow before the node's webhook runs (or decrypts)
      const refused = await this.policyRefusal(tenant.id, projectId, definition);
      if (refused) return this.decorate(refused, source, incoming.request.headers);
      const services = await this.contextServices({
        tenant,
        executionId,
        projectId,
        mode: input.mode,
        workflowId: input.workflowId,
        // P6-87 (C0): the credential gate walks from this trigger (`ctx.getCredentialGate()`, L16)
        workflow: definition,
        startNode: node.name,
      });
      const contextDeps: ContextDeps = {
        workflow,
        node,
        services,
        evaluator: this.evaluator,
        signal: AbortSignal.timeout(60_000),
      };
      // sub-nodes (a chat's memory) read the request as their item: `$json.sessionId` is the body's
      const subNodes = createWebhookSubNodes(contextDeps, requestItem(request));
      const ctx = createWebhookContext(contextDeps, request, hook.webhookName, subNodes.callbacks);
      let result: WebhookResponseData;
      try {
        result = type.webhook
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
      } finally {
        await subNodes.close();
      }

      if (!result.workflowData) {
        reply = fromWebhookResponse(result.webhookResponse ?? { statusCode: 200, body: {} });
      } else {
        // P6-87: a trigger that knew the person starts only when they have connected the private credentials
        // the run reaches; the check fails closed (a throw is 503, no run). It runs before the claim: a refusal
        // leaves a test form or chat listening, as any refused request does
        if (result.triggerUserId) {
          const blocked = await this.credentialGate(
            services,
            result.triggerUserId,
            tenant.id,
            input.workflowId,
          );
          if (blocked) return this.decorate(blocked, source, incoming.request.headers);
        }
        const lost = await input.claim?.();
        if (lost) return lost;
        // the submitter follows the run to its next page by polling, not on this request
        const pagesFollow =
          webhookUrlBase(hook.description) === 'form' &&
          incoming.method === 'POST' &&
          formPageFollows(workflow, node);
        const responseMode = pagesFollow ? 'onReceived' : hook.responseMode;
        const streaming =
          responseMode === 'streaming' || responseMode === 'responseNodes'
            ? this.streamHandle(tenant, workflow, responseMode)
            : undefined;
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
            // P6-15, P6-87 (C0): the person a signed-in trigger verified (Webhook, Form, Chat with workspace sign-in)
            endUserId: result.triggerUserId,
            destinationNode: input.destinationNode,
            // P5-61: custom data the node set for this run (e.g. the chat's session id)
            customData: result.customData,
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
   * Streaming mode, the one wire protocol for streamed answers (`ChatFrame`, NDJSON). A node run's first
   * `ctx.sendChunk(x)` opens its group with `begin`; each chunk is an `item` whose `content` is text (objects
   * as JSON); the run's end writes `end`. Every frame carries the run's metadata (node id and name, run and
   * item index, time). Groups still open (a tool's chunk and its logged run can carry different run indexes)
   * are closed before the stream ends or an `error` frame is written. A run that succeeds without sending
   * any chunk still answers: its last node's output becomes one group. A failure or a timeout writes one
   * `error` frame with fixed text in `content` and `message`, never a detail of the error.
   * A client that closes the stream before the end stops the run, so no model is called for nobody.
   * In `responseNodes` mode only the Respond to Chat nodes speak (no last-node fallback): a chunk of any other
   * node (an agent that streams) is dropped, as n8n streams an agent only in Streaming mode. A run that stops
   * at one of them to wait ends with a `wait` frame naming where the next message goes; a client that closes
   * once the run has finished or waits no longer stops it.
   */
  private streamHandle(
    tenant: TenantRow,
    workflow: Workflow,
    mode: 'streaming' | 'responseNodes' = 'streaming',
  ) {
    const stream = new PassThrough();
    let chunks = 0;
    /** set when the run finished or waits: a client that closes after that stops nothing */
    let settled = false;
    /** in `responseNodes` mode, whether a node's chunks reach the chat (Respond to Chat and its copies only) */
    const speaks = (meta: ChatChunkMeta | undefined) => {
      if (mode !== 'responseNodes') return true;
      const stored = meta ? workflow.getNode(meta.nodeName) : undefined;
      return Boolean(stored && takesChatReply(this.deps.nodeTypes.get(stored.type)));
    };
    /** open groups by node run, with the meta of their last chunk */
    const open = new Map<string, ChatChunkMeta>();
    const write = (frame: ChatFrame) => {
      if (!stream.writableEnded) stream.write(`${JSON.stringify(frame)}\n`);
    };
    const closeOpen = () => {
      for (const meta of open.values()) write({ type: 'end', metadata: frameMetadata(meta) });
      open.clear();
    };
    const fail = (message: string) => {
      closeOpen();
      write({ type: 'error', content: message, message });
      stream.end();
    };
    const observer: ExecutionObserver = {
      onChunk: (content, meta) => {
        if (!speaks(meta)) return;
        chunks++;
        const from = meta ?? UNKNOWN_CHUNK_META;
        const key = runKey(from);
        if (!open.has(key)) write({ type: 'begin', metadata: frameMetadata(from) });
        open.set(key, from);
        write({ type: 'item', content: chunkText(content), metadata: frameMetadata(from) });
      },
      onNodeRunEnd: (meta) => {
        const key = runKey(meta);
        if (!open.delete(key)) return;
        write({ type: 'end', metadata: frameMetadata(meta) });
      },
    };
    const attach = (execution: StartedExecution): WebhookReply => {
      const limitMs = (this.deps.config.executionTimeout.maxS + 30) * 1000;
      const timer = setTimeout(() => {
        this.deps.executions.discardWaiter(execution.executionId);
        fail(STREAM_TIMED_OUT);
      }, limitMs);
      timer.unref();
      stream.once('close', () => {
        if (settled || stream.writableFinished) return;
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
      void execution.finished?.then(async (outcome) => {
        settled = true;
        clearTimeout(timer);
        if (outcome.status !== 'success' && outcome.status !== 'waiting') return fail(STREAM_FAILED);
        if (mode === 'responseNodes') {
          closeOpen();
          if (outcome.status === 'waiting') {
            const resumeUrl = await this.chatReplyUrl(tenant.id, workflow, execution.executionId).catch(
              (error: unknown) => {
                this.deps.logger.warn(
                  { err: error, executionId: execution.executionId },
                  'Could not read the waiting chat node',
                );
                return undefined;
              },
            );
            if (resumeUrl) write({ type: 'wait', resumeUrl });
          }
          stream.end();
          return;
        }
        if (outcome.status === 'success' && !chunks) {
          const answer = finalAnswer(outcome);
          if (answer !== undefined) {
            const metadata = frameMetadata(lastNodeMeta(workflow, outcome));
            write({ type: 'begin', metadata });
            write({ type: 'item', content: chunkText(answer), metadata });
            write({ type: 'end', metadata });
          }
        }
        closeOpen();
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

  /**
   * Where the next chat message of a waiting run goes: its signed resume URL plus the `chat-reply` path of the
   * node it stands at (`lastNodeExecuted`). The node key is the one its links carry (`asLinkedNode`): a human
   * review holds its signed review key. Nothing when the run waits at a node that takes no chat reply.
   */
  private async chatReplyUrl(
    tenantId: string,
    workflow: Workflow,
    executionId: string,
  ): Promise<string | undefined> {
    const { repos, nodeTypes, executions } = this.deps;
    const data = await repos.executions.getData(tenantId, executionId);
    const state = (data?.state ?? null) as unknown as ExecutionState | null;
    const nodeName = state?.resultData.lastNodeExecuted;
    const stored = nodeName ? workflow.getNode(nodeName) : undefined;
    const type = stored ? nodeTypes.get(stored.type) : undefined;
    if (!stored || !takesChatReply(type)) return undefined;
    const node = asLinkedNode(stored, type, state, (key) => executions.signReviewKey(executionId, key))!;
    const hook = nodeWebhooks(workflow, node, type!, { restart: true }).find(
      (h) => h.webhookName === CHAT_REPLY_HOOK,
    );
    return hook ? `${executions.resumeUrl(executionId)}/${hook.path}` : undefined;
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
        const data = await this.deps.executions.runBinaryBuffer(tenant.id, outcome.executionId, binary);
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
    if (source.node.type === CHAT_TRIGGER_TYPE) {
      return { ...reply, headers: this.chatCors(headers, allowedOrigins, requestHeaders, source, false) };
    }
    return { ...reply, headers: withCors(headers, allowedOrigins, requestHeaders) };
  }

  /**
   * CORS of a Chat Trigger. `Origin: null` is granted only with a valid page token, a test chat's caller
   * origin only with a valid test token of this registration; otherwise the list applies, where a literal
   * `null` entry grants nothing. A preflight cannot carry a header value, so it grants on the header NAME:
   * the request itself must then show the token (the node refuses it otherwise, before any run).
   */
  private chatCors(
    headers: Record<string, string>,
    allowedOrigins: unknown,
    requestHeaders: WebhookRequest['headers'],
    source: CorsSource,
    preflight: boolean,
  ): Record<string, string> {
    const origin = header(requestHeaders, 'origin');
    if (!origin || allowedOrigins === false) return headers;
    const opaque = normalizeOrigin(origin) === OPAQUE_ORIGIN;
    const test = source.mode === 'manual';
    let grant: string | undefined;
    if (preflight) {
      const named = headerNames(header(requestHeaders, 'access-control-request-headers'));
      if (opaque && (named.includes(CHAT_PAGE_HEADER) || named.includes(CHAT_TEST_HEADER))) {
        grant = OPAQUE_ORIGIN;
      } else if (test && named.includes(CHAT_TEST_HEADER)) grant = origin;
    } else if (
      test &&
      this.chatTokenValid(header(requestHeaders, CHAT_TEST_HEADER), CHAT_TOKEN_KINDS.test, source)
    ) {
      grant = origin;
    } else if (
      opaque &&
      this.chatTokenValid(header(requestHeaders, CHAT_PAGE_HEADER), CHAT_TOKEN_KINDS.page, source)
    ) {
      grant = OPAQUE_ORIGIN;
    }
    if (!grant) return withCors(headers, allowedOrigins, requestHeaders, { ignoreOpaque: true });
    const out = { ...headers };
    out['access-control-allow-origin'] ??= grant;
    out.vary = withVary(out.vary, 'Origin');
    return out;
  }

  /** a signed chat token of `kind` for this tenant, workflow and node; a test token must name the registration */
  private chatTokenValid(token: string | undefined, kind: ChatTokenKind, source: CorsSource): boolean {
    if (!token) return false;
    const payload = this.deps.formTokens.verify(token);
    if (!payload || payload.kind !== kind) return false;
    if (payload.tenantId !== source.tenant.id || payload.workflowId !== (source.workflowId ?? ''))
      return false;
    if (payload.node !== source.node.name) return false;
    if (kind !== CHAT_TOKEN_KINDS.test) return true;
    return source.listenId !== undefined && payload.listenId === source.listenId;
  }

  /**
   * The `allowedOrigins` option as the node reads it: an expression (e.g. `{{ $vars.CHAT_ORIGINS }}`)
   * is evaluated without item data, like the node's own check. One that fails allows no origin (`false`).
   */
  private async allowedOrigins(source: CorsSource): Promise<unknown> {
    const { tenant, mode, workflowId, projectId, workflow, node } = source;
    const value = nodeOptions(workflow, node).allowedOrigins;
    if (!isExpression(value)) return value;
    try {
      const services = await this.deps.executions.buildServices({
        tenant,
        executionId: '',
        projectId: await this.deps.executions.projectFor(tenant.id, workflowId, projectId),
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

/** the Origin of a sandboxed page or a data: URL; a chat grants it only with a page token */
const OPAQUE_ORIGIN = 'null';

/**
 * Adds `Access-Control-Allow-Origin` when the caller's Origin is allowed: `*` (or an empty list)
 * allows any origin, `false` none, otherwise the matching Origin is echoed. Headers the reply already set win.
 */
function withCors(
  headers: Record<string, string>,
  allowedOrigins: unknown,
  requestHeaders: WebhookRequest['headers'],
  chat: { ignoreOpaque?: boolean } = {},
): Record<string, string> {
  const origin = header(requestHeaders, 'origin');
  if (!origin || allowedOrigins === false) return headers;
  const listed = String(allowedOrigins ?? '*')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  const any = !listed.length || listed.includes('*');
  // a chat's list never grants the opaque origin by name: only its page token does (chatCors)
  const allowed = chat.ignoreOpaque ? listed.filter((o) => o !== OPAQUE_ORIGIN) : listed;
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

/** a chunk sent without metadata (a host that gives none) still gets a group of its own */
const UNKNOWN_CHUNK_META: ChatChunkMeta = { nodeId: '', nodeName: '', runIndex: 0, itemIndex: 0 };

/** one group per node run: the key `executions.ts` uses for `onNodeRunEnd` */
const runKey = (meta: ChatChunkMeta) => `${meta.nodeName}:${meta.runIndex}`;

const frameMetadata = (meta: ChatChunkMeta): ChatFrameMetadata => ({
  nodeId: meta.nodeId,
  nodeName: meta.nodeName,
  runIndex: meta.runIndex,
  itemIndex: meta.itemIndex,
  timestamp: Date.now(),
});

/** frame content is text: strings as they are, anything else as JSON */
function chunkText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return JSON.stringify(content) ?? String(content);
}

/** the metadata of the answer of a run that streamed nothing: its last node */
function lastNodeMeta(workflow: Workflow, outcome: ExecutionOutcome): ChatChunkMeta {
  const name = outcome.lastNodeExecuted ?? '';
  const node = name ? workflow.getNode(name) : undefined;
  return { nodeId: node?.id ?? '', nodeName: name, runIndex: 0, itemIndex: 0 };
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

/** the item a webhook's sub-nodes see: the request body when it is an object (a chat's `sessionId`), else empty */
function requestItem(request: WebhookRequest): Item {
  return { json: isPlainObject(request.body) ? request.body : {} };
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
