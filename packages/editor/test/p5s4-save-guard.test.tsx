/**
 * P5-62 (S4 C0e, finding 2): while an AI draft is under review, no save path writes it. Only Accept
 * (`builderAccept`) saves; the conflict dialog stays usable; Run draft sends the draft without saving;
 * a version restore, another workflow and leaving the editor end the review.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHAT_TRIGGER_TYPE, type WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../src/api/client';
import { createChatSender } from '../src/features/editor/chat-actions';
import { convertToSubWorkflow } from '../src/features/editor/convert-to-subworkflow';
import {
  type EditorDeps,
  listenForTestEvent,
  overwriteLatest,
  reloadLatest,
  runWorkflow,
  saveWorkflow,
} from '../src/features/editor/editor-actions';
import { duplicateWorkflow } from '../src/features/editor/workflow-commands';
import { BUILDER_REVIEW_BLOCKED, builderInitialState, useBuilderStore } from '../src/stores/builder-store';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const node = (id: string, name: string, type: string, x: number, extra: Partial<WorkflowNode> = {}) =>
  ({ id, name, type, typeVersion: 1, position: [x, 0], parameters: {}, ...extra }) as WorkflowNode;

const NODES: WorkflowNode[] = [
  node('t', 'Start', 'core.manualTrigger', 0),
  node('s', 'Shape', 'core.set', 300),
  node('w', 'Webhook', 'core.webhook', 0, {
    position: [0, 300],
    parameters: { path: 'guard' },
    webhookId: '0d3b5c1e-2a4f-4b6c-8d7e-9f0a1b2c3d4e',
  }),
];
const CONNECTIONS = { Start: { main: [[{ node: 'Shape', type: 'main' as const, index: 0 }]] } };

const deps = (navigate: EditorDeps['navigate'] = vi.fn()): EditorDeps => ({
  navigate,
  descriptions: { get: () => undefined },
});

/** requests that write a workflow row or start a run or a listener */
const writes = () =>
  backend().requests.filter(
    (r: ApiRequest) =>
      (r.method === 'PATCH' && /^\/workflows\/[^/]+$/.test(r.path)) ||
      (r.method === 'POST' &&
        (r.path === '/workflows' || /\/(run|listen-test-webhook|publish)$/.test(r.path))),
  );
const blockedToasts = () => useToastStore.getState().toasts.filter((t) => t.title === BUILDER_REVIEW_BLOCKED);

function seed(name = 'Guarded', nodes = NODES) {
  return backend().seedWorkflow({ name, nodes, connections: nodes === NODES ? CONNECTIONS : {} });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(id));
  return utils;
}

/** the builder changed the canvas and the draft is under review */
function startReview() {
  const s = useWorkflowStore.getState();
  useBuilderStore.getState().setSnapshot({
    graph: {
      nodes: s.nodes,
      connections: s.connections,
      pinData: s.pinData,
      stickyNotes: s.stickyNotes,
      nodeGroups: s.nodeGroups,
    },
    versionId: s.meta.versionId,
    dirty: s.dirty,
  });
  act(() => {
    useWorkflowStore.getState().moveNodes({ Shape: [420, 40] });
    useBuilderStore.getState().setReviewing(true);
  });
  backend().requests.length = 0;
}

