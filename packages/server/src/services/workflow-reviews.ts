/**
 * Workflow reviews (P3-19): review requests before publish, as n8n workflow-reviews.
 *
 * - A request pins one version of a workflow for 1..10 reviewers (tenant members who can publish,
 *   never the requester). One open request per workflow.
 * - Read gate: a request is visible (else 404) to its authors, its assigned reviewers and tenant
 *   admins. A decision comes from an assigned reviewer who can still publish, or from an admin (an
 *   admin may decide a review they authored); any other author gets 403.
 * - While the tenant has reviews on and a request is open, publishing is blocked (409, reason
 *   review_pending or changes_requested).
 * - Approval closes the request under the row lock (storing the published version before the
 *   auto-publish as the baseline), then publishes the pinned version as the requester. A failed
 *   auto-publish is reported and the decision stays.
 * - Archive and delete close the open request (a system close, closed_by NULL). A publish closes
 *   nothing (n8n): with reviews off, an open request stays open and its approval still publishes.
 * - Any member who can publish may move an open request to another version and becomes an author.
 * - Push events name no request or workflow (every tenant member gets them); listeners refetch.
 *
 * The hooks below are called by the publish, archive and delete paths.
 */
import type { Scope } from '@workflow/workflow';
import { z } from 'zod';
import type { ServiceDeps } from '../context';
import type { Role, WorkflowReviewRequestRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { decodeCursor, encodeCursor, page } from '../http/pagination';
import type { TenantSettings } from '../plans';
import { createRepositories, isUniqueViolation, isUuid } from '../repositories';
import type {
  ReviewActivityRecord,
  ReviewListFilter,
  ReviewReach,
  ReviewUserRef,
} from '../repositories/reviews';
import { assertNotArchived } from './workflow-rules';
import type { Actor } from './workflows';

/** control characters other than tab, newline and carriage return (as n8n's note rule) */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

const ACTIVITY_PAGE = 25;

const noControlChars = (what: string) =>
  z.string().refine((v) => !hasControlChars(v), `The ${what} cannot contain control characters`);

export const reviewCreateSchema = z.object({
  workflowId: z.uuid(),
  versionId: z.uuid().optional(),
  versionName: z
    .string()
    .trim()
    .min(1, 'The version name must be 1 to 128 characters')
    .max(128, 'The version name must be 1 to 128 characters'),
  title: z
    .string()
    .trim()
    .min(1, 'The title must be 1 to 128 characters')
    .max(128, 'The title must be 1 to 128 characters'),
  description: z.string().max(512, 'The description can have at most 512 characters').optional(),
  reviewerUserIds: z
    .array(z.uuid())
    .min(1, 'Pick 1 to 10 reviewers')
    .max(10, 'Pick 1 to 10 reviewers')
    .transform((ids) => [...new Set(ids)]),
});

export const reviewUpdateVersionSchema = z.object({
  versionId: z.uuid().optional(),
  versionName: z
    .string()
    .trim()
    .min(1, 'The version name must be 1 to 128 characters')
    .max(128, 'The version name must be 1 to 128 characters'),
});

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    note: noControlChars('note')
      .pipe(z.string().max(10000, 'The note can have at most 10000 characters'))
      .transform((v) => v.trim())
      .optional(),
  })
  .refine((v) => v.decision !== 'changes_requested' || Boolean(v.note), {
    message: 'A note is required when you request changes',
    path: ['note'],
  });

export const reviewCommentSchema = z.object({
  body: noControlChars('comment')
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'The comment must be 1 to 10000 characters')
        .max(10000, 'The comment must be 1 to 10000 characters'),
    ),
});

export const reviewListQuerySchema = z.object({
  workflowId: z.string().max(64).optional(),
  state: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});

export const inboxQuerySchema = z.object({
  tab: z.enum(['to_review', 'mine']).default('to_review'),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});

export const activityQuerySchema = z.object({ cursor: z.string().max(512).optional() });

