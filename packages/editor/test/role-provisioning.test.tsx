/**
 * P6-11 (L9): Settings > Authentication > Provisioning. The panel saves the role source (manual, workspace,
 * workspace and project; claims or rules), confirms with a CSV of current access, lists, adds, edits, moves and
 * deletes rules (the demo answers the server's texts), removes the project rules when project roles stop coming
 * from the provider, and shows a member nothing. The CSV quotes cells that start a formula.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { csvCell, loadAccessRows, toCsv } from '../src/components/sso/AccessCsvButton';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

/** user-event's `type` reads `{{` as an escape, so a template is pasted */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

const RULES = {
  scopesProvisionInstanceRole: true,
  scopesProvisionProjectRoles: false,
  scopesUseExpressionMapping: true,
};

describe('CSV of current access', () => {
  it('quotes a cell that starts with =, +, - or @ and escapes commas and quotes', () => {
    for (const lead of ['=', '+', '-', '@']) {
      expect(csvCell(`${lead}cmd|calc`)).toBe(`'${lead}cmd|calc`);
    }
    expect(csvCell('Doe, Jane')).toBe('"Doe, Jane"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(
      toCsv([
        ['a', '=b'],
        ['c', 'd,e'],
      ]),
    ).toBe('a,\'=b\r\nc,"d,e"\r\n');
  });

  it('lists every member with the workspace role', async () => {
    signedIn();
    const rows = await loadAccessRows();
    expect(rows[0]).toEqual(['Email', 'Name', 'Workspace role', 'Project', 'Project role']);
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe('Role provisioning panel', () => {
  it('starts manual and saves workspace roles from claims after a confirm that offers the CSV', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/provisioning');
    expect(await screen.findByRole('heading', { name: 'Role provisioning', level: 2 }, T)).toBeTruthy();
    const assign = screen.getByLabelText('Assign roles') as HTMLSelectElement;
    expect(assign.value).toBe('manual');
    expect(screen.queryByLabelText('Workspace role claim')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(assign, 'instance');
    expect((screen.getByLabelText('Scope') as HTMLInputElement).value).toBe('workflow');
    expect((screen.getByLabelText('Workspace role claim') as HTMLInputElement).value).toBe('instance_role');
    expect(screen.queryByLabelText('Project roles claim')).toBeNull();
    await user.selectOptions(screen.getByLabelText('When no role matches'), 'block');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen
      .findByRole('alertdialog', undefined, T)
      .catch(() => screen.findByRole('dialog', undefined, T));
    expect(within(dialog).getByText(/Download who holds which role first/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Download current access/ })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));

    await waitFor(async () => {
      const config = (await call('GET', '/sso/provisioning/config')).body.data;
      expect(config.scopesProvisionInstanceRole).toBe(true);
      expect(config.scopesProvisionProjectRoles).toBe(false);
      expect(config.defaultInstanceRole).toBe('block');
    }, T);
  });

  it('shows the project claim only when project roles are on, and never offers owner', async () => {
    signedIn();
    await call('PATCH', '/sso/provisioning/config', {
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: true,
    });
    const user = userEvent.setup();
    renderApp('/settings/provisioning');
    expect(await screen.findByLabelText('Project roles claim', undefined, T)).toBeTruthy();
    const options = within(screen.getByLabelText('When no role matches')).getAllByRole('option');
    expect(options.map((o) => o.textContent).join('|')).not.toMatch(/owner/i);
    await user.selectOptions(screen.getByLabelText('Assign roles'), 'instance');
    expect(screen.queryByLabelText('Project roles claim')).toBeNull();
  });

  it('adds a workspace rule, refuses a broken expression with the reason and keeps the order', async () => {
    signedIn();
    await call('PATCH', '/sso/provisioning/config', RULES);
    const user = userEvent.setup();
    renderApp('/settings/provisioning');
    expect(await screen.findByText('Workspace role rules', undefined, T)).toBeTruthy();
    expect(screen.getByText(/No rules yet/)).toBeTruthy();
    expect(screen.queryByText('Project role rules')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add workspace rule' }));
    let dialog = await screen.findByRole('dialog', undefined, T);
    await pasteInto(user, within(dialog).getByLabelText('Condition'), '{{ ( }}');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText(/The expression doesn't work/, undefined, T)).toBeTruthy();

    const field = within(dialog).getByLabelText('Condition');
    await user.clear(field);
    await pasteInto(user, field, '{{ $claims.group === "admins" }}');
    await user.selectOptions(within(dialog).getByLabelText('Role to give'), 'admin');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);

    const list = await screen.findByRole('list', { name: 'Workspace rules' }, T);
    expect(within(list).getByText('{{ $claims.group === "admins" }}')).toBeTruthy();
    expect(within(list).getByText(/Gives Admin/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add workspace rule' }));
    dialog = await screen.findByRole('dialog', undefined, T);
    await pasteInto(user, within(dialog).getByLabelText('Condition'), '{{ true }}');
    await user.selectOptions(within(dialog).getByLabelText('Role to give'), 'member');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(async () => {
      expect((await call('GET', '/sso/role-mapping-rules')).body.data).toHaveLength(2);
    }, T);

    // move the second rule up: it becomes the first
    await waitFor(
      () =>
        expect(
          within(screen.getByRole('list', { name: 'Workspace rules' })).getAllByRole('listitem'),
        ).toHaveLength(2),
      T,
    );
    const rows = within(screen.getByRole('list', { name: 'Workspace rules' })).getAllByRole('listitem');
    await user.click(within(rows[1]!).getByRole('button', { name: 'Move up' }));
    await waitFor(async () => {
      const data = (await call('GET', '/sso/role-mapping-rules')).body.data;
      expect(data.map((r: any) => r.role)).toEqual(['member', 'admin']);
    }, T);
  });

  it('edits and deletes a rule', async () => {
    signedIn();
    await call('PATCH', '/sso/provisioning/config', RULES);
    const made = await call('POST', '/sso/role-mapping-rules', {
      type: 'instance',
      expression: '{{ true }}',
      role: 'member',
    });
    expect(made.status).toBe(200);
    const user = userEvent.setup();
    renderApp('/settings/provisioning');
    await user.click(await screen.findByRole('button', { name: 'Edit rule' }, T));
    const dialog = await screen.findByRole('dialog', undefined, T);
    await user.selectOptions(within(dialog).getByLabelText('Role to give'), 'admin');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(async () => {
      expect((await call('GET', '/sso/role-mapping-rules')).body.data[0].role).toBe('admin');
    }, T);

    await user.click(await screen.findByRole('button', { name: 'Delete rule' }, T));
    await user.click(await screen.findByRole('button', { name: 'Delete' }, T));
    await waitFor(async () => {
      expect((await call('GET', '/sso/role-mapping-rules')).body.data).toHaveLength(0);
    }, T);
  });

  it('asks for a project and removes the project rules when project roles stop coming from the provider', async () => {
    signedIn();
    await call('PATCH', '/sso/provisioning/config', { ...RULES, scopesProvisionProjectRoles: true });
    const user = userEvent.setup();
    renderApp('/settings/provisioning');
    await user.click(await screen.findByRole('button', { name: 'Add project rule' }, T));
    const dialog = await screen.findByRole('dialog', undefined, T);
    await pasteInto(user, within(dialog).getByLabelText('Condition'), '{{ true }}');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText('Pick at least one project.')).toBeTruthy();
    const project = (await call('GET', '/projects')).body.data
      ? (await call('GET', '/projects')).body.data.find((p: any) => p.type === 'team')
      : null;
    expect(project).toBeTruthy();
    await user.click(within(dialog).getByLabelText(project.name));
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
    expect((await call('GET', '/sso/role-mapping-rules')).body.data).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText('Assign roles'), 'instance');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Stop managing' }, T));
    await waitFor(async () => {
      expect((await call('GET', '/sso/role-mapping-rules')).body.data).toHaveLength(0);
    }, T);
    await waitFor(() => expect(screen.queryByText('Project role rules')).toBeNull(), T);
  });

  it('shows a member no panel', async () => {
    signedIn();
    backend().setDemoRole('member');
    renderApp('/settings/provisioning');
    expect(await screen.findByText(/don't have access to role provisioning/, undefined, T)).toBeTruthy();
    expect(screen.queryByLabelText('Assign roles')).toBeNull();
  });
});
