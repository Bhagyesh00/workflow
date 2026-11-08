/**
 * The Assistant (P5-67, lane L1): threads of one user in one tenant, chat turns, cancel, resume after a
 * card, the event stream and the leader sweeps. Every method that takes `auth` names its tenant and
 * user; another user's or tenant's thread is 404. The constructor, `sweep`, `pruneThreads` and `close`
 * never throw (`createContext`, the leader timers and `close()` run them in every server test).
 *
 * A chat: the model must be set, the AI package loaded, the files valid; this thread's expired cards are
 * swept, an open card refuses (409), `acquireRun` takes the lock (409 while another run holds it), the
 * concurrency limits apply (a 429 releases the lock), the files are stored and the user message saved
 * through `redactSecrets`; `{ runId }` answers at once and the turn runs on. Nothing about a message is
 * logged.
 */
import {
  type AssistantConfirmation,
  type AssistantEvent,
  type AssistantMessageDTO,
  type AssistantMessagesPage,
  type AssistantSendMessage,
  type AssistantStatusDTO,
  type AssistantThreadDTO,
  redactSecrets,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { decodeCursor, encodeCursor, page } from '../../http/pagination';
import type { AssistantConfirmationRow } from '../../repositories/assistant-confirmations';
import type { AssistantMessageRow, AssistantThreadRow } from '../../repositories/assistant-threads';
import { NO_AI_PACKAGE } from '../ai-builder/model';
import { type AiRuntime, loadAiRuntime } from '../ai-builder/runtime';
import type { Actor } from '../workflows';
import { ASSISTANT_APPROVAL_TEXTS } from './approvals';
import { storeAttachments, validateAttachments } from './attachments';
import { contentText } from './compaction';
import { ASSISTANT_CANCEL_CHANNEL, ASSISTANT_REPLAY_PAGE, AssistantEventLog } from './events';
import { ASSISTANT_NO_MODEL } from './model';
import {
  ASSISTANT_RESUME_TEXT,
  AssistantRun,
  type AssistantRunKey,
  createRunScope,
  executeTurn,
  newRunId,
  RUN_CANCELLED,
  RUN_CLOSED,
  type TurnOutcome,
  turnErrorText,
} from './run';
import { pruneThreads, sweepRuns } from './sweep';
import type { AssistantToolDefinition } from './types';

export interface AssistantServiceOptions {
  /** `createContext`'s `aiRuntime` (tests); else `loadAiRuntime` loads the installed AI package */
  aiRuntime?: AiRuntime;
  /** `createContext`'s `assistantTools`: the test seam, offered after the built-in tools */
  extraTools?: AssistantToolDefinition[];
}

export interface AssistantThreadListQuery {
  limit: number;
  cursor?: string;
}

/** a thread's title is the first characters of its first message */
export const ASSISTANT_TITLE_CHARS = 60;
export const ASSISTANT_OPEN_CARD = 'Answer the request above first';
export const ASSISTANT_RUN_ACTIVE = 'A run is already active for this thread';
export const ASSISTANT_TOO_MANY_RUNS = 'Too many Assistant runs are active right now. Try again in a moment.';
/** the reason stored on cards a cancel denies */
export const ASSISTANT_CANCEL_REASON = 'The person stopped the run';
/** how long a delete or a cancel waits for this process's run to end */
const STOP_WAIT_MS = 10_000;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function threadDto(row: AssistantThreadRow): AssistantThreadDTO {
  return { id: row.id, title: row.title, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

/** a stored message as a client sees it: text, calls, refs of the files (never their data) */
function messageDto(row: AssistantMessageRow): AssistantMessageDTO {
  const role = row.role === 'system' ? 'assistant' : row.role;
  return {
    id: row.id,
    runId: row.runId,
    role,
    content: contentText(row.content),
    ...(row.toolCalls?.length
      ? {
          toolCalls: row.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.arguments ?? {},
          })),
        }
      : {}),
    ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.attachments?.length
      ? {
          attachments: row.attachments.map((file) => ({
            fileName: file.fileName,
            mimeType: file.mimeType,
            size: file.size,
          })),
        }
      : {}),
    summarized: row.summarized,
    createdAt: iso(row.createdAt),
  };
}

/** a card row as the client's card, when no stored `confirmation-request` event has it */
function cardOf(row: AssistantConfirmationRow): AssistantConfirmation {
  return {
    requestId: row.id,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    title: row.toolName,
    allowSession: Boolean(row.grantKey),
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    createdAt: iso(row.createdAt),
    inputType: row.inputType,
    details: row.details,
  } as AssistantConfirmation;
}

