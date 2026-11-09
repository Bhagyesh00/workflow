/**
 * Demo routes for workflow reviews and the inbox (P3-19), registered by the MockBackend
 * constructor: /workflow-reviews (list, eligible-reviewers, create, get, update-version, decision,
 * activity, comments), /inbox and /inbox/summary. Changes emit `workflowReviewChanged`, which names
 * no request or workflow (every member gets it).
 *
 * The rules follow the server: one open request per workflow, reviewers are editors and up and never
 * the requester, decisions by an assigned reviewer or an admin (never another author), reads limited
 * to authors, assigned reviewers and admins, any member who can publish may update the version and
 * becomes an author (n8n), approval stores the published version as the baseline and publishes the
 * pinned version, and a pending request blocks publishing (see mock-publish). A pruned version keeps
 * its id on the request and loses its name.
 * State lives in `backend.ext.reviews`.
 */
import type { ReviewActivity, ReviewUser, WorkflowReviewDTO } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { copy, HttpError, listResult, now, page } from './mock-http';
import { recordPublishEvent } from './mock-publish';

interface StoredReview extends WorkflowReviewDTO {
  tenantId: string;
}

interface StoredActivity extends ReviewActivity {
  requestId: string;
}

interface ReviewStore {
  requests: StoredReview[];
  activity: StoredActivity[];
}

const RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const;
/** control characters other than tab, newline and carriage return are refused (as the server does) */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

function store(backend: MockBackend): ReviewStore {
  backend.ext.reviews ??= { requests: [], activity: [] } satisfies ReviewStore;
  return backend.ext.reviews as ReviewStore;
}

/** the open review request of a workflow, if any (publishing is blocked while one is open) */
export function openReviewOf(backend: MockBackend, workflowId: string): WorkflowReviewDTO | undefined {
  return store(backend).requests.find((r) => r.workflowId === workflowId && r.state === 'open');
}

