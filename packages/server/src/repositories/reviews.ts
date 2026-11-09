/**
 * Workflow review requests, reviewers, authors, activity and comments (P3-19).
 *
 * Every query filters tenant_id. `lockForUpdate` takes the request row lock (SELECT ... FOR UPDATE)
 * and must run inside a transaction.
 */
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  memberships,
  users,
  type WorkflowReviewRequestRow,
  workflowReviewActivity,
  workflowReviewAuthors,
  workflowReviewComments,
  workflowReviewRequests,
  workflowReviewReviewers,
  workflows,
  workflowVersions,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { inUuids } from './shares';
import { isUuid, now } from './util';

export interface ReviewUserRef {
  id: string;
  name: string;
  email: string;
}

export interface ReviewParticipants {
  reviewers: ReviewUserRef[];
  authors: ReviewUserRef[];
}

export interface ReviewActivityRecord {
  id: number;
  type: string;
  data: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  comment?: { id: number; body: string };
}

/**
 * The workflows whose review requests a caller administers (P6-27): every workflow (`all`), or those in
 * `projectIds` and the ones in `workflowIds` (shared into the caller's projects). From
 * `AccessService.listFilter`; a request with no workflow is never in a reach.
 */
export interface ReviewReach {
  all: boolean;
  projectIds: string[];
  workflowIds: string[];
}

/**
 * who may see a request in a list: everyone (`all`), its authors and assigned reviewers
 * (`participant`), or those plus the requests of the workflows in a reach (`reach`)
 */
export type ReviewScope =
  | { kind: 'all' }
  | { kind: 'participant'; userId: string }
  | { kind: 'reach'; userId: string; reach: ReviewReach };

export interface ReviewListFilter {
  workflowId?: string;
  state?: 'open' | 'closed';
  /** inbox tabs: requests the user reviews, or authored */
  reviewerId?: string;
  authorId?: string;
  /** with reviewerId and `reach`: also the requests in the reach that the user did not author */
  orNotAuthoredBy?: string;
  reach?: ReviewReach;
  scope: ReviewScope;
  limit: number;
  /** keyset on (updated_at desc, id desc) */
  cursor?: Cursor;
}

export class ReviewRepository {
  constructor(readonly db: DbOrTx) {}

  /** the open request of a workflow, if any */
  async openForWorkflow(tenantId: string, workflowId: string): Promise<WorkflowReviewRequestRow | undefined> {
    if (!isUuid(workflowId)) return undefined;
    const [row] = await this.db
      .select()
      .from(workflowReviewRequests)
      .where(
        and(
          eq(workflowReviewRequests.tenantId, tenantId),
          eq(workflowReviewRequests.workflowId, workflowId),
          eq(workflowReviewRequests.state, 'open'),
        ),
      );
    return row;
  }

