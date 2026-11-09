/** Folders, favorites, archive and move on the workflows page (P3-07, lane L8). */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { favoritesApi, foldersApi } from '../src/api/endpoints';
import { folderNameError } from '../src/components/workflow/FolderDialog';
import { folderState } from '../src/demo/mock-folders';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 20_000 };

function seed(name: string, extra: Record<string, unknown> = {}) {
  return backend().seedWorkflow({ name, nodes: [], connections: {}, ...extra });
}

async function openList(path = '/workflows', ready?: string) {
  const utils = renderApp(path);
  await screen.findByRole('region', { name: 'Workflow list' }, LONG);
  // the ready text must be in the list itself: a toast left by the previous test can show the same name while the
  // list still loads after the /workflows -> /home/workflows redirect (the region is read again on every try)
  if (ready)
    await waitFor(
      () => expect(within(screen.getByRole('region', { name: 'Workflow list' })).getAllByText(ready).length).toBeGreaterThan(0),
      LONG,
    );
  return utils;
}

const row = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement;

describe('folder name rule', () => {
  it('follows the server rule', () => {
    expect(folderNameError('Sales')).toBeNull();
    expect(folderNameError('  v1.2 final  ')).toBeNull();
    for (const bad of [
      '',
      '   ',
      '.',
      '..',
      '.hidden',
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a[b]',
      'a^b',
    ]) {
      expect(folderNameError(bad), bad).toBeTruthy();
    }
    expect(folderNameError('x'.repeat(128))).toBeNull();
    expect(folderNameError('x'.repeat(129))).toBeTruthy();
  });
});