describe('builder store (P5-62, C0 full parts)', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
  });

  it('clearReview aborts the running stream and ends the review; the chat stays', () => {
    const controller = new AbortController();
    const store = useBuilderStore.getState();
    store.setAbortController(controller);
    store.setStreaming(true);
    store.setReviewing(true);
    store.addMessage({ id: 'm1', role: 'user', text: 'Build me a flow', createdAt: '2026-11-08T00:00:00Z' });
    store.clearReview();
    const after = useBuilderStore.getState();
    expect(controller.signal.aborted).toBe(true);
    expect(after).toMatchObject({
      reviewing: false,
      snapshot: null,
      streaming: false,
      abortController: null,
    });
    expect(after.messages).toHaveLength(1);
  });

  it('reset aborts the stream and returns to the initial state, keeping the page deps', () => {
    const controller = new AbortController();
    const store = useBuilderStore.getState();
    const pageDeps = deps();
    store.setDeps(pageDeps);
    store.setAbortController(controller);
    store.setMode('plan');
    store.setPlan({ summary: 'A plan', steps: [] });
    store.setError({ title: 'Oops', message: 'Something failed' });
    store.addMessage({ id: 'm1', role: 'assistant', text: 'Hi', createdAt: '2026-11-08T00:00:00Z' });
    store.reset();
    const after = useBuilderStore.getState();
    expect(controller.signal.aborted).toBe(true);
    expect(after).toMatchObject(builderInitialState());
    expect(after.deps).toBe(pageDeps);
  });

  it('setOpen follows the side panel', () => {
    useBuilderStore.getState().setOpen(true);
    expect(useUiStore.getState().sidePanel).toBe('builder');
    useBuilderStore.getState().setOpen(false);
    expect(useUiStore.getState().sidePanel).toBeNull();
    expect(useBuilderStore.getState().open).toBe(false);
  });
});