  async get(tenantId: string, id: string): Promise<WorkflowReviewRequestRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(workflowReviewRequests)
      .where(and(eq(workflowReviewRequests.tenantId, tenantId), eq(workflowReviewRequests.id, id)));
    return row;
  }

  /** the request row under a row lock (inside a transaction) */
  async lockForUpdate(tenantId: string, id: string): Promise<WorkflowReviewRequestRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(workflowReviewRequests)
      .where(and(eq(workflowReviewRequests.tenantId, tenantId), eq(workflowReviewRequests.id, id)))
      .for('update');
    return row;
  }

  async create(
    tenantId: string,
    input: {
      workflowId: string;
      workflowVersionId: string;
      title: string;
      description: string | null;
      createdBy: string;
      reviewerUserIds: string[];
    },
  ): Promise<WorkflowReviewRequestRow> {
    const [row] = await this.db
      .insert(workflowReviewRequests)
      .values({
        tenantId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        title: input.title,
        description: input.description,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
      })
      .returning();
    await this.db
      .insert(workflowReviewReviewers)
      .values(input.reviewerUserIds.map((userId) => ({ requestId: row.id, userId, tenantId })));
    await this.addAuthor(tenantId, row.id, input.createdBy);
    return row;
  }

  async addAuthor(tenantId: string, requestId: string, userId: string): Promise<void> {
    await this.db.insert(workflowReviewAuthors).values({ requestId, userId, tenantId }).onConflictDoNothing();
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<
      Pick<
        WorkflowReviewRequestRow,
        | 'state'
        | 'decision'
        | 'workflowVersionId'
        | 'approvedBaselineVersionId'
        | 'updatedBy'
        | 'closedBy'
        | 'approvedAt'
      >
    >,
  ): Promise<WorkflowReviewRequestRow | undefined> {
    const [row] = await this.db
      .update(workflowReviewRequests)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(workflowReviewRequests.tenantId, tenantId), eq(workflowReviewRequests.id, id)))
      .returning();
    return row;
  }

  /** a system close (archive, delete): closed_by stays NULL; returns the closed row, if one was open */
  async closeOpenForWorkflow(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowReviewRequestRow | undefined> {
    const [row] = await this.db
      .update(workflowReviewRequests)
      .set({ state: 'closed', closedBy: null, updatedAt: now() })
      .where(
        and(
          eq(workflowReviewRequests.tenantId, tenantId),
          eq(workflowReviewRequests.workflowId, workflowId),
          eq(workflowReviewRequests.state, 'open'),
        ),
      )
      .returning();
    return row;
  }

  async participants(tenantId: string, requestIds: string[]): Promise<Map<string, ReviewParticipants>> {
    const out = new Map<string, ReviewParticipants>(
      requestIds.map((id) => [id, { reviewers: [], authors: [] }]),
    );
    if (!requestIds.length) return out;
    const pick = {
      requestId: workflowReviewReviewers.requestId,
      id: users.id,
      name: users.name,
      email: users.email,
    };
    const reviewers = await this.db
      .select(pick)
      .from(workflowReviewReviewers)
      .innerJoin(users, eq(users.id, workflowReviewReviewers.userId))
      .where(
        and(
          eq(workflowReviewReviewers.tenantId, tenantId),
          inArray(workflowReviewReviewers.requestId, requestIds),
        ),
      )
      .orderBy(users.name, users.id);
    const authors = await this.db
      .select({
        requestId: workflowReviewAuthors.requestId,
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(workflowReviewAuthors)
      .innerJoin(users, eq(users.id, workflowReviewAuthors.userId))
      .where(
        and(
          eq(workflowReviewAuthors.tenantId, tenantId),
          inArray(workflowReviewAuthors.requestId, requestIds),
        ),
      )
      .orderBy(users.name, users.id);
    for (const { requestId, ...user } of reviewers) out.get(requestId)?.reviewers.push(user);
    for (const { requestId, ...user } of authors) out.get(requestId)?.authors.push(user);
    return out;
  }

  /** users by id (for createdBy / updatedBy / closedBy) */
  async users(ids: string[]): Promise<Map<string, ReviewUserRef>> {
    const unique = [...new Set(ids)].filter(isUuid);
    if (!unique.length) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(rows.map((u) => [u.id, u]));
  }

  async workflowNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, unique)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async versionNames(tenantId: string, ids: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.db
      .select({ id: workflowVersions.id, versionName: workflowVersions.versionName })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.tenantId, tenantId), inArray(workflowVersions.id, unique)));
    return new Map(rows.map((r) => [r.id, r.versionName]));
  }

  /** one extra row (limit + 1) tells the caller whether a next page exists */
  async list(tenantId: string, filter: ReviewListFilter): Promise<WorkflowReviewRequestRow[]> {
    const r = workflowReviewRequests;
    const conditions = this.conditions(tenantId, filter);
    if (!conditions) return [];
    if (filter.cursor) {
      // a crafted cursor (not a uuid, not a date) matches nothing instead of failing the cast
      const at = new Date(filter.cursor.value);
      if (!isUuid(filter.cursor.id) || Number.isNaN(at.getTime())) return [];
      conditions.push(
        sql`(${r.updatedAt}, ${r.id}) < (${at.toISOString()}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    return this.db
      .select()
      .from(r)
      .where(and(...conditions))
      .orderBy(desc(r.updatedAt), desc(r.id))
      .limit(filter.limit + 1);
  }

  async count(tenantId: string, filter: Omit<ReviewListFilter, 'limit' | 'cursor'>): Promise<number> {
    const conditions = this.conditions(tenantId, filter);
    if (!conditions) return 0;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowReviewRequests)
      .where(and(...conditions));
    return row?.n ?? 0;
  }

  async isParticipant(
    tenantId: string,
    requestId: string,
    userId: string,
  ): Promise<{ reviewer: boolean; author: boolean }> {
    const [reviewer] = await this.db
      .select({ userId: workflowReviewReviewers.userId })
      .from(workflowReviewReviewers)
      .where(
        and(
          eq(workflowReviewReviewers.tenantId, tenantId),
          eq(workflowReviewReviewers.requestId, requestId),
          eq(workflowReviewReviewers.userId, userId),
        ),
      );
    const [author] = await this.db
      .select({ userId: workflowReviewAuthors.userId })
      .from(workflowReviewAuthors)
      .where(
        and(
          eq(workflowReviewAuthors.tenantId, tenantId),
          eq(workflowReviewAuthors.requestId, requestId),
          eq(workflowReviewAuthors.userId, userId),
        ),
      );
    return { reviewer: Boolean(reviewer), author: Boolean(author) };
  }

  /** tenant members with their workspace role, without the given user */
  async members(tenantId: string, exceptUserId?: string): Promise<Array<ReviewUserRef & { role: string }>> {
    const conditions: SQL[] = [eq(memberships.tenantId, tenantId)];
    if (exceptUserId) conditions.push(sql`${users.id} <> ${exceptUserId}::uuid`);
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...conditions))
      .orderBy(users.name, users.id);
  }

  async addActivity(
    tenantId: string,
    requestId: string,
    input: { type: string; data?: Record<string, unknown>; createdBy: string | null; comment?: string },
  ): Promise<ReviewActivityRecord> {
    const [row] = await this.db
      .insert(workflowReviewActivity)
      .values({ tenantId, requestId, type: input.type, data: input.data ?? {}, createdBy: input.createdBy })
      .returning();
    const record: ReviewActivityRecord = {
      id: row.id,
      type: row.type,
      data: row.data,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
    if (input.comment !== undefined) {
      const [comment] = await this.db
        .insert(workflowReviewComments)
        .values({ tenantId, activityId: row.id, createdBy: input.createdBy, body: input.comment })
        .returning();
      record.comment = { id: comment.id, body: comment.body };
    }
    return record;
  }

  /** newest first; one extra row (limit + 1) tells the caller whether a next page exists */
  async activity(
    tenantId: string,
    requestId: string,
    limit: number,
    beforeId?: number,
  ): Promise<ReviewActivityRecord[]> {
    const a = workflowReviewActivity;
    const c = workflowReviewComments;
    const conditions: SQL[] = [eq(a.tenantId, tenantId), eq(a.requestId, requestId)];
    if (beforeId !== undefined) conditions.push(sql`${a.id} < ${beforeId}`);
    const rows = await this.db
      .select({
        id: a.id,
        type: a.type,
        data: a.data,
        createdBy: a.createdBy,
        createdAt: a.createdAt,
        commentId: c.id,
        commentBody: c.body,
      })
      .from(a)
      .leftJoin(c, and(eq(c.activityId, a.id), eq(c.tenantId, tenantId)))
      .where(and(...conditions))
      .orderBy(desc(a.id))
      .limit(limit + 1);
    return rows.map(({ commentId, commentBody, ...row }) =>
      commentId !== null && commentBody !== null
        ? { ...row, comment: { id: commentId, body: commentBody } }
        : row,
    );
  }

  /** undefined: the filter can match nothing (an id that is not a uuid) */
  private conditions(
    tenantId: string,
    filter: Omit<ReviewListFilter, 'limit' | 'cursor'>,
  ): SQL[] | undefined {
    const r = workflowReviewRequests;
    const conditions: SQL[] = [eq(r.tenantId, tenantId)];
    if (filter.workflowId !== undefined) {
      if (!isUuid(filter.workflowId)) return undefined;
      conditions.push(eq(r.workflowId, filter.workflowId));
    }
    if (filter.state) conditions.push(eq(r.state, filter.state));
    if (filter.scope.kind === 'participant') {
      const { userId } = filter.scope;
      conditions.push(or(this.isReviewer(tenantId, userId), this.isAuthor(tenantId, userId)) as SQL);
    }
    if (filter.scope.kind === 'reach') {
      const { userId, reach } = filter.scope;
      const inReach = this.inReach(tenantId, reach);
      const participant = [this.isReviewer(tenantId, userId), this.isAuthor(tenantId, userId)];
      conditions.push(or(...participant, ...(inReach ? [inReach] : [])) as SQL);
    }
    if (filter.reviewerId) {
      const reviewer = this.isReviewer(tenantId, filter.reviewerId);
      const inReach = filter.reach ? this.inReach(tenantId, filter.reach) : undefined;
      conditions.push(
        filter.orNotAuthoredBy && inReach
          ? (or(reviewer, and(sql`not ${this.isAuthor(tenantId, filter.orNotAuthoredBy)}`, inReach)) as SQL)
          : reviewer,
      );
    }
    if (filter.authorId) conditions.push(this.isAuthor(tenantId, filter.authorId));
    return conditions;
  }

  /** the request's workflow is in the reach; undefined when the reach holds nothing */
  private inReach(tenantId: string, reach: ReviewReach): SQL | undefined {
    if (reach.all) return sql`true`;
    const projectIds = reach.projectIds.filter(isUuid);
    const workflowIds = reach.workflowIds.filter(isUuid);
    const alternatives: SQL[] = [];
    if (projectIds.length) {
      alternatives.push(
        sql`${workflowReviewRequests.workflowId} in (
          select w.id from ${workflows} w
          where w.tenant_id = ${tenantId}::uuid and ${inUuids(sql`w.project_id`, projectIds)}
        )`,
      );
    }
    if (workflowIds.length) alternatives.push(inUuids(workflowReviewRequests.workflowId, workflowIds));
    return alternatives.length ? (or(...alternatives) as SQL) : undefined;
  }

  private isReviewer(tenantId: string, userId: string): SQL {
    return sql`${workflowReviewRequests.id} in (
      select rr.request_id from ${workflowReviewReviewers} rr
      where rr.tenant_id = ${tenantId} and rr.user_id = ${userId}::uuid
    )`;
  }

  private isAuthor(tenantId: string, userId: string): SQL {
    return sql`${workflowReviewRequests.id} in (
      select ra.request_id from ${workflowReviewAuthors} ra
      where ra.tenant_id = ${tenantId} and ra.user_id = ${userId}::uuid
    )`;
  }
}