export type ReviewCreateInput = z.output<typeof reviewCreateSchema>;
export type ReviewUpdateVersionInput = z.output<typeof reviewUpdateVersionSchema>;
export type ReviewDecisionInput = z.output<typeof reviewDecisionSchema>;
export type ReviewListQuery = z.output<typeof reviewListQuerySchema>;
export type InboxQuery = z.output<typeof inboxQuerySchema>;

/** the caller as the routes know it */
export interface ReviewCaller {
  userId: string;
  role: Role;
  /** the request's auth (the access filter of lists reads it) */
  auth: AuthContext;
  ip?: string;
}

export interface WorkflowReviewDTO {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  workflowVersionId: string | null;
  versionName: string | null;
  approvedBaselineVersionId: string | null;
  state: 'open' | 'closed';
  decision: 'pending' | 'changes_requested' | 'approved';
  title: string;
  description: string | null;
  reviewers: ReviewUserRef[];
  authors: ReviewUserRef[];
  createdBy: ReviewUserRef | null;
  updatedBy: ReviewUserRef | null;
  closedBy: ReviewUserRef | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewActivityDTO {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdBy: ReviewUserRef | null;
  createdAt: string;
  comment?: { id: string; body: string };
}

export interface ReviewDecisionResult {
  review: WorkflowReviewDTO;
  autoPublish?: { status: 'published' | 'failed'; message?: string };
}

type ScopeSet = ReadonlySet<Scope>;

/**
 * P6-27: what a review needs from the caller's scopes ON THE REQUEST'S WORKFLOW (`scopesFor` of that
 * user; a request with no workflow, or one whose workflow is gone, only has the workspace scopes).
 * - `workflow:publish` is "can publish": reviewers, requesters and whoever moves a request need it.
 * - `workflow:move` is "administers the workflow" (workspace owners and admins, project admins, the
 *   owner of a personal project): they read and decide every request of it, as an admin did before.
 */
const PUBLISH_SCOPE: Scope = 'workflow:publish';
const ADMIN_SCOPE: Scope = 'workflow:move';

const isAdmin = (scopes: ScopeSet) => scopes.has(ADMIN_SCOPE);
const canPublish = (scopes: ScopeSet) => scopes.has(PUBLISH_SCOPE);
/** an administrator (also on a review they authored), or an assigned reviewer who can publish and is not an author */
const mayDecide = (scopes: ScopeSet, participant: { reviewer: boolean; author: boolean }) =>
  isAdmin(scopes) || (participant.reviewer && !participant.author && canPublish(scopes));

const NO_SCOPES: ScopeSet = new Set<Scope>();

export class WorkflowReviewService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  // -------------------------------------------------------------------------------------------
  // hooks of the publish, archive and delete paths

  /** throws 409 (review_pending / changes_requested) while reviews are on and a request is open */
  async assertCanPublish(tenantId: string, workflowId: string, _userId?: string): Promise<void> {
    if (!(await this.enabled(tenantId))) return;
    const open = await this.repos.reviews.openForWorkflow(tenantId, workflowId);
    if (!open) return;
    const reason = open.decision === 'changes_requested' ? 'changes_requested' : 'review_pending';
    throw ApiError.conflict(
      reason === 'changes_requested'
        ? 'Changes were requested on the open review of this workflow. Update the review before publishing.'
        : 'This workflow has a pending review. It can be published once the review is approved.',
      { reason, requestId: open.id },
    );
  }

  /**
   * A publish closes no request (as n8n): with reviews on the guard has just shown that none was
   * open, so one found now was opened during the publish and must stay open; with reviews off an
   * open request stays open and its approval still publishes the pinned version.
   */
  async afterWorkflowPublished(_tenantId: string, _workflowId: string, _versionId: string): Promise<void> {}

  /** closes the open request */
  async afterWorkflowArchived(tenantId: string, workflowId: string): Promise<void> {
    await this.systemClose(tenantId, workflowId, { reason: 'archived' });
  }

