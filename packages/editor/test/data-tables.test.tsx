/** P4-05: the data tables list, its dialogs, storage warnings and the links into it from elsewhere. */
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DATA_TABLE_ERRORS, type WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { dataTablesApi, favoritesApi } from '../src/api/endpoints';
import type { DataTableLimits } from '../src/api/types';
import { NodeStorageCallout } from '../src/components/data-tables/NodeStorageCallout';
import { demoNodeTypes } from '../src/demo/fixtures';
import { dataTableName, searchDataTables, simulateDataTableNode } from '../src/demo/mock-data-tables';
import { useToastStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp, renderParameters, withProviders } from './utils';

configure({ asyncUtilTimeout: 20_000 });

const trigger: WorkflowNode = {
  id: 'n1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function tableNode(parameters: Record<string, unknown>): WorkflowNode {
  return { id: 'n2', name: 'Table', type: 'core.dataTable', typeVersion: 1, position: [300, 0], parameters };
}

const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value });
const fields = (values: Record<string, unknown>) => ({
  fieldValues: Object.entries(values).map(([columnName, value]) => ({ columnName, value })),
});

async function runWorkflow(nodes: WorkflowNode[]) {
  const wf = backend().seedWorkflow({
    name: 'Writer',
    nodes,
    connections: { Start: { main: [[{ node: 'Table', type: 'main', index: 0 }]] } },
  });
  const done = backend().executions.filter((e) => e.status !== 'running').length;
  await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
  await waitFor(() =>
    expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(done + 1),
  );
  return wf;
}

async function openList() {
  const utils = renderApp('/data-tables');
  await screen.findByRole('heading', { name: 'Data tables' });
  return utils;
}

const card = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement;
const cardNames = () =>
  within(screen.getByRole('list', { name: 'Data table list' }))
    .getAllByRole('link')
    .map((link) => link.textContent);
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

function csvFile(text: string, name = 'people.csv') {
  return new File([text], name, { type: 'text/csv' });
}

