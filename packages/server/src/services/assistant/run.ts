/**
 * One Assistant turn (P5-67, lane L1): the run scope, the recording model and tool wrappers, `runAgent`
 * from `loadAiRuntime`, stop on an open card and resume from the stored history.
 *
 * A run (`AssistantRun`) holds the thread's run lock from `acquireRun` to `finish`: a heartbeat every
 * `ASSISTANT_HEARTBEAT_MS` (a lost lock aborts the turn), an AbortController joined to cancel, and one
 * ordered event queue, so stored ids follow the order things happened. Every turn, first or resumed,
 * builds its scope with `createRunScope`.
 *
 * The recording model wraps the guarded model. Before each call, in this order: it saves a `tool-error`
 * result for any call of the last answer that has none (`runAgent` answers an unknown name and invalid
 * arguments itself, so `toAiTools` never sees them); it stops with `AssistantTurnStop` when this run
 * holds an open card or a gate of this turn wrote one (answered meanwhile or not: the settle resumes it);
 * it compacts when the thread is over the limit, and after a compaction in this turn
 * it sends the stored view (system text with fresh notes, unsummarized messages, the turn's own user
 * message from the request) in place of `runAgent`'s fixed array. After each answer it rewrites a tool
 * call id the thread already holds, saves the assistant message and emits `text-block` and `tool-call`.
 * When the turn ends in any way, every call still without a result gets one. No message text is logged.
 *
 * The model's copy of the turn's text (never the stored message) ends with a manifest of the turn's files
 * (`assistantTurnInput`): index, name, type and how to read each one.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AiChatMessage,
  type AiChatModel,
  type AiChatRequest,
  type AiChatResponse,
  type AiMemory,
  type AiToolCall,
  ASSISTANT_MAX_ITERATIONS,
  ASSISTANT_STREAM,
  type AssistantEvent,
  type AssistantRunStatus,
  redactSecrets,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import { ApiError } from '../../http/errors';
import type { TenantSettings } from '../../plans';
import type { AssistantMessageRow } from '../../repositories/assistant-threads';
import { wrapUntrusted } from '../ai-builder/context';
import { type BuilderModel, BuilderModelError, NO_AI_PACKAGE } from '../ai-builder/model';
import type { AiRuntime } from '../ai-builder/runtime';
import type { Actor } from '../workflows';
import { attachmentImages, isImageAttachment } from './attachments';
import { compactIfNeeded, contentText } from './compaction';
import { type AssistantEventLog, redactDeep } from './events';
import { openMcpTools } from './mcp';
import { loadAssistantModel } from './model';
import { guardModel } from './model-guard';
import { assistantSystemPrompt } from './prompt';
import { ASSISTANT_HEARTBEAT_MS, ASSISTANT_RUN_LOST } from './sweep';
import { type ToolGate, toAiTools } from './tool-adapter';
import { assistantTools } from './tools';
import {
  type AssistantRunScope,
  type AssistantToolDefinition,
  AssistantTurnStop,
  type StoredAttachment,
} from './types';

export interface CreateRunScopeInput {
  tenantId: string;
  userId: string;
  threadId: string;
  runId: string;
  actor: Actor;
  signal: AbortSignal;
  attachments: StoredAttachment[];
}

/** the abort reasons of a run's controller */
export const RUN_CANCELLED = 'assistant:cancelled';
export const RUN_LOST = 'assistant:lost';
export const RUN_CLOSED = 'assistant:closed';

/** the result a call left open by a cancel gets */
export const ASSISTANT_CALL_CANCELLED = 'The person stopped the run before this finished';
/** the result a call left open by an error gets */
export const ASSISTANT_CALL_ENDED = 'The run ended before this finished';
/** the status turn a resumed run starts with (our own text) */
export const ASSISTANT_RESUME_TEXT =
  'The person answered the request above. The tool results now show what happened. Continue with the task.';
/** the finish reason when the server shuts down */
export const ASSISTANT_SERVER_CLOSED = 'The server stopped during the run';

// ---------------------------------------------------------------------------------------------
// events

/** one run's events in order: each waits for the previous one to be stored and published */
class EventQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: ServerContext,
    private readonly log: AssistantEventLog,
    private readonly tenantId: string,
    private readonly threadId: string,
  ) {}

  push(event: AssistantEvent): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.log.append(this.tenantId, this.threadId, event);
      } catch (error) {
        this.ctx.logger.warn(
          {
            tenantId: this.tenantId,
            threadId: this.threadId,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Assistant event not stored',
        );
      }
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }
}

