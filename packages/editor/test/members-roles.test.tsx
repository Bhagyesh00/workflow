/**
 * P6-45: the members page with the new workspace roles (owner, admin, member, a custom one), View projects,
 * removal with a choice for the member's work, settings links by scope, and the caller policy labels.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSettingsModal } from '../src/components/workflow/WorkflowSettingsModal';
import { addDemoRole } from '../src/demo/mock-roles';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const growth = demo.createProject({ tenantId, name: 'Growth', type: 'team' });
  demo.createProject({ tenantId, name: 'Ops', type: 'team' });
  demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
  demo.memberships.push({ tenantId, userId: 'u-sam', role: 'member' });
  demo.projectRelations.push({ tenantId, projectId: growth.id, userId: 'u-sam', role: 'project:editor' });
  addDemoRole(demo, {
    tenantId,
    slug: 'global:auditor',
    displayName: 'Auditor',
    description: 'Reads the workspace',
    systemRole: false,
    roleType: 'global',
    scopes: ['workflow:list'],
  });
  return { demo, tenantId, growth };
}

const optionNames = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('members page roles', () => {
  it('offers the system and custom workspace roles in a member row and changes the role', async () => {
    setup();
    renderApp('/settings/members');
    const select = await screen.findByLabelText('Role of Sam Shaw', {}, T);
    const names = optionNames(select);
    expect(names).toEqual(expect.arrayContaining(['Admin', 'Member', 'Auditor']));
    expect(names).not.toContain('Owner');
    expect((select as HTMLSelectElement).value).toBe('member');
    const user = userEvent.setup();
    await user.selectOptions(select, 'global:auditor');
    await waitFor(() =>
      expect(backend().memberships.find((m) => m.userId === 'u-sam')?.role).toBe('global:auditor'),
    );
    expect(await screen.findByText('Role updated', {}, T)).toBeTruthy();
  });

  it('invites with a custom role chosen from the list', async () => {
    setup();
    renderApp('/settings/members');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Invite' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' });
    expect(optionNames(within(dialog).getByLabelText('Role'))).toEqual(
      expect.arrayContaining(['Admin', 'Member', 'Auditor']),
    );
    await user.type(within(dialog).getByLabelText('Email'), 'new@example.com');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'member');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText(/\/invitation\//, {}, T)).toBeTruthy();
    expect(backend().invitations[0]).toMatchObject({ email: 'new@example.com', role: 'member' });
  });

  it('a workspace member sees the list but no invite, role change, removal or View projects', async () => {
    const { demo } = setup();
    demo.signIn('sam@example.com');
    renderApp('/settings/members');
    expect(await screen.findByText('Olive Owner', {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByLabelText('Role of Olive Owner')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View projects' })).toBeNull();
  });
});

describe('View projects', () => {
  it('lists the projects of a member with the role in each', async () => {
    setup();
    renderApp('/settings/members');
    const row = (await screen.findByText('Sam Shaw', {}, T)).closest('li') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'View projects' }));
    const dialog = await screen.findByRole('dialog', { name: 'Projects' }, T);
    const list = await within(dialog).findByRole('list', { name: 'Projects of the member' }, T);
    const rows = within(list).getAllByRole('listitem');
    const growth = rows.find((r) => r.textContent?.includes('Growth'));
    expect(growth?.textContent).toContain('Editor');
    // the personal space of the member is listed too; a project they are not in is not
    expect(list.textContent).not.toContain('Ops');
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Projects' })).toBeNull());
  });

  it('shows an admin in every team project through the workspace role', async () => {
    const { demo, tenantId } = setup();
    demo.users.push({ id: 'u-ada', email: 'ada@example.com', name: 'Ada Admin', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-ada', role: 'admin' });
    renderApp('/settings/members');
    const row = (await screen.findByText('Ada Admin', {}, T)).closest('li') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'View projects' }));
    const list = await screen.findByRole('list', { name: 'Projects of the member' }, T);
    expect(list.textContent).toContain('Growth');
    expect(list.textContent).toContain('Ops');
    expect(list.textContent).toContain('through the workspace role');
  });
});

describe('removing a member', () => {
  it('needs a choice for the work, then removes the member', async () => {
    setup();
    renderApp('/settings/members');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Sam Shaw' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Sam Shaw?' });
    const remove = within(dialog).getByRole('button', { name: 'Remove member' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await user.selectOptions(within(dialog).getByLabelText('Their work'), 'delete');
    expect(remove.disabled).toBe(false);
    await user.click(remove);
    await waitFor(() => expect(backend().memberships.some((m) => m.userId === 'u-sam')).toBe(false));
    expect(await screen.findByText('Member removed', {}, T)).toBeTruthy();
  });

  it('can move the work to a project', async () => {
    const { growth } = setup();
    renderApp('/settings/members');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Sam Shaw' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Sam Shaw?' });
    const choose = within(dialog).getByLabelText('Their work');
    await waitFor(() => expect(optionNames(choose)).toContain('Move it to Growth'));
    await user.selectOptions(choose, growth.id);
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(backend().memberships.some((m) => m.userId === 'u-sam')).toBe(false));
  });
});

describe('settings links by scope', () => {
  it('shows External secrets, AI and Assistant to an owner', async () => {
    setup();
    renderApp('/settings/members');
    const nav = await screen.findByRole('navigation', { name: 'Settings' }, T);
    for (const name of ['External secrets', 'AI', 'Assistant', 'Roles']) {
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    }
  });

  it('hides them from a workspace member', async () => {
    const { demo } = setup();
    demo.signIn('sam@example.com');
    renderApp('/settings/members');
    const nav = await screen.findByRole('navigation', { name: 'Settings' }, T);
    await within(nav).findByRole('link', { name: 'Members' }, T);
    for (const name of ['External secrets', 'AI', 'Assistant', 'Roles']) {
      expect(within(nav).queryByRole('link', { name })).toBeNull();
    }
  });
});

describe('caller policy labels', () => {
  it('names the project and defaults to the same project', async () => {
    signedIn();
    const onSave = vi.fn();
    withProviders(
      <WorkflowSettingsModal
        open
        onClose={() => undefined}
        value={{}}
        workflowId="w1"
        onSave={onSave}
        readOnly={false}
      />,
    );
    const select = (await screen.findByLabelText('Who can call this workflow', {}, T)) as HTMLSelectElement;
    expect(select.value).toBe('sameProject');
    expect(optionNames(select)).toEqual([
      'Workflows in the same project',
      'Any workflow in this workspace, from any project',
      'Only the workflows listed below',
      'No other workflow',
    ]);
    const user = userEvent.setup();
    await user.selectOptions(select, 'none');
    await user.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ callerPolicy: 'none' });
  });
});
