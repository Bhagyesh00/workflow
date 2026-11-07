/** P5-80: the resource mapper control, on the demo node `demo.resourceMapper` and its mock backend. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceMapperValue } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import { signedIn } from './backend';
import { renderParameters } from './utils';

const mapper = demoNodeTypes.find((d) => d.name === 'demo.resourceMapper')!;

const initial = (table: string, extra: Partial<ResourceMapperValue> = {}) => ({
  table,
  columns: {
    mappingMode: 'defineBelow',
    value: null,
    matchingColumns: [],
    schema: [],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
    ...extra,
  },
});

const stored = (node: { current: { parameters: Record<string, unknown> } }) =>
  node.current.parameters.columns as ResourceMapperValue;

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-mapper-field="${id}"]`);

describe('resource mapper control', () => {
  beforeEach(() => {
    signedIn();
  });

  it('shows the fields of the loaded schema, required first, and hides display false', async () => {
    const { node } = renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    expect(rowOf('notes')).toBeNull();
    expect(rowOf('name')).toBeNull();
    // the schema is saved with the value, the default match column chosen
    await waitFor(() => expect(stored(node).schema.map((f) => f.id)).toEqual(['email', 'name', 'age', 'active', 'notes']));
    expect(stored(node).matchingColumns).toEqual(['email']);
    expect(screen.getByRole('group', { name: 'Columns to match on' })).toBeTruthy();
  });

  it('follows the schema when the table changes', async () => {
    const user = userEvent.setup();
    renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Table' }), 'Deals');
    await waitFor(() => expect(rowOf('title')).toBeTruthy());
    expect(rowOf('email')).toBeNull();
    // a read only match column is shown but cannot be typed into
    expect(within(rowOf('id')!).getByRole('spinbutton')).toHaveProperty('readOnly', true);
  });

  it('saves typed values, an optional field added, and an expression', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    await user.type(within(rowOf('email')!).getByRole('textbox'), 'a@b.co');
    await waitFor(() => expect(stored(node).value).toEqual({ email: 'a@b.co' }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add column' }), 'Age');
    await waitFor(() => expect(rowOf('age')).toBeTruthy());
    await user.type(within(rowOf('age')!).getByRole('spinbutton'), '42');
    await waitFor(() => expect(stored(node).value).toEqual({ email: 'a@b.co', age: 42 }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add column' }), 'Active');
    await user.click(await screen.findByRole('switch', { name: 'Active' }));
    await waitFor(() => expect(stored(node).value?.active).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Use an expression for Email' }));
    await waitFor(() => expect(stored(node).value?.email).toBe('=a@b.co'));
  });

  it('keeps a removed field in the schema as removed and shows it', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add column' }), 'Name');
    await user.type(within(await waitFor(() => rowOf('name')!)).getByRole('textbox'), 'Ann');
    await user.click(screen.getByRole('button', { name: 'Remove Name' }));
    await waitFor(() => expect(rowOf('name')).toBeNull());
    const value = stored(node);
    expect(value.value).not.toHaveProperty('name');
    expect(value.schema.find((f) => f.id === 'name')).toMatchObject({ removed: true });
    const removed = document.querySelector('[data-mapper-removed]')!;
    expect(within(removed as HTMLElement).getByText('Name')).toBeTruthy();
    // it stays removed after a reload of the same schema, and can be restored
    await user.click(within(removed as HTMLElement).getByRole('button', { name: 'Restore Name' }));
    await waitFor(() => expect(rowOf('name')).toBeTruthy());
    expect(stored(node).schema.find((f) => f.id === 'name')?.removed).toBeUndefined();
  });

  it('a stored removed field is not shown as a row after load', async () => {
    const { node } = renderParameters(mapper, {
      parameters: initial('contacts', {
        schema: [
          { id: 'email', displayName: 'Email', required: true, defaultMatch: true, display: true },
          { id: 'name', displayName: 'Name', required: false, defaultMatch: false, display: true, removed: true },
        ],
        matchingColumns: ['email'],
      }),
    });
    await waitFor(() => expect(document.querySelector('[data-mapper-removed]')).toBeTruthy());
    expect(rowOf('name')).toBeNull();
    expect(stored(node).schema.find((f) => f.id === 'name')?.removed).toBe(true);
  });

  it('matching columns can be changed and auto map hides the rows', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(stored(node).matchingColumns).toEqual(['email']));
    await user.click(screen.getByRole('checkbox', { name: 'Name' }));
    await waitFor(() => expect(stored(node).matchingColumns).toEqual(['email', 'name']));
    await user.click(screen.getByRole('checkbox', { name: 'Name' }));
    await waitFor(() => expect(stored(node).matchingColumns).toEqual(['email']));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Mapping column mode' }), 'autoMapInputData');
    await waitFor(() => expect(stored(node).mappingMode).toBe('autoMapInputData'));
    expect(rowOf('email')).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Attempt to convert types' }));
    await waitFor(() => expect(stored(node).attemptToConvertTypes).toBe(true));
  });

  it('adds every column at once', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Add all columns' }));
    await waitFor(() => expect(rowOf('active')).toBeTruthy());
    expect(Object.keys(stored(node).value ?? {}).sort()).toEqual(['active', 'age', 'email', 'name']);
  });

  it('shows the no fields message for a table without columns', async () => {
    renderParameters(mapper, { parameters: initial('empty') });
    expect(await screen.findByText('This table has no columns')).toBeTruthy();
    expect(screen.getByText('This table has no columns yet')).toBeTruthy();
  });

  it('read only shows the values and offers no change', async () => {
    renderParameters(mapper, {
      readOnly: true,
      parameters: initial('contacts', { value: { email: 'x@y.z' } }),
    });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    expect(within(rowOf('email')!).getByRole('textbox')).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('button', { name: 'Remove Email' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Add column' })).toBeNull();
  });
});
