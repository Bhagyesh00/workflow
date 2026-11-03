/**
 * Workflow reviews and the inbox (P3-19, lane L14): requests pin a version, a pending or
 * changes-requested request blocks publishing, approval closes the request and publishes the
 * pinned version as the requester, and only participants can read a request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;

/** signup is limited to 20 per server instance, so each group of tests gets its own server */
function useServer() {
  beforeAll(async () => {
    server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await resetDatabase(server.ctx);
  });
}

type Owner = Awaited<ReturnType<typeof signup>>;
interface Member {
  client: TestClient;
  id: string;
}

async function member(owner: Owner, role: 'admin' | 'editor' | 'viewer'): Promise<Member> {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  const accepted = await client.data<{ user: { id: string } }>(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: `${role} user`, password: 'Passw0rd!' }),
  );
  return { client, id: accepted.user.id };
}

async function workspace(enabled = true) {
  const owner = await signup(server.app);
  if (enabled)
    await owner.client.data(owner.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
  return owner;
}

/** a webhook workflow (it can be published) */
const trigger = () => {
  const path = `p${Math.random().toString(36).slice(2, 10)}`;
  return node('Webhook', 'core.webhook', { httpMethod: 'POST', path }, [0, 0], { webhookId: `id-${path}` });
};

const manual = (name = 'W', value = 'v1') => ({
  name,
  nodes: [trigger(), setNode('Set', 'greeting', value)],
  connections: chain('Webhook', 'Set'),
});

/** a new draft version of the workflow */
async function save(client: TestClient, id: string, value: string) {
  const current = await client.data<{ versionId: string; nodes: Array<{ name: string }> }>(
    client.get(`/rest/workflows/${id}`),
  );
  const webhook = current.nodes.find((n) => n.name === 'Webhook');
  return client.data<{ versionId: string }>(
    client.patch(`/rest/workflows/${id}`, {
      versionId: current.versionId,
      nodes: [webhook, setNode('Set', 'greeting', value)],
      connections: chain('Webhook', 'Set'),
    }),
  );
}

const submit = (client: TestClient, body: Record<string, unknown>) =>
  client.post('/rest/workflow-reviews', body);

async function openReview(client: TestClient, workflowId: string, reviewerUserIds: string[], extra = {}) {
  return client.data<{ id: string; workflowVersionId: string }>(
    submit(client, { workflowId, title: 'Please check', versionName: 'v1', reviewerUserIds, ...extra }),
  );
}

const decide = (client: TestClient, id: string, body: Record<string, unknown>) =>
  client.post(`/rest/workflow-reviews/${id}/decision`, body);

const dbReview = async (id: string) =>
  (
    await server.ctx.database.pool.query(
      `select state, decision, closed_by, approved_at, approved_baseline_version_id, workflow_version_id
       from workflow_review_requests where id = $1`,
      [id],
    )
  ).rows[0];

describe('submitting a review request', () => {
  useServer();

  it('pins the version, names it and lists the requester as author', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await owner.client.data(
      submit(owner.client, {
        workflowId: wf.id,
        title: '  Ready  ',
        description: 'New greeting',
        versionName: 'First cut',
        reviewerUserIds: [editor.id],
      }),
    );
    expect(review).toMatchObject({
      workflowId: wf.id,
      workflowName: 'W',
      workflowVersionId: wf.versionId,
      versionName: 'First cut',
      state: 'open',
      decision: 'pending',
      title: 'Ready',
      description: 'New greeting',
      approvedBaselineVersionId: null,
      closedBy: null,
      approvedAt: null,
    });
    expect(review.reviewers.map((u: { id: string }) => u.id)).toEqual([editor.id]);
    expect(review.authors.map((u: { id: string }) => u.id)).toEqual([owner.user.id]);
    expect(review.createdBy).toMatchObject({ id: owner.user.id, email: owner.user.email });
    const version = await owner.client.data(
      owner.client.get(`/rest/workflows/${wf.id}/versions/${wf.versionId}`),
    );
    expect(version.versionName).toBe('First cut');
  });

  it('applies the request rules', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const viewer = await member(owner, 'viewer');
    const wf = await createWorkflow(owner.client, manual());
    const base = { workflowId: wf.id, title: 'T', versionName: 'v', reviewerUserIds: [editor.id] };
    const status = async (body: Record<string, unknown>) => (await submit(owner.client, body)).statusCode;

    expect(await status({ ...base, title: '' })).toBe(400);
    expect(await status({ ...base, title: 'x'.repeat(129) })).toBe(400);
    expect(await status({ ...base, versionName: '' })).toBe(400);
    expect(await status({ ...base, description: 'x'.repeat(513) })).toBe(400);
    expect(await status({ ...base, reviewerUserIds: [] })).toBe(400);
    expect(
      await status({ ...base, reviewerUserIds: Array.from({ length: 11 }, () => crypto.randomUUID()) }),
    ).toBe(400);
    const self = await submit(owner.client, { ...base, reviewerUserIds: [editor.id, owner.user.id] });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.message).toBe('You cannot assign yourself as a reviewer');
    const notPublisher = await submit(owner.client, { ...base, reviewerUserIds: [viewer.id] });
    expect(notPublisher.statusCode).toBe(400);
    expect(notPublisher.json().error.message).toBe('Reviewers must be able to publish this workflow');
    expect(await status({ ...base, versionId: crypto.randomUUID() })).toBe(404);
    expect(await status({ ...base, workflowId: crypto.randomUUID() })).toBe(404);

    expect((await submit(viewer.client, { ...base, reviewerUserIds: [editor.id] })).statusCode).toBe(403);

    expect(await status(base)).toBe(200);
    const again = await submit(owner.client, base);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('This workflow already has an open review request');
  });

  it('is refused while reviews are off', async () => {
    const owner = await workspace(false);
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const res = await submit(owner.client, {
      workflowId: wf.id,
      title: 'T',
      versionName: 'v',
      reviewerUserIds: [editor.id],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Workflow reviews are turned off for this workspace');
  });

  it('lists eligible reviewers: editors and up, never the caller', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const admin = await member(owner, 'admin');
    const viewer = await member(owner, 'viewer');
    const wf = await createWorkflow(owner.client, manual());
    const list = await editor.client.data<Array<{ id: string }>>(
      editor.client.get(`/rest/workflow-reviews/eligible-reviewers?workflowId=${wf.id}`),
    );
    expect(list.map((u) => u.id).sort()).toEqual([owner.user.id, admin.id].sort());
    expect((await viewer.client.get('/rest/workflow-reviews/eligible-reviewers')).statusCode).toBe(403);
    const other = await signup(server.app);
    expect(
      (await other.client.get(`/rest/workflow-reviews/eligible-reviewers?workflowId=${wf.id}`)).statusCode,
    ).toBe(404);
  });
});