describe('folders on the workflows page', () => {
  it('creates a folder from "New folder" and refuses a bad name', async () => {
    const user = userEvent.setup();
    signedIn();
    await openList('/workflows', 'Build your first workflow');
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    await user.type(within(dialog).getByLabelText(/Folder name/), 'a/b');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    expect(await within(dialog).findByText(/cannot contain/)).toBeTruthy();
    expect(folderState(backend()).folders).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/Folder name/));
    await user.type(within(dialog).getByLabelText(/Folder name/), '  Sales  ');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    expect(await screen.findByRole('link', { name: 'Sales' })).toBeTruthy();
    expect(folderState(backend()).folders.map((f) => f.name)).toEqual(['Sales']);
  });

  it('opens a folder (?folder=), shows its path and only its workflows, and creates a workflow in it', async () => {
    const user = userEvent.setup();
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    const b = await foldersApi.create({ name: 'Beta', parentFolderId: a.id });
    seed('Top flow');
    seed('Alpha flow', { folderId: a.id });
    seed('Beta flow', { folderId: b.id });
    await openList('/workflows', 'Top flow');
    expect(screen.getByRole('link', { name: 'Top flow' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Alpha flow' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Alpha' }));
    expect(await screen.findByRole('link', { name: 'Alpha flow' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Top flow' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Beta' })).toBeTruthy();
    expect(
      within(await screen.findByRole('navigation', { name: 'Folder path' })).getByRole('link', {
        name: 'Workflows',
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Beta' }));
    const crumbs = await screen.findByRole('navigation', { name: 'Folder path' });
    await waitFor(() => expect(within(crumbs).getByRole('link', { name: 'Alpha' })).toBeTruthy());
    expect(within(crumbs).getByText('Beta').getAttribute('aria-current')).toBe('location');
    expect(await screen.findByRole('link', { name: 'Beta flow' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await waitFor(() =>
      expect(backend().workflows.some((w) => w.name === 'My workflow' && w.folderId === b.id)).toBe(true),
    );
  });

  it('a search looks through every folder', async () => {
    const user = userEvent.setup();
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    seed('Deep invoice', { folderId: a.id });
    await openList('/workflows', 'Alpha');
    expect(screen.queryByRole('link', { name: 'Deep invoice' })).toBeNull();
    await user.type(screen.getByLabelText('Search workflows'), 'invoice');
    expect(await screen.findByRole('link', { name: 'Deep invoice' })).toBeTruthy();
  });

  it('moves a workflow and a folder with the Move dialog', async () => {
    const user = userEvent.setup();
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    const b = await foldersApi.create({ name: 'Beta' });
    const wf = seed('Mover');
    await openList('/workflows', 'Mover');
    await user.click(screen.getByRole('button', { name: 'Actions for Mover' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    const dialog = await screen.findByRole('dialog', { name: /Move “Mover”/ });
    await user.click(await within(dialog).findByRole('button', { name: 'Alpha' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(backend().workflows.find((w) => w.id === wf.id)?.folderId).toBe(a.id));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Mover' })).toBeNull());

    // a folder: it is not offered as its own target
    await user.click(screen.getByRole('button', { name: 'Actions for folder Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    const folderDialog = await screen.findByRole('dialog', { name: /Move “Alpha”/ });
    expect(within(folderDialog).queryByRole('button', { name: 'Alpha' })).toBeNull();
    await user.click(await within(folderDialog).findByRole('button', { name: 'Beta' }));
    await user.click(within(folderDialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(folderState(backend()).folders.find((f) => f.id === a.id)?.parentFolderId).toBe(b.id),
    );
  });

  it('renames a folder and the delete dialog shows the counts', async () => {
    const user = userEvent.setup();
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    await foldersApi.create({ name: 'Kid', parentFolderId: a.id });
    seed('In alpha', { folderId: a.id });
    seed('Also alpha', { folderId: a.id });
    await openList('/workflows', 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Actions for folder Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename folder' });
    const input = within(rename).getByLabelText(/Folder name/);
    await user.clear(input);
    await user.type(input, 'Omega');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: 'Omega' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Actions for folder Omega' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /Delete “Omega”/ });
    expect(await within(dialog).findByText('It holds 2 workflows and 1 subfolder.')).toBeTruthy();
    await user.click(
      within(dialog).getByRole('radio', { name: /Archive 2 workflows and delete 1 subfolder/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(folderState(backend()).folders).toHaveLength(0));
    // the workflows were archived at the top level
    expect(backend().workflows.filter((w) => w.isArchived && w.folderId === null)).toHaveLength(2);
  });

  it('deleting with "move the content" keeps the workflows and subfolders', async () => {
    const user = userEvent.setup();
    signedIn();
    const a = await foldersApi.create({ name: 'Alpha' });
    await foldersApi.create({ name: 'Kid', parentFolderId: a.id });
    const wf = seed('Stays', { folderId: a.id });
    await openList('/workflows', 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Actions for folder Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /Delete “Alpha”/ });
    await within(dialog).findByText(/It holds 1 workflow and 1 subfolder/);
    await user.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(folderState(backend()).folders.map((f) => f.name)).toEqual(['Kid']));
    expect(folderState(backend()).folders[0].parentFolderId).toBeNull();
    expect(backend().workflows.find((w) => w.id === wf.id)).toMatchObject({
      folderId: null,
      isArchived: false,
    });
  });
});

describe('favorites', () => {
  it('stars a workflow and a folder, lists them in the left nav and unstars', async () => {
    const user = userEvent.setup();
    signedIn();
    const f = await foldersApi.create({ name: 'Reports' });
    const wf = seed('Nightly');
    await openList('/workflows', 'Nightly');
    expect(screen.queryByRole('navigation', { name: 'Favorites' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Nightly to favorites' }));
    await user.click(screen.getByRole('button', { name: 'Add Reports to favorites' }));
    const nav = await screen.findByRole('navigation', { name: 'Favorites' });
    await waitFor(() => expect(within(nav).getAllByRole('link')).toHaveLength(2));
    expect(within(nav).getByRole('link', { name: 'Nightly' }).getAttribute('href')).toBe(
      `/workflow/${wf.id}`,
    );
    expect(within(nav).getByRole('link', { name: 'Reports' }).getAttribute('href')).toBe(
      `/workflows?folder=${f.id}`,
    );
    expect((await favoritesApi.list()).map((x) => x.name).sort()).toEqual(['Nightly', 'Reports']);

    await user.click(screen.getByRole('button', { name: 'Remove Nightly from favorites' }));
    await waitFor(() => expect(within(nav).queryByRole('link', { name: 'Nightly' })).toBeNull());
  });
});

describe('archive', () => {
  it('archives after a confirm, shows archived ones on request with a badge, restores and deletes', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = seed('Old job', { active: true });
    seed('Keeper');
    await openList('/workflows', 'Old job');
    await user.click(screen.getByRole('button', { name: 'Actions for Old job' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive workflow' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Old job' })).toBeNull());
    expect(backend().workflows.find((w) => w.id === wf.id)).toMatchObject({
      isArchived: true,
      active: false,
      publishedVersionId: null,
    });

    await user.click(screen.getByRole('checkbox', { name: 'Show archived workflows' }));
    const archivedRow = await waitFor(() => row('Old job'));
    expect(within(archivedRow).getByText('Archived')).toBeTruthy();
    expect(within(archivedRow).getByRole('switch').hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Actions for Old job' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => expect(within(row('Old job')).queryByText('Archived')).toBeNull());
    expect(backend().workflows.find((w) => w.id === wf.id)).toMatchObject({
      isArchived: false,
      active: false,
    });

    // archive again, then delete from the archived list
    await user.click(screen.getByRole('button', { name: 'Actions for Old job' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive workflow' }));
    await waitFor(() => expect(within(row('Old job')).getByText('Archived')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Actions for Old job' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete workflow' }));
    await waitFor(() => expect(backend().workflows.some((w) => w.id === wf.id)).toBe(false));
  });

  it('the banner on an archived workflow offers Restore', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = seed('Archived one', { isArchived: true });
    renderApp(`/workflow/${wf.id}`);
    // the page also shows a loading status first, so find the banner by its text
    const banner = (await screen.findByText('This workflow is archived.', {}, LONG)).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(banner).toBeTruthy();
    await user.click(within(banner).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(backend().workflows.find((w) => w.id === wf.id)?.isArchived).toBe(false));
    await waitFor(() => expect(screen.queryByText('This workflow is archived.')).toBeNull());
  });
});

describe('viewers', () => {
  it('cannot create, move, archive or drag, but can star', async () => {
    signedIn();
    backend().setDemoRole('viewer');
    const f = await foldersApi.create({ name: 'Alpha' }).catch(() => null);
    expect(f).toBeNull();
    backend().setDemoRole('owner');
    await foldersApi.create({ name: 'Alpha' });
    seed('Plain');
    backend().setDemoRole('viewer');
    await openList('/workflows', 'Plain');
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(row('Plain').getAttribute('draggable')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Plain' }));
    expect(await screen.findByRole('menuitem', { name: 'Add to favorites' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move to folder' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  });
});
