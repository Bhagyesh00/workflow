/**
 * P3-16 "Publish timeline" tab: one row per publish / unpublish, newest first, with the event,
 * the version name or short id, the user and the date; a pruned version shows "Published a
 * version" with a tooltip; more rows load on demand.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowsApi } from '../src/api/endpoints';
import { PublishTimeline } from '../src/components/workflow/PublishTimeline';
import { publishEvents } from '../src/demo/mock-publish';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const hook: WorkflowNode = {
  id: 'h',
  name: 'Webhook',
  type: 'core.webhook',
  typeVersion: 1,
  position: [0, 0],
  parameters: { path: 'orders', httpMethod: 'POST' },
  webhookId: '5d2b1c4e-1111-4222-8333-944455556666',
};

function seed() {
  signedIn();
  return backend().seedWorkflow({ name: 'Orders', nodes: [hook], connections: {} });
}

const rows = () => within(screen.getByRole('list', { name: 'Publish timeline' })).getAllByRole('listitem');

describe('P3-16 publish timeline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publish then unpublish shows two entries, newest first, with version, user and date', async () => {
    const wf = seed();
    await workflowsApi.activate(wf.id, { versionName: 'Launch' });
    await workflowsApi.deactivate(wf.id);
    withProviders(<PublishTimeline workflowId={wf.id} />);

    await screen.findByRole('list', { name: 'Publish timeline' });
    const [first, second] = rows();
    expect(rows()).toHaveLength(2);
    expect(first.textContent).toContain('Unpublished');
    expect(second.textContent).toContain('Published');
    expect(second.textContent).not.toContain('Unpublished');
    for (const row of [first, second]) {
      expect(row.textContent).toContain('Launch');
      expect(row.textContent).toContain('Olive Owner');
      expect(within(row).getByText((_, el) => el?.tagName === 'TIME')).toBeTruthy();
    }
  });

  it('shows the short version id when the version has no name', async () => {
    const wf = seed();
    await workflowsApi.activate(wf.id);
    withProviders(<PublishTimeline workflowId={wf.id} />);
    await screen.findByRole('list', { name: 'Publish timeline' });
    expect(rows()[0].textContent).toContain(wf.versionId.slice(0, 8));
  });

  it('a row whose version was pruned reads "Published a version" with the tooltip', async () => {
    const wf = seed();
    await workflowsApi.activate(wf.id);
    // the version is gone: the server answers versionId null
    backend().versions = backend().versions.filter((v) => v.versionId !== wf.versionId);
    withProviders(<PublishTimeline workflowId={wf.id} />);

    const label = await screen.findByText('Published a version');
    expect(label.getAttribute('title')).toBe('The published version has since been pruned.');
    expect(rows()[0].textContent).not.toContain(wf.versionId.slice(0, 8));
  });

  it('an empty timeline says so; an unsaved workflow too', async () => {
    const wf = seed();
    const { unmount } = withProviders(<PublishTimeline workflowId={wf.id} />);
    expect(await screen.findByText('Not published yet')).toBeTruthy();
    unmount();
    withProviders(<PublishTimeline />);
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('loads 20 rows, then more on "Load more"', async () => {
    const user = userEvent.setup();
    const wf = seed();
    for (let i = 0; i < 12; i++) {
      await workflowsApi.activate(wf.id);
      await workflowsApi.deactivate(wf.id);
    }
    expect(publishEvents(backend())).toHaveLength(24);
    withProviders(<PublishTimeline workflowId={wf.id} />);
    await screen.findByRole('list', { name: 'Publish timeline' });
    expect(rows()).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(24));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed load shows the error', async () => {
    const wf = seed();
    vi.spyOn(workflowsApi, 'publishTimeline').mockRejectedValue(new Error('boom'));
    withProviders(<PublishTimeline workflowId={wf.id} />);
    expect(await screen.findByText(/Couldn't load the publish timeline/)).toBeTruthy();
  });
});
