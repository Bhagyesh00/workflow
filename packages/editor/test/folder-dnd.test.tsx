/** Drag a workflow or folder onto a folder row or a breadcrumb item (P3-07, lane L8). */
import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { foldersApi, workflowsApi } from '../src/api/endpoints';
import { folderState } from '../src/demo/mock-folders';
import { canDrop, currentDrag, type DragItem } from '../src/features/workflows/folder-dnd';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 20_000 };

function seed(name: string, extra: Record<string, unknown> = {}) {
  return backend().seedWorkflow({ name, nodes: [], connections: {}, ...extra });
}

async function openList(path = '/workflows', ready?: string) {
  renderApp(path);
  await screen.findByRole('region', { name: 'Workflow list' }, LONG);
  if (ready) await screen.findAllByText(ready, undefined, LONG);
}

const rowOf = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement;

/** a DataTransfer stand-in: jsdom has none */
function transfer() {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: '',
    dropEffect: '',
    types: [] as string[],
  };
}

function drag(source: HTMLElement, target: HTMLElement) {
  const dataTransfer = transfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragEnter(target, { dataTransfer });
  const over = createEvent.dragOver(target, { dataTransfer });
  fireEvent(target, over);
  const accepted = over.defaultPrevented;
  fireEvent.drop(target, { dataTransfer });
  fireEvent.dragEnd(source, { dataTransfer });
  return accepted;
}

describe('canDrop', () => {
  const wf: DragItem = { type: 'workflow', id: 'w', name: 'W', folderId: 'a' };
  const folder: DragItem = { type: 'folder', id: 'f', name: 'F', parentFolderId: null };
  it('refuses the folder it is already in', () => {
    expect(canDrop(wf, { folderId: 'a', path: ['a'] })).toBe(false);
    expect(canDrop(wf, { folderId: null, path: [] })).toBe(true);
    expect(canDrop(folder, { folderId: null, path: [] })).toBe(false);
  });
  it('refuses a folder onto itself and onto its descendants', () => {
    expect(canDrop(folder, { folderId: 'f', path: ['f'] })).toBe(false);
    expect(canDrop(folder, { folderId: 'g', path: ['f', 'g'] })).toBe(false);
    expect(canDrop(folder, { folderId: 'x', path: ['x'] })).toBe(true);
  });
});

describe('drag to folder', () => {
  it('drops a workflow on a folder row', async () => {
    signedIn();
    const f = await foldersApi.create({ name: 'Alpha' });
    const wf = seed('Dragged');
    await openList('/workflows', 'Dragged');
    expect(drag(rowOf('Dragged'), rowOf('Alpha'))).toBe(true);
    await waitFor(() => expect(backend().workflows.find((w) => w.id === wf.id)?.folderId).toBe(f.id));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Dragged' })).toBeNull());
    expect(currentDrag()).toBeNull();
  });

  it('drops a folder on a folder row; a folder cannot be dropped on itself', async () => {
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    const b = await foldersApi.create({ name: 'Beta' });
    await openList('/workflows', 'Beta');
    expect(drag(rowOf('Beta'), rowOf('Beta'))).toBe(false);
    expect(folderState(backend()).folders.find((x) => x.id === b.id)?.parentFolderId).toBeNull();
    expect(drag(rowOf('Beta'), rowOf('Alpha'))).toBe(true);
    await waitFor(() =>
      expect(folderState(backend()).folders.find((x) => x.id === b.id)?.parentFolderId).toBe(a.id),
    );
  });

  it('drops a workflow on a breadcrumb item (the top level)', async () => {
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    const wf = seed('Inside', { folderId: a.id });
    await openList(`/workflows?folder=${a.id}`, 'Inside');
    const crumbs = await screen.findByRole('navigation', { name: 'Folder path' });
    const top = Array.from(crumbs.querySelectorAll('a')).find(
      (el) => el.textContent === 'Workflows',
    ) as HTMLElement;
    expect(drag(await waitFor(() => rowOf('Inside')), top)).toBe(true);
    await waitFor(() => expect(backend().workflows.find((w) => w.id === wf.id)?.folderId).toBeNull());
  });

  it('a workflow already in the folder is not accepted; the current breadcrumb item is not a target', async () => {
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    seed('Inside', { folderId: a.id });
    await openList(`/workflows?folder=${a.id}`, 'Inside');
    const crumbs = await screen.findByRole('navigation', { name: 'Folder path' });
    const current = await waitFor(() => {
      const el = crumbs.querySelector('[aria-current="location"]');
      if (!el) throw new Error('not yet');
      return el as HTMLElement;
    });
    expect(drag(await waitFor(() => rowOf('Inside')), current)).toBe(false);
  });

  it('an archived workflow is not draggable and the move route refuses it', async () => {
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    const old = seed('Old one', { isArchived: true });
    seed('Live one');
    await openList('/workflows', 'Live one');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived workflows' }));
    await screen.findByText('Old one', undefined, LONG);
    expect(rowOf('Old one').getAttribute('draggable')).toBeNull();
    expect(rowOf('Live one').getAttribute('draggable')).toBe('true');
    const dataTransfer = transfer();
    fireEvent.dragStart(rowOf('Old one'), { dataTransfer });
    expect(currentDrag()).toBeNull();
    await expect(workflowsApi.move({ workflowIds: [old.id], folderId: a.id })).rejects.toBeTruthy();
  });

  it('a viewer cannot drag', async () => {
    signedIn();
    await foldersApi.create({ name: 'Alpha' });
    seed('Plain');
    backend().memberships[0].role = 'viewer';
    await openList('/workflows', 'Plain');
    expect(rowOf('Plain').getAttribute('draggable')).toBeNull();
    expect(rowOf('Alpha').getAttribute('draggable')).toBeNull();
    const dataTransfer = transfer();
    fireEvent.dragStart(rowOf('Plain'), { dataTransfer });
    expect(currentDrag()).toBeNull();
  });
});
