/**
 * Assistant confirmation cards (P5-68). Every query names the tenant and the user or the thread, except
 * the `sweep*` ones, which are cross-tenant like `ExecutionRepository.markCrashed`.
 *
 * An open card is a `pending` row (still in time for `hasOpen`) or an `approved` row not yet run: while
 * a thread has one, a new message is refused, so nothing slips in between a claim and the settle.
 *
 * C0: `listPending`, `hasOpen`, `listOpenForRun` and `denyAll` are FULL (L1's chat, wrapper and cancel
 * call them before L3 exists); the sweeps do nothing; the rest are stubs lane L3 fills.
 */
import type { AssistantConfirmAnswer, DataObject } from '@workflow/workflow';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type AssistantSystemAnswer, assistantPendingConfirmations as cards } from '../db/schema';
import { now as clock, isUuid } from './util';

export type AssistantConfirmationRow = typeof cards.$inferSelect;
export type AssistantConfirmationStatus = AssistantConfirmationRow['status'];

/** one card as the approval gate stores it */
export interface NewAssistantConfirmation {
  userId: string;
  threadId: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  args: DataObject;
  inputType: AssistantConfirmationRow['inputType'];
  details: AssistantConfirmationRow['details'];
  grantKey?: string | null;
  /** null: no timeout */
  expiresAt: Date | null;
}

const OPEN: AssistantConfirmationStatus[] = ['pending', 'approved'];

export class AssistantConfirmationRepository {
  constructor(readonly db: DbOrTx) {}

  async create(_tenantId: string, _input: NewAssistantConfirmation): Promise<AssistantConfirmationRow> {
    throw new Error('not implemented (L3)');
  }

  /** the card, or undefined when it is not this user's in this tenant */
  async get(_tenantId: string, _userId: string, _id: string): Promise<AssistantConfirmationRow | undefined> {
    throw new Error('not implemented (L3)');
  }

  /**
   * FULL: the user's `pending` cards on the thread that are still in time at `now`, oldest first
   * (what `GET .../status` shows).
   */
  async listPending(
    tenantId: string,
    userId: string,
    threadId: string,
    now: Date = clock(),
  ): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(threadId)) return [];
    return this.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.userId, userId),
          eq(cards.threadId, threadId),
          eq(cards.status, 'pending'),
          or(isNull(cards.expiresAt), gt(cards.expiresAt, now)),
        ),
      )
      .orderBy(asc(cards.createdAt), asc(cards.id));
  }

  /** FULL: true while the thread has a `pending` card in time at `now` or an `approved` card not yet run */
  async hasOpen(tenantId: string, threadId: string, now: Date): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return false;
    const [row] = await this.db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.threadId, threadId),
          or(
            and(eq(cards.status, 'pending'), or(isNull(cards.expiresAt), gt(cards.expiresAt, now))),
            eq(cards.status, 'approved'),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** the thread's `approved` cards not yet run, in creation order (L1 orders them by `tool_calls`) */
  async listApproved(_tenantId: string, _threadId: string): Promise<AssistantConfirmationRow[]> {
    throw new Error('not implemented (L3)');
  }

  /** `approved` to `executed` once the tool ran; false when the row was no longer `approved` */
  async markExecuted(_tenantId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L3)');
  }

  /**
   * Answers a card once: one atomic update `where status = 'pending' and (expires_at is null or
   * expires_at > now)`, setting `status`, `answer` and `resolved_at`. Null when the card is not the
   * user's, was answered already or ran out of time.
   */
  async claim(
    _tenantId: string,
    _userId: string,
    _id: string,
    _status: Extract<AssistantConfirmationStatus, 'approved' | 'denied'>,
    _answer: AssistantConfirmAnswer,
    _now: Date,
  ): Promise<AssistantConfirmationRow | null> {
    throw new Error('not implemented (L3)');
  }

  /** FULL: the open cards (`pending` or `approved`) a run of the thread wrote, oldest first */
  async listOpenForRun(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    return this.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.threadId, threadId),
          eq(cards.runId, runId),
          inArray(cards.status, OPEN),
        ),
      )
      .orderBy(asc(cards.createdAt), asc(cards.id));
  }

  /**
   * FULL: denies every open card of the thread (`pending`, and `approved` not yet run, so a cancelled
   * write never runs later), with `answer` `{ kind: 'system', reason }`. Returns the denied rows.
   */
  async denyAll(tenantId: string, threadId: string, reason: string): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId)) return [];
    const answer: AssistantSystemAnswer = { kind: 'system', reason };
    return this.db
      .update(cards)
      .set({ status: 'denied', answer, resolvedAt: clock() })
      .where(and(eq(cards.tenantId, tenantId), eq(cards.threadId, threadId), inArray(cards.status, OPEN)))
      .returning();
  }

  /**
   * Cross-tenant (or one thread): `pending` cards past `expires_at` become `expired`. Returns them.
   * Does nothing until L3.
   */
  async sweepExpired(_now: Date, _threadId?: string): Promise<AssistantConfirmationRow[]> {
    return [];
  }

  /**
   * Cross-tenant: `approved` cards resolved before `before` whose thread has no live run become
   * `expired` (never rerun: the write may have happened). Does nothing until L3.
   */
  async sweepOrphanApproved(_before: Date): Promise<AssistantConfirmationRow[]> {
    return [];
  }
}