describe('save guard while a draft is under review (P5-62)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
    useToastStore.setState({ toasts: [] });
    useUiStore.setState({ sidePanel: null, saveConflict: false });
  });

  it('Save and listen save nothing while reviewing', async () => {
    const wf = seed();
    await openEditor(wf.id);
    startReview();
    expect(await saveWorkflow(deps())).toBeNull();
    await listenForTestEvent(deps(), 'Webhook');
    expect(writes()).toHaveLength(0);
    expect(blockedToasts().length).toBeGreaterThanOrEqual(2);
    expect(useWorkflowStore.getState().dirty).toBe(true);
    expect(useRunStore.getState().status).not.toBe('listening');
  }, 60_000);

  it('autosave stays idle while reviewing', async () => {
    const wf = seed();
    await openEditor(wf.id);
    // the settings (autosaveEnabled) load after the page
    await new Promise((r) => setTimeout(r, 300));
    startReview();
    await new Promise((r) => setTimeout(r, 2500));
    expect(writes()).toHaveLength(0);
    // autosave shows no toast: it never reaches the guard
    expect(blockedToasts()).toHaveLength(0);
  }, 60_000);

  it('a canvas chat message saves nothing and starts no listen', async () => {
    const wf = seed('Chatty', [node('c', 'When chat message received', CHAT_TRIGGER_TYPE, 0)]);
    await openEditor(wf.id);
    startReviewOnChat();
    const sender = createChatSender(() => deps());
    expect(await sender.beforeMessageSent('hello')).toBeUndefined();
    expect(writes()).toHaveLength(0);
    expect(blockedToasts()).toHaveLength(1);
    expect(useToastStore.getState().toasts.some((t) => t.description === 'Save the workflow first.')).toBe(
      true,
    );
  }, 60_000);

  it('Run draft sends workflowData and saves nothing', async () => {
    const wf = seed();
    await openEditor(wf.id);
    startReview();
    await runWorkflow(deps());
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    const [run, ...others] = writes();
    expect(run.path).toBe(`/workflows/${wf.id}/run`);
    const sent = (run.body as { workflowData?: { nodes: WorkflowNode[] } }).workflowData;
    expect(sent?.nodes.find((n) => n.name === 'Shape')?.position).toEqual([420, 40]);
    expect(others.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(blockedToasts()).toHaveLength(0);
  }, 60_000);

  it('Keep my version saves the draft and ends the review', async () => {
    const wf = seed();
    await openEditor(wf.id);
    startReview();
    act(() => useUiStore.getState().setSaveConflict(true));
    const saved = await overwriteLatest(deps());
    expect(saved).not.toBeNull();
    const patches = writes().filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(
      (patches[0].body as { nodes: WorkflowNode[] }).nodes.find((n) => n.name === 'Shape')?.position,
    ).toEqual([420, 40]);
    expect(useBuilderStore.getState()).toMatchObject({ reviewing: false, snapshot: null });
    expect(blockedToasts()).toHaveLength(0);
  }, 60_000);

  it('Load their version ends the review', async () => {
    const wf = seed();
    await openEditor(wf.id);
    startReview();
    act(() => useUiStore.getState().setSaveConflict(true));
    await act(() => reloadLatest());
    expect(useBuilderStore.getState()).toMatchObject({ reviewing: false, snapshot: null });
    expect(useWorkflowStore.getState().dirty).toBe(false);
    expect(writes()).toHaveLength(0);
  }, 60_000);

  it('Duplicate and Convert send nothing while reviewing', async () => {
    const wf = seed();
    await openEditor(wf.id);
    startReview();
    expect(await duplicateWorkflow(deps())).toBeNull();
    expect(await convertToSubWorkflow(deps(), { nodeNames: ['Shape'], name: 'Extracted' })).toBeNull();
    expect(writes()).toHaveLength(0);
    expect(blockedToasts()).toHaveLength(2);
  }, 60_000);

  it('a version restore ends the review', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, nodes: NODES, name: 'Guarded later' },
    });
    await openEditor(wf.id);
    startReview();
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    const items = await within(panel).findAllByRole('button', { name: /Demo user|Olive Owner/ });
    await user.click(items[items.length - 1]);
    const dialog = await screen.findByRole('dialog', { name: 'Version preview' });
    await user.click(await within(dialog).findByRole('button', { name: 'Restore this version' }));
    // the canvas is dirty, so the restore asks first
    const confirm = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(false));
    expect(useBuilderStore.getState().snapshot).toBeNull();
  }, 60_000);

  it('opening another workflow and leaving the editor reset the store', async () => {
    const first = seed('First');
    const second = seed('Second');
    const { router, unmount } = await openEditor(first.id);
    const controller = new AbortController();
    act(() => {
      useBuilderStore
        .getState()
        .addMessage({ id: 'm1', role: 'user', text: 'Hi', createdAt: '2026-11-08T00:00:00Z' });
      useBuilderStore.getState().setAbortController(controller);
      useBuilderStore.getState().setReviewing(true);
    });
    await act(() => router.navigate(`/workflow/${second.id}`));
    await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(second.id));
    expect(controller.signal.aborted).toBe(true);
    expect(useBuilderStore.getState()).toMatchObject({
      reviewing: false,
      messages: [],
      abortController: null,
    });

    act(() => {
      useBuilderStore
        .getState()
        .addMessage({ id: 'm2', role: 'user', text: 'Again', createdAt: '2026-11-08T00:00:00Z' });
      useBuilderStore.getState().setReviewing(true);
    });
    unmount();
    expect(useBuilderStore.getState()).toMatchObject({ reviewing: false, messages: [] });
  }, 60_000);

  it('the redirect from new to the row it just created keeps the chat', async () => {
    const { router } = renderApp('/workflow/new');
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    act(() => {
      useWorkflowStore.getState().addNode(node('t', 'Start', 'core.manualTrigger', 0));
      useBuilderStore
        .getState()
        .addMessage({ id: 'm1', role: 'user', text: 'Build it', createdAt: '2026-11-08T00:00:00Z' });
    });
    const dto = await act(() => saveWorkflow(deps((to, options) => void router.navigate(to, options))));
    expect(dto).not.toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflow/${dto!.id}`));
    await new Promise((r) => setTimeout(r, 100));
    expect(useBuilderStore.getState().messages).toHaveLength(1);
    expect(useWorkflowStore.getState().meta.id).toBe(dto!.id);
  }, 60_000);
});

/** the review on the chat-trigger workflow: the builder moved its only node */
function startReviewOnChat() {
  act(() => {
    useWorkflowStore.getState().moveNodes({ 'When chat message received': [60, 60] });
    useBuilderStore.getState().setReviewing(true);
  });
  backend().requests.length = 0;
}