/** the queues of the runs of this process, by run id (scopes of one run share one) */
const queues = new Map<string, EventQueue>();

function queueOf(ctx: ServerContext, tenantId: string, threadId: string, runId: string): EventQueue {
  let queue = queues.get(runId);
  if (!queue) {
    queue = new EventQueue(ctx, ctx.assistant.events, tenantId, threadId);
    queues.set(runId, queue);
  }
  return queue;
}

/**
 * The scope of one turn, first or resumed: tenant, user and role read now, the effective settings,
 * `sendValues`, the turn's attachments and `emit` bound to this thread and run.
 */
export async function createRunScope(
  ctx: ServerContext,
  input: CreateRunScopeInput,
): Promise<AssistantRunScope> {
  const tenant = await ctx.repos.tenants.get(input.tenantId);
  if (!tenant) throw ApiError.notFound('Workspace');
  const user = await ctx.repos.users.get(input.userId);
  if (!user) throw ApiError.notFound('User');
  const membership = await ctx.repos.memberships.get(input.tenantId, input.userId);
  if (!membership) throw ApiError.forbidden('You are no longer a member of this workspace');
  const settings = await ctx.assistantSettings.read(tenant);
  const queue = queueOf(ctx, input.tenantId, input.threadId, input.runId);
  return {
    tenant,
    user,
    role: membership.role,
    actor: input.actor,
    threadId: input.threadId,
    runId: input.runId,
    signal: input.signal,
    settings,
    sendValues: settings.sendValues,
    attachments: input.attachments,
    emit: (event) => queue.push({ ...event, runId: input.runId } as AssistantEvent),
  };
}

// ---------------------------------------------------------------------------------------------
// the run

export interface AssistantRunKey {
  tenantId: string;
  userId: string;
  threadId: string;
  runId: string;
  actor: Actor;
}

export interface TurnOutcome {
  status: AssistantRunStatus;
  reason?: string;
}

/**
 * One run of a thread on this process: the lock `acquireRun` took, the heartbeat, the turn's
 * AbortController and the event queue. `finish` closes every run.
 */
export class AssistantRun {
  readonly controller = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private finished = false;

