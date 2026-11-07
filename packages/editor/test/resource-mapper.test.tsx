/** P5-80: the resource mapper control, on the demo node `demo.resourceMapper` and its mock backend. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceMapperValue } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeTypesApi } from '../src/api/endpoints';
import { fixedFromExpression } from '../src/components/parameters/resource-mapper/FieldRow';
import { sameSync } from '../src/components/parameters/resource-mapper/useMapperFields';
import { demoNodeTypes } from '../src/demo/fixtures';
import { buildFromAiOverride } from '../src/lib/from-ai-override';
import { signedIn } from './backend';
import { renderParameters } from './utils';

const mapper = demoNodeTypes.find((d) => d.name === 'demo.resourceMapper')!;

/** the demo node with every displayed field a row (`addAllFields` not false) and no type conversion switches */
const showAllMapper = {
  ...mapper,
  properties: mapper.properties.map((p) =>
    p.name === 'columns'
      ? {
          ...p,
          typeOptions: {
            ...p.typeOptions,
            resourceMapper: {
              ...p.typeOptions!.resourceMapper!,
              addAllFields: true,
              showTypeConversionOptions: false,
            },
          },
        }
      : p,
  ),
};

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
    await waitFor(() =>
      expect(stored(node).schema.map((f) => f.id)).toEqual(['email', 'name', 'age', 'active', 'notes']),
    );
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
          {
            id: 'name',
            displayName: 'Name',
            required: false,
            defaultMatch: false,
            display: true,
            removed: true,
          },
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

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Mapping column mode' }),
      'autoMapInputData',
    );
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

  it('read only shows the stored values and fields, loads nothing and shows no error', async () => {
    const load = vi.spyOn(nodeTypesApi, 'resourceMapping');
    renderParameters(mapper, {
      readOnly: true,
      parameters: initial('contacts', {
        value: { email: 'x@y.z' },
        schema: [{ id: 'email', displayName: 'Email', required: true, defaultMatch: true, display: true }],
      }),
    });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText('Could not load columns')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh columns' })).toHaveProperty('disabled', true);
    load.mockRestore();
    expect(within(rowOf('email')!).getByRole('textbox')).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('button', { name: 'Remove Email' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Add column' })).toBeNull();
  });

  it('shows every displayed field as a row when addAllFields is not false', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(showAllMapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    for (const id of ['name', 'age', 'active']) expect(rowOf(id)).toBeTruthy();
    expect(rowOf('notes')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Add column' })).toBeNull();
    // an empty row sends nothing
    expect(stored(node).value ?? {}).toEqual({});
    // a removed field leaves the rows and can come back
    await user.click(screen.getByRole('button', { name: 'Remove Name' }));
    await waitFor(() => expect(rowOf('name')).toBeNull());
    const removed = document.querySelector('[data-mapper-removed]') as HTMLElement;
    await user.click(within(removed).getByRole('button', { name: 'Restore Name' }));
    await waitFor(() => expect(rowOf('name')).toBeTruthy());
  });

  it('shows the type conversion switches only for a node that asks for them', async () => {
    renderParameters(showAllMapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    expect(screen.queryByRole('switch', { name: 'Attempt to convert types' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Convert all fields to string' })).toBeNull();
  });

  it('the expression toggle keeps the type of the value', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(showAllMapper, {
      parameters: initial('contacts', { value: { active: true, age: 5, name: '={{ $json.n }}' } }),
    });
    await waitFor(() => expect(rowOf('active')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Use an expression for Active' }));
    await waitFor(() => expect(stored(node).value?.active).toBe('=true'));
    await user.click(screen.getByRole('button', { name: 'Use a fixed value for Active' }));
    await waitFor(() => expect(stored(node).value?.active).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Use an expression for Age' }));
    await user.click(screen.getByRole('button', { name: 'Use a fixed value for Age' }));
    await waitFor(() => expect(stored(node).value?.age).toBe(5));

    // an expression that holds {{ }} does not become literal field text
    await user.click(screen.getByRole('button', { name: 'Use a fixed value for Name' }));
    await waitFor(() => expect(stored(node).value?.name).toBe(''));
  });

  it('has no expression toggle while the model defines the field', async () => {
    renderParameters(showAllMapper, {
      parameters: initial('contacts', {
        value: { name: buildFromAiOverride({ key: 'columns_value_name', description: '', type: 'string' }) },
      }),
    });
    await waitFor(() => expect(rowOf('name')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Defined by agent' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /expression for Name|fixed value for Name/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use an expression for Email' })).toBeTruthy();
  });

  it('shows the loading state while a refresh runs', async () => {
    const user = userEvent.setup();
    renderParameters(mapper, { parameters: initial('contacts') });
    await waitFor(() => expect(rowOf('email')).toBeTruthy());
    expect(screen.queryByText('Loading columns…')).toBeNull();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = nodeTypesApi.resourceMapping.bind(nodeTypesApi);
    const slow = vi.spyOn(nodeTypesApi, 'resourceMapping').mockImplementation(async (body) => {
      await gate;
      return real(body);
    });
    await user.click(screen.getByRole('button', { name: 'Refresh columns' }));
    expect(await screen.findByText('Loading columns…')).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByText('Loading columns…')).toBeNull());
    slow.mockRestore();
  });
});

describe('mapper helpers', () => {
  const field = (type: 'boolean' | 'number' | 'string' | 'object' | 'array') => ({
    id: 'f',
    displayName: 'F',
    required: false,
    defaultMatch: false,
    display: true,
    type,
  });
  const base = (schema: ResourceMapperValue['schema']): ResourceMapperValue => ({
    mappingMode: 'defineBelow',
    value: { a: 1, b: 2 },
    matchingColumns: [],
    schema,
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  });

  it('sameSync does not depend on the key order of a field or of the values', () => {
    const one = {
      id: 'x',
      displayName: 'X',
      required: false,
      defaultMatch: false,
      display: true,
      type: 'string' as const,
    };
    const reordered = {
      type: 'string' as const,
      display: true,
      defaultMatch: false,
      required: false,
      displayName: 'X',
      id: 'x',
    };
    expect(sameSync(base([one]), { ...base([reordered]), value: { b: 2, a: 1 } })).toBe(true);
    expect(sameSync(base([one]), base([{ ...one, required: true }]))).toBe(false);
    expect(sameSync(base([one, { ...one, id: 'y' }]), base([{ ...one, id: 'y' }, one]))).toBe(false);
  });

  it('an expression goes back to a value of the field type', () => {
    expect(fixedFromExpression(field('boolean'), '=true')).toBe(true);
    expect(fixedFromExpression(field('boolean'), '={{ $json.x }}')).toBe(false);
    expect(fixedFromExpression(field('number'), '=12')).toBe(12);
    expect(fixedFromExpression(field('string'), '=abc')).toBe('abc');
    expect(fixedFromExpression(field('string'), '={{ $json.x }}')).toBe('');
    expect(fixedFromExpression(field('object'), '={"a":1}')).toEqual({ a: 1 });
    expect(fixedFromExpression(field('array'), '=[1,2]')).toEqual([1, 2]);
  });
});
