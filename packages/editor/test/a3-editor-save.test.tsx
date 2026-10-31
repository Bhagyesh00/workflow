import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowImport } from '../src/pages/WorkflowsPage';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const WEBHOOK_ID = '7d3d3f4e-1111-4222-8333-944455556666';
const hook: WorkflowNode = {
  id: 'h',
  name: 'Webhook',
  type: 'core.webhook',
  typeVersion: 1,
  position: [0, 0],
  parameters: { path: '' },
  webhookId: WEBHOOK_ID,
};
const plain: WorkflowNode = {
  id: 'p',
  name: 'Plain',
  type: 'core.noOp',
  typeVersion: 1,
  position: [300, 0],
  parameters: {},
};
const activationError = {
  message: 'The workflow could not be activated',
  details: [
    {
      node: 'Webhook',
      message: 'The webhook path "GET shared-path" is already used by another active workflow',
    },
  ],
};

function hasDeactivationToast() {
  return useToastStore.getState().toasts.some((t) => t.title === 'Saved, but the workflow was deactivated');
}

function seed() {
  signedIn();
  return backend().seedWorkflow({ name: 'Hooked', nodes: [hook, plain], connections: {}, active: true });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="p"]')).toBeTruthy());
  return utils;
}

/** Make the mock server deactivate the workflow on save/restore, as the real one does when re-registration fails. */
function failReactivation() {
  const real = backend().handle.bind(backend());
  vi.spyOn(backend(), 'handle').mockImplementation(async (request) => {
    const response = await real(request);
    const rewrites = request.method === 'PATCH' || /\/versions\/[^/]+\/restore$/.test(request.path);
    if (rewrites && response.status === 200) {
      const data = (response.body as { data: Record<string, unknown> }).data;
      const stored = backend().workflows.find((w) => w.id === data.id);
      if (stored) stored.active = false;
      return { ...response, body: { data: { ...data, active: false, activationError } } };
    }
    return response;
  });
}

describe('R23 saving an active workflow that the server deactivated', () => {
  beforeEach(() => {
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false, activationErrors: null });
    useToastStore.setState({ toasts: [] });
  });

  it('tells the user on save and lists the failing nodes', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    failReactivation();
    const name = screen.getByRole('textbox', { name: 'Workflow name' });
    await user.clear(name);
    await user.type(name, 'Hooked v2{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useWorkflowStore.getState().dirty).toBe(false));
    expect(useWorkflowStore.getState().meta.active).toBe(false);
    expect(hasDeactivationToast()).toBe(true);
    expect(useUiStore.getState().activationErrors).toEqual(activationError.details);
  });

  it('tells the user after restoring a version', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, nodes: [hook, plain], name: 'Hooked older' },
    });
    await openEditor(wf.id);
    failReactivation();
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    const items = await within(panel).findAllByRole('button', { name: /Demo user|Olive Owner/ });
    await user.click(items[items.length - 1]);
    const dialog = await screen.findByRole('dialog', { name: 'Version preview' });
    await user.click(await within(dialog).findByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(hasDeactivationToast()).toBe(true));
    expect(useUiStore.getState().activationErrors).toEqual(activationError.details);
  });
});

describe('R25 copies of a workflow get their own webhookId', () => {
  const exported = JSON.stringify({ name: 'Hooked', nodes: [hook, plain], connections: {} });

  it('import parsing replaces the webhookId and leaves nodes without one alone', () => {
    const parsed = parseWorkflowImport(exported);
    if ('error' in parsed) throw new Error(parsed.error);
    const [h, p] = parsed.nodes;
    expect(h.webhookId).toBeTruthy();
    expect(h.webhookId).not.toBe(WEBHOOK_ID);
    expect('webhookId' in p).toBe(false);
  });

  it('Duplicate in the workflow list creates a copy with a new webhookId', async () => {
    const user = userEvent.setup();
    const wf = seed();
    renderApp('/workflows');
    await user.click(
      await screen.findByRole('button', { name: `Actions for ${wf.name}` }, { timeout: 20_000 }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(backend().workflows).toHaveLength(2));
    const copy = backend().workflows.find((w) => w.id !== wf.id)!;
    const copied = copy.nodes.find((n) => n.name === 'Webhook')!;
    expect(copied.webhookId).toBeTruthy();
    expect(copied.webhookId).not.toBe(WEBHOOK_ID);
    expect(backend().workflows.find((w) => w.id === wf.id)!.nodes[0].webhookId).toBe(WEBHOOK_ID);
  });

  it('Duplicate in the editor creates a copy with a new webhookId', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(backend().workflows).toHaveLength(2));
    const copy = backend().workflows.find((w) => w.id !== wf.id)!;
    const copied = copy.nodes.find((n) => n.name === 'Webhook')!;
    expect(copied.webhookId).toBeTruthy();
    expect(copied.webhookId).not.toBe(WEBHOOK_ID);
  });
});
