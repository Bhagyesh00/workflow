/**
 * P3-19 (editor): the review gate, submit / update dialogs, status banner, inbox, review detail
 * (diff of published vs pinned, approved baseline once closed), decision rules and the Security
 * settings switch, against the demo backend's review routes.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../src/App';
import type { ApiError } from '../src/api/client';
import { inboxApi, reviewsApi, settingsApi } from '../src/api/endpoints';
import { ReviewStatusBanner } from '../src/features/reviews/ReviewStatusBanner';
import { reviewGate, useReviewUi } from '../src/features/reviews/review-publish';
import { newId } from '../src/lib/ids';
import { useToastStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, testQueryClient } from './utils';

const node = (id: string, name: string, type: string, x: number): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 0],
  parameters: {},
});

function addMember(name: string, role: 'viewer' | 'editor' | 'admin'): string {
  const b = backend();
  const id = newId();
  b.users.push({ id, email: `${name.toLowerCase()}@example.com`, name, password: 'secret-pass-1' });
  b.memberships.push({ tenantId: b.session!.tenantId, userId: id, role });
  return id;
}

function actAs(userId: string): void {
  backend().session = { userId, tenantId: backend().session!.tenantId };
}

interface Scene {
  owner: string;
  editor: string;
  reviewer: string;
  other: string;
  workflowId: string;
  /** the version published before the request (null when never published) */
  baselineId: string | null;
  /** the version the request pins */
  pinnedId: string;
}

/** reviews on; a workflow with a published V1 (or none) and a saved V2 that adds a node "Extra" */
async function scene(published = true): Promise<Scene> {
  signedIn();
  const owner = backend().session!.userId;
  const editor = addMember('Ed', 'editor');
  const reviewer = addMember('Rae', 'editor');
  const other = addMember('Otto', 'editor');
  await settingsApi.update({ workflowReviews: { enabled: true } });
  const dto = backend().seedWorkflow({
    name: 'Lead flow',
    active: published,
    nodes: [node('n1', 'Start', 'core.manualTrigger', 0)],
    connections: {},
  });
  const wf = backend().workflows.find((w) => w.id === dto.id)!;
  const baselineId = published ? wf.versionId : null;
  wf.nodes = [...wf.nodes, node('n2', 'Extra', 'core.set', 300)];
  wf.versionId = newId();
  backend().recordVersion(wf, 'Added Extra');
  return { owner, editor, reviewer, other, workflowId: wf.id, baselineId, pinnedId: wf.versionId };
}

async function submitRequest(s: Scene, by = s.editor) {
  actAs(by);
  return reviewsApi.create({
    workflowId: s.workflowId,
    versionName: 'Version two',
    title: 'Ship version two',
    reviewerUserIds: [s.reviewer],
  });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the request to fail');
}