interface LocalRun {
  run: AssistantRun;
  done: Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export class AssistantService {
  readonly extraTools: AssistantToolDefinition[];
  readonly events: AssistantEventLog;
  private runtimePromise?: Promise<AiRuntime | undefined>;
  /** this process's runs, by `<tenantId>:<threadId>` */
  private readonly local = new Map<string, LocalRun>();
  private cancelListener?: Promise<() => void>;
  private closed = false;

  constructor(
    readonly deps: ServiceDeps,
    readonly options: AssistantServiceOptions = {},
  ) {
    this.extraTools = options.extraTools ?? [];
    this.events = new AssistantEventLog(deps);
  }

  /** the AI runtime, loaded once; undefined when the AI package is not installed */
  runtime(): Promise<AiRuntime | undefined> {
    this.runtimePromise ??= loadAiRuntime(this.options.aiRuntime);
    return this.runtimePromise;
  }

  private get repo() {
    return this.deps.repos.assistantThreads;
  }

  /** the caller's thread or 404 */
  private async own(auth: AuthContext, threadId: string): Promise<AssistantThreadRow> {
    const row = await this.repo.get(auth.tenant.id, auth.user.id, threadId);
    if (!row) throw ApiError.notFound('Thread');
    return row;
  }

  async createThread(auth: AuthContext, body?: { title?: string }): Promise<AssistantThreadDTO> {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    return threadDto(await this.repo.create(auth.tenant.id, auth.user.id, { title }));
  }

  /** the caller's threads, newest first (keyset on updated_at, id) */
  async listThreads(
    auth: AuthContext,
    query: AssistantThreadListQuery,
  ): Promise<{ data: AssistantThreadDTO[]; nextCursor: string | null }> {
    const rows = await this.repo.list(auth.tenant.id, auth.user.id, {
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    const result = page(rows, query.limit, (row) => encodeCursor(row.updatedAt, row.id));
    return { data: result.data.map(threadDto), nextCursor: result.nextCursor };
  }

  async getThread(auth: AuthContext, threadId: string): Promise<AssistantThreadDTO> {
    return threadDto(await this.own(auth, threadId));
  }

  async renameThread(auth: AuthContext, threadId: string, title: string): Promise<AssistantThreadDTO> {
    const row = await this.repo.rename(auth.tenant.id, auth.user.id, threadId, title.trim());
    if (!row) throw ApiError.notFound('Thread');
    return threadDto(row);
  }

  /** cancels the run first and denies its cards, then deletes the thread and its binary data */
  async deleteThread(auth: AuthContext, threadId: string): Promise<void> {
    const thread = await this.own(auth, threadId);
    await this.stopRun(thread.tenantId, auth.user.id, thread.id);
    await this.denyCards(thread.tenantId, thread.id, false);
    await this.repo.delete(auth.tenant.id, auth.user.id, thread.id);
    await this.deps.context().executions.removeBinaryData(thread.tenantId, thread.id);
  }

  /** every stored message (summarized ones too), attachments as refs only, and `nextEventId` */
  async messages(auth: AuthContext, threadId: string): Promise<AssistantMessagesPage> {
    const thread = await this.own(auth, threadId);
    // the cursor first: an event stored after it is streamed again rather than missed
    const lastEventId = await this.repo.lastEventId(thread.tenantId, thread.id);
    const rows = await this.repo.listMessages(thread.tenantId, thread.id, { includeSummarized: true });
    return {
      messages: rows.filter((row) => row.role !== 'system').map(messageDto),
      nextEventId: lastEventId + 1,
    };
  }

  async status(auth: AuthContext, threadId: string): Promise<AssistantStatusDTO> {
    const thread = await this.own(auth, threadId);
    const cards = this.deps.repos.assistantConfirmations;
    const now = new Date();
    const pendingRows = await cards.listPending(thread.tenantId, auth.user.id, thread.id, now);
    const open = await cards.hasOpen(thread.tenantId, thread.id, now);
    const shown = await this.repo.confirmationEvents(
      thread.tenantId,
      thread.id,
      pendingRows.map((row) => row.id),
    );
    const byId = new Map<string, AssistantConfirmation>();
    for (const event of shown) {
      if (event.type === 'confirmation-request')
        byId.set(event.payload.confirmation.requestId, event.payload.confirmation);
    }
    return {
      hasActiveRun: thread.activeRunId !== null,
      isSuspended: open,
      pending: pendingRows.map((row) => byId.get(row.id) ?? cardOf(row)),
    };
  }

  /**
   * Starts a turn and answers `{ runId }` at once. `actor` carries the request's IP (default: the
   * caller with no IP).
   */
  async chat(
    auth: AuthContext,
    threadId: string,
    body: AssistantSendMessage,
    actor?: Actor,
  ): Promise<{ runId: string }> {
    const ctx = this.deps.context();
    const thread = await this.own(auth, threadId);
    const tenantId = thread.tenantId;
    const settings = await ctx.assistantSettings.read(auth.tenant);
    if (!settings.model) throw ApiError.badRequest(ASSISTANT_NO_MODEL);
    const runtime = await this.runtime();
    if (!runtime) throw ApiError.badRequest(NO_AI_PACKAGE);
    validateAttachments(body.attachments);

    const now = new Date();
    // an expired card that the sweep has not reached yet never blocks a message
    await ctx.assistantApprovals.sweepExpired(now, thread.id);
    if (await ctx.repos.assistantConfirmations.hasOpen(tenantId, thread.id, now)) {
      throw ApiError.conflict(ASSISTANT_OPEN_CARD);
    }
    const runId = newRunId();
    if (!(await this.repo.acquireRun(tenantId, thread.id, runId)))
      throw ApiError.conflict(ASSISTANT_RUN_ACTIVE);

    const key: AssistantRunKey = {
      tenantId,
      userId: auth.user.id,
      threadId: thread.id,
      runId,
      actor: actor ?? { userId: auth.user.id },
    };
    let userSeq: number;
    let text: string;
    let attachments: Awaited<ReturnType<typeof storeAttachments>>;
    try {
      const { maxConcurrentRuns, maxConcurrentRunsPerUser } = this.deps.config.assistant;
      if (
        (maxConcurrentRuns >= 0 && (await this.repo.countActiveRuns()) > maxConcurrentRuns) ||
        (maxConcurrentRunsPerUser >= 0 &&
          (await this.repo.countActiveRuns(auth.user.id)) > maxConcurrentRunsPerUser)
      ) {
        throw ApiError.tooMany(ASSISTANT_TOO_MANY_RUNS);
      }
      attachments = await storeAttachments(ctx, tenantId, thread.id, body.attachments ?? []);
      text = redactSecrets(body.message ?? '');
      const row = await this.repo.appendMessage(tenantId, thread.id, {
        runId,
        role: 'user',
        content: text,
        attachments: attachments.length ? attachments : null,
      });
      userSeq = Number(row.seq);
      await this.repo.touch(tenantId, thread.id);
    } catch (error) {
      await this.repo.releaseRun(tenantId, thread.id, runId);
      throw error;
    }

    const run = this.startRun(key);
    if (!thread.title.trim() && text.trim()) {
      const title = text.trim().slice(0, ASSISTANT_TITLE_CHARS);
      await this.repo.setTitle(tenantId, thread.id, title);
      run.emit({ type: 'thread-title-updated', runId, payload: { title } });
    }
    this.track(
      run,
      (async () => {
        const outcome = await executeTurn(run, {
          runtime,
          extraTools: this.extraTools,
          resumed: false,
          input: text,
          userSeq,
          attachments,
        });
        await this.end(run, outcome);
      })(),
    );
    return { runId };
  }

  /** idempotent; crosses mains on the bus; pending cards denied */
  async cancel(auth: AuthContext, threadId: string): Promise<void> {
    const thread = await this.own(auth, threadId);
    await this.stopRun(thread.tenantId, auth.user.id, thread.id);
    await this.denyCards(thread.tenantId, thread.id, true);
  }

  /** a new turn from the stored history with one short status turn (after a card) */
  async resumeThread(tenantId: string, userId: string, threadId: string, actor: Actor): Promise<void> {
    const runId = newRunId();
    if (!(await this.repo.acquireRun(tenantId, threadId, runId))) return;
    const run = this.startRun({ tenantId, userId, threadId, runId, actor });
    const done = (async () => {
      let outcome: TurnOutcome;
      try {
        const attachments = await this.repo.turnAttachments(tenantId, threadId);
        outcome = await executeTurn(run, {
          runtime: await this.runtime(),
          extraTools: this.extraTools,
          resumed: true,
          input: ASSISTANT_RESUME_TEXT,
          userSeq: null,
          attachments,
        });
      } catch (error) {
        outcome = this.failed(run, error);
      }
      await this.end(run, outcome);
    })();
    this.track(run, done);
    await done.catch(() => {});
  }

  /** runs the approved cards of the thread in call order under one run lock, then resumes the turn */
  async settleConfirmations(tenantId: string, userId: string, threadId: string, actor: Actor): Promise<void> {
    const runId = newRunId();
    // false: another run holds the thread, and it settles what is approved when it ends
    if (!(await this.repo.acquireRun(tenantId, threadId, runId))) return;
    const ctx = this.deps.context();
    const run = this.startRun({ tenantId, userId, threadId, runId, actor });
    const done = (async () => {
      let outcome: TurnOutcome;
      try {
        run.emit({ type: 'run-start', runId, payload: { resumed: true } });
        const attachments = await this.repo.turnAttachments(tenantId, threadId);
        const scope = await createRunScope(ctx, {
          tenantId,
          userId,
          threadId,
          runId,
          actor,
          signal: run.signal,
          attachments,
        });
        const rows = await ctx.repos.assistantConfirmations.listApproved(tenantId, threadId);
        // call order: the position in the stored `tool_calls`, since one `Promise.all` writes rows in any order
        const order = await this.repo.listToolCallIds(tenantId, threadId);
        const position = (row: AssistantConfirmationRow) => {
          const at = order.indexOf(row.toolCallId);
          return at < 0 ? Number.MAX_SAFE_INTEGER : at;
        };
        for (const row of [...rows].sort((a, b) => position(a) - position(b))) {
          if (run.signal.aborted) break;
          await ctx.assistantApprovals.runApproved(scope, row);
        }
        if (run.signal.aborted) outcome = run.abortOutcome();
        else if ((await ctx.repos.assistantConfirmations.listPending(tenantId, userId, threadId)).length) {
          outcome = { status: 'suspended' };
        } else {
          outcome = await executeTurn(run, {
            runtime: await this.runtime(),
            extraTools: this.extraTools,
            resumed: true,
            input: ASSISTANT_RESUME_TEXT,
            userSeq: null,
            attachments,
            announce: false,
          });
        }
      } catch (error) {
        outcome = this.failed(run, error);
      }
      await this.end(run, outcome);
    })();
    this.track(run, done);
    await done.catch(() => {});
  }

  /** the one door for events sent outside a turn (L3's confirm, L7's Accept); the stored id */
  async publish(tenantId: string, threadId: string, event: AssistantEvent): Promise<number> {
    return (await this.events.append(tenantId, threadId, event)) ?? 0;
  }

  /** replays stored events after `afterId`, then follows live ones; resolves with the unsubscribe function */
  async subscribe(
    auth: AuthContext,
    threadId: string,
    afterId: number,
    onEvent: (event: AssistantEvent) => void,
  ): Promise<() => void> {
    const thread = await this.own(auth, threadId);
    let lastSent = Number.isFinite(afterId) && afterId > 0 ? Math.floor(afterId) : 0;
    let replaying = true;
    const buffer: AssistantEvent[] = [];
    const deliver = (event: AssistantEvent) => {
      if (typeof event.id === 'number') {
        if (event.id <= lastSent) return;
        lastSent = event.id;
      }
      onEvent(event);
    };
    // subscribe first, so nothing published during the replay is lost
    const unsubscribe = await this.events.subscribe(thread.tenantId, thread.id, (event) => {
      if (replaying) buffer.push(event);
      else deliver(event);
    });
    try {
      for (;;) {
        const page = await this.events.replay(thread.tenantId, thread.id, lastSent, ASSISTANT_REPLAY_PAGE);
        for (const event of page) deliver(event);
        if (page.length < ASSISTANT_REPLAY_PAGE) break;
      }
    } catch (error) {
      unsubscribe();
      throw error;
    }
    replaying = false;
    for (const event of buffer.splice(0)) deliver(event);
    return unsubscribe;
  }

  /** leader, every 30 s: stale runs and expired cards */
  async sweep(now: Date): Promise<void> {
    try {
      await sweepRuns(this.deps.context(), now);
    } catch {
      /* sweepRuns logs its own failures */
    }
  }

  /** leader, every `INSTANCE_AI_PRUNE_INTERVAL`: the thread TTL */
  async pruneThreads(now: Date): Promise<void> {
    try {
      await pruneThreads(this.deps.context(), now);
    } catch {
      /* pruneThreads logs its own failures */
    }
  }

  /** aborts this process's turns and drops subscriptions */
  async close(): Promise<void> {
    this.closed = true;
    const runs = [...this.local.values()];
    for (const { run } of runs) run.abort(RUN_CLOSED);
    await Promise.race([Promise.allSettled(runs.map((entry) => entry.done)), wait(STOP_WAIT_MS)]);
    const listener = this.cancelListener;
    this.cancelListener = undefined;
    if (listener) (await listener.catch(() => () => {}))();
    await this.events.close();
  }

  // -------------------------------------------------------------------------------------------
  // runs

  private keyOf(tenantId: string, threadId: string): string {
    return `${tenantId}:${threadId}`;
  }

  /** a run on this process, listening for cancels from any main */
  private startRun(key: AssistantRunKey): AssistantRun {
    this.listenForCancels();
    const run = new AssistantRun(this.deps.context(), key);
    if (this.closed) run.abort(RUN_CLOSED);
    return run;
  }

  private track(run: AssistantRun, work: Promise<void>): void {
    const id = this.keyOf(run.key.tenantId, run.key.threadId);
    const done = work
      .catch((error) => {
        this.deps.logger.warn(
          {
            tenantId: run.key.tenantId,
            threadId: run.key.threadId,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Assistant run failed',
        );
      })
      .finally(() => {
        if (this.local.get(id)?.run === run) this.local.delete(id);
      });
    this.local.set(id, { run, done });
  }

  /** an error outside the turn itself (a settle, a resume that could not start) */
  private failed(run: AssistantRun, error: unknown): TurnOutcome {
    if (run.signal.aborted) return run.abortOutcome();
    const message = turnErrorText(error);
    this.deps.logger.warn(
      {
        tenantId: run.key.tenantId,
        threadId: run.key.threadId,
        error: error instanceof Error ? error.name : 'unknown',
      },
      'Assistant turn failed',
    );
    run.emit({ type: 'error', runId: run.key.runId, payload: { message } });
    return { status: 'error', reason: message };
  }

  /**
   * Finishes the run; a turn that stopped for a card that was approved meanwhile (no pending one left)
   * hands it to the settle, which the holder of the lock must cover.
   */
  private async end(run: AssistantRun, outcome: TurnOutcome): Promise<void> {
    await run.finish(outcome);
    if (outcome.status !== 'suspended' || this.closed) return;
    const { tenantId, userId, threadId, runId, actor } = run.key;
    const cards = this.deps.repos.assistantConfirmations;
    try {
      const pending = await cards.listPending(tenantId, userId, threadId);
      if (pending.length) return;
      const open = await cards.listOpenForRun(tenantId, threadId, runId);
      if (open.some((row) => row.status === 'approved')) {
        void this.settleConfirmations(tenantId, userId, threadId, actor).catch(() => {});
      }
    } catch {
      /* the next answer or the sweep settles it */
    }
  }

  /** subscribes once to the cancel channel: a cancel on any main aborts this process's run of the thread */
  private listenForCancels(): void {
    if (this.cancelListener || this.closed) return;
    this.cancelListener = this.deps
      .context()
      .bus.subscribe(ASSISTANT_CANCEL_CHANNEL, (message: { tenantId?: unknown; threadId?: unknown }) => {
        if (typeof message?.tenantId !== 'string' || typeof message?.threadId !== 'string') return;
        this.local.get(this.keyOf(message.tenantId, message.threadId))?.run.abort(RUN_CANCELLED);
      });
    this.cancelListener.catch(() => {
      this.cancelListener = undefined;
    });
  }

  /** aborts the thread's run here and on every other main, and waits for it to end */
  private async stopRun(tenantId: string, userId: string, threadId: string): Promise<void> {
    const id = this.keyOf(tenantId, threadId);
    const here = this.local.get(id);
    here?.run.abort(RUN_CANCELLED);
    await this.deps
      .context()
      .bus.publish(ASSISTANT_CANCEL_CHANNEL, { tenantId, threadId })
      .catch(() => {});
    if (here) {
      await Promise.race([here.done, wait(STOP_WAIT_MS)]);
      return;
    }
    // another main holds it: wait a little for its finish, then go on
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await this.repo.get(tenantId, userId, threadId).catch(() => undefined);
      if (!row?.activeRunId) return;
      await wait(100);
    }
  }

  /** denies the thread's open cards; their calls read that the run stopped */
  private async denyCards(tenantId: string, threadId: string, announce: boolean): Promise<void> {
    const rows = await this.deps.repos.assistantConfirmations.denyAll(
      tenantId,
      threadId,
      ASSISTANT_CANCEL_REASON,
    );
    for (const row of rows) {
      await this.repo.replaceToolResult(
        tenantId,
        threadId,
        row.toolCallId,
        ASSISTANT_APPROVAL_TEXTS.runStopped,
      );
      if (announce) {
        await this.publish(tenantId, threadId, {
          type: 'confirmation-resolved',
          runId: row.runId,
          payload: { requestId: row.id, toolCallId: row.toolCallId, outcome: 'denied' },
        });
      }
    }
  }
}
