/**
 * The MCP Server Trigger's transport and run (P5-03). services/webhooks.ts hands a found `mcp` hook here (Host
 * already checked) before reading the body. This service reads and parses the JSON-RPC message
 * (`parseMcpMessage`; too large 413, malformed or a batch a JSON-RPC error), calls the node's `webhook` (auth and
 * the answers that need no run: `initialize`, `server/discover`, `tools/list`), then owns sessions
 * (`Mcp-Session-Id`, legacy SSE with `?sessionId=` and bus channel `mcp-session:<id>`), `ping`, notifications
 * (202), DELETE, and `tools/call`: `claim()`, then one execution with `{ ...baseItem, mcpToolCall, mcpMessageId }`
 * whose `lastNodeOutput` answers the POST. Every reply carries `mcpCorsHeaders`. For `tools/list` the node is called
 * a second time under `MCP_TOOLS_LIST_HOOK` with sub-nodes that get the base item `{ body, headers, user? }`, the
 * item a tool sees at a call (n8n's tool input). A POST of a legacy SSE session gets 202 once its session, auth and
 * subject are checked; its answer (or a JSON-RPC error) goes out on the stream when ready, so a long tool run never
 * holds the POST open.
 *
 * Revisions: a 2025 client opens a session with `initialize` (Streamable HTTP) or the GET stream (legacy SSE); a
 * 2026-07-28 client sends `server/discover` and requests with a `_meta` envelope and routing headers, without a
 * session, and gets `resultType: 'complete'` results.
 *
 * Queue mode: sessions live in Redis, so any main answers a Streamable HTTP request; an SSE stream lives on the
 * main that opened it, and a POST on any main publishes its answer on the bus channel that main listens to. The
 * bus message holds the JSON-RPC answer only, never a token. Tool calls run on a worker like any execution; the
 * answer is the run's `lastNodeOutput`.
 *
 * The constructor and `close` never throw (`createContext` and `close()` run them in every server test).
 */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { type ContextDeps, createWebhookContext, createWebhookSubNodes } from '@workflow/core';
import {
  checkMcpRoutingHeaders,
  type DataObject,
  ExpressionEvaluator,
  isModernMcpRequest,
  isPlainObject,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MCP_ERRORS,
  MCP_LEGACY_REVISIONS,
  MCP_TOOLS_LIST_HOOK,
  type McpAuthHelper,
  type McpCallResult,
  mcpCompleteResult,
  mcpError,
  mcpErrorResult,
  mcpResult,
  parseMcpMessage,
  redactSecrets,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { mcpCorsHeaders } from '../http/mcp-http';
import type { ExecutionOutcome, StartedExecution } from './executions';
import { createMcpAuthHelper } from './mcp/oauth/tokens';
import { McpSessionLimitError, type McpSessionRecord, type McpSessionStore } from './mcp-sessions';
import { evaluateWorkflow } from './type-policies/enforce';
import { PolicyCheckFailedError, PolicyViolationError } from './type-policies/errors';
import type { NodeWebhook } from './webhook-paths';
import {
  fromWebhookResponse,
  header,
  type IncomingWebhook,
  WebhookBodyError,
  type WebhookReply,
} from './webhooks';

export interface McpTriggerServiceDeps extends ServiceDeps {
  /** the context's MCP session store (`createMcpSessionStore`) */
  sessions: McpSessionStore;
}

/** one request to an MCP Server Trigger's URL, production or test */
export interface McpTriggerRequest {
  tenant: TenantRow;
  definition: WorkflowDefinition;
  workflowId: string;
  node: WorkflowNode;
  /** `setup` GET, `default` POST or `sessionEnd` DELETE */
  hook: NodeWebhook;
  mode: 'webhook' | 'manual';
  /** the request; its body is not read yet */
  incoming: IncomingWebhook;
  params: Record<string, string>;
  userId?: string;
  /** a test URL: takes the registration on the first tool call; a reply means another request took it */
  claim?: () => Promise<WebhookReply | undefined>;
  onStarted?(executionId: string): void;
}

/** legacy SSE streams one workspace may hold open across all mains */
export const MCP_TENANT_STREAM_CAP = 100;

/** how often a held stream sends a keep-alive comment and a running call refreshes its session (at most) */
export const MCP_KEEP_ALIVE_MS = 15_000;

/** the text of a tool call whose run stopped to wait for a person */
export const MCP_TOOL_WAITING = 'This tool is waiting for a person and cannot answer here';

/** the node's `customData` key holding the hash of who authenticated (McpTrigger.node.ts) */
const SUBJECT_KEY = 'mcpSubject';

/** the revision of a legacy SSE session until its `initialize` (SSE came with 2024-11-05) */
const SSE_REVISION = MCP_LEGACY_REVISIONS[MCP_LEGACY_REVISIONS.length - 1];

const TEXTS = {
  noSession: 'No sessionId provided',
  noTransport: 'No transport found for sessionId',
  sessionNotFound: 'Session not found',
  methodNotAllowed: 'Method Not Allowed',
  badCall: 'Require a name and arguments for the tool call',
  methodNotFound: 'Method not found',
  tooLarge: 'Request body too large',
  parse: 'Parse error',
  tooManyStreams: 'Too many open MCP streams for this workspace',
  tooManySessions: 'Too many open MCP sessions for this workspace',
  internal: 'Internal error',
  timedOut: 'The workflow did not respond in time',
  noResult: 'The tool gave no result',
} as const;

/** the bus channel an SSE session's answers travel on */
export const mcpSessionChannel = (sessionId: string) => `mcp-session:${sessionId}`;

const rpc = (
  statusCode: number,
  body: JsonRpcResponse,
  headers: Record<string, string> = {},
): WebhookReply => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

const accepted = (): WebhookReply => ({ statusCode: 202, headers: {} });

/** what a POST's message gets: a reply sent as it is (a used-up test URL), or its answer (none for a notification) */
type Answered = { reply: WebhookReply } | { answer?: JsonRpcResponse };

/** the tool name a node gets (nodes-ai `toToolName`): what maps a called tool back to its sub-node */
function toolNameOf(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'tool').slice(0, 64);
}