describe('the publish guard and decisions', () => {
  useServer();

  it('blocks publishing while pending, then while changes are requested (409 with the reason)', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [editor.id]);

    const pending = await owner.client.post(`/rest/workflows/${wf.id}/activate`);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.details).toMatchObject({ reason: 'review_pending', requestId: review.id });

    expect((await decide(editor.client, review.id, { decision: 'changes_requested' })).statusCode).toBe(400);
    expect(
      (await decide(editor.client, review.id, { decision: 'changes_requested', note: 'bad\u0007note' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await decide(editor.client, review.id, { decision: 'changes_requested', note: 'x'.repeat(10001) }))
        .statusCode,
    ).toBe(400);
    const changes = await editor.client.data(
      decide(editor.client, review.id, { decision: 'changes_requested', note: 'Rename\nthe node' }),
    );
    expect(changes.review).toMatchObject({ state: 'open', decision: 'changes_requested' });
    expect(changes.autoPublish).toBeUndefined();

    const blocked = await owner.client.post(`/rest/workflows/${wf.id}/activate`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details).toMatchObject({ reason: 'changes_requested' });
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))?.active).toBe(false);
  });

  it('approval closes the request and publishes the pinned version (no baseline when never published)', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [editor.id]);
    // a newer draft after the request: the pinned version is the one that goes live
    await save(owner.client, wf.id, 'v2');

    const result = await editor.client.data(decide(editor.client, review.id, { decision: 'approved' }));
    expect(result.autoPublish).toEqual({ status: 'published' });
    expect(result.review).toMatchObject({
      state: 'closed',
      decision: 'approved',
      approvedBaselineVersionId: null,
      closedBy: { id: editor.id },
    });
    expect(result.review.approvedAt).toEqual(expect.any(String));
    const live = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(live).toMatchObject({ active: true, publishedVersionId: wf.versionId });
    const row = await dbReview(review.id);
    expect(row).toMatchObject({ state: 'closed', decision: 'approved', closed_by: editor.id });
    expect(row.approved_baseline_version_id).toBeNull();
    // the request is closed: the guard lets the next publish through
    expect((await owner.client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(200);
  });

  it('approval stores the published version before the auto-publish as the baseline', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    const next = await save(owner.client, wf.id, 'v2');
    const review = await openReview(owner.client, wf.id, [editor.id], { versionId: next.versionId });
    const result = await editor.client.data(decide(editor.client, review.id, { decision: 'approved' }));
    expect(result.review.approvedBaselineVersionId).toBe(wf.versionId);
    expect(result.autoPublish).toEqual({ status: 'published' });
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))?.publishedVersionId).toBe(
      next.versionId,
    );
  });

  it('an admin decides a review they authored; another author is refused (403)', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const reviewer = await member(owner, 'editor');
    const mine = await openReview(owner.client, (await createWorkflow(owner.client, manual('A'))).id, [
      editor.id,
    ]);
    expect((await decide(owner.client, mine.id, { decision: 'approved' })).statusCode).toBe(200);

    const theirs = await openReview(editor.client, (await createWorkflow(editor.client, manual('B'))).id, [
      reviewer.id,
    ]);
    const refused = await decide(editor.client, theirs.id, { decision: 'approved' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe('Authors cannot decide on their own review request');
    expect((await dbReview(theirs.id)).state).toBe('open');
  });

  it('runs one decision at a time: a second approval of the same request answers 409', async () => {
    const owner = await workspace();
    const first = await member(owner, 'editor');
    const second = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [first.id, second.id]);
    const results = await Promise.all([
      decide(first.client, review.id, { decision: 'approved' }),
      decide(second.client, review.id, { decision: 'approved' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const published = await server.ctx.database.pool.query(
      `select count(*)::int as n from workflow_publish_history where workflow_id = $1 and event = 'activated'`,
      [wf.id],
    );
    expect(published.rows[0].n).toBeLessThanOrEqual(1);
  });

  it('keeps the approval when the requester can no longer publish', async () => {
    const owner = await workspace();
    const requester = await member(owner, 'editor');
    const reviewer = await member(owner, 'editor');
    const wf = await createWorkflow(requester.client, manual());
    const review = await openReview(requester.client, wf.id, [reviewer.id]);
    await owner.client.data(owner.client.patch(`/rest/members/${requester.id}`, { role: 'viewer' }));
    const result = await reviewer.client.data(decide(reviewer.client, review.id, { decision: 'approved' }));
    expect(result.autoPublish).toEqual({
      status: 'failed',
      message: 'The review requester no longer has permission to publish this workflow',
    });
    expect(result.review).toMatchObject({ state: 'closed', decision: 'approved', closedBy: null });
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))?.active).toBe(false);
  });

  it('reports a requester who left the workspace and a pinned version that is gone', async () => {
    const owner = await workspace();
    const requester = await member(owner, 'editor');
    const reviewer = await member(owner, 'editor');
    const a = await createWorkflow(requester.client, manual('A'));
    const left = await openReview(requester.client, a.id, [reviewer.id]);
    await owner.client.data(owner.client.delete(`/rest/members/${requester.id}`));
    const gone = await reviewer.client.data(decide(reviewer.client, left.id, { decision: 'approved' }));
    expect(gone.autoPublish).toEqual({
      status: 'failed',
      message: 'The review requester is no longer available',
    });

    const b = await createWorkflow(owner.client, manual('B'));
    const pruned = await openReview(owner.client, b.id, [reviewer.id]);
    await save(owner.client, b.id, 'v2');
    await server.ctx.database.pool.query('delete from workflow_versions where id = $1', [b.versionId]);
    const missing = await reviewer.client.data(decide(reviewer.client, pruned.id, { decision: 'approved' }));
    expect(missing.autoPublish).toEqual({
      status: 'failed',
      message: 'The reviewed workflow version no longer exists',
    });
    expect(missing.review).toMatchObject({ state: 'closed', decision: 'approved' });
  });

  it('a closed request takes no more decisions', async () => {
    const owner = await workspace();
    const editor = await member(owner, 'editor');
    const review = await openReview(owner.client, (await createWorkflow(owner.client, manual())).id, [
      editor.id,
    ]);
    await editor.client.data(decide(editor.client, review.id, { decision: 'approved' }));
    expect((await decide(editor.client, review.id, { decision: 'approved' })).statusCode).toBe(409);
  });
});

