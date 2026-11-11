/**
 * P6-79 (L8): on a protected workspace (`setDemoProtected(true)`) the builder panel and the Assistant page show
 * why their writes are off, and the draft review's Accept is disabled and sends no save; Run draft and Discard
 * still work. With the switch off there is no notice and Accept works.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuilderChunk, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiRequest } from '../src/api/client';
import { queryKeys } from '../src/api/queries';
import { PROTECTED_NOTICE_TEXTS } from '../src/components/protected/ProtectedNotice';
import { useBuilderStore } from '../src/stores/builder-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

const node = (id: string, name: string, type: string, x: number, extra: Partial<WorkflowNode> = {}) =>
  ({ id, name, type, typeVersion: 1, position: [x, 0], parameters: {}, ...extra }) as WorkflowNode;

const NODES = [node('t', 'Start', 'core.manualTrigger', 0), node('h', 'Call API', 'core.httpRequest', 300)];
const CONNECTIONS = { Start: { main: [[{ node: 'Call API', type: 'main' as const, index: 0 }]] } };

const DRAFT: BuilderChunk = {
  type: 'workflow-updated',
  workflow: {
    name: 'Draft',
    nodes: [
      NODES[0],
      { ...NODES[1], parameters: { method: 'POST', url: 'https://api.example.com/new' } },
      node('s', 'Shape', 'core.set', 600, { parameters: { mode: 'raw' } }),
    ],
    connections: {
      ...CONNECTIONS,
      'Call API': { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
    },
  },
};

const patches = () =>
  backend().requests.filter((r: ApiRequest) => r.method === 'PATCH' && /^\/workflows\/[^/]+$/.test(r.path));

/**
 * opens the editor and the builder panel (through the store) and puts DRAFT under review. A protected canvas
 * is read only and starts no draft, so the switch goes on afterwards (`protect`), as when an admin turns it on
 * while a draft is open; the panel then reads the settings again.
 */
async function openDraft() {
  const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
  const { queryClient } = renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, T);
  await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(wf.id));
  const user = userEvent.setup();
  act(() => useBuilderStore.getState().setOpen(true));
  const panel = await screen.findByRole('complementary', { name: 'AI builder' }, T);
  act(() => useBuilderStore.getState().applyChunk(DRAFT));
  await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(true));
  const bar = await within(panel).findByRole('region', { name: 'Draft review' }, T);
  backend().requests.length = 0;
  const protect = async () => {
    backend().setDemoProtected(true);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.settings }));
  };
  return { user, panel, bar, protect };
}

describe('ProtectedNotice (P6-79)', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useWorkflowStore.getState().reset();
  });
  afterEach(() => {
    useBuilderStore.getState().reset();
  });

  it('shows on the builder panel, and Accept is disabled and sends no save', async () => {
    signedIn();
    const { user, panel, bar, protect } = await openDraft();
    expect(within(panel).queryByTestId('protected-notice-builder')).toBeNull();
    await protect();
    const notice = await within(panel).findByTestId('protected-notice-builder');
    expect(notice.textContent).toContain(PROTECTED_NOTICE_TEXTS.title);
    expect(notice.textContent).toContain(PROTECTED_NOTICE_TEXTS.builder);
    const accept = within(bar).getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    await waitFor(() => expect(accept.disabled).toBe(true));
    await user.click(accept);
    expect(patches()).toHaveLength(0);
    expect(useBuilderStore.getState().reviewing).toBe(true);
    // Run draft and Discard are not locked
    expect((within(bar).getByRole('button', { name: 'Run draft' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    const discard = within(bar).getByRole('button', { name: 'Discard' }) as HTMLButtonElement;
    expect(discard.disabled).toBe(false);
    await user.click(discard);
    await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(false));
    expect(patches()).toHaveLength(0);
  }, 60_000);

  it('shows on the Assistant page', async () => {
    signedIn().setDemoProtected(true);
    renderApp('/assistant');
    const notice = await screen.findByTestId('protected-notice-assistant', {}, T);
    expect(notice.textContent).toContain(PROTECTED_NOTICE_TEXTS.title);
    expect(notice.textContent).toContain(PROTECTED_NOTICE_TEXTS.assistant);
    expect(screen.queryByTestId('protected-notice-builder')).toBeNull();
  });

  it('shows nothing on an unprotected workspace, and Accept works', async () => {
    signedIn();
    const { user, panel, bar } = await openDraft();
    expect(within(panel).queryByTestId('protected-notice-builder')).toBeNull();
    const accept = within(bar).getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    await user.click(accept);
    await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(false));
    expect(patches()).toHaveLength(1);
  }, 60_000);
});
