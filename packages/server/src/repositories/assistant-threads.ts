/**
 * Assistant threads, messages and durable events (P5-67). One thread belongs to one user in one tenant:
 * every query names the tenant and the user or the thread, except `listStaleRuns` and
 * `listExpiredThreads`, which are cross-tenant like `ExecutionRepository.markCrashed` (the sweep and the
 * TTL timer run them on the leader). Ids from URLs are checked with `isUuid` before they reach a uuid
 * column, so a bad id is simply not found.
 */
import type { AssistantEvent, AssistantTask } from '@workflow/workflow';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type AssistantStoredAttachment,
  type AssistantStoredDraft,
  assistantEvents,
  assistantMessages,
  assistantPendingConfirmations,
  assistantThreads,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { now as clock, isUuid } from './util';

export type AssistantThreadRow = typeof assistantThreads.$inferSelect;
export type AssistantMessageRow = typeof assistantMessages.$inferSelect;
export type AssistantEventRow = typeof assistantEvents.$inferSelect;

export interface AssistantThreadListQuery {
  limit: number;
  /** keyset on (updated_at desc, id) */
  cursor?: Cursor;
}

/** one message as the run loop appends it */
export interface NewAssistantMessage {
  runId?: string | null;
  role: AssistantMessageRow['role'];
  content: AssistantMessageRow['content'];
  toolCalls?: AssistantMessageRow['toolCalls'];
  toolCallId?: string | null;
  name?: string | null;
  attachments?: AssistantStoredAttachment[] | null;
}

export interface AssistantMessageListOptions {
  /** false (default): only messages not folded into the observations */
  includeSummarized?: boolean;
  /** only messages with `seq` above this */
  afterSeq?: number;
  limit?: number;
}

/** a tool call an assistant message holds that no tool message answers yet */
export interface OpenToolCall {
  id: string;
  name: string;
  runId: string | null;
}

const threads = assistantThreads;
const messages = assistantMessages;

/**
 * A message row as read back: `content` as node-postgres parsed the jsonb, with no second `JSON.parse`
 * (drizzle's jsonb reader parses any string again, so a message that is itself JSON text, `null` or
 * `"approved"`, would come back changed). Writes keep the column's `JSON.stringify`.
 */
const messageRow = {
  ...getTableColumns(messages),
  content: sql<AssistantMessageRow['content']>`${messages.content}`,
};
const events = assistantEvents;
const cards = assistantPendingConfirmations;

export class AssistantThreadRepository {
  constructor(readonly db: DbOrTx) {}

  /** a new thread of this user, with an optional title */
  async create(tenantId: string, userId: string, input?: { title?: string }): Promise<AssistantThreadRow> {
    const [row] = await this.db
      .insert(threads)
      .values({ tenantId, userId, title: input?.title ?? '' })
      .returning();
    return row;
  }

