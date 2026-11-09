/** P4-05: the grid of one data table: cells per type, rows, columns, header menu, filters, search, paging. */
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DATA_TABLE_ERRORS, type DataTableColumnInput, type DataTableRowInput } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataTablesApi } from '../src/api/endpoints';
import { useToastStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

configure({ asyncUtilTimeout: 20_000 });

const COLUMNS: DataTableColumnInput[] = [
  { name: 'name', type: 'string' },
  { name: 'age', type: 'number' },
  { name: 'active', type: 'boolean' },
  { name: 'joined', type: 'date' },
];
const ANN = { name: 'Ann', age: 30, active: true, joined: '2026-01-02T03:04:05.000Z' };
const BOB = { name: 'Bob', age: 41, active: false, joined: '2026-03-04T00:00:00.000Z' };

async function open(rows: DataTableRowInput[] = [ANN, BOB], columns = COLUMNS) {
  const table = await dataTablesApi.create({ name: 'Leads', columns });
  if (rows.length) await dataTablesApi.insertRows(table.id, rows, 'count');
  const utils = renderApp(`/data-tables/${table.id}`);
  if (columns.length) await screen.findByRole('grid', { name: 'Rows of Leads' });
  return { ...utils, table };
}

const cell = (name: string) => screen.findByRole('gridcell', { name });
const headers = () => screen.getAllByRole('columnheader').map((h) => h.getAttribute('data-column'));
const firstColumn = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .flatMap((row) => {
      const found = row.querySelector('[data-column-cell="name"]');
      return found ? [found.textContent] : [];
    });
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

async function columnMenu(column: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: `Column menu for ${column}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

async function applyFilter(column: string, condition: string, values: Record<string, string> = {}) {
  await columnMenu(column, 'Filter');
  const dialog = await screen.findByRole('dialog', { name: `Filter ${column}` });
  fireEvent.change(within(dialog).getByLabelText('Condition'), { target: { value: condition } });
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  }
  await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
}

beforeEach(() => {
  signedIn();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('page', () => {
  it('shows a not found state for a missing table', async () => {
    renderApp('/data-tables/missing');
    expect(await screen.findByText('Data table not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to data tables' }).getAttribute('href')).toBe(
      '/data-tables',
    );
  });

  it('has breadcrumbs, renames and deletes the table', async () => {
    const { router } = await open();
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Data tables', current: false })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Actions for Leads' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename data table' });
    const input = within(dialog).getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Customers');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('grid', { name: 'Rows of Customers' });

    await user.click(screen.getByRole('button', { name: 'Actions for Customers' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete data table' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/data-tables'));
  });

  it('clears the rows after a confirm', async () => {
    await open();
    const user = userEvent.setup();
    await cell('Ann');
    await user.click(screen.getByRole('button', { name: 'Actions for Leads' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Clear all rows' }));
    const confirm = await screen.findByRole('dialog', { name: 'Clear all rows' });
    await user.click(within(confirm).getByRole('button', { name: 'Clear rows' }));
    expect(await screen.findByText('No rows')).toBeTruthy();
  });

  it('the pill lists the workflows that use the table', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: COLUMNS });
    const wf = backend().seedWorkflow({
      name: 'Writer',
      nodes: [
        {
          id: 'n',
          name: 'T',
          type: 'core.dataTable',
          typeVersion: 1,
          position: [0, 0],
          parameters: { dataTableId: { __rl: true, mode: 'name', value: 'Leads' } },
        },
      ],
      connections: {},
    });
    const { router } = renderApp(`/data-tables/${table.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Used by 1 workflow' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Writer' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflow/${wf.id}`));
  });
});

describe('cells', () => {
  it('edits text; Enter saves, Escape cancels, Shift+Enter keeps a line break', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await user.click(await cell('Ann'));
    const input = await screen.findByLabelText('Edit name of row 1');
    await user.clear(input);
    await user.type(input, 'Anna{Enter}');
    const saved = await cell('Anna');
    await waitFor(() => expect(document.activeElement).toBe(saved));
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).data[0].name).toBe('Anna'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'));

    await user.click(await cell('Bob'));
    const second = await screen.findByLabelText('Edit name of row 2');
    await user.type(second, 'by{Escape}');
    await cell('Bob');
    expect((await dataTablesApi.rows(table.id)).data[1].name).toBe('Bob');

    await user.click(await cell('Bob'));
    await user.type(await screen.findByLabelText('Edit name of row 2'), 'x{Shift>}{Enter}{/Shift}y{Enter}');
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).data[1].name).toBe('Bobx\ny'));
  });

  it('does not write when nothing changed', async () => {
    await open();
    const update = vi.spyOn(dataTablesApi, 'updateRows');
    const user = userEvent.setup();
    await user.click(await cell('Ann'));
    await user.keyboard('{Enter}');
    await cell('Ann');
    expect(update).not.toHaveBeenCalled();
  });

  it('text can be set to null or to empty, and shows which', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await user.click(await cell('Ann'));
    await user.clear(await screen.findByLabelText('Edit name of row 1'));
    await user.keyboard('{Enter}');
    expect(await cell('Empty')).toBeTruthy();
    expect((await dataTablesApi.rows(table.id)).data[0].name).toBe('');

    await user.click(await cell('Bob'));
    await user.click(await screen.findByRole('button', { name: 'Set to null' }));
    expect(await cell('Null')).toBeTruthy();
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).data[1].name).toBeNull());
  });

  it('edits a number, refuses bad input and warns above the safe range', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await user.click(await cell('30'));
    const input = await screen.findByLabelText('Edit age of row 1');
    await user.clear(input);
    await user.type(input, 'old{Enter}');
    expect(screen.getByText('Enter a number')).toBeTruthy();

    await user.clear(input);
    await user.type(input, '9007199254740993');
    expect(screen.getByText(/above 9,007,199,254,740,991/)).toBeTruthy();

    await user.clear(input);
    await user.type(input, '31.5{Enter}');
    expect(await cell('31.5')).toBeTruthy();
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).data[0].age).toBe(31.5));
  });

  it('edits a boolean', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await user.click(await cell('true'));
    const select = await screen.findByLabelText('Edit active of row 1');
    fireEvent.change(select, { target: { value: 'false' } });
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).data[0].active).toBe(false));
  });

  it('edits a date in UTC', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await user.click(await cell('2026-01-02 03:04:05'));
    const input = (await screen.findByLabelText('Edit joined of row 1')) as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2026-01-02T03:04:05');
    fireEvent.change(input, { target: { value: '2027-05-06T07:08:09' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(async () =>
      expect((await dataTablesApi.rows(table.id)).data[0].joined).toBe('2027-05-06T07:08:09.000Z'),
    );
  });

  it('shows the n8n toast and the old value when a save fails', async () => {
    await open();
    vi.spyOn(dataTablesApi, 'updateRows').mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    await user.click(await cell('Ann'));
    await user.type(await screen.findByLabelText('Edit name of row 1'), 'x{Enter}');
    await waitFor(() => expect(toastTitles()).toContain('Error updating row'));
    expect(await cell('Ann')).toBeTruthy();
  });

  it('renders a large value as a message', async () => {
    await open([{ name: 'x'.repeat(10_001), age: 1 }]);
    expect(await cell('Value too large to display')).toBeTruthy();
    expect(document.body.textContent).not.toContain('xxxxxxxxxx');
  });

  it('moves with the arrow keys and opens an editor from the keyboard', async () => {
    await open();
    const ann = await cell('Ann');
    ann.focus();
    fireEvent.keyDown(ann, { key: 'ArrowDown' });
    const bob = await cell('Bob');
    await waitFor(() => expect(document.activeElement).toBe(bob));
    fireEvent.keyDown(bob, { key: 'ArrowRight' });
    const age = await cell('41');
    await waitFor(() => expect(document.activeElement).toBe(age));
    fireEvent.keyDown(age, { key: 'Enter' });
    expect(await screen.findByLabelText('Edit age of row 2')).toBeTruthy();
  });
});

describe('rows', () => {
  it('adds a row and goes to the page it is on', async () => {
    const { table } = await open(Array.from({ length: 10 }, (_, i) => ({ name: `R${i}` })));
    await cell('R0');
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await waitFor(async () => expect((await dataTablesApi.rows(table.id)).count).toBe(11));
    await screen.findByText('11-11 of 11');
    await screen.findByRole('checkbox', { name: 'Select row 11' });
  });

  it('shows the n8n toast when adding fails', async () => {
    await open();
    await cell('Ann');
    vi.spyOn(dataTablesApi, 'insertRows').mockRejectedValue(new Error('nope'));
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await waitFor(() => expect(toastTitles()).toContain('Error adding row'));
  });

  it('selects and deletes rows after a confirm', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await cell('Ann');
    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    await user.click(screen.getByRole('button', { name: 'Delete rows (1)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete rows' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete rows' }));
    await waitFor(() => expect(screen.queryByRole('gridcell', { name: 'Ann' })).toBeNull());
    expect((await dataTablesApi.rows(table.id)).data.map((r) => r.name)).toEqual(['Bob']);

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    await user.click(screen.getByRole('button', { name: 'Delete rows (1)' }));
    const again = await screen.findByRole('dialog', { name: 'Delete rows' });
    await user.click(within(again).getByRole('button', { name: 'Delete rows' }));
    expect(await screen.findByText('No rows')).toBeTruthy();
  });

  it('shows the n8n toast when deleting fails', async () => {
    await open();
    await cell('Ann');
    vi.spyOn(dataTablesApi, 'deleteRows').mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    await user.click(screen.getByRole('button', { name: 'Delete rows (1)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete rows' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete rows' }));
    await waitFor(() => expect(toastTitles()).toContain('Error deleting rows'));
  });

  it('goes back a page when the last row of a page is deleted', async () => {
    await open(Array.from({ length: 11 }, (_, i) => ({ name: `R${i}` })));
    const user = userEvent.setup();
    await cell('R0');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await cell('R10');
    await user.click(screen.getByRole('checkbox', { name: 'Select row 11' }));
    await user.click(screen.getByRole('button', { name: 'Delete rows (1)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete rows' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete rows' }));
    await screen.findByText('1-10 of 10');
  });

  it('page sizes 10, 20 and 50', async () => {
    await open(Array.from({ length: 25 }, (_, i) => ({ name: `R${i}` })));
    await cell('R0');
    await screen.findByText('1-10 of 25');
    const select = screen.getByLabelText('Rows per page') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['10', '20', '50']);
    fireEvent.change(select, { target: { value: '20' } });
    await screen.findByText('1-20 of 25');
    fireEvent.change(select, { target: { value: '50' } });
    await screen.findByText('1-25 of 25');
  });

  it('shows the n8n toast when the rows cannot be read', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: COLUMNS });
    vi.spyOn(dataTablesApi, 'rows').mockRejectedValue(new Error('nope'));
    renderApp(`/data-tables/${table.id}`);
    await waitFor(() => expect(toastTitles()).toContain('Error fetching data table content'));
  });
});

describe('columns', () => {
  it('starts with "No columns yet", and checks a new name first', async () => {
    await open([], []);
    const user = userEvent.setup();
    expect(await screen.findByText('No columns yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add first column' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add column' });
    const input = within(dialog).getByLabelText('Column name');
    const submit = within(dialog).getByRole('button', { name: 'Add column' }) as HTMLButtonElement;

    await user.type(input, '1bad');
    expect(within(dialog).getByText(DATA_TABLE_ERRORS.columnNameInvalid)).toBeTruthy();
    expect(submit.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, 'CreatedAt');
    expect(within(dialog).getByText(DATA_TABLE_ERRORS.columnNameReserved('CreatedAt'))).toBeTruthy();
    await user.clear(input);
    await user.type(input, 'age');
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'number' } });
    await user.click(submit);
    await screen.findByRole('columnheader', { name: /age/ });
  });

  it('refuses a name the table has', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add column' });
    await userEvent.type(within(dialog).getByLabelText('Column name'), 'age');
    expect(within(dialog).getByText(DATA_TABLE_ERRORS.columnNameExists('age', 'Leads'))).toBeTruthy();
  });

  it('shows the n8n toast when adding a column fails', async () => {
    await open();
    vi.spyOn(dataTablesApi, 'addColumn').mockRejectedValue(new Error('nope'));
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add column' });
    await userEvent.type(within(dialog).getByLabelText('Column name'), 'city');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(toastTitles()).toContain('Error adding column'));
  });

  it('renames from the header menu and keeps the rows', async () => {
    await open();
    const user = userEvent.setup();
    await cell('Ann');
    await columnMenu('name', 'Rename column');
    const dialog = await screen.findByRole('dialog', { name: 'Rename column' });
    const input = within(dialog).getByLabelText('Column name');
    await user.clear(input);
    await user.type(input, 'fullName');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('columnheader', { name: /fullName/ });
    expect(await cell('Ann')).toBeTruthy();
  });

  it('deletes after a confirm, and shows the n8n toast on failure', async () => {
    const { table } = await open();
    const user = userEvent.setup();
    await cell('Ann');
    const fail = vi.spyOn(dataTablesApi, 'removeColumn').mockRejectedValueOnce(new Error('nope'));
    await columnMenu('age', 'Delete column');
    let confirm = await screen.findByRole('dialog', { name: 'Delete column' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => expect(toastTitles()).toContain('Error deleting column'));

    fail.mockRestore();
    await columnMenu('age', 'Delete column');
    confirm = await screen.findByRole('dialog', { name: 'Delete column' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /^age/ })).toBeNull());
    expect((await dataTablesApi.columns(table.id)).map((c) => c.name)).toEqual(['name', 'active', 'joined']);
  });

  it('moves by menu and by drag, and shows the n8n toast on failure', async () => {
    await open();
    await cell('Ann');
    expect(headers()).toEqual(['id', 'name', 'age', 'active', 'joined', 'createdAt', 'updatedAt']);
    await columnMenu('name', 'Move right');
    await waitFor(() => expect(headers().slice(1, 3)).toEqual(['age', 'name']));

    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const from = screen.getByRole('columnheader', { name: /^joined/ });
    const to = screen.getByRole('columnheader', { name: /^age/ });
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    await waitFor(() => expect(headers().slice(1, 5)).toEqual(['joined', 'age', 'name', 'active']));

    vi.spyOn(dataTablesApi, 'moveColumn').mockRejectedValue(new Error('nope'));
    await columnMenu('joined', 'Move right');
    await waitFor(() => expect(toastTitles()).toContain('Error moving column'));
  });

  it('the first and last column cannot move further', async () => {
    await open();
    await cell('Ann');
    await userEvent.click(screen.getByRole('button', { name: 'Column menu for name' }));
    expect(((await screen.findByRole('menuitem', { name: 'Move left' })) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('menuitem', { name: 'Move right' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a system column can be sorted and filtered, not changed', async () => {
    await open();
    await cell('Ann');
    await userEvent.click(screen.getByRole('button', { name: 'Column menu for id' }));
    expect(await screen.findByRole('menuitem', { name: 'Sort descending' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Filter' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete column' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sort descending' }));
    await waitFor(() => expect(firstColumn()).toEqual(['Bob', 'Ann']));
  });
});

describe('sort, filter and search', () => {
  it('sorts from the header menu and marks the column', async () => {
    await open();
    await cell('Ann');
    await columnMenu('age', 'Sort descending');
    await waitFor(() => expect(firstColumn()).toEqual(['Bob', 'Ann']));
    expect(screen.getByRole('columnheader', { name: /^age/ }).getAttribute('aria-sort')).toBe('descending');
    await columnMenu('age', 'Clear sort');
    await waitFor(() => expect(firstColumn()).toEqual(['Ann', 'Bob']));
    expect(screen.getByRole('columnheader', { name: /^age/ }).getAttribute('aria-sort')).toBe('none');
  });

  it('text: contains, equals, is empty, and a chip removes the filter', async () => {
    await open([ANN, BOB, { name: '', age: 1 }, { age: 2 }]);
    await cell('Ann');
    await applyFilter('name', 'contains', { Value: 'AN' });
    await waitFor(() => expect(firstColumn()).toEqual(['Ann']));
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter on name' }));
    await waitFor(() => expect(firstColumn()).toHaveLength(4));

    await applyFilter('name', 'equals', { Value: 'Bob' });
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));
    await applyFilter('name', 'isEmpty');
    await waitFor(() => expect(firstColumn()).toEqual(['Empty', 'Null']));
    await applyFilter('name', 'isNull');
    await waitFor(() => expect(firstColumn()).toEqual(['Null']));
  });

  it('number: comparisons, between and a check of the value', async () => {
    await open([ANN, BOB, { name: 'Cy', age: 50 }]);
    await cell('Ann');
    await applyFilter('age', 'gt', { Value: '30' });
    await waitFor(() => expect(firstColumn()).toEqual(['Bob', 'Cy']));
    await applyFilter('age', 'between', { From: '31', To: '45' });
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));

    await columnMenu('age', 'Filter');
    const dialog = await screen.findByRole('dialog', { name: 'Filter age' });
    fireEvent.change(within(dialog).getByLabelText('Condition'), { target: { value: 'equals' } });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'old' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(within(dialog).getByText('Enter a number')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(firstColumn()).toHaveLength(3));
  });

  it('boolean: true, false, null', async () => {
    await open([ANN, BOB, { name: 'Cy' }]);
    await cell('Ann');
    await applyFilter('active', 'true');
    await waitFor(() => expect(firstColumn()).toEqual(['Ann']));
    await applyFilter('active', 'false');
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));
    await applyFilter('active', 'isNull');
    await waitFor(() => expect(firstColumn()).toEqual(['Cy']));
  });

  it('date: before, after, between in UTC', async () => {
    await open();
    await cell('Ann');
    await applyFilter('joined', 'lt', { Value: '2026-02-01T00:00:00' });
    await waitFor(() => expect(firstColumn()).toEqual(['Ann']));
    await applyFilter('joined', 'gte', { Value: '2026-02-01T00:00:00' });
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));
    await applyFilter('joined', 'between', { From: '2026-01-01T00:00:00', To: '2026-04-01T00:00:00' });
    await waitFor(() => expect(firstColumn()).toEqual(['Ann', 'Bob']));
    const last = backend()
      .requests.filter((r) => r.path.endsWith('/rows') && r.method === 'GET')
      .at(-1);
    expect(String(last?.query?.filter)).toContain('2026-01-01T00:00:00.000Z');
  });

  it('a filter on a column goes when the column goes', async () => {
    await open();
    await cell('Ann');
    await applyFilter('age', 'gt', { Value: '30' });
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));
    await columnMenu('age', 'Delete column');
    const confirm = await screen.findByRole('dialog', { name: 'Delete column' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => expect(firstColumn()).toEqual(['Ann', 'Bob']));
    expect(toastTitles()).not.toContain('Error fetching data table content');
  });

  it('searches across columns and says dates use UTC', async () => {
    await open();
    await cell('Ann');
    expect(screen.getByText('Date searches use UTC format')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search rows'), 'bob');
    await waitFor(() => expect(firstColumn()).toEqual(['Bob']));
    await userEvent.clear(screen.getByLabelText('Search rows'));
    await userEvent.type(screen.getByLabelText('Search rows'), 'zzz');
    expect(await screen.findByText('No rows')).toBeTruthy();
  });
});

describe('viewers', () => {
  it('see the rows but no way to change them', async () => {
    const table = await dataTablesApi.create({ name: 'Leads', columns: COLUMNS });
    await dataTablesApi.insertRows(table.id, [ANN], 'count');
    backend().setDemoRole('viewer');
    renderApp(`/data-tables/${table.id}`);
    const ann = await cell('Ann');
    await userEvent.click(ann);
    expect(screen.queryByLabelText('Edit name of row 1')).toBeNull();
    fireEvent.keyDown(ann, { key: 'Enter' });
    expect(screen.queryByLabelText('Edit name of row 1')).toBeNull();
    for (const name of ['Add row', 'Add column']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('checkbox', { name: 'Select row 1' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Column menu for name' }));
    expect(await screen.findByRole('menuitem', { name: 'Sort ascending' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move right' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /^name/ }).getAttribute('draggable')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Leads' }));
    expect(await screen.findByRole('menuitem', { name: 'Download CSV' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});