  /** closes the open request; called BEFORE the workflow row is deleted */
  async afterWorkflowDeleted(tenantId: string, workflowId: string): Promise<void> {
    await this.systemClose(tenantId, workflowId, { reason: 'deleted' });
  }

  // -------------------------------------------------------------------------------------------
  // reads

  async list(tenantId: string, caller: ReviewCaller, query: ReviewListQuery) {
    return this.listPage(tenantId, query.limit, query.cursor, {
      workflowId: query.workflowId,
      state: query.state,
      scope: await this.listScope(caller),
    });
  }

  async inbox(tenantId: string, caller: ReviewCaller, query: InboxQuery) {
    return this.listPage(tenantId, query.limit, query.cursor, await this.inboxFilter(caller, query.tab));
  }

  async inboxSummary(tenantId: string, caller: ReviewCaller): Promise<{ toReview: number; mine: number }> {
    const [toReviewFilter, mineFilter] = await Promise.all([
      this.inboxFilter(caller, 'to_review'),
      this.inboxFilter(caller, 'mine'),
    ]);
    const [toReview, mine] = await Promise.all([
      this.repos.reviews.count(tenantId, toReviewFilter),
      this.repos.reviews.count(tenantId, mineFilter),
    ]);
    return { toReview, mine };
  }

  async get(tenantId: string, id: string, caller: ReviewCaller): Promise<WorkflowReviewDTO> {
    const { row } = await this.readable(tenantId, id, caller);
    return this.dto(tenantId, row);
  }

  async activity(tenantId: string, id: string, caller: ReviewCaller, cursor?: string) {
    const { row } = await this.readable(tenantId, id, caller);
    const before = decodeCursor(cursor);
    const beforeId = before ? Number(before.value) : undefined;
    if (beforeId !== undefined && !Number.isSafeInteger(beforeId))
      throw ApiError.badRequest('Invalid cursor');
    const rows = await this.repos.reviews.activity(tenantId, row.id, ACTIVITY_PAGE, beforeId);
    const { data, nextCursor } = page(rows, ACTIVITY_PAGE, (a) => encodeCursor(a.id, String(a.id)));
    return { data: await this.activityDtos(data), nextCursor };
  }

  /**
   * tenant members who can publish the workflow (`workflow:publish` on it; without a workflow, in the
   * workspace), without the caller
   */
  async eligibleReviewers(
    tenantId: string,
    caller: ReviewCaller,
    workflowId?: string,
  ): Promise<ReviewUserRef[]> {
    if (workflowId !== undefined) await this.deps.context().workflows.get(tenantId, workflowId);
    const members = await this.repos.reviews.members(tenantId, caller.userId);
    const eligible: ReviewUserRef[] = [];
    for (let start = 0; start < members.length; start += 10) {
      const chunk = members.slice(start, start + 10);
      const held = await Promise.all(
        chunk.map((member) => this.scopesOf(tenantId, member.id, workflowId ?? null, member.role as Role)),
      );
      chunk.forEach(({ role: _role, ...ref }, index) => {
        if (canPublish(held[index])) eligible.push(ref);
      });
    }
    return eligible;
  }

  // -------------------------------------------------------------------------------------------
  // writes

