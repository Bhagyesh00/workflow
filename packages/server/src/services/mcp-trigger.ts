/**
 * The MCP Server Trigger's transport and run (P5-03). services/webhooks.ts hands a found `mcp` hook here (Host
 * already checked) before reading the body. This service reads and parses the JSON-RPC message
 * (`parseMcpMessage`; too large 413, malformed or a batch a JSON-RPC error), calls the node's `webhook` (auth and
 * the answers that need no run: `initialize`, `server/discover`, `tools/list`), then owns sessions
 * (`Mcp-Session-Id`, legacy SSE with `?sessionId=` and bus channel `mcp-session:<id>`), `ping`, notifications
 * (202), DELETE, and `tools/call`: `claim()`, then one execution with `{ ...baseItem, mcpToolCall, mcpMessageId }`
 * whose `lastNodeOutput` answers the POST. Every reply carries `mcpCorsHeaders`.
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
import type { McpSessionRecord, McpSessionStore } from './mcp-sessions';
import type { NodeWebhook } from './webhook-paths';
import { fromWebhookResponse, header, type IncomingWebhook, WebhookBodyError, type WebhookReply } from './webhooks';

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
  internal: 'Internal error',
  timedOut: 'The workflow did not respond in time',
  noResult: 'The tool gave no result',
} as const;

/** the bus channel an SSE session's answers travel on */
export const mcpSessionChannel = (sessionId: string) => `mcp-session:${sessionId}`;

const rpc = (statusCode: number, body: JsonRpcResponse, headers: Record<string, string> = {}): WebhookReply => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

const accepted = (): WebhookReply => ({ statusCode: 202, headers: {} });

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
      const message =
        input.mode === 'manual' ? redactSecrets((error as Error)?.message || TEXTS.internal) : TEXTS.internal;
      reply = rpc(500, mcpError(null, MCP_ERRORS.INTERNAL, message));
    }
    return { ...reply, headers: { ...cors, ...reply.headers } };
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

  /** the node's `webhook`: auth, and for `tools/list` only the connected tools (sub-nodes), closed in `finally` */
  private async callNode(
    input: McpTriggerRequest,
    request: WebhookRequest,
    withTools: boolean,
  ): Promise<WebhookResponseData> {
    const ctx = this.deps.context();
    const workflow = new Workflow(input.definition, ctx.registries.nodeTypes);
    const type = workflow.getNodeType(input.node);
    if (!type.webhook) throw new Error('The MCP Server Trigger cannot answer requests');
    this.mcpAuth ??= createMcpAuthHelper(this.deps.context);
    const services = await ctx.executions.buildServices({
      tenant: input.tenant,
      executionId: randomUUID(),
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
    // at list time a tool sees the request as `$json.body`, the same as the base item of a call
    const subNodes = withTools
      ? createWebhookSubNodes(deps, { json: { body: (request.body ?? {}) as DataObject[keyof DataObject] } })
      : undefined;
    try {
      return await type.webhook(createWebhookContext(deps, request, input.hook.webhookName, subNodes?.callbacks));
    } finally {
      await subNodes?.close();
    }
  }

  /** a refusal of the node (auth), sent as it is */
  private refusalOf(result: WebhookResponseData): WebhookReply | undefined {
    if (result.workflowData || !result.webhookResponse) return undefined;
    return (result.webhookResponse.statusCode ?? 200) >= 400 ? fromWebhookResponse(result.webhookResponse) : undefined;
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

    const result = await this.callNode(input, request, parsed.kind === 'request' && message?.method === 'tools/list');
    const refusal = this.refusalOf(result);
    if (refusal) return refusal;
    const subject = this.subjectOf(result);
    if (session && sessionId && session.subjectHash !== subject) {
      return session.transport === 'sse'
        ? rpc(401, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.noTransport))
        : rpc(404, mcpError(id, MCP_ERRORS.INVALID_REQUEST, TEXTS.sessionNotFound));
    }
    if (sessionId) await sessions.touch(sessionId);

    let answer: JsonRpcResponse | undefined;
    if (result.webhookResponse && !result.workflowData) {
      answer = result.webhookResponse.body as JsonRpcResponse;
    } else if (parsed.kind === 'request') {
      const base = (result.workflowData?.[0]?.[0]?.json ?? {}) as DataObject;
      const request_ = parsed.message;
      if (request_.method === 'ping') {
        answer = mcpResult(id, modern ? mcpCompleteResult(request_.method, {}) : {});
      } else if (request_.method === 'tools/call') {
        const call = await this.callTool(input, request_, base, sessionId, modern);
        if ('reply' in call) return call.reply;
        answer = call.answer;
      } else {
        answer = mcpError(id, MCP_ERRORS.METHOD_NOT_FOUND, TEXTS.methodNotFound);
      }
    }

    // initialize opens a Streamable HTTP session (an SSE session already exists)
    if (initialize && !session && answer && !answer.error) {
      const negotiated = (answer.result as DataObject | undefined)?.protocolVersion;
      const newId = await sessions.create({
        tenantId: input.tenant.id,
        workflowId: input.workflowId,
        nodeName: input.node.name,
        subjectHash: subject,
        protocolVersion: typeof negotiated === 'string' ? negotiated : MCP_LEGACY_REVISIONS[0],
        transport: 'http',
      });
      return rpc(200, answer, { 'mcp-session-id': newId });
    }
    // notifications and a client's responses need no answer
    if (!answer) return accepted();
    if (session?.transport === 'sse' && sessionId) {
      // the main holding the stream writes it; the message is the answer only
      await this.deps.context().bus.publish(mcpSessionChannel(sessionId), { message: answer });
      return accepted();
    }
    return rpc(200, answer);
  }

  // -------------------------------------------------------------------------------------------
  // tools/call: one execution

  private async callTool(
    input: McpTriggerRequest,
    message: JsonRpcRequest,
    base: DataObject,
    sessionId: string | undefined,
    modern: boolean,
  ): Promise<{ reply: WebhookReply } | { answer: JsonRpcResponse }> {
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
        mcpToolCall: { toolName, arguments: args, sourceNodeName: sourceNodeOf(workflow, input.node, toolName) },
        mcpMessageId: message.id,
      },
    };
    // a running call keeps its session alive past the idle TTL
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
          wait: true,
        });
      } catch (error) {
        // limits and quotas: their texts are fixed and safe to show
        if (error instanceof ApiError) return { answer: mcpError(message.id, MCP_ERRORS.INTERNAL, error.message) };
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
    const result = await this.callNode(input, request, false);
    const refusal = this.refusalOf(result);
    if (refusal) return refusal;
    if ((await sessions.countStreams(input.tenant.id)) >= MCP_TENANT_STREAM_CAP) {
      return rpc(429, mcpError(null, MCP_ERRORS.INTERNAL, TEXTS.tooManyStreams));
    }
    const sessionId = await sessions.create({
      tenantId: input.tenant.id,
      workflowId: input.workflowId,
      nodeName: input.node.name,
      subjectHash: this.subjectOf(result),
      protocolVersion: SSE_REVISION,
      transport: 'sse',
    });
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
    const result = await this.callNode(input, request, false);
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