async function openMenu(name: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

const limits = (quotaStatus: DataTableLimits['quotaStatus'], totalMb: number): DataTableLimits => ({
  totalBytes: totalMb * 1024 * 1024,
  maxBytes: 200 * 1024 * 1024,
  warningBytes: 160 * 1024 * 1024,
  quotaStatus,
  uploadMaxFileSize: 1024,
  dataTables: {},
});

beforeEach(() => {
  signedIn();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('done when: a table made in the editor shows the rows a workflow wrote', () => {
  it('creates the table in the UI, a demo workflow inserts, the grid shows the rows', async () => {
    const user = userEvent.setup();
    const { unmount } = await openList();

    await user.click(screen.getByRole('button', { name: 'New data table' }));
    const dialog = await screen.findByRole('dialog', { name: 'New data table' });
    await user.type(within(dialog).getByLabelText('Name'), 'Leads');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await screen.findByRole('button', { name: 'Add first column' });
    await user.click(screen.getByRole('button', { name: 'Add first column' }));
    const add = await screen.findByRole('dialog', { name: 'Add column' });
    await user.type(within(add).getByLabelText('Column name'), 'email');
    await user.click(within(add).getByRole('button', { name: 'Add column' }));
    await screen.findByRole('columnheader', { name: /email/ });

    const [{ id }] = (await dataTablesApi.list()).data;
    await runWorkflow([
      trigger,
      tableNode({
        operation: 'insert',
        dataTableId: rl(id),
        dataMode: 'defineBelow',
        fieldsUi: fields({ email: '=ann@{{ "example.com" }}' }),
      }),
    ]);
    unmount();

    renderApp(`/data-tables/${id}`);
    expect(await screen.findByRole('gridcell', { name: 'ann@example.com' })).toBeTruthy();
  });
});

describe('list', () => {
  it('starts with an empty state that creates the first table', async () => {
    await openList();
    expect(await screen.findByText('Create your first data table')).toBeTruthy();
  });

  it('shows column count, size and the workflows that use a table', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'email', type: 'string' }] });
    await dataTablesApi.insertRows(table.id, [{ email: 'a@example.com' }], 'count');
    backend().seedWorkflow({
      name: 'Uses leads',
      nodes: [tableNode({ dataTableId: rl(table.id) })],
      connections: {},
    });
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    expect(within(card('Leads')).getByText(/1 column\b/)).toBeTruthy();
    expect(await within(card('Leads')).findByText(/MB/)).toBeTruthy();
    expect(await within(card('Leads')).findByRole('button', { name: 'Used by 1 workflow' })).toBeTruthy();
  });

  it('searches on the server and sorts', async () => {
    for (const name of ['Beta', 'Alpha', 'Gamma']) await dataTablesApi.create({ name, columns: [] });
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Alpha' });

    fireEvent.change(screen.getByLabelText('Sort data tables'), { target: { value: 'name:asc' } });
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Beta', 'Gamma']));
    fireEvent.change(screen.getByLabelText('Sort data tables'), { target: { value: 'name:desc' } });
    await waitFor(() => expect(cardNames()).toEqual(['Gamma', 'Beta', 'Alpha']));

    await user.type(screen.getByLabelText('Search data tables'), 'alp');
    await waitFor(() => expect(cardNames()).toEqual(['Alpha']));
    await waitFor(() =>
      expect(
        backend().requests.some(
          (r) => r.path === '/data-tables' && String(r.query?.filter).includes('"name":"alp"'),
        ),
      ).toBe(true),
    );

    await user.clear(screen.getByLabelText('Search data tables'));
    await user.type(screen.getByLabelText('Search data tables'), 'nothing');
    expect(await screen.findByText('No data tables match your search')).toBeTruthy();
  });

  it('pages by 10', async () => {
    for (let i = 0; i < 12; i++) {
      await dataTablesApi.create({ name: `T${String(i).padStart(2, '0')}`, columns: [] });
    }
    await openList();
    await screen.findByText('1-10 of 12');
    fireEvent.change(screen.getByLabelText('Sort data tables'), { target: { value: 'name:asc' } });
    await waitFor(() => expect(cardNames()[0]).toBe('T00'));
    expect(cardNames()).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('11-12 of 12');
    await waitFor(() => expect(cardNames()).toEqual(['T10', 'T11']));
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('1-10 of 12');
  });

  it('renames, refuses a duplicate with the n8n toast, and deletes after a confirm', async () => {
    await dataTablesApi.create({ name: 'Leads', columns: [] });
    await dataTablesApi.create({ name: 'Taken', columns: [] });
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Leads' });

    await openMenu('Leads', 'Rename');
    let dialog = await screen.findByRole('dialog', { name: 'Rename data table' });
    const input = within(dialog).getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Taken');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(toastTitles()).toContain('Error renaming data table'));
    expect(
      useToastStore.getState().toasts.find((t) => t.title === 'Error renaming data table')?.description,
    ).toBe(DATA_TABLE_ERRORS.tableNameExists('Taken'));

    dialog = screen.getByRole('dialog', { name: 'Rename data table' });
    await user.clear(input);
    await user.type(input, 'Customers');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('link', { name: 'Customers' });

    await openMenu('Customers', 'Delete');
    const confirm = await screen.findByRole('dialog', { name: 'Delete data table' });
    expect(within(confirm).getByText(/This action cannot be undone\./)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Customers' })).toBeNull());
    expect((await dataTablesApi.list()).count).toBe(1);
  });

  it('shows the n8n toast when a create fails', async () => {
    await dataTablesApi.create({ name: 'Leads', columns: [] });
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    await user.click(screen.getByRole('button', { name: 'New data table' }));
    const dialog = await screen.findByRole('dialog', { name: 'New data table' });
    await user.type(within(dialog).getByLabelText('Name'), 'Leads');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(toastTitles()).toContain('Error creating data table'));
  });

  it('opens the create dialog from a link with a name', async () => {
    renderApp('/data-tables?new=1&name=From%20locator');
    const dialog = await screen.findByRole('dialog', { name: 'New data table' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('From locator');
  });
});

