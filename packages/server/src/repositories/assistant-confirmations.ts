/**
 * Assistant confirmation cards (P5-68). Every query names the tenant and the user, except the `sweep*`
 * ones, which are cross-tenant like `ExecutionRepository.markCrashed`. The C0 methods keyed by thread
 * (`hasOpen`, `listApproved`, `markExecuted`, `listOpenForRun`, `denyAll`) take an optional `userId`
 * last: given, the row must be that user's; left out, it must be the user who owns its thread
 * (`ownerScope`), so a card never reaches someone else's thread.
 *
 * An open card is a `pending` row (still in time for `hasOpen`) or an `approved` row not yet run: while
 * a thread has one, a new message is refused, so nothing slips in between a claim and the settle.
 *
 * Status moves: `claim` is the only way a row leaves `pending` for an answer (`approved` or `denied`);
 * `sweepExpired` moves a `pending` row past its time to `expired`; `markExecuted` moves `approved` to
 * `executed` once the tool ran, `refuseApproved` moves it to `denied` when it may no longer run, and
 * `sweepOrphanApproved` to `expired` when its run is gone; `denyAll` (cancel) denies every open one.
 */
import type { AssistantConfirmAnswer, DataObject } from '@workflow/workflow';
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import {
  type AssistantSystemAnswer,
  assistantThreads,
  assistantPendingConfirmations as cards,
} from '../db/schema';
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

/** the row is `userId`'s, or (no user given) the user's who owns its thread in its tenant */
function ownerScope(db: DbOrTx, userId: string | undefined) {
  if (userId !== undefined) return eq(cards.userId, userId);
  return exists(
    db
      .select({ one: sql`1` })
      .from(assistantThreads)
      .where(
        and(
          eq(assistantThreads.id, cards.threadId),
          eq(assistantThreads.tenantId, cards.tenantId),
          eq(assistantThreads.userId, cards.userId),
        ),
      ),
  );
}

/** false when a user is given and is not a UUID */
const userOk = (userId: string | undefined) => userId === undefined || isUuid(userId);

export class AssistantConfirmationRepository {
  constructor(readonly db: DbOrTx) {}