export function registerReviewRoutes(backend: MockBackend): void {
  const user = (id: string): ReviewUser => {
    const u = backend.users.find((x) => x.id === id);
    return { id, name: u?.name ?? 'Unknown', email: u?.email ?? '' };
  };
  /** a member whose workspace role holds `workflow:publish` (P6-43: scopes, not the old words) */
  const publisher = (tenantId: string, userId: string) => {
    const m = backend.memberships.find((x) => x.tenantId === tenantId && x.userId === userId);
    return (
      m !== undefined && backend.globalScopesOf(m.globalRole ?? m.role, tenantId).includes('workflow:publish')
    );
  };
  /** the signed-in user may publish in the workspace or in one of its projects */
  const mayPublish = () => {
    try {
      backend.requireScopeAnywhere('workflow:publish');
      return true;
    } catch {
      return false;
    }
  };
  const isAdmin = (role: keyof typeof RANK) => RANK[role] >= RANK.admin;

  const emit = (_r: StoredReview) =>
    backend.emit({ type: 'workflowReviewChanged', data: { workflowId: '', requestId: '' } });
  const log = (
    r: StoredReview,
    type: string,
    data: Record<string, unknown>,
    by: string | null,
    comment?: ReviewActivity['comment'],
  ) => {
    const entry: StoredActivity = {
      id: newId(),
      requestId: r.id,
      type,
      data,
      createdBy: by ? user(by) : null,
      createdAt: now(),
      ...(comment ? { comment } : {}),
    };
    store(backend).activity.push(entry);
    return entry;
  };
  /** the version name is read from the version (null once it is pruned), as the server does */
  const dto = ({ tenantId: _t, ...rest }: StoredReview): WorkflowReviewDTO => {
    const version = backend.versions.find(
      (v) => v.workflowId === rest.workflowId && v.versionId === rest.workflowVersionId,
    );
    return copy({ ...rest, versionName: version ? (version.versionName ?? null) : null });
  };

  /** a participant (author, assigned reviewer, admin) or a 404, as the server answers */
  const readable = (id: string) => {
    const { user: me, tenant, role } = backend.auth();
    const r = store(backend).requests.find((x) => x.id === id && x.tenantId === tenant.id);
    const participant =
      r &&
      (isAdmin(role) || r.authors.some((a) => a.id === me.id) || r.reviewers.some((a) => a.id === me.id));
    if (!r || !participant) throw new HttpError(404, 'not_found', 'Review request not found');
    return { r, me, tenant, role };
  };
  const canDecide = (r: StoredReview, meId: string, role: keyof typeof RANK) =>
    isAdmin(role) ||
    (r.reviewers.some((x) => x.id === meId) && !r.authors.some((x) => x.id === meId) && mayPublish());

  const visibleTo = (tab: 'to_review' | 'mine' | undefined) => {
    const { user: me, tenant, role } = backend.auth();
    return store(backend)
      .requests.filter((r) => r.tenantId === tenant.id && r.state === 'open')
      .filter((r) => {
        const mine = r.authors.some((a) => a.id === me.id);
        const toReview = r.reviewers.some((a) => a.id === me.id) || (isAdmin(role) && !mine);
        return tab === 'mine' ? mine : toReview;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  backend.on('GET', '/workflow-reviews', ({ query }) => {
    const { user: me, tenant, role } = backend.auth();
    const rows = store(backend)
      .requests.filter((r) => r.tenantId === tenant.id)
      .filter((r) => !query.workflowId || r.workflowId === query.workflowId)
      .filter((r) => !query.state || r.state === query.state)
      .filter(
        (r) =>
          isAdmin(role) || r.authors.some((a) => a.id === me.id) || r.reviewers.some((a) => a.id === me.id),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const result = page(rows, query);
    return listResult({ data: result.data.map(dto), nextCursor: result.nextCursor });
  });

  backend.on('GET', '/workflow-reviews/eligible-reviewers', ({ query }) => {
    const { user: me, tenant } = backend.requireScopeAnywhere('workflow:update');
    if (query.workflowId) backend.workflow(query.workflowId);
    return backend.memberships
      .filter((m) => m.tenantId === tenant.id && m.userId !== me.id && publisher(tenant.id, m.userId))
      .map((m) => user(m.userId));
  });

  backend.on('POST', '/workflow-reviews', ({ body }) => {
    const wf = backend.workflow(String(body.workflowId ?? ''));
    const { user: me, tenant } = backend.requireScope('workflow:update', { scopes: backend.rowScopes(wf) });
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const versionName = typeof body.versionName === 'string' ? body.versionName.trim() : '';
    const description = typeof body.description === 'string' ? body.description : null;
    const ids = Array.isArray(body.reviewerUserIds) ? (body.reviewerUserIds as unknown[]).map(String) : [];
    if (title.length < 1 || title.length > 128)
      throw new HttpError(400, 'bad_request', 'The title must be 1 to 128 characters');
    if (versionName.length < 1 || versionName.length > 128)
      throw new HttpError(400, 'bad_request', 'The version name must be 1 to 128 characters');
    if (description !== null && description.length > 512)
      throw new HttpError(400, 'bad_request', 'The description can have at most 512 characters');
    if (ids.length < 1 || ids.length > 10) throw new HttpError(400, 'bad_request', 'Pick 1 to 10 reviewers');
    if (ids.includes(me.id))
      throw new HttpError(400, 'bad_request', 'You cannot assign yourself as a reviewer');
    for (const id of ids) {
      if (!publisher(tenant.id, id))
        throw new HttpError(400, 'bad_request', 'Reviewers must be able to publish this workflow');
    }
    if (openReviewOf(backend, wf.id))
      throw new HttpError(409, 'conflict', 'This workflow already has an open review request');
    const versionId = typeof body.versionId === 'string' ? body.versionId : wf.versionId;
    const version = backend.versions.find((v) => v.workflowId === wf.id && v.versionId === versionId);
    if (!version) throw new HttpError(404, 'not_found', 'Version not found');
    version.versionName = versionName;
    const stamp = now();
    const request: StoredReview = {
      id: newId(),
      tenantId: tenant.id,
      workflowId: wf.id,
      workflowName: wf.name,
      workflowVersionId: versionId,
      versionName,
      approvedBaselineVersionId: null,
      state: 'open',
      decision: 'pending',
      title,
      description: description || null,
      reviewers: ids.map(user),
      authors: [user(me.id)],
      createdBy: user(me.id),
      updatedBy: user(me.id),
      closedBy: null,
      approvedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    store(backend).requests.push(request);
    log(request, 'created', { title, versionName }, me.id);
    emit(request);
    return dto(request);
  });

  backend.on('GET', '/workflow-reviews/:id', ({ params }) => dto(readable(params[0]).r));

  backend.on('POST', '/workflow-reviews/:id/update-version', ({ params, body }) => {
    const { user: me, tenant, role } = backend.auth();
    // any member who can publish may move it (n8n); others get 404 (non-participant) or 403
    if (!mayPublish()) {
      readable(params[0]);
      throw new HttpError(
        403,
        'forbidden',
        'Only members who can publish this workflow can update the request',
      );
    }
    const r = store(backend).requests.find((x) => x.id === params[0] && x.tenantId === tenant.id);
    if (!r) throw new HttpError(404, 'not_found', 'Review request not found');
    if (r.state !== 'open') throw new HttpError(409, 'conflict', 'The review request is closed');
    const versionName = typeof body.versionName === 'string' ? body.versionName.trim() : '';
    if (versionName.length < 1 || versionName.length > 128)
      throw new HttpError(400, 'bad_request', 'The version name must be 1 to 128 characters');
    const wf = backend.workflow(r.workflowId as string);
    const versionId = typeof body.versionId === 'string' ? body.versionId : wf.versionId;
    const version = backend.versions.find((v) => v.workflowId === wf.id && v.versionId === versionId);
    if (!version) throw new HttpError(404, 'not_found', 'Version not found');
    version.versionName = versionName;
    r.workflowVersionId = versionId;
    r.versionName = versionName;
    r.decision = 'pending';
    r.updatedBy = user(me.id);
    r.updatedAt = now();
    if (!r.authors.some((a) => a.id === me.id)) r.authors.push(user(me.id));
    log(r, 'version_updated', { versionId, versionName }, me.id);
    emit(r);
    return dto(r);
  });

  backend.on('POST', '/workflow-reviews/:id/decision', ({ params, body }) => {
    const { r, me, tenant, role } = readable(params[0]);
    if (!canDecide(r, me.id, role)) {
      throw r.authors.some((a) => a.id === me.id)
        ? new HttpError(403, 'forbidden', 'Authors cannot decide on their own review request')
        : new HttpError(403, 'forbidden', 'You cannot decide on this review request');
    }
    if (r.state !== 'open') throw new HttpError(409, 'conflict', 'The review request is closed');
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'changes_requested')
      throw new HttpError(400, 'bad_request', 'The decision must be approved or changes_requested');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (decision === 'changes_requested' && !note)
      throw new HttpError(400, 'bad_request', 'A note is required when you request changes');
    if (note.length > 10000 || hasControlChars(note))
      throw new HttpError(400, 'bad_request', 'The note is too long or has characters that are not allowed');
    r.decision = decision;
    r.updatedBy = user(me.id);
    r.updatedAt = now();
    log(r, 'decision', { decision, ...(note ? { note } : {}) }, me.id);
    if (decision === 'changes_requested') {
      emit(r);
      return { review: dto(r) };
    }
    const wf = backend.workflow(r.workflowId as string);
    const requesterId = r.createdBy?.id ?? '';
    r.approvedBaselineVersionId = wf.publishedVersionId;
    r.state = 'closed';
    r.closedBy = user(me.id);
    r.approvedAt = now();
    log(r, 'closed', { reason: 'approved' }, me.id);
    emit(r);
    const version = backend.versions.find(
      (v) => v.workflowId === wf.id && v.versionId === r.workflowVersionId,
    );
    let autoPublish: { status: 'published' | 'failed'; message?: string };
    if (!publisher(tenant.id, requesterId)) {
      autoPublish = {
        status: 'failed',
        message: 'The review requester no longer has permission to publish this workflow',
      };
    } else if (!version) {
      autoPublish = { status: 'failed', message: 'The reviewed workflow version no longer exists' };
    } else {
      Object.assign(wf, copy(version.snapshot));
      wf.versionId = version.versionId;
      wf.active = true;
      wf.publishedVersionId = version.versionId;
      wf.updatedAt = now();
      recordPublishEvent(backend, wf, 'activated', version.versionId);
      autoPublish = { status: 'published' };
    }
    return { review: dto(r), autoPublish };
  });

  backend.on('GET', '/workflow-reviews/:id/activity', ({ params, query }) => {
    const { r } = readable(params[0]);
    const rows = store(backend)
      .activity.filter((a) => a.requestId === r.id)
      .reverse();
    const result = page(rows, { ...query, limit: '25' });
    return listResult({
      data: result.data.map(({ requestId: _r, ...entry }) => copy(entry)),
      nextCursor: result.nextCursor,
    });
  });

  backend.on('POST', '/workflow-reviews/:id/comments', ({ params, body }) => {
    const { r, me, role } = readable(params[0]);
    if (!r.authors.some((a) => a.id === me.id) && !canDecide(r, me.id, role))
      throw new HttpError(403, 'forbidden', 'You cannot comment on this review request');
    if (r.state !== 'open') throw new HttpError(409, 'conflict', 'The review request is closed');
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (hasControlChars(text))
      throw new HttpError(400, 'bad_request', 'The comment cannot contain control characters');
    if (text.length < 1 || text.length > 10000)
      throw new HttpError(400, 'bad_request', 'The comment must be 1 to 10000 characters');
    const entry = log(r, 'comment', {}, me.id, { id: newId(), body: text });
    r.updatedAt = now();
    emit(r);
    const { requestId: _r, ...out } = entry;
    return copy(out);
  });

  backend.on('GET', '/inbox', ({ query }) => {
    const tab = query.tab === 'mine' ? 'mine' : 'to_review';
    const result = page(visibleTo(tab), query);
    return listResult({ data: result.data.map(dto), nextCursor: result.nextCursor });
  });
  backend.on('GET', '/inbox/summary', () => ({
    toReview: visibleTo('to_review').length,
    mine: visibleTo('mine').length,
  }));
}