  /** the thread, or undefined when it is not this user's in this tenant */
  async get(tenantId: string, userId: string, id: string): Promise<AssistantThreadRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.tenantId, tenantId), eq(threads.userId, userId), eq(threads.id, id)))
      .limit(1);
    return row;
  }

  /** the user's threads, newest `updated_at` first; `limit + 1` rows so the route can page */
  async list(
    tenantId: string,
    userId: string,
    query: AssistantThreadListQuery,
  ): Promise<AssistantThreadRow[]> {
    if (!isUuid(tenantId) || !isUuid(userId)) return [];
    const conditions = [eq(threads.tenantId, tenantId), eq(threads.userId, userId)];
    if (query.cursor) {
      if (!isUuid(query.cursor.id)) return [];
      conditions.push(
        sql`(${threads.updatedAt}, ${threads.id}) < (${query.cursor.value}::timestamptz, ${query.cursor.id}::uuid)`,
      );
    }
    return this.db
      .select()
      .from(threads)
      .where(and(...conditions))
      .orderBy(desc(threads.updatedAt), desc(threads.id))
      .limit(query.limit + 1);
  }

  /** the thread after the rename, or undefined when it is not the user's */
  async rename(
    tenantId: string,
    userId: string,
    id: string,
    title: string,
  ): Promise<AssistantThreadRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .update(threads)
      .set({ title, updatedAt: clock() })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.userId, userId), eq(threads.id, id)))
      .returning();
    return row;
  }

  /** sets the title without moving `updated_at` (the first message's title) */
  async setTitle(tenantId: string, threadId: string, title: string): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({ title })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  /** deletes the thread (messages, events and cards cascade); true when there was one */
  async delete(tenantId: string, userId: string, id: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return false;
    const rows = await this.db
      .delete(threads)
      .where(and(eq(threads.tenantId, tenantId), eq(threads.userId, userId), eq(threads.id, id)))
      .returning({ id: threads.id });
    return rows.length > 0;
  }

  /**
   * The TTL prune's delete: only while the thread has no run and no open card (`pending` or `approved`),
   * so a run that started after the listing keeps its thread. True when it was deleted.
   */
  async deleteIfIdle(tenantId: string, threadId: string, before: Date): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return false;
    const rows = await this.db
      .delete(threads)
      .where(
        and(
          eq(threads.tenantId, tenantId),
          eq(threads.id, threadId),
          isNull(threads.activeRunId),
          lt(threads.updatedAt, before),
          sql`not exists (select 1 from ${cards} c where c.thread_id = ${threads.id} and c.tenant_id = ${threads.tenantId} and c.status in ('pending', 'approved'))`,
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  }

  /** moves `updated_at` to now */
  async touch(tenantId: string, threadId: string): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({ updatedAt: clock() })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  async appendMessage(
    tenantId: string,
    threadId: string,
    message: NewAssistantMessage,
  ): Promise<AssistantMessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({
        tenantId,
        threadId,
        runId: message.runId ?? null,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls ?? null,
        toolCallId: message.toolCallId ?? null,
        name: message.name ?? null,
        attachments: message.attachments ?? null,
      })
      .returning(messageRow);
    return row;
  }

  /** messages in `seq` order */
  async listMessages(
    tenantId: string,
    threadId: string,
    options: AssistantMessageListOptions = {},
  ): Promise<AssistantMessageRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    const conditions = [eq(messages.tenantId, tenantId), eq(messages.threadId, threadId)];
    if (!options.includeSummarized) conditions.push(eq(messages.summarized, false));
    if (options.afterSeq !== undefined) conditions.push(gt(messages.seq, options.afterSeq));
    const query = this.db
      .select(messageRow)
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.seq));
    return options.limit !== undefined ? await query.limit(options.limit) : await query;
  }

  /** the highest `seq` of the thread's messages; 0 when it has none */
  async lastSeq(tenantId: string, threadId: string): Promise<number> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return 0;
    const [row] = await this.db
      .select({ seq: sql<string | null>`max(${messages.seq})` })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.threadId, threadId)));
    return Number(row?.seq ?? 0);
  }

  /** every tool call id the thread's assistant messages hold, in order */
  async listToolCallIds(tenantId: string, threadId: string): Promise<string[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    const rows = await this.db
      .select({ toolCalls: messages.toolCalls })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.threadId, threadId),
          eq(messages.role, 'assistant'),
          isNotNull(messages.toolCalls),
        ),
      )
      .orderBy(asc(messages.seq));
    return rows.flatMap((row) => (row.toolCalls ?? []).map((call) => call.id));
  }

  /** the ids among `toolCallIds` that a tool message of the thread already answers */
  async answeredToolCallIds(tenantId: string, threadId: string, toolCallIds: string[]): Promise<Set<string>> {
    if (!isUuid(tenantId) || !isUuid(threadId) || toolCallIds.length === 0) return new Set();
    const rows = await this.db
      .select({ toolCallId: messages.toolCallId })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.threadId, threadId),
          eq(messages.role, 'tool'),
          inArray(messages.toolCallId, toolCallIds),
        ),
      );
    return new Set(rows.map((row) => row.toolCallId).filter((id): id is string => typeof id === 'string'));
  }

  /** the tool calls of the thread (of one run, when given) that no tool message answers, in call order */
  async openToolCalls(tenantId: string, threadId: string, runId?: string): Promise<OpenToolCall[]> {
    const all = await this.listMessages(tenantId, threadId, { includeSummarized: true });
    const answered = new Set(all.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId));
    const open: OpenToolCall[] = [];
    for (const message of all) {
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      if (runId !== undefined && message.runId !== runId) continue;
      for (const call of message.toolCalls) {
        if (!answered.has(call.id)) open.push({ id: call.id, name: call.name, runId: message.runId });
      }
    }
    return open;
  }

  /** the attachments of the thread's latest user message (the current turn's files) */
  async turnAttachments(tenantId: string, threadId: string): Promise<AssistantStoredAttachment[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    const [row] = await this.db
      .select({ attachments: messages.attachments })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.threadId, threadId), eq(messages.role, 'user')))
      .orderBy(desc(messages.seq))
      .limit(1);
    return row?.attachments ?? [];
  }

  /** replaces the content of the tool message answering `toolCallId`; true when there was one */
  async replaceToolResult(
    tenantId: string,
    threadId: string,
    toolCallId: string,
    content: AssistantMessageRow['content'],
  ): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return false;
    const rows = await this.db
      .update(messages)
      .set({ content })
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.threadId, threadId),
          eq(messages.role, 'tool'),
          eq(messages.toolCallId, toolCallId),
        ),
      )
      .returning({ seq: messages.seq });
    return rows.length > 0;
  }

  /** marks every message up to and including `uptoSeq` as summarized */
  async markSummarized(tenantId: string, threadId: string, uptoSeq: number): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(messages)
      .set({ summarized: true })
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.threadId, threadId),
          lte(messages.seq, uptoSeq),
          eq(messages.summarized, false),
        ),
      );
  }

  async setObservations(tenantId: string, threadId: string, observations: string | null): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({ observations })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  /** the thread's rolling summary; null before the first compaction or when the thread is gone */
  async getObservations(tenantId: string, threadId: string): Promise<string | null> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return null;
    const [row] = await this.db
      .select({ observations: threads.observations })
      .from(threads)
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)))
      .limit(1);
    return row?.observations ?? null;
  }

  async setTasks(tenantId: string, threadId: string, tasks: AssistantTask[]): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({ tasks })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  /** adds a session grant key once (a second add of the same key changes nothing) */
  async addGrant(tenantId: string, threadId: string, grantKey: string): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({
        grants: sql`case when ${threads.grants} @> jsonb_build_array(${grantKey}::text) then ${threads.grants} else ${threads.grants} || jsonb_build_array(${grantKey}::text) end`,
      })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  /** the thread's unaccepted drafts by id */
  async getDrafts(tenantId: string, threadId: string): Promise<Record<string, AssistantStoredDraft>> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return {};
    const [row] = await this.db
      .select({ drafts: threads.drafts })
      .from(threads)
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)))
      .limit(1);
    return row?.drafts ?? {};
  }

  /** writes one draft under its id; null removes it */
  async putDraft(
    tenantId: string,
    threadId: string,
    draftId: string,
    draft: AssistantStoredDraft | null,
  ): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    const drafts =
      draft === null
        ? sql`${threads.drafts} - ${draftId}::text`
        : sql`${threads.drafts} || jsonb_build_object(${draftId}::text, ${JSON.stringify(draft)}::jsonb)`;
    await this.db
      .update(threads)
      .set({ drafts })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)));
  }

  /**
   * Takes the thread's run lock: one atomic update `where active_run_id is null`, which also sets the
   * heartbeat. False when another run holds it.
   */
  async acquireRun(tenantId: string, threadId: string, runId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return false;
    const rows = await this.db
      .update(threads)
      .set({ activeRunId: runId, runHeartbeatAt: clock() })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId), isNull(threads.activeRunId)))
      .returning({ id: threads.id });
    return rows.length > 0;
  }

  /** moves the heartbeat of the run that holds the lock; false when `runId` no longer holds it */
  async heartbeat(tenantId: string, threadId: string, runId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return false;
    const rows = await this.db
      .update(threads)
      .set({ runHeartbeatAt: clock() })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId), eq(threads.activeRunId, runId)))
      .returning({ id: threads.id });
    return rows.length > 0;
  }

  /** frees the lock only when `runId` holds it */
  async releaseRun(tenantId: string, threadId: string, runId: string): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return;
    await this.db
      .update(threads)
      .set({ activeRunId: null, runHeartbeatAt: null })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId), eq(threads.activeRunId, runId)));
  }

  /** threads with a run lock, of one user or (no user) of the whole instance */
  async countActiveRuns(userId?: string): Promise<number> {
    if (userId !== undefined && !isUuid(userId)) return 0;
    const conditions = [isNotNull(threads.activeRunId)];
    if (userId !== undefined) conditions.push(eq(threads.userId, userId));
    const [row] = await this.db
      .select({ n: count() })
      .from(threads)
      .where(and(...conditions));
    return Number(row?.n ?? 0);
  }

  /** stores one durable event and returns its id (the stream's event id) */
  async appendEvent(
    tenantId: string,
    threadId: string,
    runId: string | null,
    event: AssistantEvent,
  ): Promise<number> {
    const { id: _id, ...payload } = event;
    const [row] = await this.db
      .insert(events)
      .values({ tenantId, threadId, runId, type: event.type, payload: payload as AssistantEvent })
      .returning({ id: events.id });
    return Number(row.id);
  }

  /** events with `id > afterId`, in id order */
  async listEvents(
    tenantId: string,
    threadId: string,
    afterId: number,
    limit: number,
  ): Promise<AssistantEventRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.threadId, threadId), gt(events.id, afterId)))
      .orderBy(asc(events.id))
      .limit(limit);
  }

  /**
   * The thread's stored `tasks-update` and `artifact` events with `id <= uptoId`, in id order (the
   * messages page folds them per run).
   */
  async listFoldEvents(
    tenantId: string,
    threadId: string,
    uptoId: number,
  ): Promise<Array<{ runId: string | null; event: AssistantEvent }>> {
    if (!isUuid(tenantId) || !isUuid(threadId) || uptoId <= 0) return [];
    const rows = await this.db
      .select({ runId: events.runId, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.threadId, threadId),
          inArray(events.type, ['tasks-update', 'artifact']),
          lte(events.id, uptoId),
        ),
      )
      .orderBy(asc(events.id));
    return rows.map((row) => ({ runId: row.runId, event: row.payload }));
  }

  /** the thread's highest event id; 0 when it has none */
  async lastEventId(tenantId: string, threadId: string): Promise<number> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return 0;
    const [row] = await this.db
      .select({ id: sql<string | null>`max(${events.id})` })
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.threadId, threadId)));
    return Number(row?.id ?? 0);
  }

  /** the stored `confirmation-request` events of the thread for these card ids (what the client saw) */
  async confirmationEvents(
    tenantId: string,
    threadId: string,
    requestIds: string[],
  ): Promise<AssistantEvent[]> {
    if (!isUuid(tenantId) || !isUuid(threadId) || requestIds.length === 0) return [];
    const rows = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.threadId, threadId),
          eq(events.type, 'confirmation-request'),
          inArray(sql<string>`${events.payload} -> 'payload' -> 'confirmation' ->> 'requestId'`, requestIds),
        ),
      )
      .orderBy(asc(events.id));
    return rows.map((row) => row.payload);
  }

  /** cross-tenant: threads whose run heartbeat is older than `before` */
  async listStaleRuns(before: Date): Promise<AssistantThreadRow[]> {
    return this.db
      .select()
      .from(threads)
      .where(and(isNotNull(threads.activeRunId), lt(threads.runHeartbeatAt, before)))
      .orderBy(asc(threads.runHeartbeatAt))
      .limit(500);
  }

  /**
   * Cross-tenant: threads last updated before `before`, skipping a thread with an active run or an open
   * card (`pending`, or `approved` not yet run).
   */
  async listExpiredThreads(before: Date): Promise<AssistantThreadRow[]> {
    return this.db
      .select()
      .from(threads)
      .where(
        and(
          lt(threads.updatedAt, before),
          isNull(threads.activeRunId),
          sql`not exists (select 1 from ${cards} c where c.thread_id = ${threads.id} and c.tenant_id = ${threads.tenantId} and c.status in ('pending', 'approved'))`,
        ),
      )
      .orderBy(asc(threads.updatedAt))
      .limit(500);
  }
}