/** the sub-node a tool came from: the one named like it, else the only one connected */
function sourceNodeOf(workflow: Workflow, trigger: WorkflowNode, toolName: string): string {
  const tools = workflow.getSubNodes(trigger.name, 'ai_tool');
  const named = tools.find((n) => toolNameOf(n.name) === toolName);
  return named?.name ?? (tools.length === 1 ? tools[0].name : '');
}

export class McpTriggerService {
  private readonly evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });
  private readonly streams = new Map<string, () => void>();
  private mcpAuth?: McpAuthHelper;

  constructor(readonly deps: McpTriggerServiceDeps) {}

  /** a session is refreshed well within its idle TTL, so a held stream or a running call never expires */
  private get keepAliveMs(): number {
    return Math.max(50, Math.min(MCP_KEEP_ALIVE_MS, Math.floor(this.deps.config.mcp.sessionIdleTtlMs / 3)));
  }

  async handle(input: McpTriggerRequest): Promise<WebhookReply> {
    const cors = mcpCorsHeaders(input.incoming.headers);
    let reply: WebhookReply;
    try {
      reply = await this.route(input);
    } catch (error) {
      // P6-04: the type policy refused the trigger's workflow (403), or its check failed (503)
      reply =
        error instanceof PolicyViolationError || error instanceof PolicyCheckFailedError
          ? rpc(error.statusCode, mcpError(null, MCP_ERRORS.INTERNAL, error.message))
          : rpc(500, mcpError(null, MCP_ERRORS.INTERNAL, this.failure(input, error)));
    }
    return { ...reply, headers: { ...cors, ...reply.headers } };
  }

  /** logs a failed request and returns the text its caller gets */
  private failure(input: McpTriggerRequest, error: unknown): string {
    // no message text in the log: it can hold a caller's data
    this.deps.logger.warn(
      {
        tenantId: input.tenant.id,
        workflowId: input.workflowId,
        node: input.node.name,
        error: (error as Error)?.name,
      },
      'MCP trigger request failed',
    );
    // details help while testing in the editor; production callers get the generic JSON-RPC error
    return input.mode === 'manual'
      ? redactSecrets((error as Error)?.message || TEXTS.internal)
      : TEXTS.internal;
  }

  /** ends held SSE streams and bus subscriptions */
  async close(): Promise<void> {
    for (const close of [...this.streams.values()]) close();
    this.streams.clear();
  }

  // -------------------------------------------------------------------------------------------
  // routing

  private async route(input: McpTriggerRequest): Promise<WebhookReply> {
    const method = input.incoming.method.toUpperCase();
    if (method === 'GET' && header(input.incoming.headers, 'mcp-session-id') !== undefined) {
      // Streamable HTTP has no server-to-client stream here; clients expect 405
      return rpc(405, mcpError(null, MCP_ERRORS.INVALID_REQUEST, TEXTS.methodNotAllowed), {
        allow: 'POST, DELETE',
      });
    }
    let request: WebhookRequest;
    try {
      request = { ...(await input.incoming.read()), params: { ...input.params } };
    } catch (error) {
      if (!(error instanceof WebhookBodyError)) throw error;
      return error.statusCode === 413
        ? rpc(413, mcpError(null, MCP_ERRORS.INVALID_REQUEST, TEXTS.tooLarge))
        : rpc(400, mcpError(null, MCP_ERRORS.PARSE, TEXTS.parse));
    }
    if (method === 'POST') return this.post(input, request);
    if (method === 'GET') return this.openStream(input, request);
    if (method === 'DELETE') return this.endSession(input, request);
    return rpc(405, mcpError(null, MCP_ERRORS.INVALID_REQUEST, TEXTS.methodNotAllowed), {
      allow: 'GET, POST, DELETE',
    });
  }

  /**
   * the node's `webhook`: auth and the answers that need no run. With `toolInput` (the base item of a `tools/list`
   * request) it runs under `MCP_TOOLS_LIST_HOOK` with sub-nodes that see that item, closed in `finally`.
   */
  private async callNode(
    input: McpTriggerRequest,
    request: WebhookRequest,
    toolInput?: DataObject,
  ): Promise<WebhookResponseData> {
    const ctx = this.deps.context();
    const workflow = new Workflow(input.definition, ctx.registries.nodeTypes);
    const type = workflow.getNodeType(input.node);
    if (!type.webhook) throw new Error('The MCP Server Trigger cannot answer requests');
    this.mcpAuth ??= createMcpAuthHelper(this.deps.context);
    // P6 S1: the trigger's workflow row's project
    const projectId = await ctx.executions.projectFor(input.tenant.id, input.workflowId);
    // P6-04: the type policy judges the workflow as a run start does, before the node and its tools run (or
    // decrypt); a refusal reaches `handle` (403, a failed check 503)
    await evaluateWorkflow(this.deps, 'workflowStart', {
      tenantId: input.tenant.id,
      projectId,
      workflow: input.definition,
    });
    const services = await ctx.executions.buildServices({
      tenant: input.tenant,
      executionId: randomUUID(),
      projectId,
      mode: input.mode,
      workflowId: input.workflowId,
    });
    const deps: ContextDeps = {
      workflow,
      node: input.node,
      services: { ...services, mcpAuth: this.mcpAuth },
      evaluator: this.evaluator,
      signal: AbortSignal.timeout(60_000),
    };
    const subNodes = toolInput ? createWebhookSubNodes(deps, { json: toolInput }) : undefined;
    const webhookName = toolInput ? MCP_TOOLS_LIST_HOOK : input.hook.webhookName;
    try {
      return await type.webhook(createWebhookContext(deps, request, webhookName, subNodes?.callbacks));
    } finally {
      await subNodes?.close();
    }
  }

  /** a refusal of the node (auth), sent as it is */
  private refusalOf(result: WebhookResponseData): WebhookReply | undefined {
    if (result.workflowData || !result.webhookResponse) return undefined;
    return (result.webhookResponse.statusCode ?? 200) >= 400
      ? fromWebhookResponse(result.webhookResponse)
      : undefined;
  }

  private subjectOf(result: WebhookResponseData): string {
    return String(result.customData?.[SUBJECT_KEY] ?? '');
  }

  /**
   * A session of this trigger: same tenant, workflow, node and transport (checked before the node runs, so a
   * foreign id never builds tools); the subject is compared once the node has authenticated the caller.
   */
  private async findSession(
    input: McpTriggerRequest,
    id: string,
    transport: McpSessionRecord['transport'],
  ): Promise<McpSessionRecord | undefined> {
    const session = await this.deps.sessions.get(id);
    if (
      !session ||
      session.tenantId !== input.tenant.id ||
      session.workflowId !== input.workflowId ||
      session.nodeName !== input.node.name ||
      session.transport !== transport
    ) {
      return undefined;
    }
    return session;
  }

  // -------------------------------------------------------------------------------------------
  // POST: one JSON-RPC message

  private async post(input: McpTriggerRequest, request: WebhookRequest): Promise<WebhookReply> {
    const { sessions } = this.deps;
    const parsed = parseMcpMessage(request.body);
    if (parsed.kind === 'invalid') return rpc(400, mcpError(parsed.id, parsed.code, parsed.text));
    const message = parsed.kind === 'response' ? undefined : parsed.message;
    const id: JsonRpcId | null = parsed.kind === 'request' ? parsed.message.id : null;
    if (parsed.kind === 'request') {
      const mismatch = checkMcpRoutingHeaders(request.headers, parsed.message);
      if (mismatch) return rpc(400, mcpError(id, mismatch.code, mismatch.text));
    }
    const querySession = typeof request.query.sessionId === 'string' ? request.query.sessionId : undefined;
    const headerSession = header(request.headers, 'mcp-session-id');
    const initialize = message?.method === 'initialize' && parsed.kind === 'request';
    const modern = !querySession && !headerSession && message !== undefined && isModernMcpRequest(message);

    let sessionId: string | undefined;
    let session: McpSessionRecord | undefined;
    if (querySession !== undefined) {
      session = await this.findSession(input, querySession, 'sse');
      if (!session) return rpc(401, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.noTransport));
      sessionId = querySession;
    } else if (headerSession !== undefined && !initialize) {
      session = await this.findSession(input, headerSession, 'http');
      if (!session) return rpc(404, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.sessionNotFound));
      sessionId = headerSession;
    } else if (!initialize && !modern) {
      return rpc(400, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.noSession));
    }

    let result = await this.callNode(input, request);
    let refusal = this.refusalOf(result);
    if (refusal) return refusal;
    if (parsed.kind === 'request' && parsed.message.method === 'tools/list' && result.workflowData) {
      // the tools see the request's base item, as at a call; the node checks auth again under the list hook
      result = await this.callNode(input, request, (result.workflowData[0]?.[0]?.json ?? {}) as DataObject);
      refusal = this.refusalOf(result);
      if (refusal) return refusal;
    }
    const subject = this.subjectOf(result);
    if (session && sessionId && session.subjectHash !== subject) {
      return session.transport === 'sse'
        ? rpc(401, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.noTransport))
        : rpc(404, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.sessionNotFound));
    }
    if (sessionId) await sessions.touch(sessionId);
    const request_ = parsed.kind === 'request' ? parsed.message : undefined;

    if (session?.transport === 'sse' && sessionId) {
      // the stream carries the answer: 202 now, so a long tool run never holds the POST open
      void this.answerOnStream(input, sessionId, id, () =>
        this.answerOf(input, result, request_, sessionId, modern),
      );
      return accepted();
    }
    const answered = await this.answerOf(input, result, request_, sessionId, modern);
    if ('reply' in answered) return answered.reply;
    const { answer } = answered;

    // initialize opens a Streamable HTTP session (an SSE session already exists)
    if (initialize && !session && answer && !answer.error) {
      const negotiated = (answer.result as DataObject | undefined)?.protocolVersion;
      let newId: string;
      try {
        newId = await sessions.create({
          tenantId: input.tenant.id,
          workflowId: input.workflowId,
          nodeName: input.node.name,
          subjectHash: subject,
          protocolVersion: typeof negotiated === 'string' ? negotiated : MCP_LEGACY_REVISIONS[0],
          transport: 'http',
        });
      } catch (error) {
        if (!(error instanceof McpSessionLimitError)) throw error;
        return rpc(429, mcpError(id, MCP_ERRORS.INTERNAL, TEXTS.tooManySessions));
      }
      return rpc(200, answer, { 'mcp-session-id': newId });
    }
    // notifications and a client's responses need no answer
    if (!answer) return accepted();
    return rpc(200, answer);
  }

  /** the answer of a message the node did not answer itself: ping, a tool call, or method not found */
  private async answerOf(
    input: McpTriggerRequest,
    result: WebhookResponseData,
    message: JsonRpcRequest | undefined,
    sessionId: string | undefined,
    modern: boolean,
  ): Promise<Answered> {
    if (result.webhookResponse && !result.workflowData) {
      return { answer: result.webhookResponse.body as JsonRpcResponse };
    }
    if (!message) return {};
    if (message.method === 'ping') {
      return { answer: mcpResult(message.id, modern ? mcpCompleteResult(message.method, {}) : {}) };
    }
    if (message.method === 'tools/call') {
      const base = (result.workflowData?.[0]?.[0]?.json ?? {}) as DataObject;
      // P6-15 (C0): the run acts for the user of a verified OAuth token (the node's `triggerUserId`), else nobody
      return this.callTool(input, message, base, sessionId, modern, result.triggerUserId);
    }
    return { answer: mcpError(message.id, MCP_ERRORS.METHOD_NOT_FOUND, TEXTS.methodNotFound) };
  }

  /**
   * An SSE POST's answer, sent after its 202: the main holding the stream writes it (the bus message is the answer
   * only). A failure or a used-up test URL goes out as a JSON-RPC error. Never throws.
   */
  private async answerOnStream(
    input: McpTriggerRequest,
    sessionId: string,
    id: JsonRpcId | null,
    work: () => Promise<Answered>,
  ): Promise<void> {
    let answer: JsonRpcResponse | undefined;
    try {
      const answered = await work();
      if ('reply' in answered) {
        // the used-up test URL's text names the URL
        const text = (answered.reply.body as { error?: { message?: unknown } } | undefined)?.error?.message;
        answer = mcpError(id, MCP_ERRORS.INTERNAL, typeof text === 'string' ? text : TEXTS.internal);
      } else {
        answer = answered.answer;
      }
    } catch (error) {
      answer = mcpError(id, MCP_ERRORS.INTERNAL, this.failure(input, error));
    }
    if (!answer) return;
    try {
      await this.deps.context().bus.publish(mcpSessionChannel(sessionId), { message: answer });
    } catch (error) {
      this.failure(input, error);
    }
  }

  // -------------------------------------------------------------------------------------------
  // tools/call: one execution

  private async callTool(
    input: McpTriggerRequest,
    message: JsonRpcRequest,
    base: DataObject,
    sessionId: string | undefined,
    modern: boolean,
    endUserId?: string,
  ): Promise<Answered> {
    const params = message.params ?? {};
    const toolName = params.name;
    const args = params.arguments === undefined ? {} : params.arguments;
    if (typeof toolName !== 'string' || !toolName || !isPlainObject(args)) {
      return { answer: mcpError(message.id, MCP_ERRORS.INVALID_PARAMS, TEXTS.badCall) };
    }
    const done = (result: McpCallResult) => ({
      answer: mcpResult(
        message.id,
        modern ? mcpCompleteResult(message.method, result as unknown as DataObject) : result,
      ),
    });
    // a test URL is used up by the first call, not by initialize or a list
    const lost = await input.claim?.();
    if (lost) return { reply: lost };

    const ctx = this.deps.context();
    const workflow = new Workflow(input.definition, ctx.registries.nodeTypes);
    const item = {
      json: {
        ...base,
        mcpToolCall: {
          toolName,
          arguments: args,
          sourceNodeName: sourceNodeOf(workflow, input.node, toolName),
        },
        mcpMessageId: message.id,
      },
    };
    // a running call keeps its session alive past the idle TTL, and the tenant cap never evicts it
    if (sessionId) this.deps.sessions.hold(sessionId);
    const keepAlive = sessionId
      ? setInterval(() => {
          this.deps.sessions.touch(sessionId).catch(() => {});
        }, this.keepAliveMs)
      : undefined;
    keepAlive?.unref();
    try {
      let execution: StartedExecution;
      try {
        execution = await ctx.executions.start({
          tenantId: input.tenant.id,
          workflow: input.definition,
          workflowId: input.workflowId,
          mode: input.mode,
          startNode: input.node.name,
          triggerItems: JSON.parse(JSON.stringify([item])),
          userId: input.userId,
          endUserId,
          wait: true,
        });
      } catch (error) {
        // limits and quotas: their texts are fixed and safe to show
        if (error instanceof ApiError)
          return { answer: mcpError(message.id, MCP_ERRORS.INTERNAL, error.message) };
        throw error;
      }
      input.onStarted?.(execution.executionId);
      const outcome = await this.awaitOutcome(execution);
      if (!outcome) return done(mcpErrorResult(toolName, TEXTS.timedOut));
      if (outcome.status === 'waiting') {
        return done({ content: [{ type: 'text', text: MCP_TOOL_WAITING }], isError: true });
      }
      if (outcome.status !== 'success') {
        return done(mcpErrorResult(toolName, redactSecrets(outcome.error?.message || 'Error in workflow')));
      }
      const items = (outcome.lastNodeOutput ?? []).find((o) => o?.length) ?? [];
      const json = items[0]?.json ?? {};
      const failure = json.mcpError;
      if (isPlainObject(failure)) {
        return {
          answer: mcpError(
            message.id,
            typeof failure.code === 'number' ? failure.code : MCP_ERRORS.INTERNAL,
            String(failure.message ?? TEXTS.internal),
          ),
        };
      }
      const result = json.mcpToolResult;
      if (!isPlainObject(result) || !Array.isArray(result.content)) {
        return done(mcpErrorResult(toolName, TEXTS.noResult));
      }
      return done(result as unknown as McpCallResult);
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      if (sessionId) this.deps.sessions.release(sessionId);
    }
  }

  /** the run's outcome, or undefined when it outlives the longest possible execution (a worker crashed) */
  private async awaitOutcome(execution: StartedExecution): Promise<ExecutionOutcome | undefined> {
    const limitMs = (this.deps.config.executionTimeout.maxS + 30) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), limitMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([execution.finished, timeout]);
      if (!outcome) this.deps.context().executions.discardWaiter(execution.executionId);
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------------------------
  // GET: legacy SSE stream

  private async openStream(input: McpTriggerRequest, request: WebhookRequest): Promise<WebhookReply> {
    const { sessions } = this.deps;
    const result = await this.callNode(input, request);
    const refusal = this.refusalOf(result);
    if (refusal) return refusal;
    if ((await sessions.countStreams(input.tenant.id)) >= MCP_TENANT_STREAM_CAP) {
      return rpc(429, mcpError(null, MCP_ERRORS.INTERNAL, TEXTS.tooManyStreams));
    }
    let sessionId: string;
    try {
      sessionId = await sessions.create({
        tenantId: input.tenant.id,
        workflowId: input.workflowId,
        nodeName: input.node.name,
        subjectHash: this.subjectOf(result),
        protocolVersion: SSE_REVISION,
        transport: 'sse',
      });
    } catch (error) {
      if (!(error instanceof McpSessionLimitError)) throw error;
      return rpc(429, mcpError(null, MCP_ERRORS.INTERNAL, TEXTS.tooManySessions));
    }
    // an open stream is never evicted by the tenant cap
    sessions.hold(sessionId);
    const stream = new PassThrough();
    const write = (chunk: string) => {
      if (!stream.destroyed && !stream.writableEnded) stream.write(chunk);
    };
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const keepAlive = setInterval(() => {
      write(': keep-alive\n\n');
      sessions
        .touch(sessionId)
        .then((alive) => {
          if (!alive) close();
        })
        .catch(() => {});
    }, this.keepAliveMs);
    keepAlive.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe?.();
      this.streams.delete(sessionId);
      sessions.release(sessionId);
      sessions.delete(sessionId).catch(() => {});
      if (!stream.destroyed) stream.end();
    };
    stream.on('close', close);
    stream.on('error', close);
    this.streams.set(sessionId, close);
    try {
      unsubscribe = await this.deps.context().bus.subscribe(mcpSessionChannel(sessionId), (payload) => {
        const message = (payload as { message?: unknown } | undefined)?.message;
        if (message) write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      });
    } catch (error) {
      close();
      throw error;
    }
    if (closed) unsubscribe();
    // the client posts its messages here; the path keeps /mcp or /mcp-test as the caller used it
    const path = (request.url ?? '').split('?')[0];
    write(`event: endpoint\ndata: ${path}?sessionId=${sessionId}\n\n`);
    return {
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
      stream,
    };
  }

  // -------------------------------------------------------------------------------------------
  // DELETE: end a Streamable HTTP session

  private async endSession(input: McpTriggerRequest, request: WebhookRequest): Promise<WebhookReply> {
    const result = await this.callNode(input, request);
    const refusal = this.refusalOf(result);
    if (refusal) return refusal;
    const sessionId = header(request.headers, 'mcp-session-id');
    if (!sessionId) return rpc(400, mcpError(null, MCP_ERRORS.INVALID_REQUEST, TEXTS.noSession));
    const session = await this.findSession(input, sessionId, 'http');
    if (!session || session.subjectHash !== this.subjectOf(result)) {
      return rpc(404, mcpError(null, MCP_ERRORS.INVALID_REQUEST, TEXTS.sessionNotFound));
    }
    await this.deps.sessions.delete(sessionId);
    return { statusCode: 200, headers: {} };
  }
}