  constructor(
    readonly ctx: ServerContext,
    readonly key: AssistantRunKey,
  ) {
    this.heartbeat = setInterval(() => {
      void ctx.repos.assistantThreads
        .heartbeat(key.tenantId, key.threadId, key.runId)
        .then((held) => {
          if (!held) this.abort(RUN_LOST);
        })
        // a failed write keeps the run: the next tick tries again, the sweep decides after 2 minutes
        .catch(() => {});
    }, ASSISTANT_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  /** an event of this run (outside a scope: run-start, errors, run-finish) */
  emit(event: AssistantEvent): void {
    queueOf(this.ctx, this.key.tenantId, this.key.threadId, this.key.runId).push({
      ...event,
      runId: this.key.runId,
    } as AssistantEvent);
  }

  /** what an aborted run ends as */
  abortOutcome(): TurnOutcome {
    const reason = this.signal.reason;
    if (reason === RUN_LOST) return { status: 'error', reason: ASSISTANT_RUN_LOST };
    if (reason === RUN_CLOSED) return { status: 'cancelled', reason: ASSISTANT_SERVER_CLOSED };
    return { status: 'cancelled' };
  }

  /**
   * Ends the run: a result for each call still open, `run-finish`, the events flushed, the heartbeat
   * stopped and the lock released. Writes that fail (a thread deleted meanwhile) are skipped quietly.
   */
  async finish(outcome: TurnOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const { ctx, key } = this;
    const repo = ctx.repos.assistantThreads;
    const text = outcome.status === 'cancelled' ? ASSISTANT_CALL_CANCELLED : ASSISTANT_CALL_ENDED;
    try {
      for (const call of await repo.openToolCalls(key.tenantId, key.threadId, key.runId)) {
        await repo.appendMessage(key.tenantId, key.threadId, {
          runId: key.runId,
          role: 'tool',
          content: `Error: ${text}`,
          toolCallId: call.id,
          name: call.name,
        });
        this.emit({
          type: 'tool-error',
          runId: key.runId,
          payload: { toolCallId: call.id, toolName: call.name, error: text },
        });
      }
    } catch {
      /* the thread is gone */
    }
    this.emit({
      type: 'run-finish',
      runId: key.runId,
      payload: {
        status: outcome.status,
        ...(outcome.reason ? { reason: redactSecrets(outcome.reason) } : {}),
      },
    });
    const queue = queues.get(key.runId);
    await queue?.flush();
    queues.delete(key.runId);
    clearInterval(this.heartbeat);
    await repo.releaseRun(key.tenantId, key.threadId, key.runId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// the turn

export interface AssistantTurn {
  runtime: AiRuntime | undefined;
  extraTools: AssistantToolDefinition[];
  resumed: boolean;
  /** the text `runAgent` gets as the turn's user message (the person's text, or the status turn) */
  input: string;
  /** a chat turn: the stored user message (left out of the history; the request's copy takes its place) */
  userSeq: number | null;
  attachments: StoredAttachment[];
  /** false when the caller already emitted `run-start` (a settle) */
  announce?: boolean;
}

/** the files a turn's manifest lists by name; more get one "and N more" line */
export const ASSISTANT_MANIFEST_FILES = 10;
/** what the model is asked when the person sent files without any text (our own text) */
export const ASSISTANT_FILES_ONLY_TEXT =
  'The person sent files without a message. Look at the first file (index 0) and give a short summary of it.';

/** a file name or type as one clean line: control characters and newlines gone, cut to `max` */
function manifestText(value: string, max: number): string {
  return redactSecrets(String(value ?? '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' '))
    .trim()
    .slice(0, max);
}

/**
 * The text `runAgent` gets for a turn: the person's text (or `ASSISTANT_FILES_ONLY_TEXT` when they sent
 * only files), then one line per file in send order (`index: name (type): how to read it`). The index is
 * `parse_file`'s `attachmentIndex`, images included. Names and types are the person's or a third party's
 * text, so they come cleaned, cut and inside `wrapUntrusted`.
 */
export function assistantTurnInput(
  text: string,
  files: ReadonlyArray<{ fileName: string; mimeType: string }>,
): string {
  if (files.length === 0) return text;
  const lines = files.slice(0, ASSISTANT_MANIFEST_FILES).map((file, index) => {
    const how = isImageAttachment(file)
      ? 'an image, shown to you with this message'
      : 'read it with parse_file';
    return `${index}: ${manifestText(file.fileName, 200)} (${manifestText(file.mimeType, 100)}): ${how}`;
  });
  if (files.length > ASSISTANT_MANIFEST_FILES) {
    lines.push(`... and ${files.length - ASSISTANT_MANIFEST_FILES} more`);
  }
  const head = text.trim() ? text : ASSISTANT_FILES_ONLY_TEXT;
  const list = wrapUntrusted('attached-files', lines.join('\n'));
  return `${head}\n\nAttached files (index: name (type): how to read it):\n${list}`;
}

/** the text a client sees for a failed turn: our own refusals as written, other errors redacted */
export function turnErrorText(error: unknown): string {
  if (error instanceof BuilderModelError || error instanceof ApiError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text) || 'The AI model did not answer';
}

/** a fresh id for a clashing tool call id, keeping its prefix (`call_`, `gemini_call_`, `toolu_`) */
export function freshToolCallId(old: string, taken: Set<string>): string {
  const prefix = /^(.*_)/.exec(old ?? '')?.[1] ?? 'call_';
  for (;;) {
    const id = `${prefix}${randomBytes(12).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Stored messages as the model's view: in `seq` order, the results of an assistant message right after it
 * in call order, a call without a stored result answered with an error, a result without its call left
 * out. So no request ever holds a dangling call.
 */
export function toChatMessages(rows: AssistantMessageRow[]): AiChatMessage[] {
  const results = new Map<string, AssistantMessageRow>();
  for (const row of rows) {
    if (row.role === 'tool' && row.toolCallId && !results.has(row.toolCallId))
      results.set(row.toolCallId, row);
  }
  const out: AiChatMessage[] = [];
  for (const row of rows) {
    if (row.role === 'tool' || row.role === 'system') continue;
    if (row.role === 'assistant' && row.toolCalls?.length) {
      out.push({ role: 'assistant', content: contentText(row.content), toolCalls: row.toolCalls });
      for (const call of row.toolCalls) {
        const result = results.get(call.id);
        out.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result ? contentText(result.content) : `Error: ${ASSISTANT_CALL_ENDED}`,
        });
      }
      continue;
    }
    out.push({ role: row.role, content: contentText(row.content) });
  }
  return out;
}

const AGENT_NODE: WorkflowNode = {
  id: 'assistant',
  name: 'Assistant',
  type: 'ai.agent',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

/** `inner` with hooks before each call (what to send) and after each answer (what to keep) */
function recordingModel(
  inner: AiChatModel,
  hooks: {
    before(request: AiChatRequest): Promise<AiChatMessage[]>;
    after(response: AiChatResponse): Promise<AiChatResponse>;
  },
): AiChatModel {
  const call = async (
    request: AiChatRequest,
    send: (request: AiChatRequest) => Promise<AiChatResponse>,
  ): Promise<AiChatResponse> => {
    const messages = await hooks.before(request);
    const response = await send({ ...request, messages });
    return hooks.after(response);
  };
  const model: AiChatModel = {
    kind: 'chatModel',
    provider: inner.provider,
    model: inner.model,
    chat: (request) => call(request, (r) => inner.chat(r)),
  };
  const capabilities = (inner as { capabilities?: unknown }).capabilities;
  if (capabilities !== undefined) Object.assign(model, { capabilities });
  if (inner.stream) {
    const stream = inner.stream.bind(inner);
    model.stream = (request, onDelta) => call(request, (r) => stream(r, onDelta));
  }
  return model;
}

/**
 * One turn under `run`: the model, compaction, the tools of the caller's role and the MCP tools,
 * `runAgent` with the recording model. Answers how the turn ended; `run.finish` is the caller's.
 */
export async function executeTurn(run: AssistantRun, turn: AssistantTurn): Promise<TurnOutcome> {
  const { ctx, key } = run;
  const repo = ctx.repos.assistantThreads;
  const { tenantId, threadId, runId } = key;
  let builderModel: BuilderModel | undefined;
  let mcp: { close(): Promise<void> } | undefined;
  try {
    if (turn.announce !== false) {
      run.emit({ type: 'run-start', runId, payload: { resumed: turn.resumed } });
    }
    if (!turn.runtime) throw new BuilderModelError(NO_AI_PACKAGE);
    const runtime = turn.runtime;
    const scope = await createRunScope(ctx, {
      tenantId,
      userId: key.userId,
      threadId,
      runId,
      actor: key.actor,
      signal: run.signal,
      attachments: turn.attachments,
    });
    builderModel = await loadAssistantModel(ctx, scope.tenant, scope.settings, run.signal);
    const guarded = guardModel(builderModel.model, {
      idleMs: ctx.config.assistant.streamIdleTimeoutMs,
      firstOutputMs: ctx.config.assistant.streamFirstOutputTimeoutMs,
      stallRetries: ASSISTANT_STREAM.stallRetries,
    });

    // before the turn: the stored view shrinks first, so the history below is already the short one
    await compactIfNeeded({ ctx, run: scope, model: guarded, signal: run.signal });

    const opened = await openMcpTools(ctx, scope);
    mcp = opened;
    const defs = [...assistantTools(scope.role, scope.settings, turn.extraTools), ...opened.tools];
    // a card written in this turn stops it at the next model call, even when it was answered meanwhile
    let cardWritten = false;
    const gate: ToolGate = {
      gate: async (...args) => {
        const decision = await ctx.assistantApprovals.gate(...args);
        if (decision.decision === 'suspended') cardWritten = true;
        return decision;
      },
    };
    const tools = toAiTools(ctx, defs, scope, gate);
    const toolNames = tools.map((tool) => tool.name);
    const timezone = ((scope.tenant.settings ?? {}) as TenantSettings).timezone;
    const systemText = async () =>
      assistantSystemPrompt({
        role: scope.role,
        observations: await repo.getObservations(tenantId, threadId),
        toolNames,
        timezone,
      });

    // the history: chat turns leave out their own user message, resumed turns take everything so far
    const startSeq = await repo.lastSeq(tenantId, threadId);
    const isBefore = (row: AssistantMessageRow) =>
      turn.userSeq !== null ? Number(row.seq) < turn.userSeq : Number(row.seq) <= startSeq;
    const isAfter = (row: AssistantMessageRow) =>
      turn.userSeq !== null ? Number(row.seq) > turn.userSeq : Number(row.seq) > startSeq;
    let historyLength = 0;
    const memory: AiMemory & { sessionId: string } = {
      kind: 'memory',
      sessionId: threadId,
      load: async () => {
        const rows = await repo.listMessages(tenantId, threadId);
        const history = toChatMessages(rows.filter(isBefore));
        historyLength = history.length;
        return history;
      },
      loadAll: async () =>
        toChatMessages(await repo.listMessages(tenantId, threadId, { includeSummarized: true })),
      // the run loop stores every message itself, never through the agent's memory
      append: async () => {},
      replace: async () => {},
      clear: async () => {},
    };

    let compacted = false;
    let lastCalls: AiToolCall[] = [];
    const recorder = recordingModel(guarded, {
      before: async (request) => {
        // 1. results `runAgent` gave without `toAiTools` (unknown tool, invalid arguments)
        if (lastCalls.length) {
          const calls = lastCalls;
          lastCalls = [];
          const answered = await repo.answeredToolCallIds(
            tenantId,
            threadId,
            calls.map((c) => c.id),
          );
          for (const call of calls) {
            if (answered.has(call.id)) continue;
            const given = request.messages.find((m) => m.role === 'tool' && m.toolCallId === call.id);
            const text = redactSecrets(given ? contentText(given.content) : `Error: ${ASSISTANT_CALL_ENDED}`);
            await repo.appendMessage(tenantId, threadId, {
              runId,
              role: 'tool',
              content: text,
              toolCallId: call.id,
              name: call.name,
            });
            scope.emit({
              type: 'tool-error',
              runId,
              payload: { toolCallId: call.id, toolName: call.name, error: text.replace(/^Error:\s*/, '') },
            });
          }
        }
        // 2. a card of this run waits, or was answered meanwhile (approved, denied, expired) and waits for
        // the settle: the turn stops here, so the model never reads the placeholder as the answer
        if (cardWritten) throw new AssistantTurnStop();
        const open = await ctx.repos.assistantConfirmations.listOpenForRun(tenantId, threadId, runId);
        if (open.length) throw new AssistantTurnStop();
        // 3. a long turn shrinks between calls
        if (await compactIfNeeded({ ctx, run: scope, model: guarded, signal: run.signal })) compacted = true;
        if (!compacted) return request.messages;
        const rows = await repo.listMessages(tenantId, threadId);
        const own = request.messages[1 + historyLength];
        return [
          { role: 'system', content: await systemText() },
          ...toChatMessages(rows.filter(isBefore)),
          ...(own ? [own] : []),
          ...toChatMessages(rows.filter(isAfter)),
        ];
      },
      after: async (response) => {
        const message = response.message;
        let calls = message.toolCalls ?? [];
        if (calls.length) {
          // an id the thread already holds (`call_0` on every answer) gets a fresh one before the loop reads it
          const taken = new Set(await repo.listToolCallIds(tenantId, threadId));
          calls = calls.map((call) => {
            const id = !call.id || taken.has(call.id) ? freshToolCallId(call.id, taken) : call.id;
            taken.add(id);
            return id === call.id ? call : { ...call, id };
          });
        }
        const text = redactSecrets(contentText(message.content));
        const stored = calls.length ? redactDeep(calls) : null;
        const row = await repo.appendMessage(tenantId, threadId, {
          runId,
          role: 'assistant',
          content: text,
          toolCalls: stored,
        });
        lastCalls = calls;
        if (text) scope.emit({ type: 'text-block', runId, payload: { messageId: row.id, text } });
        for (const call of stored ?? []) {
          scope.emit({
            type: 'tool-call',
            runId,
            payload: { toolCallId: call.id, toolName: call.name, args: call.arguments ?? {} },
          });
        }
        return calls.length ? { ...response, message: { ...message, toolCalls: calls } } : response;
      },
    });

    const images = await attachmentImages(ctx, tenantId, turn.attachments);
    await runtime.runAgent({
      node: AGENT_NODE,
      itemIndex: 0,
      model: recorder,
      tools,
      memory,
      sessionId: threadId,
      systemMessage: await systemText(),
      input: assistantTurnInput(turn.input, turn.attachments),
      ...(images.length ? { attachments: images } : {}),
      maxIterations: ASSISTANT_MAX_ITERATIONS,
      toolErrorBehavior: 'feedback',
      streaming: true,
      onChunk: (delta) => {
        if (delta) scope.emit({ type: 'text-delta', runId, payload: { text: delta } });
      },
      signal: run.signal,
    });
    return { status: 'completed' };
  } catch (error) {
    if (error instanceof AssistantTurnStop) return { status: 'suspended' };
    if (run.signal.aborted) return run.abortOutcome();
    const message = turnErrorText(error);
    ctx.logger.warn(
      { tenantId, threadId, runId, error: error instanceof Error ? error.name : 'unknown' },
      'Assistant turn failed',
    );
    run.emit({ type: 'error', runId, payload: { message } });
    return { status: 'error', reason: message };
  } finally {
    await mcp?.close().catch(() => {});
    await builderModel?.close().catch(() => {});
  }
}

/** a run id for a new run */
export function newRunId(): string {
  return randomUUID();
}
