/**
 * P6-81 (L14): presence and the write lock in the editor. The store routes the four push events of the open
 * workflow (a lock held by another tab makes `lockedByOther`; other workflows' events and the user's own saves
 * are ignored); the editor opens presence, asks for the lock, shows the avatars, the read-only banner and the
 * take over confirm; autosave stops while another holds the lock and goes on when it is free; "workflow was
 * updated" reloads. The lock is part of the workflow store's read-only flag, so Save, Publish, Ctrl+S, paste
 * and every store edit refuse while another holds it. A reload or a closed tab (`pagehide`) closes presence at
 * once; a leave waits for the calls still in flight. The demo backend plays the server (one session: it gives
 * the lock to the asking tab).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTransport, getTransport, setTransport } from '../src/api/client';
import { CollaboratorsPane } from '../src/components/collaboration/CollaboratorsPane';
import { handlePushEvent } from '../src/components/shell/PushBridge';
import { clientId } from '../src/lib/client-id';
import {
  type CollaborationSession,
  receiveCollaborationEvent,
  startCollaboration,
  useCollaborationStore,
} from '../src/stores/collaboration-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const OTHER = '99999999-9999-4999-8999-999999999999';
const otherPerson = {
  userId: OTHER,
  name: 'Omar Other',
  email: 'omar@example.com',
  lastSeen: '2026-01-01T00:00:00Z',
};

const paths = (method: string, pattern: RegExp) =>
  backend().requests.filter((r) => r.method === method && pattern.test(r.path));
const patches = () => paths('PATCH', /^\/workflows\/[^/]+$/);

let started: CollaborationSession | null = null;
afterEach(() => {
  started?.stop();
  started = null;
  useCollaborationStore.getState().reset();
});

function seed() {
  signedIn();
  const wf = backend().seedWorkflow({ name: 'Shared', nodes: [trigger], connections: {}, active: false });
  return { wf, selfId: backend().auth().user.id };
}

const lockOf = (userId: string, tab: string) => ({
  userId,
  clientId: tab,
  name: userId === OTHER ? 'Omar Other' : 'Olive Owner',
  expiresAt: '2026-01-01T00:02:00Z',
});

describe('the collaboration store', () => {
  it('a lock of another tab makes the editor read-only; the own tab does not', () => {
    const store = useCollaborationStore.getState();
    store.setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    expect(useCollaborationStore.getState().lockedByOther).toBe(true);
    store.setWriteLock(lockOf(OTHER, clientId()));
    expect(useCollaborationStore.getState().lockedByOther).toBe(false);
    store.setWriteLock(null);
    expect(useCollaborationStore.getState().lockedByOther).toBe(false);
  });

  it('the lock is part of the workflow store read-only flag, over the role and the archive', () => {
    const lock = useCollaborationStore.getState();
    const flag = () => useWorkflowStore.getState().readOnly;
    const loadWith = (readOnly: boolean) =>
      useWorkflowStore.getState().load({ name: 'Flag', nodes: [trigger], connections: {} }, { readOnly });
    loadWith(false);
    expect(flag()).toBe(false);
    lock.setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    expect(flag()).toBe(true);
    // a load under the lock stays read-only; the own tab's lock does not
    loadWith(false);
    expect(flag()).toBe(true);
    lock.setWriteLock(lockOf(OTHER, clientId()));
    expect(flag()).toBe(false);
    // the role stays read-only when the lock goes
    loadWith(true);
    lock.setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    lock.setWriteLock(null);
    expect(flag()).toBe(true);
    // so does the archive; unarchive with the role's answer frees it
    loadWith(false);
    useWorkflowStore.getState().setArchived(true);
    lock.setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    lock.setWriteLock(null);
    expect(flag()).toBe(true);
    useWorkflowStore.getState().setArchived(false, false);
    expect(flag()).toBe(false);
    // a leave frees the store
    lock.setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    lock.reset();
    expect(flag()).toBe(false);
  });

  it('a store edit is refused while another holds the lock, and goes through when it is free', () => {
    useWorkflowStore
      .getState()
      .load({ name: 'Edits', nodes: [trigger], connections: {} }, { readOnly: false });
    useCollaborationStore.getState().setWriteLock(lockOf(OTHER, 'tab-of-someone-else'));
    const revision = useWorkflowStore.getState().revision;
    useWorkflowStore.getState().moveNodes({ Start: [90, 30] });
    useWorkflowStore.getState().setName('Renamed under the lock');
    expect(useWorkflowStore.getState()).toMatchObject({ revision, dirty: false });
    expect(useWorkflowStore.getState().meta.name).toBe('Edits');
    useCollaborationStore.getState().setWriteLock(null);
    useWorkflowStore.getState().setName('Renamed free');
    expect(useWorkflowStore.getState().meta.name).toBe('Renamed free');
  });

  it('opens presence and asks for the lock, and takes the answers', async () => {
    const { wf, selfId } = seed();
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: true });
    await waitFor(() => expect(useCollaborationStore.getState().writeLock?.clientId).toBe(clientId()));
    const state = useCollaborationStore.getState();
    expect(state.workflowId).toBe(wf.id);
    expect(state.collaborators.map((c) => c.userId)).toEqual([selfId]);
    expect(state.lockedByOther).toBe(false);
    expect(paths('POST', /\/presence$/)[0]?.body).toEqual({ action: 'open' });
    expect(paths('POST', /\/write-access$/)[0]?.body).toEqual({ action: 'request' });
  });

  it('a viewer opens presence but never asks for the lock', async () => {
    const { wf, selfId } = seed();
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: false });
    await waitFor(() => expect(useCollaborationStore.getState().collaborators).toHaveLength(1));
    expect(paths('POST', /\/write-access$/)).toHaveLength(0);
    // it may ask once it can edit
    started.setCanWrite(true);
    await waitFor(() => expect(paths('POST', /\/write-access$/)).toHaveLength(1));
  });

  it('routes the four push events of the open workflow and ignores the rest', async () => {
    const { wf, selfId } = seed();
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: true });
    await waitFor(() => expect(useCollaborationStore.getState().writeLock).not.toBeNull());

    handlePushEvent({
      type: 'collaboratorsChanged',
      data: { workflowId: wf.id, collaborators: [otherPerson] },
    });
    expect(useCollaborationStore.getState().collaborators).toEqual([otherPerson]);

    handlePushEvent({
      type: 'writeAccessAcquired',
      data: { workflowId: wf.id, userId: OTHER, clientId: 'their-tab' },
    });
    expect(useCollaborationStore.getState()).toMatchObject({
      lockedByOther: true,
      writeLock: { userId: OTHER, clientId: 'their-tab', name: 'Omar Other' },
    });

    // another workflow's events change nothing
    const elsewhere = '11111111-1111-4111-8111-111111111111';
    receiveCollaborationEvent({ type: 'writeAccessReleased', data: { workflowId: elsewhere } });
    receiveCollaborationEvent({ type: 'workflowUpdated', data: { workflowId: elsewhere, userId: OTHER } });
    expect(useCollaborationStore.getState().lockedByOther).toBe(true);
    expect(useCollaborationStore.getState().updatedBy).toBeNull();

    // the user's own save is no news; another user's is
    handlePushEvent({ type: 'workflowUpdated', data: { workflowId: wf.id, userId: selfId } });
    expect(useCollaborationStore.getState().updatedBy).toBeNull();
    handlePushEvent({ type: 'workflowUpdated', data: { workflowId: wf.id, userId: OTHER } });
    expect(useCollaborationStore.getState().updatedBy).toBe(OTHER);

    // a release frees the editor, and the tab asks for the lock again
    const asked = paths('POST', /\/write-access$/).length;
    handlePushEvent({ type: 'writeAccessReleased', data: { workflowId: wf.id } });
    expect(useCollaborationStore.getState().lockedByOther).toBe(false);
    await waitFor(() => expect(paths('POST', /\/write-access$/).length).toBe(asked + 1));
  });

  it('stopping closes presence and empties the store', async () => {
    const { wf, selfId } = seed();
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: true });
    await waitFor(() => expect(useCollaborationStore.getState().writeLock).not.toBeNull());
    started.stop();
    started = null;
    expect(useCollaborationStore.getState()).toMatchObject({
      workflowId: null,
      collaborators: [],
      writeLock: null,
    });
    await waitFor(() =>
      expect(paths('POST', /\/presence$/).map((r) => r.body)).toContainEqual({ action: 'close' }),
    );
    // events after the end change nothing
    receiveCollaborationEvent({ type: 'workflowUpdated', data: { workflowId: wf.id, userId: OTHER } });
    expect(useCollaborationStore.getState().updatedBy).toBeNull();
  });
});

describe('leaving', () => {
  const presenceBodies = () => paths('POST', /\/presence$/).map((r) => r.body);

  it('a leave while the lock request is in flight sends close after it, so no lock is left behind', async () => {
    const { wf, selfId } = seed();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    setTransport(async (request) => {
      if (/\/write-access$/.test(request.path)) {
        held++;
        await gate;
      }
      return fetchTransport(request);
    });
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: true });
    await waitFor(() => expect(held).toBe(1));
    started.stop();
    started = null;
    // the request has not been served: close waits
    await new Promise((r) => setTimeout(r, 200));
    expect(presenceBodies()).not.toContainEqual({ action: 'close' });
    release();
    await waitFor(() => expect(presenceBodies()).toContainEqual({ action: 'close' }));
    const order = backend().requests.map((r) => `${r.path.split('/').pop()}:${JSON.stringify(r.body)}`);
    expect(order.indexOf('write-access:{"action":"request"}')).toBeLessThan(
      order.indexOf('presence:{"action":"close"}'),
    );
    // the (demo) server ends with nothing open for the tab that left
    const open = (backend().ext.collaboration as { open: Map<string, unknown> }).open;
    expect(open.get(wf.id)).toBeUndefined();
  });

  it('a reload or a closed tab (pagehide) closes presence at once, with keepalive and the push-ref header', async () => {
    const { wf, selfId } = seed();
    started = startCollaboration({ workflowId: wf.id, selfUserId: selfId, canWrite: true });
    await waitFor(() => expect(useCollaborationStore.getState().writeLock?.clientId).toBe(clientId()));
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return realFetch(input, init);
    });
    try {
      expect(getTransport()).toBe(fetchTransport);
      window.dispatchEvent(new Event('pagehide'));
      await waitFor(() => expect(calls).toHaveLength(1));
      const [url, init] = calls[0];
      expect(String(url)).toContain(`/workflows/${wf.id}/presence`);
      expect(init).toMatchObject({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ action: 'close' }),
      });
      expect(((init?.headers ?? {}) as Record<string, string>)['push-ref']).toBe(clientId());
      await waitFor(() => expect(presenceBodies()).toContainEqual({ action: 'close' }));
      const open = (backend().ext.collaboration as { open: Map<string, unknown> }).open;
      expect(open.get(wf.id)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    // after a leave the page no longer reacts
    started.stop();
    started = null;
    await waitFor(() =>
      expect(presenceBodies().filter((b) => (b as { action: string }).action === 'close')).toHaveLength(2),
    );
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 100));
    expect(presenceBodies().filter((b) => (b as { action: string }).action === 'close')).toHaveLength(2);
  });
});

describe('the avatars', () => {
  it('show who has the workflow open, with the holder of the lock marked', () => {
    const id = 'wf-avatars';
    useCollaborationStore.setState({
      workflowId: id,
      collaborators: [
        { userId: 'u1', name: 'Olive Owner', email: 'owner@example.com', lastSeen: '' },
        otherPerson,
      ],
      writeLock: lockOf(OTHER, 'their-tab'),
    });
    withProviders(<CollaboratorsPane workflowId={id} />);
    const list = screen.getByLabelText(/People with this workflow open: Olive Owner, Omar Other/);
    expect(list.querySelectorAll('[data-testid="collaborator"]')).toHaveLength(2);
    expect(screen.getByLabelText('Omar Other, editing')).toBeTruthy();
    expect(screen.getAllByText('OO')).toHaveLength(2);
  });

  it('show nothing for another workflow or for nobody', () => {
    useCollaborationStore.setState({ workflowId: 'a', collaborators: [otherPerson] });
    const other = withProviders(<CollaboratorsPane workflowId="b" />);
    expect(other.container.querySelector('[data-testid="collaborators"]')).toBeNull();
    useCollaborationStore.setState({ workflowId: 'b', collaborators: [] });
    other.unmount();
    const nobody = withProviders(<CollaboratorsPane workflowId="b" />);
    expect(nobody.container.querySelector('[data-testid="collaborators"]')).toBeNull();
  });
});

describe('the editor', () => {
  async function openEditor() {
    const { wf, selfId } = seed();
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    // the settings (autosaveEnabled) load after the page
    await new Promise((r) => setTimeout(r, 300));
    return { wf, selfId };
  }

  it('opens presence and takes the lock, shows the avatar, and a lock of another turns it read-only with take over', async () => {
    const user = userEvent.setup();
    const { wf, selfId } = await openEditor();
    await waitFor(() => expect(useCollaborationStore.getState().writeLock?.clientId).toBe(clientId()));
    expect(await screen.findByLabelText(/People with this workflow open: Olive Owner/)).toBeTruthy();
    expect(screen.queryByTestId('write-lock-banner')).toBeNull();

    // an edit made before the lock is lost waits; autosave stops with the lock
    useWorkflowStore.getState().moveNodes({ Start: [90, 30] });
    expect(useWorkflowStore.getState().dirty).toBe(true);

    // someone else takes the lock
    handlePushEvent({
      type: 'collaboratorsChanged',
      data: {
        workflowId: wf.id,
        collaborators: [
          { userId: selfId, name: 'Olive Owner', email: 'owner@example.com', lastSeen: '' },
          otherPerson,
        ],
      },
    });
    handlePushEvent({
      type: 'writeAccessAcquired',
      data: { workflowId: wf.id, userId: OTHER, clientId: 'their-tab' },
    });
    const banner = await screen.findByTestId('write-lock-banner');
    expect(banner.textContent).toContain('Omar Other is editing this workflow.');
    expect(banner.textContent).toContain('read-only');

    // autosave stops while the other holds the lock, and a new edit is refused
    const revision = useWorkflowStore.getState().revision;
    useWorkflowStore.getState().moveNodes({ Start: [120, 60] });
    expect(useWorkflowStore.getState().revision).toBe(revision);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual([90, 30]);
    await new Promise((r) => setTimeout(r, 2400));
    expect(patches()).toHaveLength(0);

    // take over: confirm first, then `force`
    const before = paths('POST', /\/write-access$/).length;
    await user.click(within(banner).getByRole('button', { name: 'Take over' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Omar Other is editing this workflow now');
    expect(paths('POST', /\/write-access$/).length).toBe(before);
    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() =>
      expect(paths('POST', /\/write-access$/).map((r) => r.body)).toContainEqual({ action: 'force' }),
    );
    await waitFor(() => expect(screen.queryByTestId('write-lock-banner')).toBeNull());
    expect(useCollaborationStore.getState().lockedByOther).toBe(false);

    // free again: the pending change is saved
    await waitFor(() => expect(patches().length).toBeGreaterThanOrEqual(1), { timeout: 20_000 });
  }, 60_000);

  it('while another holds the lock Save and Publish are disabled, Ctrl+S sends no PATCH, and paste and Delete do nothing', async () => {
    const user = userEvent.setup();
    const { wf } = await openEditor();
    await waitFor(() => expect(useCollaborationStore.getState().writeLock).not.toBeNull());
    // an unsaved edit: Save is live and so is Publish
    act(() => useWorkflowStore.getState().moveNodes({ Start: [90, 30] }));
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    handlePushEvent({
      type: 'writeAccessAcquired',
      data: { workflowId: wf.id, userId: OTHER, clientId: 'their-tab' },
    });
    await screen.findByTestId('write-lock-banner');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);

    const names = () => useWorkflowStore.getState().nodes.map((n) => n.name);
    const before = backend().requests.length;
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.paste(document, {
      clipboardData: {
        getData: () =>
          JSON.stringify({
            nodes: [{ name: 'Pasted', type: 'core.noOp', position: [10, 10], parameters: {} }],
            connections: {},
          }),
      },
    });
    act(() => useWorkflowStore.getState().select({ nodes: ['Start'], stickies: [], edges: [] }));
    fireEvent.keyDown(window, { key: 'Delete' });
    await user.keyboard('{Escape}');
    expect(names()).toEqual(['Start']);
    expect(
      backend()
        .requests.slice(before)
        .filter((r) => r.method !== 'GET' && !/(presence|write-access)$/.test(r.path)),
    ).toEqual([]);

    // free again: the same keys edit
    handlePushEvent({ type: 'writeAccessReleased', data: { workflowId: wf.id } });
    await waitFor(() => expect(screen.queryByTestId('write-lock-banner')).toBeNull());
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', false);
    act(() => useWorkflowStore.getState().select({ nodes: ['Start'], stickies: [], edges: [] }));
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(names()).toEqual([]);
  }, 60_000);

  it('a release by the other lets the editor go on', async () => {
    const { wf } = await openEditor();
    await waitFor(() => expect(useCollaborationStore.getState().writeLock).not.toBeNull());
    handlePushEvent({
      type: 'writeAccessAcquired',
      data: { workflowId: wf.id, userId: OTHER, clientId: 'their-tab' },
    });
    await screen.findByTestId('write-lock-banner');
    handlePushEvent({ type: 'writeAccessReleased', data: { workflowId: wf.id } });
    await waitFor(() => expect(screen.queryByTestId('write-lock-banner')).toBeNull());
  }, 60_000);

  it('another user saving shows "updated" with Reload, which loads the latest and dismisses it', async () => {
    const user = userEvent.setup();
    const { wf } = await openEditor();
    handlePushEvent({
      type: 'collaboratorsChanged',
      data: { workflowId: wf.id, collaborators: [otherPerson] },
    });
    handlePushEvent({ type: 'workflowUpdated', data: { workflowId: wf.id, userId: OTHER } });
    const prompt = await screen.findByTestId('workflow-updated-prompt');
    expect(prompt.textContent).toContain('Omar Other updated this workflow.');
    // another user's change reaches the stored workflow, then the person reloads
    backend().workflows.find((w) => w.id === wf.id)!.name = 'Renamed by Omar';
    await user.click(within(prompt).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByTestId('workflow-updated-prompt')).toBeNull());
    expect(useWorkflowStore.getState().meta.name).toBe('Renamed by Omar');
  }, 60_000);
});