describe('read gate, tenants and comments', () => {
  useServer();

  it('answers 404 to an unrelated editor, an unrelated viewer and another tenant', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const outsider = await member(owner, 'editor');
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const review = await openReview(owner.client, (await createWorkflow(owner.client, manual())).id, [
      reviewer.id,
    ]);
    for (const client of [outsider.client, viewer.client, other.client]) {
      expect((await client.get(`/rest/workflow-reviews/${review.id}`)).statusCode).toBe(404);
      expect((await client.get(`/rest/workflow-reviews/${review.id}/activity`)).statusCode).toBe(404);
      expect(
        (await client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'hi' })).statusCode,
      ).toBe(404);
      expect((await decide(client, review.id, { decision: 'approved' })).statusCode).toBe(404);
      expect(
        (await client.post(`/rest/workflow-reviews/${review.id}/update-version`, { versionName: 'x' }))
          .statusCode,
      ).toBe(404);
      expect((await client.data(client.get('/rest/workflow-reviews'))).length).toBe(0);
    }
    expect((await other.client.get('/rest/workflow-reviews/not-a-uuid')).statusCode).toBe(404);
    // participants and admins read it
    expect((await reviewer.client.get(`/rest/workflow-reviews/${review.id}`)).statusCode).toBe(200);
    const admin = await member(owner, 'admin');
    expect((await admin.client.get(`/rest/workflow-reviews/${review.id}`)).statusCode).toBe(200);
    expect((await dbReview(review.id)).state).toBe('open');
  });

  it('records comments and the activity feed, newest first; refuses demoted reviewers and closed requests', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const demoted = await member(owner, 'editor');
    const review = await openReview(owner.client, (await createWorkflow(owner.client, manual())).id, [
      reviewer.id,
      demoted.id,
    ]);
    const comment = await reviewer.client.data(
      reviewer.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: '  Looks fine  ' }),
    );
    expect(comment).toMatchObject({
      type: 'comment',
      comment: { body: 'Looks fine' },
      createdBy: { id: reviewer.id },
    });
    expect(
      (await owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: '' })).statusCode,
    ).toBe(400);
    expect(
      (await owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'a\u0000b' }))
        .statusCode,
    ).toBe(400);
    await owner.client.data(
      owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'Thanks' }),
    );

    await owner.client.data(owner.client.patch(`/rest/members/${demoted.id}`, { role: 'viewer' }));
    expect((await demoted.client.get(`/rest/workflow-reviews/${review.id}`)).statusCode).toBe(200);
    expect(
      (await demoted.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'x' })).statusCode,
    ).toBe(403);
    expect((await decide(demoted.client, review.id, { decision: 'approved' })).statusCode).toBe(403);

    const feed = await owner.client.get(`/rest/workflow-reviews/${review.id}/activity`);
    const body = feed.json();
    expect(body.data.map((a: { type: string }) => a.type)).toEqual(['comment', 'comment', 'created']);
    expect(body.data[0].comment.body).toBe('Thanks');
    expect(body.nextCursor).toBeNull();

    await reviewer.client.data(decide(reviewer.client, review.id, { decision: 'approved' }));
    expect(
      (await owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'late' })).statusCode,
    ).toBe(409);
    const after = (await owner.client.get(`/rest/workflow-reviews/${review.id}/activity`)).json();
    expect(after.data.map((a: { type: string }) => a.type).slice(0, 2)).toEqual(['closed', 'decision']);
  });

  it('pages the activity feed by 25', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const review = await openReview(owner.client, (await createWorkflow(owner.client, manual())).id, [
      reviewer.id,
    ]);
    for (let i = 0; i < 26; i++) {
      await owner.client.data(
        owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: `c${i}` }),
      );
    }
    const first = (await owner.client.get(`/rest/workflow-reviews/${review.id}/activity`)).json();
    expect(first.data).toHaveLength(25);
    expect(first.data[0].comment.body).toBe('c25');
    const second = (
      await owner.client.get(`/rest/workflow-reviews/${review.id}/activity?cursor=${first.nextCursor}`)
    ).json();
    expect(second.data.map((a: { type: string }) => a.type)).toEqual(['comment', 'created']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('update-version, archive, delete and the inbox', () => {
  useServer();

  it('moves an open request to a newer version and resets the decision', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const outsiderWf = await createWorkflow(owner.client, manual('Other'));
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [reviewer.id]);
    await reviewer.client.data(
      decide(reviewer.client, review.id, { decision: 'changes_requested', note: 'Fix it' }),
    );
    const next = await save(owner.client, wf.id, 'v2');
    const moved = await owner.client.data(
      owner.client.post(`/rest/workflow-reviews/${review.id}/update-version`, { versionName: 'Second cut' }),
    );
    expect(moved).toMatchObject({
      workflowVersionId: next.versionId,
      versionName: 'Second cut',
      decision: 'pending',
    });
    expect(
      (
        await owner.client.post(`/rest/workflow-reviews/${review.id}/update-version`, {
          versionId: outsiderWf.versionId,
          versionName: 'x',
        })
      ).statusCode,
    ).toBe(404);
    const feed = (await owner.client.get(`/rest/workflow-reviews/${review.id}/activity`)).json();
    expect(feed.data[0]).toMatchObject({
      type: 'version_updated',
      data: { versionId: next.versionId, versionName: 'Second cut', previousVersionId: wf.versionId },
    });
    const blocked = await owner.client.post(`/rest/workflows/${wf.id}/activate`);
    expect(blocked.json().error.details).toMatchObject({ reason: 'review_pending' });
  });

  it('only an author or an admin moves a request to another version', async () => {
    const owner = await workspace();
    const author = await member(owner, 'editor');
    const reviewer = await member(owner, 'editor');
    const wf = await createWorkflow(author.client, manual());
    const review = await openReview(author.client, wf.id, [reviewer.id]);
    const refused = await reviewer.client.post(`/rest/workflow-reviews/${review.id}/update-version`, {
      versionName: 'x',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe('Only an author can update the request');
    await save(author.client, wf.id, 'v2');
    const moved = await owner.client.data(
      owner.client.post(`/rest/workflow-reviews/${review.id}/update-version`, { versionName: 'By admin' }),
    );
    // the admin who synced the version is now an author too, and as an admin may still decide
    expect(moved.authors.map((u: { id: string }) => u.id).sort()).toEqual([author.id, owner.user.id].sort());
    expect((await decide(owner.client, review.id, { decision: 'approved' })).statusCode).toBe(200);
  });

  it('with reviews turned off, publishing passes the guard and closes the open request', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [reviewer.id]);
    await owner.client.data(owner.client.patch('/rest/settings', { workflowReviews: { enabled: false } }));
    expect((await owner.client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(200);
    expect(await dbReview(review.id)).toMatchObject({
      state: 'closed',
      decision: 'pending',
      closed_by: null,
    });
    // a later approval cannot publish the older pinned version over it
    expect((await decide(reviewer.client, review.id, { decision: 'approved' })).statusCode).toBe(409);
  });

  it('public DELETE (force) closes an open request and the inbox no longer lists it', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const key = (await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k' }))).key as string;
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [reviewer.id]);
    expect((await reviewer.client.data(reviewer.client.get('/rest/inbox/summary'))).toReview).toBe(1);

    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/workflows/${wf.id}`,
      headers: { 'x-api-key': key },
    });
    expect(res.statusCode).toBe(200);
    const row = await dbReview(review.id);
    expect(row).toMatchObject({ state: 'closed', decision: 'pending', closed_by: null });
    expect((await reviewer.client.data(reviewer.client.get('/rest/inbox?tab=to_review'))).length).toBe(0);
    expect((await reviewer.client.data(reviewer.client.get('/rest/inbox/summary'))).toReview).toBe(0);
    const dto = await reviewer.client.data(reviewer.client.get(`/rest/workflow-reviews/${review.id}`));
    expect(dto).toMatchObject({ workflowId: null, state: 'closed', closedBy: null });
  });

  it('archive closes an open request', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [reviewer.id]);
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/archive`));
    expect(await dbReview(review.id)).toMatchObject({ state: 'closed', closed_by: null });
    const feed = (await owner.client.get(`/rest/workflow-reviews/${review.id}/activity`)).json();
    expect(feed.data[0]).toMatchObject({ type: 'closed', data: { reason: 'archived' }, createdBy: null });
  });

  it('lists only the caller’s reviews in the inbox (admins see all)', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const author = await member(owner, 'editor');
    const outsider = await member(owner, 'editor');
    const review = await openReview(author.client, (await createWorkflow(author.client, manual())).id, [
      reviewer.id,
    ]);

    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
    expect(ids(await reviewer.client.data(reviewer.client.get('/rest/inbox?tab=to_review')))).toEqual([
      review.id,
    ]);
    expect(ids(await reviewer.client.data(reviewer.client.get('/rest/inbox?tab=mine')))).toEqual([]);
    expect(ids(await author.client.data(author.client.get('/rest/inbox?tab=mine')))).toEqual([review.id]);
    expect(ids(await author.client.data(author.client.get('/rest/inbox?tab=to_review')))).toEqual([]);
    expect(ids(await outsider.client.data(outsider.client.get('/rest/inbox')))).toEqual([]);
    expect(await outsider.client.data(outsider.client.get('/rest/inbox/summary'))).toEqual({
      toReview: 0,
      mine: 0,
    });
    expect(await author.client.data(author.client.get('/rest/inbox/summary'))).toEqual({
      toReview: 0,
      mine: 1,
    });
    expect(ids(await owner.client.data(owner.client.get('/rest/inbox')))).toEqual([review.id]);
    const other = await signup(server.app);
    expect(ids(await other.client.data(other.client.get('/rest/inbox')))).toEqual([]);
    expect(ids(await reviewer.client.data(reviewer.client.get(`/rest/workflow-reviews?state=open`)))).toEqual(
      [review.id],
    );
  });

  it('emits workflowReviewChanged on every change', async () => {
    const owner = await workspace();
    const reviewer = await member(owner, 'editor');
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = await server.ctx.push.subscribe(owner.tenant.id, (event) => events.push(event));
    const wf = await createWorkflow(owner.client, manual());
    const review = await openReview(owner.client, wf.id, [reviewer.id]);
    await owner.client.data(
      owner.client.post(`/rest/workflow-reviews/${review.id}/comments`, { body: 'hi' }),
    );
    await reviewer.client.data(decide(reviewer.client, review.id, { decision: 'approved' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    const changes = events.filter((e) => e.type === 'workflowReviewChanged');
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes[0].data).toEqual({ workflowId: wf.id, requestId: review.id });
  });
});