  async create(tenantId: string, input: ReviewCreateInput, caller: ReviewCaller): Promise<WorkflowReviewDTO> {
    // the workflow first: another workspace's id is 404, a caller who cannot publish it is 403
    const callerScopes = await this.deps.context().access.scopesFor(tenantId, caller.userId, {
      workflowId: input.workflowId,
    });
    if (!canPublish(callerScopes)) throw ApiError.forbidden();
    if (!(await this.enabled(tenantId))) {
      throw ApiError.badRequest('Workflow reviews are turned off for this workspace');
    }
    const workflow = await this.deps.context().workflows.get(tenantId, input.workflowId);
    assertNotArchived(workflow, 'activate');
    if (input.reviewerUserIds.includes(caller.userId)) {
      throw ApiError.badRequest('You cannot assign yourself as a reviewer');
    }
    for (const userId of input.reviewerUserIds) {
      if (!canPublish(await this.scopesOf(tenantId, userId, workflow.id))) {
        throw ApiError.badRequest('Reviewers must be able to publish this workflow');
      }
    }
    const versionId = input.versionId ?? workflow.versionId;
    if (!(await this.repos.versions.get(tenantId, workflow.id, versionId)))
      throw ApiError.notFound('Version');

    let row: WorkflowReviewRequestRow;
    try {
      row = await this.deps.database.db.transaction(async (tx) => {
        const repos = createRepositories(tx);
        if (await repos.reviews.openForWorkflow(tenantId, workflow.id)) throw this.alreadyOpen();
        const created = await repos.reviews.create(tenantId, {
          workflowId: workflow.id,
          workflowVersionId: versionId,
          title: input.title,
          description: input.description?.trim() || null,
          createdBy: caller.userId,
          reviewerUserIds: input.reviewerUserIds,
        });
        await repos.versions.update(tenantId, workflow.id, versionId, { versionName: input.versionName });
        await repos.reviews.addActivity(tenantId, created.id, {
          type: 'created',
          data: { title: input.title, versionId, versionName: input.versionName },
          createdBy: caller.userId,
        });
        return created;
      });
    } catch (error) {
      // two submits at once: the unique index on the open request decides
      if (isUniqueViolation(error)) throw this.alreadyOpen();
      throw error;
    }
    await this.audit(tenantId, caller, 'workflow_review.created', row.id, {
      workflowId: workflow.id,
      versionId,
    });
    this.emit(tenantId);
    return this.dto(tenantId, row);
  }

