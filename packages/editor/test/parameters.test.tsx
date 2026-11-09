import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeTypeDescription } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoNodeTypes, kitchenSink } from '../src/demo/fixtures';
import { useProjectStore } from '../src/stores/project-store';
import { signedIn } from './backend';
import { renderParameters, runDataFor } from './utils';

/** P6-43: option calls name the saved workflow, else a project: the setup works in the default project */
function signedInInProject() {
  const demo = signedIn();
  useProjectStore.getState().setCurrentProject(demo.defaultProjectFor(demo.auth().tenant.id).id);
  return demo;
}

const crm = demoNodeTypes.find((d) => d.name === 'app.crm')!;

function field(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-parameter="${name}"]`);
  if (!el) throw new Error(`parameter ${name} is not rendered`);
  return el;
}

const isShown = (name: string) => Boolean(document.querySelector(`[data-parameter="${name}"]`));

describe('parameter form renders every property type', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('renders an input for each type', async () => {
    renderParameters(kitchenSink);
    // string, multi-row string, password
    expect(within(field('text')).getByRole('textbox')).toHaveProperty('value', 'hello');
    expect(field('longText').querySelector('textarea')?.getAttribute('rows')).toBe('4');
    expect(field('secret').querySelector('input')?.getAttribute('type')).toBe('password');
    // number with min/max
    const count = within(field('count')).getByRole('spinbutton') as HTMLInputElement;
    expect(count.min).toBe('1');
    expect(count.max).toBe('10');
    // boolean
    expect(within(field('enabled')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    // options and multi options
    expect(within(field('choice')).getByRole('combobox')).toBeTruthy();
    expect(within(field('tags')).getByRole('button', { name: 'Tags' })).toBeTruthy();
    // collection and fixedCollection
    expect(within(field('extras')).getByRole('button', { name: /add extra/i })).toBeTruthy();
    expect(within(field('headers')).getByRole('button', { name: /add header/i })).toBeTruthy();
    // json and code use CodeMirror
    expect(field('payload').querySelector('[data-testid="code-editor-json"]')).toBeTruthy();
    expect(field('script').querySelector('[data-testid="code-editor-javascript"]')).toBeTruthy();
    // color, dateTime
    expect(field('colour').querySelector('input[type="color"]')).toBeTruthy();
    expect(field('when').querySelector('input[type="datetime-local"]')).toBeTruthy();
    // notice is plain text, hidden is not rendered
    expect(screen.getByText('Read the docs before changing this node.')).toBeTruthy();
    expect(isShown('internal')).toBe(false);
    // credentialsSelect lists credential types
    await waitFor(() =>
      expect(within(field('authType')).getByRole('option', { name: 'Basic Auth' })).toBeTruthy(),
    );
    // resource locator: mode select plus value
    expect(within(field('record')).getByRole('combobox', { name: /record mode/i })).toBeTruthy();
    // filter and assignment editors
    expect(field('conditions').querySelector('[data-testid="filter-condition"]')).toBeTruthy();
    expect(within(field('fields')).getByRole('button', { name: /add field/i })).toBeTruthy();
    // button
    expect(screen.getByRole('button', { name: 'Fetch sample' })).toBeTruthy();
    // options loaded from the server (loadOptionsMethod)
    await waitFor(() =>
      expect(within(field('dynamic')).getByRole('option', { name: 'Renewals' })).toBeTruthy(),
    );
  });

  it('writes typed values back', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    await user.clear(within(field('text')).getByRole('textbox'));
    await user.type(within(field('text')).getByRole('textbox'), 'abc');
    expect(node.current.parameters.text).toBe('abc');

    fireEvent.change(within(field('count')).getByRole('spinbutton'), { target: { value: '7' } });
    expect(node.current.parameters.count).toBe(7);

    await user.click(within(field('enabled')).getByRole('switch'));
    expect(node.current.parameters.enabled).toBe(true);

    await user.click(within(field('tags')).getByRole('button', { name: 'Tags' }));
    await user.click(screen.getByRole('option', { name: /blue/i }));
    expect(node.current.parameters.tags).toEqual(['blue']);

    fireEvent.change(field('colour').querySelectorAll('input')[1], { target: { value: '#112233' } });
    expect(node.current.parameters.colour).toBe('#112233');
  });

  it('typing {{ in a string turns it into an expression', async () => {
    const { node } = renderParameters(kitchenSink);
    fireEvent.change(within(field('text')).getByRole('textbox'), {
      target: { value: 'Hi {{ $json.name }}' },
    });
    expect(node.current.parameters.text).toBe('=Hi {{ $json.name }}');
  });

  it('a pasted expression that already starts with = keeps one =', async () => {
    const { node } = renderParameters(kitchenSink);
    fireEvent.change(within(field('text')).getByRole('textbox'), {
      target: { value: '={{ $json.name }}' },
    });
    expect(node.current.parameters.text).toBe('={{ $json.name }}');
  });
});

describe('display options', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('shows and hides parameters by sibling values', async () => {
    const user = userEvent.setup();
    renderParameters(kitchenSink);
    expect(isShown('onlyB')).toBe(false);
    expect(isShown('notB')).toBe(true);
    await user.selectOptions(within(field('choice')).getByRole('combobox'), 'Option B');
    expect(isShown('onlyB')).toBe(true);
    expect(isShown('notB')).toBe(false);
  });

  it('matches @version against the node version', () => {
    renderParameters(kitchenSink, { typeVersion: 1 });
    expect(isShown('v2Only')).toBe(false);
  });

  it('shows @version parameters for matching versions', () => {
    renderParameters(kitchenSink, { typeVersion: 2 });
    expect(isShown('v2Only')).toBe(true);
  });

  it('resolves /root paths inside collections', async () => {
    const user = userEvent.setup();
    renderParameters(kitchenSink, { parameters: { choice: 'a' } });
    await user.click(within(field('extras')).getByRole('button', { name: /add extra/i }));
    expect(screen.queryByRole('menuitem', { name: 'Shown with root choice B' })).toBeNull();
    await user.keyboard('{Escape}');
  });

  it('offers root-dependent collection options when the root value matches', async () => {
    const user = userEvent.setup();
    renderParameters(kitchenSink, { parameters: { choice: 'b' } });
    await user.click(within(field('extras')).getByRole('button', { name: /add extra/i }));
    expect(screen.getByRole('menuitem', { name: 'Shown with root choice B' })).toBeTruthy();
  });

  it('switches operation lists by resource', async () => {
    const user = userEvent.setup();
    renderParameters(crm);
    const operation = () => within(field('operation')).getByRole('combobox');
    expect(
      within(operation())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Get', 'Create']);
    await user.selectOptions(within(field('resource')).getByRole('combobox'), 'Deal');
    await waitFor(() =>
      expect(
        within(operation())
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toContain('Create'),
    );
    expect(isShown('pipeline')).toBe(true);
    expect(isShown('contactId')).toBe(false);
  });
});

describe('collections', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('adds and removes collection options', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    await user.click(within(field('extras')).getByRole('button', { name: /add extra/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Retries' }));
    expect(node.current.parameters.extras).toEqual({ retries: 2 });
    await user.click(screen.getByRole('button', { name: 'Remove Retries' }));
    expect(node.current.parameters.extras).toEqual({});
  });

  it('adds, reorders and removes fixed collection entries', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    await user.click(within(field('headers')).getByRole('button', { name: /add header/i }));
    await user.click(within(field('headers')).getByRole('button', { name: /add header/i }));
    const entries = () => document.querySelectorAll('[data-testid="fixed-collection-entry-values"]');
    expect(entries()).toHaveLength(2);
    fireEvent.change(within(entries()[0] as HTMLElement).getAllByRole('textbox')[0], {
      target: { value: 'X-First' },
    });
    fireEvent.change(within(entries()[1] as HTMLElement).getAllByRole('textbox')[0], {
      target: { value: 'X-Second' },
    });
    await user.click(screen.getByRole('button', { name: 'Move Header 2 up' }));
    const values = (node.current.parameters.headers as { values: Array<{ name: string }> }).values;
    expect(values.map((v) => v.name)).toEqual(['X-Second', 'X-First']);
    await user.click(screen.getByRole('button', { name: 'Remove Header 1' }));
    expect((node.current.parameters.headers as { values: unknown[] }).values).toHaveLength(1);
  });
});

describe('expressions', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('toggles between fixed and expression and keeps the value', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    await user.click(within(field('text')).getByRole('button', { name: 'Expression' }));
    expect(node.current.parameters.text).toBe('=hello');
    expect(field('text').querySelector('[data-testid="code-editor-expression"]')).toBeTruthy();
    await user.click(within(field('text')).getByRole('button', { name: 'Fixed' }));
    expect(node.current.parameters.text).toBe('hello');
  });

  it('converts numbers back when leaving expression mode', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink, { parameters: { count: '=5' } });
    await user.click(within(field('count')).getByRole('button', { name: 'Fixed' }));
    expect(node.current.parameters.count).toBe(5);
  });

  it('previews the result against the latest run data', async () => {
    renderParameters(kitchenSink, {
      parameters: { text: '=Hello {{ $json.name.toUpperCase() }}' },
      runData: runDataFor('Source', [{ name: 'ada' }]),
    });
    await waitFor(() =>
      expect(within(field('text')).getByTestId('expression-preview').textContent).toContain('Hello ADA'),
    );
  });

  it('shows evaluation errors in the preview', async () => {
    renderParameters(kitchenSink, { parameters: { text: "={{ $('Nope').item.json.x }}" } });
    await waitFor(() =>
      expect(within(field('text')).getByTestId('expression-preview').textContent).toMatch(/Error.*Nope/),
    );
  });

  it('does not offer expressions for noDataExpression parameters', () => {
    renderParameters(crm);
    expect(within(field('resource')).queryByRole('button', { name: 'Expression' })).toBeNull();
  });

  it('dropping a field inserts an expression', () => {
    const { node } = renderParameters(kitchenSink);
    const dataTransfer = {
      types: ['application/x-wf-expression'],
      getData: (type: string) => (type === 'application/x-wf-expression' ? '{{ $json.email }}' : ''),
    };
    fireEvent.dragOver(field('text'), { dataTransfer });
    fireEvent.drop(field('text'), { dataTransfer });
    expect(node.current.parameters.text).toBe('={{ $json.email }}');
  });
});

describe('filter editor', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('edits conditions, hides the right value for single-value operators and toggles the combinator', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    const filter = () =>
      node.current.parameters.conditions as {
        conditions: Array<Record<string, unknown>>;
        combinator: string;
      };
    fireEvent.change(screen.getByRole('textbox', { name: 'Condition 1 value 1' }), {
      target: { value: 'status' },
    });
    expect(filter().conditions[0].leftValue).toBe('status');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 operator' }), 'is empty');
    expect(filter().conditions[0].operator).toEqual({
      type: 'string',
      operation: 'empty',
      singleValue: true,
    });
    expect(screen.queryByRole('textbox', { name: 'Condition 1 value 2' })).toBeNull();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Condition 1 operator' }),
      'is greater than',
    );
    expect(screen.getByRole('textbox', { name: 'Condition 1 value 2' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(filter().conditions).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /combine conditions with or/i }));
    expect(filter().combinator).toBe('or');
    await user.click(screen.getByRole('button', { name: 'Remove condition 2' }));
    expect(filter().conditions).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: 'Case sensitive' }));
    expect(
      (node.current.parameters.conditions as { options: { caseSensitive: boolean } }).options.caseSensitive,
    ).toBe(false);
  });
});

describe('assignment editor', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('adds rows with name, type and value', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(kitchenSink);
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 name' }), { target: { value: 'total' } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field 1 type' }), 'Number');
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 value' }), {
      target: { value: '{{ $json.a + 1 }}' },
    });
    const [row] = (node.current.parameters.fields as { assignments: Array<Record<string, unknown>> })
      .assignments;
    expect(row).toMatchObject({ name: 'total', type: 'number', value: '={{ $json.a + 1 }}' });
  });

  it('maps a dropped input field to a new row', () => {
    const { node } = renderParameters(kitchenSink);
    const dataTransfer = {
      types: ['application/x-wf-expression'],
      getData: () => '{{ $json.customer.email }}',
    };
    const zone = screen.getByRole('region', { name: 'Fields' });
    fireEvent.dragOver(zone, { dataTransfer });
    fireEvent.drop(zone, { dataTransfer });
    const [row] = (node.current.parameters.fields as { assignments: Array<Record<string, unknown>> })
      .assignments;
    expect(row).toMatchObject({ name: 'email', value: '={{ $json.customer.email }}' });
  });
});

describe('dynamic options', () => {
  beforeEach(() => {
    signedInInProject();
  });

  it('reloads options when a loadOptionsDependsOn value changes', async () => {
    const user = userEvent.setup();
    const deal: NodeTypeDescription = crm;
    renderParameters(deal, { parameters: { resource: 'deal', operation: 'create', pipeline: 'new' } });
    const stage = () => within(field('stage')).getByRole('combobox');
    await waitFor(() => expect(within(stage()).getByRole('option', { name: 'Qualified' })).toBeTruthy());
    await user.selectOptions(within(field('pipeline')).getByRole('combobox'), 'Renewals');
    await waitFor(() => expect(within(stage()).getByRole('option', { name: 'Renewed' })).toBeTruthy());
  });

  it('searches resource locator lists with pagination', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(crm, { parameters: { resource: 'contact', operation: 'get' } });
    await user.click(within(field('contactId')).getByRole('button', { name: /^Contact\*?$/ }));
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(10));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(20));
    await user.type(screen.getByRole('textbox', { name: 'Search resources' }), 'theo');
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .getAllByRole('option')
          .every((o) => /Theo/.test(o.textContent ?? '')),
      ).toBe(true),
    );
    await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[0]);
    expect(node.current.parameters.contactId).toMatchObject({
      __rl: true,
      mode: 'list',
      value: 'c_101',
      cachedResultName: 'Theo Lindqvist',
    });
  });

  it('resource locator id mode accepts expressions', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(crm, { parameters: { resource: 'contact', operation: 'get' } });
    await user.selectOptions(
      within(field('contactId')).getByRole('combobox', { name: 'Contact mode' }),
      'By ID',
    );
    fireEvent.change(within(field('contactId')).getByRole('textbox'), {
      target: { value: '{{ $json.id }}' },
    });
    expect(node.current.parameters.contactId).toMatchObject({
      __rl: true,
      mode: 'id',
      value: '={{ $json.id }}',
    });
  });
});