function renderHost() {
  const router = createMemoryRouter([{ path: '*', element: <ReviewStatusBanner /> }]);
  return render(
    <AppProviders queryClient={testQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

function openWorkflow(workflowId: string, name = 'Lead flow'): void {
  useWorkflowStore.setState((s) => ({ meta: { ...s.meta, id: workflowId, name }, dirty: false }));
}

beforeEach(() => {
  useReviewUi.setState({ choice: null, submitOpen: false, updateFor: null });
  useWorkflowStore.getState().reset();
  window.localStorage.clear();
  useToastStore.setState({ toasts: [] });
});

describe('review gate', () => {
  it('lets Publish go on while reviews are off', async () => {
    signedIn();
    const dto = backend().seedWorkflow({ name: 'Plain' });
    openWorkflow(dto.id);
    expect(await reviewGate()).toBe('publish');
  });

  it('asks Publish or Submit for review, and Cancel stops', async () => {
    const user = userEvent.setup();
    const s = await scene();
    actAs(s.editor);
    openWorkflow(s.workflowId);
    renderHost();
    let result = reviewGate();
    const dialog = await screen.findByRole('dialog', { name: 'Publish or ask for a review?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await result).toBe('blocked');

    result = reviewGate();
    await user.click(
      await within(await screen.findByRole('dialog', { name: 'Publish or ask for a review?' })).findByRole(
        'button',
        { name: 'Submit for review' },
      ),
    );
    expect(await result).toBe('review');
    expect(useReviewUi.getState().submitOpen).toBe(true);
  });

  it('remembers "Don\'t ask again" for Publish', async () => {
    const user = userEvent.setup();
    const s = await scene();
    actAs(s.editor);
    openWorkflow(s.workflowId);
    renderHost();
    const result = reviewGate();
    const dialog = await screen.findByRole('dialog', { name: 'Publish or ask for a review?' });
    await user.click(within(dialog).getByLabelText("Don't ask again"));
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await result).toBe('publish');
    // the next Publish goes straight on, without a question
    expect(await reviewGate()).toBe('publish');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('blocks Publish while a request is open and explains why', async () => {
    const s = await scene();
    await submitRequest(s);
    openWorkflow(s.workflowId);
    expect(await reviewGate()).toBe('blocked');
    expect(
      useToastStore.getState().toasts.some((t) => t.title === 'This workflow is waiting for a review'),
    ).toBe(true);
  });
});

describe('submit for review', () => {
  it('needs a reviewer, then creates the request for the saved version', async () => {
    const user = userEvent.setup();
    const s = await scene();
    actAs(s.editor);
    openWorkflow(s.workflowId);
    renderHost();
    act(() => useReviewUi.getState().setSubmitOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'Submit for review' });
    const submit = within(dialog).getByRole('button', { name: 'Submit for review' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // the requester is not offered as a reviewer
    expect(await within(dialog).findByLabelText(/Rae/)).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Ed \(/)).toBeNull();
    await user.click(within(dialog).getByLabelText(/Rae/));
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const created = backend().requests.find((r) => r.method === 'POST' && r.path === '/workflow-reviews');
    expect(created?.body).toMatchObject({
      workflowId: s.workflowId,
      title: 'Review Lead flow',
      versionName: 'Lead flow',
      reviewerUserIds: [s.reviewer],
    });
    expect(created?.body).not.toHaveProperty('versionId');
    expect((await reviewsApi.list({ state: 'open' })).data).toHaveLength(1);
  });

  it('asks to save first when the canvas has unsaved changes', async () => {
    const s = await scene();
    actAs(s.editor);
    openWorkflow(s.workflowId);
    useWorkflowStore.setState({ dirty: true });
    renderHost();
    act(() => useReviewUi.getState().setSubmitOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'Submit for review' });
    expect(within(dialog).getByText('Save your changes first')).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('status banner and update', () => {
  it('shows the open request and lets the author update it after changes were requested', async () => {
    const user = userEvent.setup();
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    await reviewsApi.decide(review.id, { decision: 'changes_requested', note: 'Rename Extra' });
    actAs(s.editor);
    openWorkflow(s.workflowId);
    renderHost();
    expect(await screen.findByText('Changes requested')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open request' }).getAttribute('href')).toBe(
      `/inbox/${review.id}`,
    );
    await user.click(screen.getByRole('button', { name: 'Update review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the review' });
    await user.clear(within(dialog).getByLabelText(/Version name/));
    await user.type(within(dialog).getByLabelText(/Version name/), 'Version three');
    await user.click(within(dialog).getByRole('button', { name: 'Update review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const updated = await reviewsApi.get(review.id);
    expect(updated).toMatchObject({ versionName: 'Version three', decision: 'pending', state: 'open' });
  });

  it('shows nothing when no request is open', async () => {
    const s = await scene();
    actAs(s.editor);
    openWorkflow(s.workflowId);
    renderHost();
    await waitFor(() => expect(backend().requests.some((r) => r.path === '/workflow-reviews')).toBe(true));
    expect(screen.queryByRole('link', { name: 'Open request' })).toBeNull();
  });
});

describe('inbox', () => {
  it('lists the request for the reviewer with a nav count, and for the author under My requests', async () => {
    const user = userEvent.setup();
    const s = await scene();
    await submitRequest(s);
    actAs(s.reviewer);
    renderApp('/inbox');
    expect(await screen.findByText('Ship version two')).toBeTruthy();
    expect(await screen.findByRole('status', { name: '1 to review' })).toBeTruthy();
    expect(screen.getByText('Pending review')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /My requests/ }));
    expect(await screen.findByText('No requests yet')).toBeTruthy();
  });

  it('keeps an unrelated editor out of the request and the inbox', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.other);
    expect((await failure(reviewsApi.get(review.id))).status).toBe(404);
    expect((await failure(reviewsApi.activity(review.id))).status).toBe(404);
    expect((await failure(reviewsApi.comment(review.id, 'hi'))).status).toBe(404);
    expect((await failure(reviewsApi.decide(review.id, { decision: 'approved' }))).status).toBe(404);
    expect(await inboxApi.summary()).toEqual({ toReview: 0, mine: 0 });
  });
});

describe('review detail', () => {
  it('diffs the published version against the pinned one while open', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByRole('heading', { name: /Ship version two/ })).toBeTruthy();
    expect(await screen.findByText('Extra')).toBeTruthy();
    expect(screen.getByText(/Adds/)).toBeTruthy();
    const diff = backend().requests.find(
      (r) => r.path === `/workflows/${s.workflowId}/versions/${s.pinnedId}/diff`,
    );
    expect(diff?.query).toMatchObject({ against: 'published' });
  });

  it('diffs the approved baseline against the pinned version once closed', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    const result = await reviewsApi.decide(review.id, { decision: 'approved' });
    expect(result.autoPublish?.status).toBe('published');
    expect(result.review.approvedBaselineVersionId).toBe(s.baselineId);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByText('Approved', { selector: 'span' })).toBeTruthy();
    expect(await screen.findByText('Extra')).toBeTruthy();
    const diff = backend().requests.filter(
      (r) => r.path === `/workflows/${s.workflowId}/versions/${s.pinnedId}/diff`,
    );
    expect(diff.at(-1)?.query).toMatchObject({ against: s.baselineId });
  });

  it('shows no diff for a null baseline and never asks for the live version', async () => {
    const s = await scene(false);
    const review = await submitRequest(s);
    actAs(s.reviewer);
    const result = await reviewsApi.decide(review.id, { decision: 'approved' });
    expect(result.review.approvedBaselineVersionId).toBeNull();
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByText(/there is no comparison/)).toBeTruthy();
    expect(backend().requests.some((r) => r.path.endsWith('/diff'))).toBe(false);
  });

  it('shows the short id of a pruned baseline, never "nothing was published before"', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    await reviewsApi.decide(review.id, { decision: 'approved' });
    // compaction pruned the baseline: the request keeps its id (no FK)
    const versions = backend().versions;
    versions.splice(
      versions.findIndex((v) => v.versionId === s.baselineId),
      1,
    );
    renderApp(`/inbox/${review.id}`);
    const short = (s.baselineId as string).slice(0, 8);
    expect(await screen.findByText(`Version ${short} was pruned, so there is no comparison.`)).toBeTruthy();
    expect(screen.queryByText(/Nothing was published before/)).toBeNull();
    expect(screen.queryByText(/Nothing is published yet/)).toBeNull();
  });

  it('shows the short id of a pruned pinned version', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    const versions = backend().versions;
    versions.splice(
      versions.findIndex((v) => v.versionId === s.pinnedId),
      1,
    );
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    const short = s.pinnedId.slice(0, 8);
    expect(await screen.findByText(`Version ${short} was pruned`)).toBeTruthy();
    expect(await screen.findByText(`Version ${short} was pruned, so there is no comparison.`)).toBeTruthy();
  });

  it('offers Review and Update version to an assigned reviewer who can publish', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByRole('button', { name: 'Review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update version' })).toBeTruthy();
    // updating makes them an author (n8n), so they can no longer decide
    const moved = await reviewsApi.updateVersion(review.id, { versionName: 'By the reviewer' });
    expect(moved.authors.map((a) => a.id).sort()).toEqual([s.editor, s.reviewer].sort());
    expect((await failure(reviewsApi.decide(review.id, { decision: 'approved' }))).status).toBe(403);
  });

  it('offers neither button to a reviewer who can no longer publish', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    const membership = backend().memberships.find((m) => m.userId === s.reviewer);
    if (membership) membership.role = 'viewer';
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByRole('heading', { name: /Ship version two/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update version' })).toBeNull();
    const refused = await failure(reviewsApi.updateVersion(review.id, { versionName: 'x' }));
    expect(refused.status).toBe(403);
    expect(refused.message).toBe('Only members who can publish this workflow can update the request');
  });

  it('offers Update version to an admin who is not an author', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.owner);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByRole('button', { name: 'Update version' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('requires a note for changes, then approves and publishes the pinned version', async () => {
    const user = userEvent.setup();
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const form = await screen.findByRole('form', { name: 'Your decision' });
    await user.click(within(form).getByLabelText('Request changes'));
    expect((within(form).getByRole('button', { name: 'Send decision' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(within(form).getByLabelText(/Note/), 'Please rename Extra');
    await user.click(within(form).getByRole('button', { name: 'Send decision' }));
    await waitFor(async () => expect((await reviewsApi.get(review.id)).decision).toBe('changes_requested'));
    expect((await reviewsApi.get(review.id)).state).toBe('open');

    // the author moves it to a new version, then the reviewer approves
    actAs(s.editor);
    await reviewsApi.updateVersion(review.id, { versionName: 'Version three' });
    actAs(s.reviewer);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Send decision' }));
    await waitFor(async () => expect((await reviewsApi.get(review.id)).state).toBe('closed'));
    const wf = backend().workflows.find((w) => w.id === s.workflowId)!;
    expect(wf.publishedVersionId).toBe(s.pinnedId);
    expect(wf.active).toBe(true);
  });

  it('does not offer the decision to an author who is not a reviewer, and refuses it', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    renderApp(`/inbox/${review.id}`);
    expect(await screen.findByRole('button', { name: 'Update version' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    const error = await failure(reviewsApi.decide(review.id, { decision: 'approved' }));
    expect(error.status).toBe(403);
    expect(error.message).toBe('Authors cannot decide on their own review request');
  });

  it('lets an admin decide a review they authored', async () => {
    const s = await scene();
    const review = await submitRequest(s, s.owner);
    const result = await reviewsApi.decide(review.id, { decision: 'approved' });
    expect(result.review.state).toBe('closed');
  });

  it('refuses yourself as a reviewer and a second open request', async () => {
    const s = await scene();
    actAs(s.editor);
    const self = await failure(
      reviewsApi.create({
        workflowId: s.workflowId,
        versionName: 'V',
        title: 'T',
        reviewerUserIds: [s.editor],
      }),
    );
    expect(self.status).toBe(400);
    expect(self.message).toBe('You cannot assign yourself as a reviewer');
    await submitRequest(s);
    const again = await failure(
      reviewsApi.create({
        workflowId: s.workflowId,
        versionName: 'V',
        title: 'T',
        reviewerUserIds: [s.reviewer],
      }),
    );
    expect(again.status).toBe(409);
  });

  it('posts a comment from a participant', async () => {
    const user = userEvent.setup();
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    await user.type(await screen.findByLabelText('Comment'), 'Looks fine to me');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Looks fine to me')).toBeTruthy();
    expect(screen.getByText('Rae commented')).toBeTruthy();
  });

  it('refuses a comment with control characters before it is sent', async () => {
    const s = await scene();
    const review = await submitRequest(s);
    actAs(s.reviewer);
    renderApp(`/inbox/${review.id}`);
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'Ring \u0007 bell' } });
    expect(screen.getByRole('alert').textContent).toBe('The comment has characters that are not allowed.');
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Ring the bell' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Security settings', () => {
  it('lets an admin turn workflow reviews on and off', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/security');
    const toggle = await screen.findByRole('switch', { name: 'Workflow reviews' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Workflow reviews' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    expect((await settingsApi.get()).workflowReviews.enabled).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Workflow reviews' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Workflow reviews' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
  });

  it('is read-only for an editor', async () => {
    signedIn();
    const editor = addMember('Ed', 'editor');
    actAs(editor);
    renderApp('/settings/security');
    const toggle = await screen.findByRole('switch', { name: 'Workflow reviews' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only admins can change this setting.')).toBeTruthy();
  });
});