  /** moves an open request to another (default: the current) version of its workflow */
  async updateVersion(
    tenantId: string,
    id: string,
    input: ReviewUpdateVersionInput,
    caller: ReviewCaller,
  ): Promise<WorkflowReviewDTO> {
    // any member who can publish the workflow may move it (n8n); they become an author below
    const current = await this.repos.reviews.get(tenantId, id);
    if (!current) throw ApiError.notFound('Review request');
    if (!canPublish(await this.scopesOf(tenantId, caller.userId, current.workflowId, caller.role))) {
      await this.readable(tenantId, id, caller); // 404 for a non-participant
      throw ApiError.forbidden('Only members who can publish this workflow can update the request');
    }
    if (current.state !== 'open' || !current.workflowId) throw this.closed();
    const workflow = await this.deps.context().workflows.get(tenantId, current.workflowId);
    const versionId = input.versionId ?? workflow.versionId;
    if (!(await this.repos.versions.get(tenantId, workflow.id, versionId)))
      throw ApiError.notFound('Version');

    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const locked = await repos.reviews.lockForUpdate(tenantId, id);
      if (locked?.state !== 'open') throw this.closed();
      await repos.versions.update(tenantId, workflow.id, versionId, { versionName: input.versionName });
      const updated = await repos.reviews.update(tenantId, id, {
        workflowVersionId: versionId,
        decision: 'pending',
        updatedBy: caller.userId,
      });
      // whoever syncs a version becomes an author (n8n)
      await repos.reviews.addAuthor(tenantId, id, caller.userId);
      await repos.reviews.addActivity(tenantId, id, {
        type: 'version_updated',
        data: { versionId, versionName: input.versionName, previousVersionId: locked.workflowVersionId },
        createdBy: caller.userId,
      });
      return updated as WorkflowReviewRequestRow;
    });
    await this.audit(tenantId, caller, 'workflow_review.version_updated', id, { versionId });
    this.emit(tenantId);
    return this.dto(tenantId, row);
  }

  async decide(
    tenantId: string,
    id: string,
    input: ReviewDecisionInput,
    caller: ReviewCaller,
  ): Promise<ReviewDecisionResult> {
    const { row: current, participant, scopes } = await this.readable(tenantId, id, caller);
    if (!mayDecide(scopes, participant)) {
      throw ApiError.forbidden(
        participant.author
          ? 'Authors cannot decide on their own review request'
          : 'You cannot decide on this review request',
      );
    }
    if (current.state !== 'open') throw this.closed();

    // the requester is resolved before the lock (n8n): it decides closed_by and the auto-publish
    const requester = input.decision === 'approved' ? await this.requester(tenantId, current) : undefined;

    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const locked = await repos.reviews.lockForUpdate(tenantId, id);
      if (locked?.state !== 'open') throw this.closed();
      const note = input.note || undefined;
      await repos.reviews.addActivity(tenantId, id, {
        type: 'decision',
        data: { decision: input.decision, ...(note ? { note } : {}) },
        createdBy: caller.userId,
      });
      if (input.decision === 'changes_requested') {
        return (await repos.reviews.update(tenantId, id, {
          decision: 'changes_requested',
          updatedBy: caller.userId,
        })) as WorkflowReviewRequestRow;
      }
      const workflow = locked.workflowId ? await repos.workflows.get(tenantId, locked.workflowId) : undefined;
      const closed = await repos.reviews.update(tenantId, id, {
        state: 'closed',
        decision: 'approved',
        approvedAt: new Date(),
        approvedBaselineVersionId: workflow?.publishedVersionId ?? null,
        // a requester who can no longer publish makes the close a system close
        closedBy: requester?.ok ? caller.userId : null,
        updatedBy: caller.userId,
      });
      await repos.reviews.addActivity(tenantId, id, {
        type: 'closed',
        data: { reason: 'approved' },
        createdBy: requester?.ok ? caller.userId : null,
      });
      return closed as WorkflowReviewRequestRow;
    });
    await this.audit(tenantId, caller, 'workflow_review.decided', id, { decision: input.decision });
    this.emit(tenantId);

    if (input.decision === 'changes_requested') return { review: await this.dto(tenantId, row) };
    const autoPublish = await this.autoPublish(tenantId, row, requester);
    return { review: await this.dto(tenantId, row), autoPublish };
  }

  async comment(
    tenantId: string,
    id: string,
    body: string,
    caller: ReviewCaller,
  ): Promise<ReviewActivityDTO> {
    const { row: current, participant, scopes } = await this.readable(tenantId, id, caller);
    if (!participant.author && !mayDecide(scopes, participant)) {
      throw ApiError.forbidden('You cannot comment on this review request');
    }
    if (current.state !== 'open') throw this.closed();
    const record = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const locked = await repos.reviews.lockForUpdate(tenantId, id);
      if (locked?.state !== 'open') throw this.closed();
      const added = await repos.reviews.addActivity(tenantId, id, {
        type: 'comment',
        createdBy: caller.userId,
        comment: body,
      });
      await repos.reviews.update(tenantId, id, {});
      return added;
    });
    this.emit(tenantId);
    const [dto] = await this.activityDtos([record]);
    return dto;
  }

  // -------------------------------------------------------------------------------------------
  // internals

  private async enabled(tenantId: string): Promise<boolean> {
    const tenant = await this.repos.tenants.get(tenantId);
    return (tenant?.settings as TenantSettings | undefined)?.workflowReviews?.enabled === true;
  }

  /** the request if the caller may read it (author, assigned reviewer or admin), else 404 */
  private async readable(tenantId: string, id: string, caller: ReviewCaller) {
    const row = await this.repos.reviews.get(tenantId, id);
    if (!row) throw ApiError.notFound('Review request');
    const participant = await this.repos.reviews.isParticipant(tenantId, row.id, caller.userId);
    // a non-participant learns nothing about the request, not even that it exists
    const scopes = await this.scopesOf(tenantId, caller.userId, row.workflowId, caller.role);
    if (!participant.author && !participant.reviewer && !isAdmin(scopes))
      throw ApiError.notFound('Review request');
    return { row, participant, scopes };
  }

  /**
   * `userId`'s scopes on the workflow (`AccessService.scopesFor`); with no workflow, or one that is
   * gone, the workspace scopes of their role. No membership: none.
   */
  private async scopesOf(
    tenantId: string,
    userId: string,
    workflowId: string | null,
    role?: Role,
  ): Promise<ScopeSet> {
    const { access } = this.deps.context();
    if (workflowId) {
      try {
        return await access.scopesFor(tenantId, userId, { workflowId });
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 404) throw error;
      }
    }
    const memberRole = role ?? (await this.repos.memberships.get(tenantId, userId))?.role;
    return memberRole === undefined ? NO_SCOPES : access.globalScopes(tenantId, memberRole);
  }

  /** the workflows whose requests the caller administers (`workflow:move`) */
  private async reachOf(caller: ReviewCaller): Promise<ReviewReach> {
    const filter = await this.deps.context().access.listFilter(caller.auth, ADMIN_SCOPE);
    return filter.all
      ? { all: true, projectIds: [], workflowIds: [] }
      : { all: false, projectIds: filter.projectIds, workflowIds: filter.workflowIds };
  }

  private async listScope(caller: ReviewCaller): Promise<ReviewListFilter['scope']> {
    const reach = await this.reachOf(caller);
    return reach.all ? { kind: 'all' } : { kind: 'reach', userId: caller.userId, reach };
  }

  /** the requester as a publisher: a member who can publish (editor and up) */
  private async requester(
    tenantId: string,
    row: WorkflowReviewRequestRow,
  ): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
    const membership = row.createdBy ? await this.repos.memberships.get(tenantId, row.createdBy) : undefined;
    if (!row.createdBy || !membership) {
      return { ok: false, message: 'The review requester is no longer available' };
    }
    if (!canPublish(await this.scopesOf(tenantId, row.createdBy, row.workflowId, membership.role))) {
      return { ok: false, message: 'The review requester no longer has permission to publish this workflow' };
    }
    return { ok: true, userId: row.createdBy };
  }

  /** after the lock: publish the pinned version as the requester (the closed request passes the guard) */
  private async autoPublish(
    tenantId: string,
    row: WorkflowReviewRequestRow,
    requester: Awaited<ReturnType<WorkflowReviewService['requester']>> | undefined,
  ): Promise<{ status: 'published' | 'failed'; message?: string }> {
    if (!requester?.ok) {
      return {
        status: 'failed',
        message: requester?.message ?? 'The review requester is no longer available',
      };
    }
    const versionId = row.workflowVersionId;
    const version =
      row.workflowId && versionId
        ? await this.repos.versions.get(tenantId, row.workflowId, versionId)
        : undefined;
    if (!row.workflowId || !versionId || !version) {
      return { status: 'failed', message: 'The reviewed workflow version no longer exists' };
    }
    try {
      const actor: Actor = { userId: requester.userId };
      await this.deps.context().workflows.setActive(tenantId, row.workflowId, true, actor, { versionId });
      return { status: 'published' };
    } catch (error) {
      this.deps.logger.warn(
        { tenantId, workflowId: row.workflowId, requestId: row.id },
        'the auto-publish of an approved review failed',
      );
      return { status: 'failed', message: error instanceof Error ? error.message : 'The publish failed' };
    }
  }

  private async systemClose(
    tenantId: string,
    workflowId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!isUuid(workflowId)) return;
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const closed = await repos.reviews.closeOpenForWorkflow(tenantId, workflowId);
      if (closed)
        await repos.reviews.addActivity(tenantId, closed.id, { type: 'closed', data, createdBy: null });
      return closed;
    });
    if (row) this.emit(tenantId);
  }

  private async inboxFilter(
    caller: ReviewCaller,
    tab: 'to_review' | 'mine',
  ): Promise<Omit<ReviewListFilter, 'limit'>> {
    const base = { state: 'open' as const, scope: { kind: 'all' as const } };
    if (tab === 'mine') return { ...base, authorId: caller.userId };
    // administrators of a workflow review everything of it they did not author
    return {
      ...base,
      reviewerId: caller.userId,
      orNotAuthoredBy: caller.userId,
      reach: await this.reachOf(caller),
    };
  }

  private async listPage(
    tenantId: string,
    limit: number,
    cursor: string | undefined,
    filter: Omit<ReviewListFilter, 'limit' | 'cursor'>,
  ) {
    const rows = await this.repos.reviews.list(tenantId, { ...filter, limit, cursor: decodeCursor(cursor) });
    const { data, nextCursor } = page(rows, limit, (r) => encodeCursor(r.updatedAt, r.id));
    return { data: await this.dtos(tenantId, data), nextCursor };
  }

  private async dto(tenantId: string, row: WorkflowReviewRequestRow): Promise<WorkflowReviewDTO> {
    const [dto] = await this.dtos(tenantId, [row]);
    return dto;
  }

  private async dtos(tenantId: string, rows: WorkflowReviewRequestRow[]): Promise<WorkflowReviewDTO[]> {
    if (!rows.length) return [];
    const { reviews } = this.repos;
    const ids = rows.map((r) => r.id);
    const [participants, people, names, versionNames] = await Promise.all([
      reviews.participants(tenantId, ids),
      reviews.users(
        rows.flatMap((r) => [r.createdBy, r.updatedBy, r.closedBy]).filter((v): v is string => !!v),
      ),
      reviews.workflowNames(
        tenantId,
        rows.map((r) => r.workflowId).filter((v): v is string => !!v),
      ),
      reviews.versionNames(
        tenantId,
        rows.map((r) => r.workflowVersionId).filter((v): v is string => !!v),
      ),
    ]);
    const person = (id: string | null) => (id ? (people.get(id) ?? null) : null);
    return rows.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      workflowName: r.workflowId ? (names.get(r.workflowId) ?? null) : null,
      workflowVersionId: r.workflowVersionId,
      versionName: r.workflowVersionId ? (versionNames.get(r.workflowVersionId) ?? null) : null,
      approvedBaselineVersionId: r.approvedBaselineVersionId,
      state: r.state,
      decision: r.decision,
      title: r.title,
      description: r.description,
      reviewers: participants.get(r.id)?.reviewers ?? [],
      authors: participants.get(r.id)?.authors ?? [],
      createdBy: person(r.createdBy),
      updatedBy: person(r.updatedBy),
      closedBy: person(r.closedBy),
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  private async activityDtos(rows: ReviewActivityRecord[]): Promise<ReviewActivityDTO[]> {
    const people = await this.repos.reviews.users(
      rows.map((a) => a.createdBy).filter((v): v is string => !!v),
    );
    return rows.map((a) => ({
      id: String(a.id),
      type: a.type,
      data: a.data,
      createdBy: a.createdBy ? (people.get(a.createdBy) ?? null) : null,
      createdAt: a.createdAt.toISOString(),
      ...(a.comment ? { comment: { id: String(a.comment.id), body: a.comment.body } } : {}),
    }));
  }

  /**
   * The push stream reaches every tenant member, and a non-participant must not learn that a
   * request exists, so the event names neither the request nor its workflow: listeners refetch
   * through the gated list, inbox and detail endpoints.
   */
  private emit(tenantId: string): void {
    this.deps.context().push.send(tenantId, 'workflowReviewChanged', { workflowId: '', requestId: '' });
  }

  private async audit(
    tenantId: string,
    caller: ReviewCaller,
    action: string,
    requestId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.repos.audit.add(tenantId, {
      userId: caller.userId,
      action,
      resourceType: 'workflow_review',
      resourceId: requestId,
      metadata,
      ip: caller.ip,
    });
  }

  private alreadyOpen() {
    return ApiError.conflict('This workflow already has an open review request');
  }

  private closed() {
    return ApiError.conflict('The review request is closed');
  }
}
