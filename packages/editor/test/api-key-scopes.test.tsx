/** P4-18: the scope picker of the API key form. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyScopesField } from '../src/components/settings/ApiKeyScopesField';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

function Harness({ initial = [] as string[], onChange = vi.fn() }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ApiKeyScopesField
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('ApiKeyScopesField', () => {
  it('starts on all scopes with the list hidden', () => {
    render(<Harness />);
    expect((screen.getByRole('radio', { name: 'All scopes' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('group', { name: 'Data tables' })).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('[]');
  });

  it('picks single scopes and a whole resource, in the server order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Only the scopes I pick' }));
    expect(screen.getByTestId('scope-summary').textContent).toMatch(/Nothing picked yet/);
    await user.click(screen.getByRole('checkbox', { name: 'workflow:read' }));
    expect(onChange).toHaveBeenLastCalledWith(['workflow:read']);
    await user.click(screen.getByRole('checkbox', { name: 'All data table rows scopes' }));
    expect(JSON.parse(screen.getByTestId('value').textContent ?? '')).toEqual([
      'workflow:read',
      'dataTableRow:read',
      'dataTableRow:create',
      'dataTableRow:update',
      'dataTableRow:upsert',
      'dataTableRow:delete',
    ]);
    expect(screen.getByTestId('scope-summary').textContent).toMatch(/6 scopes picked/);
    const group = screen.getByRole('group', { name: 'Data table rows' });
    await user.click(within(group).getByRole('checkbox', { name: 'dataTableRow:upsert' }));
    expect((screen.getByRole('checkbox', { name: 'All data table rows scopes' }) as HTMLInputElement).indeterminate).toBe(
      true,
    );
    await user.click(screen.getByRole('checkbox', { name: 'All data table rows scopes' }));
    await user.click(screen.getByRole('checkbox', { name: 'All data table rows scopes' }));
    expect(JSON.parse(screen.getByTestId('value').textContent ?? '')).toEqual(['workflow:read']);
  });

  it('opens on the picked scopes and clears them when switched back to all', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['tag:list']} />);
    expect((screen.getByRole('checkbox', { name: 'tag:list' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'All scopes' }));
    expect(screen.getByTestId('value').textContent).toBe('[]');
  });

  it('is locked while disabled', () => {
    render(<ApiKeyScopesField value={['tag:list']} onChange={vi.fn()} disabled />);
    expect((screen.getByRole('radio', { name: 'All scopes' }) as HTMLInputElement).matches(':disabled')).toBe(true);
  });
});

describe('API key form', () => {
  it('sends the picked scopes and starts over after saving', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/api-keys');
    await user.type(await screen.findByLabelText('New key name', {}, { timeout: 5000 }), 'CI');
    await user.click(screen.getByRole('radio', { name: 'Only the scopes I pick' }));
    await user.click(screen.getByRole('checkbox', { name: 'dataTable:list' }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByTestId('new-api-key');
    const post = backend().requests.find((r) => r.method === 'POST' && r.path === '/api-keys');
    expect(post?.body).toEqual({ name: 'CI', scopes: ['dataTable:list'] });
  });
});