describe('create from CSV', () => {
  async function pickCsv(text: string) {
    await openList();
    await userEvent.click(screen.getByRole('button', { name: 'New data table' }));
    const dialog = await screen.findByRole('dialog', { name: 'New data table' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'People');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Import CSV' }));
    await userEvent.upload(within(dialog).getByLabelText('CSV file'), csvFile(text));
    return dialog;
  }

  it('detects the columns, lets them be renamed and retyped, and imports the rows', async () => {
    const user = userEvent.setup();
    const dialog = await pickCsv('name,age,active,joined\nAnn,30,true,2026-01-02\nBob,41,false,2026-03-04\n');
    expect(await within(dialog).findByText('2 rows, 4 columns')).toBeTruthy();
    expect((within(dialog).getByLabelText('Name of column 1') as HTMLInputElement).value).toBe('name');
    expect((within(dialog).getByLabelText('Type of column 2') as HTMLSelectElement).value).toBe('number');
    expect((within(dialog).getByLabelText('Type of column 3') as HTMLSelectElement).value).toBe('boolean');
    expect((within(dialog).getByLabelText('Type of column 4') as HTMLSelectElement).value).toBe('date');

    const first = within(dialog).getByLabelText('Name of column 1');
    await user.clear(first);
    await user.type(first, 'fullName');
    fireEvent.change(within(dialog).getByLabelText('Type of column 2'), { target: { value: 'string' } });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('gridcell', { name: 'Ann' })).toBeTruthy();
    const [table] = (await dataTablesApi.list()).data;
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([
      ['fullName', 'string'],
      ['age', 'string'],
      ['active', 'boolean'],
      ['joined', 'date'],
    ]);
    const { data } = await dataTablesApi.rows(table.id);
    expect(data[1]).toMatchObject({
      fullName: 'Bob',
      age: '41',
      active: false,
      joined: '2026-03-04T00:00:00.000Z',
    });
  });

  it('checks names: invalid, reserved, duplicate', async () => {
    const user = userEvent.setup();
    const dialog = await pickCsv('First Name,id,a,a\nAnn,1,2,3\n');
    await within(dialog).findByText('1 row, 4 columns');
    expect(within(dialog).getByText(DATA_TABLE_ERRORS.columnNameInvalid)).toBeTruthy();
    expect(within(dialog).getByText(DATA_TABLE_ERRORS.columnNameReserved('id'))).toBeTruthy();
    expect(within(dialog).getAllByText('Column names must be different')).toHaveLength(2);
    expect((within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByLabelText('Include column 2'));
    expect(within(dialog).queryByText(DATA_TABLE_ERRORS.columnNameReserved('id'))).toBeNull();
  });

  it('asks to keep every column when one is renamed and another left out', async () => {
    const user = userEvent.setup();
    const dialog = await pickCsv('name,age\nAnn,30\n');
    await within(dialog).findByText('1 row, 2 columns');
    await user.click(within(dialog).getByLabelText('Include column 2'));
    const first = within(dialog).getByLabelText('Name of column 1');
    await user.clear(first);
    await user.type(first, 'fullName');
    expect(within(dialog).getByText(/Include every column to rename one/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves a column out, and reads a file with no header row', async () => {
    const user = userEvent.setup();
    const dialog = await pickCsv('Ann,30\nBob,41\n');
    await within(dialog).findByText('1 row, 2 columns');
    await user.click(within(dialog).getByRole('checkbox', { name: 'My CSV file contains a header row' }));
    await within(dialog).findByText('2 rows, 2 columns');
    expect((within(dialog).getByLabelText('Name of column 1') as HTMLInputElement).value).toBe('Column_1');
    await user.click(within(dialog).getByLabelText('Include column 2'));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await screen.findByRole('gridcell', { name: 'Bob' });
    const [table] = (await dataTablesApi.list()).data;
    expect(table.columns.map((c) => c.name)).toEqual(['Column_1']);
  });

  it('shows the n8n toast when the file cannot be read', async () => {
    const dialog = await pickCsv('name\n"not closed\n');
    await waitFor(() => expect(toastTitles()).toContain('Error uploading CSV file'));
    expect(within(dialog).queryByLabelText('Name of column 1')).toBeNull();
  });

  it('refuses a file over the upload limit without sending it', async () => {
    vi.spyOn(dataTablesApi, 'limits').mockResolvedValue(limits('ok', 1));
    const preview = vi.spyOn(dataTablesApi, 'csvPreview');
    await pickCsv(`name\n${'x'.repeat(2000)}\n`);
    await waitFor(() => expect(toastTitles()).toContain('Error uploading CSV file'));
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('import and download', () => {
  it('imports into a table, ignores system columns and says so', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'email', type: 'string' }] });
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    await openMenu('Leads', 'Import CSV');
    const dialog = await screen.findByRole('dialog', { name: 'Import CSV into Leads' });
    await user.upload(within(dialog).getByLabelText('CSV file'), csvFile('id,email\n9,a@example.com\n'));
    await within(dialog).findByText('1 row, 2 columns');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(toastTitles()).toContain('Imported 1 row'));
    expect(useToastStore.getState().toasts.at(-1)?.description).toContain('id');
    const { data } = await dataTablesApi.rows(table.id);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 1, email: 'a@example.com' });
  });

  it('will not import a column the table lacks', async () => {
    await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'email', type: 'string' }] });
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    await openMenu('Leads', 'Import CSV');
    const dialog = await screen.findByRole('dialog', { name: 'Import CSV into Leads' });
    await userEvent.upload(within(dialog).getByLabelText('CSV file'), csvFile('phone\n123\n'));
    expect(await within(dialog).findByText(DATA_TABLE_ERRORS.unknownColumn('phone'))).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the n8n toast when an import fails', async () => {
    await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'age', type: 'number' }] });
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    await openMenu('Leads', 'Import CSV');
    const dialog = await screen.findByRole('dialog', { name: 'Import CSV into Leads' });
    await userEvent.upload(within(dialog).getByLabelText('CSV file'), csvFile('age\nold\n'));
    await within(dialog).findByText('1 row, 1 column');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(toastTitles()).toContain('Failed to import CSV'));
  });

  it('downloads a CSV file, with or without the system columns', async () => {
    const table = await dataTablesApi.create({ name: 'Le/ads', columns: [{ name: 'note', type: 'string' }] });
    await dataTablesApi.insertRows(table.id, [{ note: '=1+1' }], 'count');
    const created: Blob[] = [];
    const names: string[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:csv';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Le/ads' });

    await openMenu('Le/ads', 'Download CSV');
    let dialog = await screen.findByRole('dialog', { name: 'Download CSV' });
    const box = within(dialog).getByRole('checkbox', {
      name: 'Include system columns (id, createdAt, updatedAt)',
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].type).toContain('text/csv');
    expect(names[0]).toBe('Leads.csv');

    await openMenu('Le/ads', 'Download CSV');
    dialog = await screen.findByRole('dialog', { name: 'Download CSV' });
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Include system columns (id, createdAt, updatedAt)' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(created).toHaveLength(2));
    await waitFor(() =>
      expect(
        backend()
          .requests.filter((r) => r.path.endsWith('/download-csv'))
          .at(-1)?.query?.includeSystemColumns,
      ).toBe('false'),
    );
    const { csvContent } = await dataTablesApi.downloadCsv(table.id, false);
    expect(csvContent).toBe(`note\r\n'=1+1`);
  });
});