  /**
   * Writes a `pending` card. A second card for the same tool call of the thread writes nothing and
   * gives the first one back (one call, one card).
   */
  async create(tenantId: string, input: NewAssistantConfirmation): Promise<AssistantConfirmationRow> {
    const [row] = await this.db
      .insert(cards)
      .values({
        tenantId,
        userId: input.userId,
        threadId: input.threadId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
        inputType: input.inputType,
        details: input.details,
        grantKey: input.grantKey ?? null,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({ target: [cards.threadId, cards.toolCallId] })
      .returning();
    if (row) return row;
    const [existing] = await this.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.userId, input.userId),
          eq(cards.threadId, input.threadId),
          eq(cards.toolCallId, input.toolCallId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('The approval card could not be saved');
    return existing;
  }

  /** the card, or undefined when it is not this user's in this tenant */
  async get(tenantId: string, userId: string, id: string): Promise<AssistantConfirmationRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(cards)
      .where(and(eq(cards.tenantId, tenantId), eq(cards.userId, userId), eq(cards.id, id)))
      .limit(1);
    return row;
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
  async hasOpen(tenantId: string, threadId: string, now: Date, userId?: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(threadId) || !userOk(userId)) return false;
    const [row] = await this.db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          ownerScope(this.db, userId),
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
  async listApproved(
    tenantId: string,
    threadId: string,
    userId?: string,
  ): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId) || !userOk(userId)) return [];
    return this.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          ownerScope(this.db, userId),
          eq(cards.threadId, threadId),
          eq(cards.status, 'approved'),
        ),
      )
      .orderBy(asc(cards.createdAt), asc(cards.id));
  }

  /** `approved` to `executed` once the tool ran; false when the row was no longer `approved` */
  async markExecuted(tenantId: string, id: string, userId?: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(id) || !userOk(userId)) return false;
    const rows = await this.db
      .update(cards)
      .set({ status: 'executed' })
      .where(
        and(
          eq(cards.tenantId, tenantId),
          ownerScope(this.db, userId),
          eq(cards.id, id),
          eq(cards.status, 'approved'),
        ),
      )
      .returning({ id: cards.id });
    return rows.length > 0;
  }

  /**
   * `approved` to `denied` with `{ kind: 'system', reason }` when the approved call may no longer run
   * (the tool is gone, the user lost the role, an admin blocked it); false when it was not `approved`.
   */
  async refuseApproved(tenantId: string, userId: string, id: string, reason: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return false;
    const answer: AssistantSystemAnswer = { kind: 'system', reason };
    const rows = await this.db
      .update(cards)
      .set({ status: 'denied', answer })
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.userId, userId),
          eq(cards.id, id),
          eq(cards.status, 'approved'),
        ),
      )
      .returning({ id: cards.id });
    return rows.length > 0;
  }

  /**
   * Answers a card once: one atomic update `where status = 'pending' and (expires_at is null or
   * expires_at > now)`, setting `status`, `answer` and `resolved_at`. Null when the card is not the
   * user's, was answered already or ran out of time.
   */
  async claim(
    tenantId: string,
    userId: string,
    id: string,
    status: Extract<AssistantConfirmationStatus, 'approved' | 'denied'>,
    answer: AssistantConfirmAnswer,
    now: Date,
  ): Promise<AssistantConfirmationRow | null> {
    if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(id)) return null;
    const [row] = await this.db
      .update(cards)
      .set({ status, answer, resolvedAt: now })
      .where(
        and(
          eq(cards.tenantId, tenantId),
          eq(cards.userId, userId),
          eq(cards.id, id),
          eq(cards.status, 'pending'),
          or(isNull(cards.expiresAt), gt(cards.expiresAt, now)),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** FULL: the open cards (`pending` or `approved`) a run of the thread wrote, oldest first */
  async listOpenForRun(
    tenantId: string,
    threadId: string,
    runId: string,
    userId?: string,
  ): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId) || !userOk(userId)) return [];
    return this.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.tenantId, tenantId),
          ownerScope(this.db, userId),
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
  async denyAll(
    tenantId: string,
    threadId: string,
    reason: string,
    userId?: string,
  ): Promise<AssistantConfirmationRow[]> {
    if (!isUuid(tenantId) || !isUuid(threadId) || !userOk(userId)) return [];
    const answer: AssistantSystemAnswer = { kind: 'system', reason };
    return this.db
      .update(cards)
      .set({ status: 'denied', answer, resolvedAt: clock() })
      .where(
        and(
          eq(cards.tenantId, tenantId),
          ownerScope(this.db, userId),
          eq(cards.threadId, threadId),
          inArray(cards.status, OPEN),
        ),
      )
      .returning();
  }

  /**
   * Cross-tenant (or one thread): `pending` cards past `expires_at` become `expired`, with
   * `{ kind: 'system', reason }`. A card with no `expires_at` never expires. Returns them.
   */
  async sweepExpired(now: Date, threadId?: string): Promise<AssistantConfirmationRow[]> {
    if (threadId !== undefined && !isUuid(threadId)) return [];
    const answer: AssistantSystemAnswer = { kind: 'system', reason: 'timeout' };
    return this.db
      .update(cards)
      .set({ status: 'expired', answer, resolvedAt: now })
      .where(
        and(
          eq(cards.status, 'pending'),
          isNotNull(cards.expiresAt),
          lte(cards.expiresAt, now),
          threadId === undefined ? undefined : eq(cards.threadId, threadId),
        ),
      )
      .returning();
  }

  /**
   * Cross-tenant: `approved` cards resolved before `before` whose thread has no live run and no
   * `pending` card become `expired` (never rerun: the write may have happened). Returns them. A
   * pending sibling means the turn still waits for its last answer, which settles the approved card
   * (the caller sweeps cards past their time first).
   */
  async sweepOrphanApproved(before: Date): Promise<AssistantConfirmationRow[]> {
    const answer: AssistantSystemAnswer = { kind: 'system', reason: 'run stopped' };
    const sibling = alias(cards, 'sibling');
    return this.db
      .update(cards)
      .set({ status: 'expired', answer })
      .where(
        and(
          eq(cards.status, 'approved'),
          isNotNull(cards.resolvedAt),
          lt(cards.resolvedAt, before),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(assistantThreads)
              .where(
                and(
                  eq(assistantThreads.id, cards.threadId),
                  eq(assistantThreads.tenantId, cards.tenantId),
                  isNotNull(assistantThreads.activeRunId),
                ),
              ),
          ),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(sibling)
              .where(
                and(
                  eq(sibling.threadId, cards.threadId),
                  eq(sibling.tenantId, cards.tenantId),
                  eq(sibling.status, 'pending'),
                ),
              ),
          ),
        ),
      )
      .returning();
  }
}
