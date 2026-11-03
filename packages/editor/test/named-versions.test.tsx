/**
 * P3-10 named versions in the editor: Publish button and dialog, status chip, save makes no
 * activate call, versions panel (name, description, Published badge, rename, publish a version),
 * executions show the version they ran.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiRequest } from '../src/api/client';
import { usePublishTarget } from '../src/features/editor/publish-actions';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const hook: WorkflowNode = {
  id: 'h',
  name: 'Webhook',
  type: 'core.webhook',
  typeVersion: 1,
  position: [0, 0],
  parameters: { path: 'orders', httpMethod: 'POST' },
  webhookId: '5d2b1c4e-1111-4222-8333-944455556666',
};
const plain: WorkflowNode = {
  id: 'p',
  name: 'Plain',
  type: 'core.noOp',
  typeVersion: 1,
  position: [300, 0],
  parameters: {},
};
const wiring = { Webhook: { main: [[{ node: 'Plain', type: 'main' as const, index: 0 }]] } };

function seed(active = false) {
  signedIn();
  return backend().seedWorkflow({ name: 'Orders', nodes: [hook, plain], connections: wiring, active });
}

/** the requests the editor sent since the call (the mock server logs every request) */
function recordRequests(): () => ApiRequest[] {
  const from = backend().requests.length;
  return () => backend().requests.slice(from);
}

async function openEditor(id: string) {
  renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="p"]')).toBeTruthy());
}

const chip = () => screen.getByRole('status', { name: /^Publish status/ });

describe('P3-10 publish vs save', () => {
  beforeEach(() => {
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false, activationErrors: null });
    useToastStore.setState({ toasts: [] });
    usePublishTarget.setState({ versionId: null, revision: 0 });
  });

  it('Publish opens the dialog and sends the version name and description', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    const requests = recordRequests();
    expect(chip().textContent).toBe('Not published');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish workflow' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Version name' }), 'Launch');
    await user.type(within(dialog).getByRole('textbox', { name: 'Description' }), 'First live version');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(useWorkflowStore.getState().meta.publishedVersionId).toBe(wf.versionId));
    const activate = requests().find((r) => r.method === 'POST' && r.path.endsWith('/activate'));
    expect(activate?.body).toEqual({ versionName: 'Launch', description: 'First live version' });
    const stored = backend().versions.find((v) => v.versionId === wf.versionId);
    expect(stored).toMatchObject({ versionName: 'Launch', description: 'First live version' });
    expect(chip().textContent).toBe('Published');
    expect(screen.queryByRole('dialog', { name: 'Publish workflow' })).toBeNull();
  });

  it('a save of a published workflow makes no activate call and shows that the draft has changes', async () => {
    const user = userEvent.setup();
    const wf = seed(true);
    await openEditor(wf.id);
    expect(chip().textContent).toBe('Published');
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
    const requests = recordRequests();
    const name = screen.getByRole('textbox', { name: 'Workflow name' });
    await user.clear(name);
    await user.type(name, 'Orders v2{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useWorkflowStore.getState().dirty).toBe(false));

    expect(requests().some((r) => r.path.endsWith('/activate'))).toBe(false);
    expect(useWorkflowStore.getState().meta.publishedVersionId).toBe(wf.versionId);
    expect(useWorkflowStore.getState().meta.versionId).not.toBe(wf.versionId);
    expect(backend().workflows[0].publishedVersionId).toBe(wf.versionId);
    expect(chip().textContent).toBe('Published, draft has changes');
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Unpublish in the More menu clears the published version', async () => {
    const user = userEvent.setup();
    const wf = seed(true);
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unpublish' }));
    await waitFor(() => expect(useWorkflowStore.getState().meta.publishedVersionId).toBeNull());
    expect(backend().workflows[0]).toMatchObject({ active: false, publishedVersionId: null });
    expect(chip().textContent).toBe('Not published');
  });
});

describe('P3-10 versions panel', () => {
  beforeEach(() => {
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false, activationErrors: null });
    usePublishTarget.setState({ versionId: null, revision: 0 });
  });

  it('shows the name, description and Published badge, and renames a version', async () => {
    const user = userEvent.setup();
    const wf = seed(true);
    const version = backend().versions.find((v) => v.versionId === wf.versionId)!;
    version.versionName = 'Launch';
    version.description = 'First live version';
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    expect(await within(panel).findByText('Launch')).toBeTruthy();
    expect(within(panel).getByText('First live version')).toBeTruthy();
    expect(within(panel).getByText('Published')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Rename version Launch' }));
    const form = within(panel).getByRole('form', { name: 'Version name and description' });
    const input = within(form).getByRole('textbox', { name: 'Version name' });
    await user.clear(input);
    await user.type(input, 'Launch day');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version.versionName).toBe('Launch day'));
    expect(await within(panel).findByText('Launch day')).toBeTruthy();
    expect(version.description).toBe('First live version');
  });

  it('publishes an earlier version from its preview and leaves the draft alone', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, name: 'Orders later' },
    });
    const draft = backend().workflows[0].versionId;
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    const items = await within(panel).findAllByRole('button', { name: /Olive Owner/ });
    await user.click(items[items.length - 1]);
    const preview = await screen.findByRole('dialog', { name: 'Version preview' });
    await user.click(await within(preview).findByRole('button', { name: 'Publish this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this version' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(backend().workflows[0].publishedVersionId).toBe(wf.versionId));
    expect(backend().workflows[0].versionId).toBe(draft);
    expect(useWorkflowStore.getState().meta.publishedVersionId).toBe(wf.versionId);
  });
});

describe('P3-10 executions show their version', () => {
  it('shows "Ran on version" with the name, the row label and the version filter', async () => {
    const user = userEvent.setup();
    const wf = seed(true);
    const version = backend().versions.find((v) => v.versionId === wf.versionId)!;
    version.versionName = 'Launch';
    await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(1));
    const execution = backend().executions[0];
    expect(execution.workflowVersionId).toBe(wf.versionId);

    renderApp(`/executions/${execution.id}`);
    const ran = await screen.findByText(/Ran on version/, {}, { timeout: 10_000 });
    expect(await within(ran).findByRole('link', { name: 'Launch' })).toBeTruthy();
    await user.click(within(ran).getByRole('link', { name: 'Launch' }));
    expect(useUiStore.getState().sidePanel).toBe('versions');
  });

  it('labels rows and filters the list by version', async () => {
    const user = userEvent.setup();
    const wf = seed(true);
    const version = backend().versions.find((v) => v.versionId === wf.versionId)!;
    version.versionName = 'Launch';
    await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(1));
    const requests = recordRequests();
    renderApp(`/executions?workflowId=${wf.id}`);
    const filter = await screen.findByRole('combobox', { name: 'Filter by version' }, { timeout: 10_000 });
    await waitFor(() => expect(within(filter).getByRole('option', { name: 'Launch' })).toBeTruthy());
    expect(await screen.findByText('Launch', { selector: 'span' })).toBeTruthy();
    await user.selectOptions(filter, wf.versionId);
    await waitFor(() =>
      expect(
        requests().some(
          (r) =>
            r.method === 'GET' && r.path === '/executions' && r.query?.workflowVersionId === wf.versionId,
        ),
      ).toBe(true),
    );
  });
});