describe('viewers', () => {
  it('reads, downloads and stars but cannot change anything', async () => {
    await dataTablesApi.create({ name: 'Leads', columns: [] });
    backend().setDemoRole('viewer');
    await expect(dataTablesApi.create({ name: 'No', columns: [] })).rejects.toBeInstanceOf(ApiError);
    const user = userEvent.setup();
    await openList();
    await screen.findByRole('link', { name: 'Leads' });
    expect(screen.queryByRole('button', { name: 'New data table' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for Leads' }));
    expect(await screen.findByRole('menuitem', { name: 'Download CSV' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add to favorites' })).toBeTruthy();
    for (const item of ['Rename', 'Delete', 'Import CSV', 'Clear all rows']) {
      expect(screen.queryByRole('menuitem', { name: item })).toBeNull();
    }
  });

  it('gets no create dialog from a link', async () => {
    backend().setDemoRole('viewer');
    await dataTablesApi.limits();
    renderApp('/data-tables?new=1');
    await screen.findByRole('heading', { name: 'Data tables' });
    await screen.findByText('No data tables yet');
    expect(screen.queryByRole('dialog', { name: 'New data table' })).toBeNull();
  });
});

describe('storage warnings', () => {
  it('shows nothing while storage is fine', async () => {
    await openList();
    await screen.findByText('Create your first data table');
    expect(screen.queryByText(/of data tables storage used/)).toBeNull();
  });

  it('warns above every page, then errors', async () => {
    const spy = vi.spyOn(dataTablesApi, 'limits').mockResolvedValue(limits('warn', 170));
    const { unmount } = renderApp('/workflows');
    expect(await screen.findByText(/170 \/ 200 MB of data tables storage used/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    spy.mockResolvedValue(limits('error', 200));
    renderApp('/workflows');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('200 / 200 MB of data tables storage used');
  });

  it('the node panel callout warns and errors with usage / max MB', async () => {
    const spy = vi.spyOn(dataTablesApi, 'limits').mockResolvedValue(limits('warn', 170));
    const first = withProviders(<NodeStorageCallout />);
    expect(await screen.findByText(/170 \/ 200 MB/)).toBeTruthy();
    first.unmount();
    spy.mockResolvedValue(limits('error', 200));
    withProviders(<NodeStorageCallout />);
    expect((await screen.findByRole('alert')).textContent).toContain('200 / 200 MB');
  });

  it('the callout stays away when storage is fine', async () => {
    const spy = vi.spyOn(dataTablesApi, 'limits').mockResolvedValue(limits('ok', 1));
    const { container } = withProviders(<NodeStorageCallout />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('links into data tables', () => {
  it('favorites: star from the card, the left nav opens the table', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: [] });
    const user = userEvent.setup();
    await openList();
    await user.click(await screen.findByRole('button', { name: 'Add Leads to favorites' }));
    const nav = await screen.findByRole('navigation', { name: 'Favorites' });
    const link = await within(nav).findByRole('link', { name: 'Leads' });
    expect(link.getAttribute('href')).toBe(`/data-tables/${table.id}`);
    await user.click(await screen.findByRole('button', { name: 'Remove Leads from favorites' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Favorites' })).toBeNull());
  });

  it('a deleted table drops out of the favorites', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: [] });
    await favoritesApi.add('dataTable', table.id);
    await dataTablesApi.remove(table.id);
    expect(await favoritesApi.list()).toEqual([]);
  });

  it('command bar: Go to Data tables', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/workflows');
    await screen.findByRole('region', { name: 'Workflow list' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search the command bar' });
    await user.type(input, 'data tables');
    await user.click(await screen.findByRole('option', { name: /Go to Data tables/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/data-tables'));
  });

  it("the locator's create link opens the create dialog in a new tab, with the typed name", async () => {
    const description = demoNodeTypes.find((d) => d.name === 'core.dataTable')!;
    const user = userEvent.setup();
    renderParameters(description, { parameters: { operation: 'insert', dataTableId: rl('') } });
    await user.click(screen.getByText(/Choose from the list/));
    const link = (await screen.findByRole('link', { name: 'Create a new data table' })) as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.getAttribute('href')).toBe('/data-tables?new=1');
    await user.type(screen.getByLabelText('Search resources'), 'My leads');
    await waitFor(() => expect(link.getAttribute('href')).toBe('/data-tables?new=1&name=My%20leads'));
  });

  it('a create link that leaves this site is not shown', async () => {
    const description = structuredClone(demoNodeTypes.find((d) => d.name === 'core.dataTable')!);
    const prop = description.properties.find((p) => p.name === 'dataTableId')!;
    prop.modes![0].typeOptions!.allowNewResource = { label: 'Elsewhere', url: '//evil.example/x' };
    renderParameters(description, { parameters: { operation: 'insert', dataTableId: rl('') } });
    await userEvent.click(screen.getByText(/Choose from the list/));
    await screen.findByLabelText('Search resources');
    expect(screen.queryByRole('link', { name: 'Elsewhere' })).toBeNull();
  });
});

describe('the demo backend keeps the server rules', () => {
  it('names and tenants', async () => {
    await expect(dataTablesApi.create({ name: '   ', columns: [] })).rejects.toBeInstanceOf(ApiError);
    const table = await dataTablesApi.create({ name: ' Leads ', columns: [] });
    expect(table.name).toBe('Leads');
    await expect(dataTablesApi.create({ name: 'Leads', columns: [] })).rejects.toThrow(
      DATA_TABLE_ERRORS.tableNameExists('Leads'),
    );
    expect(dataTableName(table.id)).toBe('Leads');
    expect(searchDataTables('lea').results).toEqual([
      { name: 'Leads', value: table.id, url: `/data-tables/${table.id}` },
    ]);
    backend().tenants.push({ ...backend().tenants[0], id: 'other' });
    backend().memberships.push({ tenantId: 'other', userId: backend().memberships[0].userId, role: 'owner' });
    backend().session = { ...backend().session!, tenantId: 'other' };
    expect(dataTableName(table.id)).toBeUndefined();
    await expect(dataTablesApi.get(table.id)).rejects.toThrow(DATA_TABLE_ERRORS.tableIdNotFound(table.id));
  });

  it('row filters, search, delete and clear', async () => {
    const table = await dataTablesApi.create({
      name: 'Leads',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'number' },
      ],
    });
    await dataTablesApi.insertRows(
      table.id,
      [
        { name: 'Ann', age: '30' },
        { name: 'Bob', age: 41 },
        { name: null, age: null },
      ],
      'count',
    );
    const names = async (q: Parameters<typeof dataTablesApi.rows>[1]) =>
      (await dataTablesApi.rows(table.id, q)).data.map((r) => r.name);
    const where = (columnName: string, condition: 'gt' | 'neq' | 'ilike' | 'isEmpty', value?: string) => ({
      filter: { type: 'and' as const, filters: [{ columnName, condition, value }] },
    });
    expect(await names(where('age', 'gt', '30'))).toEqual(['Bob']);
    expect(await names(where('name', 'neq', 'Ann'))).toEqual(['Bob', null]);
    expect(await names(where('name', 'ilike', 'AN'))).toEqual(['Ann']);
    expect(await names(where('name', 'isEmpty'))).toEqual([null]);
    expect(await names({ search: 'bo' })).toEqual(['Bob']);
    expect(await names({ sortBy: { column: 'age', direction: 'desc' } })).toEqual([null, 'Bob', 'Ann']);
    await expect(names(where('nope', 'isEmpty'))).rejects.toThrow(DATA_TABLE_ERRORS.unknownColumn('nope'));
    await expect(dataTablesApi.insertRows(table.id, [{ age: 'old' }], 'count')).rejects.toThrow(/number/);
    await expect(dataTablesApi.deleteRows(table.id, { type: 'and', filters: [] })).rejects.toThrow(
      DATA_TABLE_ERRORS.filterRequiredForDelete,
    );
    expect(await dataTablesApi.clearRows(table.id)).toEqual({ deletedCount: 3 });
  });

  it('simulates get, update, upsert and delete, and reports a missing table', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'n', type: 'number' }] });
    const run = (parameters: Record<string, unknown>) =>
      simulateDataTableNode(tableNode({ dataTableId: rl(table.id), ...parameters }), [{ json: { n: 7 } }]);
    const match = { filters: { conditions: [{ keyName: 'n', condition: 'eq', keyValue: 7 }] } };

    expect(run({ operation: 'insert', dataMode: 'autoMapInputData' })[0][0].json).toMatchObject({ n: 7 });
    expect(run({ operation: 'get', limit: 5 })[0]).toHaveLength(1);
    expect(
      run({ operation: 'update', fieldsUi: fields({ n: 8 }), dataMode: 'defineBelow', ...match })[0],
    ).toHaveLength(1);
    expect(() => run({ operation: 'update', fieldsUi: fields({ n: 8 }) })).toThrow(
      DATA_TABLE_ERRORS.atLeastOneCondition,
    );
    run({ operation: 'upsert', fieldsUi: fields({ n: 7 }), ...match });
    expect((await dataTablesApi.rows(table.id)).count).toBe(2);
    expect(run({ operation: 'deleteRows', ...match })[0]).toHaveLength(1);
    expect(() =>
      simulateDataTableNode(tableNode({ operation: 'get', dataTableId: rl('Gone', 'name') }), [{ json: {} }]),
    ).toThrow(DATA_TABLE_ERRORS.tableNameNotFound('Gone'));
  });
});

describe('fix round: size sort, kept sort, CSV source, demo node', () => {
  it('sorts by size, largest and smallest, and keeps the sort for the next visit', async () => {
    const big = await dataTablesApi.create({ name: 'Big', columns: [{ name: 'a', type: 'string' }] });
    await dataTablesApi.create({ name: 'Empty', columns: [] });
    const small = await dataTablesApi.create({ name: 'Small', columns: [{ name: 'a', type: 'string' }] });
    await dataTablesApi.insertRows(
      big.id,
      Array.from({ length: 10 }, () => ({ a: 'x'.repeat(80) })),
      'count',
    );
    await dataTablesApi.insertRows(small.id, [{ a: 'y' }], 'count');
    const { unmount } = await openList();
    await screen.findByRole('link', { name: 'Big' });
    const options = within(screen.getByLabelText('Sort data tables'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Largest', 'Smallest']));

    fireEvent.change(screen.getByLabelText('Sort data tables'), { target: { value: 'size:desc' } });
    await waitFor(() => expect(cardNames()).toEqual(['Big', 'Small', 'Empty']));
    fireEvent.change(screen.getByLabelText('Sort data tables'), { target: { value: 'size:asc' } });
    await waitFor(() => expect(cardNames()).toEqual(['Empty', 'Small', 'Big']));
    unmount();

    await openList();
    expect((screen.getByLabelText('Sort data tables') as HTMLSelectElement).value).toBe('size:asc');
    await waitFor(() => expect(cardNames()).toEqual(['Empty', 'Small', 'Big']));
  });

  it('opens on the first sort when the saved one is unknown or storage is blocked', async () => {
    window.localStorage.setItem('workflow.dataTables.sort', 'colour:asc');
    const first = await openList();
    expect((screen.getByLabelText('Sort data tables') as HTMLSelectElement).value).toBe('updatedAt:desc');
    first.unmount();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await openList();
    expect((screen.getByLabelText('Sort data tables') as HTMLSelectElement).value).toBe('updatedAt:desc');
    get.mockRestore();
  });

  describe('create dialog', () => {
    async function openDialog() {
      await openList();
      await userEvent.click(screen.getByRole('button', { name: 'New data table' }));
      return screen.findByRole('dialog', { name: 'New data table' });
    }

    it('sends the columns it detected only while Import CSV is chosen', async () => {
      const user = userEvent.setup();
      const dialog = await openDialog();
      await user.type(within(dialog).getByLabelText('Name'), 'Blank');
      await user.click(within(dialog).getByRole('radio', { name: 'Import CSV' }));
      await user.upload(within(dialog).getByLabelText('CSV file'), csvFile('a,b\n1,2\n'));
      await within(dialog).findByText('1 row, 2 columns');
      await user.click(within(dialog).getByRole('radio', { name: 'From scratch' }));
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(() =>
        expect(backend().requests.some((r) => r.method === 'POST' && r.path === '/data-tables')).toBe(true),
      );
      const post = backend().requests.find((r) => r.method === 'POST' && r.path === '/data-tables');
      expect(post?.body).toEqual({ name: 'Blank', columns: [] });
    });

    it('keeps the values with their columns when two columns take other names', async () => {
      const user = userEvent.setup();
      const dialog = await openDialog();
      await user.type(within(dialog).getByLabelText('Name'), 'Swapped');
      await user.click(within(dialog).getByRole('radio', { name: 'Import CSV' }));
      await user.upload(within(dialog).getByLabelText('CSV file'), csvFile('a,b,c\n1,2,3\n'));
      await within(dialog).findByText('1 row, 3 columns');
      const first = within(dialog).getByLabelText('Name of column 1');
      await user.clear(first);
      await user.type(first, 'b');
      const second = within(dialog).getByLabelText('Name of column 2');
      await user.clear(second);
      await user.type(second, 'x');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(async () => expect((await dataTablesApi.list()).count).toBe(1));
      const [table] = (await dataTablesApi.list()).data;
      const { data } = await dataTablesApi.rows(table.id);
      expect(data[0]).toMatchObject({ b: 1, x: 2, c: 3 });
    });
  });

  describe('the demo Data Table node', () => {
    const description = () => demoNodeTypes.find((d) => d.name === 'core.dataTable')!;

    it('offers conditions, match type, the exists checks, order by and dry run', () => {
      const names = description().properties.map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(['matchType', 'filters', 'returnAll', 'orderBy', 'orderByColumn', 'options']),
      );
      const operation = description().properties.find((p) => p.name === 'operation')!;
      expect(operation.options?.map((o) => (o as { value: string }).value)).toEqual(
        expect.arrayContaining(['rowExists', 'rowNotExists']),
      );
    });

    it('ignores item fields that are no column, reads an unset match type as any, and checks existence', async () => {
      const table = await dataTablesApi.create({
        name: 'Leads',
        columns: [
          { name: 'n', type: 'number' },
          { name: 's', type: 'string' },
        ],
      });
      const run = (parameters: Record<string, unknown>, json: Record<string, unknown> = { n: 1 }) =>
        simulateDataTableNode(tableNode({ dataTableId: rl(table.id), ...parameters }), [{ json }]);
      const inserted = run(
        { operation: 'insert', dataMode: 'autoMapInputData' },
        { n: 1, extra: 'x', id: 99 },
      );
      expect(inserted[0][0].json).toMatchObject({ n: 1, id: 1 });
      const conditions = [
        { keyName: 'n', condition: 'eq', keyValue: 1 },
        { keyName: 's', condition: 'eq', keyValue: 'nope' },
      ];
      expect(run({ operation: 'get', returnAll: true, filters: { conditions } })[0]).toHaveLength(1);
      expect(
        run({ operation: 'get', returnAll: true, matchType: 'allConditions', filters: { conditions } })[0],
      ).toHaveLength(0);
      expect(run({ operation: 'rowExists', filters: { conditions } })[0]).toHaveLength(1);
      expect(run({ operation: 'rowNotExists', filters: { conditions } })[0]).toHaveLength(0);
      const dry = run({
        operation: 'update',
        dataMode: 'autoMapInputData',
        options: { dryRun: true },
        filters: { conditions },
      })[0];
      expect(dry.map((i) => i.json.dryRunState)).toEqual(['before', 'after']);
      expect((await dataTablesApi.rows(table.id)).data[0].n).toBe(1);
    });
  });

  it('the demo list refuses like with null, as the server does', async () => {
    const table = await dataTablesApi.create({ name: 'Names', columns: [{ name: 'a', type: 'string' }] });
    await dataTablesApi.insertRows(table.id, [{ a: 'x' }], 'count');
    await expect(
      dataTablesApi.rows(table.id, {
        filter: { type: 'and', filters: [{ columnName: 'a', condition: 'like', value: null }] },
      }),
    ).rejects.toThrow(/like needs a text value/);
  });
});
