/**
 * Assistant threads, messages and durable events (P5-67). One thread belongs to one user in one tenant:
 * every query names the tenant and the user or the thread, except `listStaleRuns` and
 * `listExpiredThreads`, which are cross-tenant like `ExecutionRepository.markCrashed` (the sweep and the
 * TTL timer run them on the leader).
 *
 * C0 stub with the final signatures; lane L1 writes the bodies. The two sweep queries return nothing
 * until then, because the C0 sweep timers may call them.
 */
import type { AssistantEvent, AssistantTask } from '@workflow/workflow';
import type { DbOrTx } from '../db/client';
import type {
  AssistantStoredAttachment,
  AssistantStoredDraft,
  assistantEvents,
  assistantMessages,
  assistantThreads,
} from '../db/schema';
import type { Cursor } from '../http/pagination';

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

export class AssistantThreadRepository {
  constructor(readonly db: DbOrTx) {}

  /** a new thread of this user, with an optional title */
  async create(_tenantId: string, _userId: string, _input?: { title?: string }): Promise<AssistantThreadRow> {
    throw new Error('not implemented (L1)');
  }

  /** the thread, or undefined when it is not this user's in this tenant */
  async get(_tenantId: string, _userId: string, _id: string): Promise<AssistantThreadRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  /** the user's threads, newest `updated_at` first; `limit + 1` rows so the route can page */
  async list(
    _tenantId: string,
    _userId: string,
    _query: AssistantThreadListQuery,
  ): Promise<AssistantThreadRow[]> {
    throw new Error('not implemented (L1)');
  }

  /** the thread after the rename, or undefined when it is not the user's */
  async rename(
    _tenantId: string,
    _userId: string,
    _id: string,
    _title: string,
  ): Promise<AssistantThreadRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  /** deletes the thread (messages, events and cards cascade); true when there was one */
  async delete(_tenantId: string, _userId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L1)');
  }

  /** moves `updated_at` to now */
  async touch(_tenantId: string, _threadId: string): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  async appendMessage(
    _tenantId: string,
    _threadId: string,
    _message: NewAssistantMessage,
  ): Promise<AssistantMessageRow> {
    throw new Error('not implemented (L1)');
  }

  /** messages in `seq` order */
  async listMessages(
    _tenantId: string,
    _threadId: string,
    _options?: AssistantMessageListOptions,
  ): Promise<AssistantMessageRow[]> {
    throw new Error('not implemented (L1)');
  }

  /** every tool call id the thread's assistant messages hold, in order */
  async listToolCallIds(_tenantId: string, _threadId: string): Promise<string[]> {
    throw new Error('not implemented (L1)');
  }

  /** the attachments of the thread's latest user message (the current turn's files) */
  async turnAttachments(_tenantId: string, _threadId: string): Promise<AssistantStoredAttachment[]> {
    throw new Error('not implemented (L1)');
  }

  /** replaces the content of the tool message answering `toolCallId`; true when there was one */
  async replaceToolResult(
    _tenantId: string,
    _threadId: string,
    _toolCallId: string,
    _content: AssistantMessageRow['content'],
  ): Promise<boolean> {
    throw new Error('not implemented (L1)');
  }

  /** marks every message up to and including `uptoSeq` as summarized */
  async markSummarized(_tenantId: string, _threadId: string, _uptoSeq: number): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  async setObservations(_tenantId: string, _threadId: string, _observations: string | null): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  async setTasks(_tenantId: string, _threadId: string, _tasks: AssistantTask[]): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** adds a session grant key once (a second add of the same key changes nothing) */
  async addGrant(_tenantId: string, _threadId: string, _grantKey: string): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** the thread's unaccepted drafts by id */
  async getDrafts(_tenantId: string, _threadId: string): Promise<Record<string, AssistantStoredDraft>> {
    throw new Error('not implemented (L1)');
  }

  /** writes one draft under its id; null removes it */
  async putDraft(
    _tenantId: string,
    _threadId: string,
    _draftId: string,
    _draft: AssistantStoredDraft | null,
  ): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /**
   * Takes the thread's run lock: one atomic update `where active_run_id is null`, which also sets the
   * heartbeat. False when another run holds it.
   */
  async acquireRun(_tenantId: string, _threadId: string, _runId: string): Promise<boolean> {
    throw new Error('not implemented (L1)');
  }

  /** moves the heartbeat of the run that holds the lock; false when `runId` no longer holds it */
  async heartbeat(_tenantId: string, _threadId: string, _runId: string): Promise<boolean> {
    throw new Error('not implemented (L1)');
  }

  /** frees the lock only when `runId` holds it */
  async releaseRun(_tenantId: string, _threadId: string, _runId: string): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** threads with a run lock, of one user or (no user) of the whole instance */
  async countActiveRuns(_userId?: string): Promise<number> {
    throw new Error('not implemented (L1)');
  }

  /** stores one durable event and returns its id (the stream's event id) */
  async appendEvent(
    _tenantId: string,
    _threadId: string,
    _runId: string | null,
    _event: AssistantEvent,
  ): Promise<number> {
    throw new Error('not implemented (L1)');
  }

  /** events with `id > afterId`, in id order */
  async listEvents(
    _tenantId: string,
    _threadId: string,
    _afterId: number,
    _limit: number,
  ): Promise<AssistantEventRow[]> {
    throw new Error('not implemented (L1)');
  }

  /** cross-tenant: threads whose run heartbeat is older than `before` */
  async listStaleRuns(_before: Date): Promise<AssistantThreadRow[]> {
    return [];
  }

  /**
   * Cross-tenant: threads last updated before `before`, skipping a thread with an active run or an open
   * card (`pending`, or `approved` not yet run).
   */
  async listExpiredThreads(_before: Date): Promise<AssistantThreadRow[]> {
    return [];
  }
}
