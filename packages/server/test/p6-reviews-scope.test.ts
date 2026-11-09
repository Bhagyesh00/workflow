/**
 * P6-27 (L7): workflow reviews read the project scopes of each user on the request's workflow. A true
 * `member` (invited as `member`, given a project role through `addToProject`) can submit and be
 * assigned only where it holds `workflow:publish`; a project admin (and the workspace owner) reads and
 * decides every request of the workflow; a request with no workflow is for its participants and the
 * workspace roles only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  chain,
  createTestServer,
  node,
  projectIn,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const webhook = () => {
  const path = `p${Math.random().toString(36).slice(2, 10)}`;
  return node('Webhook', 'core.webhook', { httpMethod: 'POST', path }, [0, 0], { webhookId: `id-${path}` });
};

/**
 * an owner, a workflow in project Alpha, and members: `author` and `reviewer` (project:editor in Alpha),
 * `admin` (project:admin in Alpha), `viewer` (project:viewer in Alpha), `peer` (project:editor in Alpha,
 * not a participant) and `outsider` (project:editor in Beta only)
 */
async function setup() {
  const owner = await signup(server.app);
  await owner.client.data(owner.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  const people = {
    author: await realMember(owner, { name: 'Author' }),
    reviewer: await realMember(owner, { name: 'Reviewer' }),
    admin: await realMember(owner, { name: 'Admin of Alpha' }),
    viewer: await realMember(owner, { name: 'Viewer' }),
    peer: await realMember(owner, { name: 'Peer' }),
    outsider: await realMember(owner, { name: 'Outsider' }),
  };
  const tenantId = owner.tenant.id;
  await addToProject(server, tenantId, alpha.id, people.author.user.id, 'project:editor');
  await addToProject(server, tenantId, alpha.id, people.reviewer.user.id, 'project:editor');
  await addToProject(server, tenantId, alpha.id, people.admin.user.id, 'project:admin');
  await addToProject(server, tenantId, alpha.id, people.viewer.user.id, 'project:viewer');
  await addToProject(server, tenantId, alpha.id, people.peer.user.id, 'project:editor');
  await addToProject(server, tenantId, beta.id, people.outsider.user.id, 'project:editor');
  const workflow = await owner.client.data<{ id: string; versionId: string }>(
    owner.client.post('/rest/workflows', {
      name: 'Reviewed',
      projectId: alpha.id,
      nodes: [webhook(), setNode('Set', 'greeting', 'v1')],
      connections: chain('Webhook', 'Set'),
    }),
  );
  return { owner, alpha, beta, workflow, tenantId, ...people };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const body = (workflowId: string, reviewerUserIds: string[]) => ({
  workflowId,
  title: 'Please check',
  versionName: 'v1',
  reviewerUserIds,
});

/** the author opens a request that the reviewer is assigned to */
async function openReview(s: Setup) {
  return s.author.client.data<{ id: string }>(
    s.author.client.post('/rest/workflow-reviews', body(s.workflow.id, [s.reviewer.user.id])),
  );
}

describe('submitting a request', () => {
  it('needs workflow:publish on the workflow: a project editor can, a project viewer or an outsider cannot', async () => {
    const s = await setup();
    const reviewers = [s.reviewer.user.id];
    const viewer = await s.viewer.client.post('/rest/workflow-reviews', body(s.workflow.id, reviewers));
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.message).toBe(FORBIDDEN);
    const outsider = await s.outsider.client.post('/rest/workflow-reviews', body(s.workflow.id, reviewers));
    expect(outsider.statusCode).toBe(403);
    const author = await s.author.client.post('/rest/workflow-reviews', body(s.workflow.id, reviewers));
    expect(author.statusCode).toBe(200);
    expect(author.json().data.authors.map((a: { id: string }) => a.id)).toEqual([s.author.user.id]);
  });

  it("answers 404 to another workspace's workflow", async () => {
    const s = await setup();
    const other = await signup(server.app);
    const res = await other.client.post('/rest/workflow-reviews', body(s.workflow.id, []));
    expect(res.statusCode).toBe(404);
  });

  it('assigns only members who can publish this workflow', async () => {
    const s = await setup();
    const status = async (ids: string[]) =>
      (await s.author.client.post('/rest/workflow-reviews', body(s.workflow.id, ids))).statusCode;
    expect(await status([s.viewer.user.id])).toBe(400);
    expect(await status([s.outsider.user.id])).toBe(400);
    expect(await status([s.peer.user.id, s.admin.user.id])).toBe(200);
  });

  it('lists as eligible reviewers the members who hold workflow:publish on that workflow', async () => {
    const s = await setup();
    const list = await s.author.client.data<Array<{ id: string }>>(
      s.author.client.get(`/rest/workflow-reviews/eligible-reviewers?workflowId=${s.workflow.id}`),
    );
    const ids = list.map((user) => user.id).sort();
    expect(ids).toEqual([s.reviewer.user.id, s.admin.user.id, s.peer.user.id, s.owner.user.id].sort());
    expect(ids).not.toContain(s.viewer.user.id);
    expect(ids).not.toContain(s.outsider.user.id);
    expect(ids).not.toContain(s.author.user.id);
    const denied = await s.viewer.client.get(
      `/rest/workflow-reviews/eligible-reviewers?workflowId=${s.workflow.id}`,
    );
    expect(denied.statusCode).toBe(403);
  });
});

describe('who reads a request', () => {
  it('shows it to its participants, the project admin and the owner, and hides it from other members (404)', async () => {
    const s = await setup();
    const review = await openReview(s);
    const get = async (who: { client: { get: (url: string) => Promise<{ statusCode: number }> } }) =>
      (await who.client.get(`/rest/workflow-reviews/${review.id}`)).statusCode;
    expect(await get(s.author)).toBe(200);
    expect(await get(s.reviewer)).toBe(200);
    expect(await get(s.admin)).toBe(200);
    expect(await get(s.owner)).toBe(200);
    expect(await get(s.peer)).toBe(404);
    expect(await get(s.viewer)).toBe(404);
    expect(await get(s.outsider)).toBe(404);
  });

  it('lists the requests by scope: all for the owner, those of the project for its admin, only theirs for others', async () => {
    const s = await setup();
    const review = await openReview(s);
    const ids = async (who: { client: { get: (url: string) => Promise<{ json: () => any }> } }) =>
      (await who.client.get('/rest/workflow-reviews')).json().data.map((r: { id: string }) => r.id);
    expect(await ids(s.owner)).toEqual([review.id]);
    expect(await ids(s.admin)).toEqual([review.id]);
    expect(await ids(s.reviewer)).toEqual([review.id]);
    expect(await ids(s.peer)).toEqual([]);
    expect(await ids(s.outsider)).toEqual([]);
  });

  it('puts the request in the inbox of its reviewer and of the project admin, not in the peer inbox', async () => {
    const s = await setup();
    const review = await openReview(s);
    const inbox = async (who: { client: { get: (url: string) => Promise<{ json: () => any }> } }) =>
      (await who.client.get('/rest/inbox?tab=to_review')).json().data.map((r: { id: string }) => r.id);
    expect(await inbox(s.reviewer)).toEqual([review.id]);
    expect(await inbox(s.admin)).toEqual([review.id]);
    expect(await inbox(s.peer)).toEqual([]);
    expect(await inbox(s.author)).toEqual([]);
    const summary = await s.admin.client.data<{ toReview: number }>(
      s.admin.client.get('/rest/inbox/summary'),
    );
    expect(summary.toReview).toBe(1);
  });

  it('reads a request with no workflow for its participants and the workspace roles only', async () => {
    const s = await setup();
    const review = await openReview(s);
    await server.ctx.database.pool.query(
      'update workflow_review_requests set workflow_id = null where id = $1',
      [review.id],
    );
    const status = async (who: { client: { get: (url: string) => Promise<{ statusCode: number }> } }) =>
      (await who.client.get(`/rest/workflow-reviews/${review.id}`)).statusCode;
    expect(await status(s.author)).toBe(200);
    expect(await status(s.reviewer)).toBe(200);
    expect(await status(s.owner)).toBe(200);
    expect(await status(s.admin)).toBe(404);
    const list = await s.admin.client.data<unknown[]>(s.admin.client.get('/rest/workflow-reviews'));
    expect(list).toEqual([]);
  });
});

describe('decisions and updates', () => {
  const decide = (who: Setup['reviewer'], id: string, decision = 'changes_requested') =>
    who.client.post(`/rest/workflow-reviews/${id}/decision`, { decision, note: 'ok' });

  it('lets the assigned reviewer and the project admin decide, and refuses the author and other members', async () => {
    const s = await setup();
    const review = await openReview(s);
    expect((await decide(s.author, review.id)).statusCode).toBe(403);
    expect((await decide(s.peer, review.id)).statusCode).toBe(404);
    expect((await decide(s.outsider, review.id)).statusCode).toBe(404);
    expect((await decide(s.reviewer, review.id)).statusCode).toBe(200);
    expect((await decide(s.admin, review.id)).statusCode).toBe(200);
  });

  it('refuses a reviewer who lost workflow:publish on the next call', async () => {
    const s = await setup();
    const review = await openReview(s);
    await addToProject(server, s.tenantId, s.alpha.id, s.reviewer.user.id, 'project:viewer');
    const res = await decide(s.reviewer, review.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('You cannot decide on this review request');
  });

  it('a project admin who authored a request may decide it', async () => {
    const s = await setup();
    const review = await s.admin.client.data<{ id: string }>(
      s.admin.client.post('/rest/workflow-reviews', body(s.workflow.id, [s.reviewer.user.id])),
    );
    expect((await decide(s.admin, review.id)).statusCode).toBe(200);
  });

  it('reports a requester who lost workflow:publish when the approval tries to publish', async () => {
    const s = await setup();
    const review = await openReview(s);
    await addToProject(server, s.tenantId, s.alpha.id, s.author.user.id, 'project:viewer');
    const res = await decide(s.reviewer, review.id, 'approved');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.autoPublish).toMatchObject({
      status: 'failed',
      message: 'The review requester no longer has permission to publish this workflow',
    });
  });

  it('lets a project editor who is no participant move the request, and refuses a viewer and an outsider', async () => {
    const s = await setup();
    const review = await openReview(s);
    const update = (who: Setup['peer']) =>
      who.client.post(`/rest/workflow-reviews/${review.id}/update-version`, { versionName: 'v2' });
    expect((await update(s.viewer)).statusCode).toBe(404);
    expect((await update(s.outsider)).statusCode).toBe(404);
    const moved = await update(s.peer);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data.authors.map((a: { id: string }) => a.id)).toContain(s.peer.user.id);
  });

  it('answers 403 to a participant who cannot publish when moving the request', async () => {
    const s = await setup();
    const review = await openReview(s);
    await addToProject(server, s.tenantId, s.alpha.id, s.reviewer.user.id, 'project:viewer');
    const res = await s.reviewer.client.post(`/rest/workflow-reviews/${review.id}/update-version`, {
      versionName: 'v2',
    });
    expect(res.statusCode).toBe(403);
  });
});
