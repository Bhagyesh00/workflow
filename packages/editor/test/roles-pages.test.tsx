/**
 * P6-46: `/settings/roles`: the tabs, the table of system and custom roles with usage, the delete guard
 * (a project role in use is refused, a workspace role is reassigned first) and the assignments tab.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { addDemoRole, findCustomRole } from '../src/demo/mock-roles';
import { signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

function addMember(demo: ReturnType<typeof signedIn>, id: string, name: string, globalRole = 'member') {
  const tenantId = demo.auth().tenant.id;
  demo.users.push({ id, email: `${id}@example.com`, name, password: 'x' });
  demo.memberships.push({ tenantId, userId: id, role: 'viewer', globalRole });
  return tenantId;
}

const rowOf = (slug: string) => document.querySelector(`tr[data-role="${slug}"]`) as HTMLElement;

describe('roles page', () => {
  it('lists the project roles with their type and usage, and switches to the workspace roles', async () => {
    const demo = signedIn();
    const tenantId = addMember(demo, 'u-sam', 'Sam Shaw');
    const team = demo.defaultProjectFor(tenantId);
    demo.projectRelations.push({ tenantId, projectId: team.id, userId: 'u-sam', role: 'project:reviewer' });
    renderApp('/settings/roles');
    expect(await screen.findByRole('tab', { name: 'Project roles' }, T)).toBeTruthy();
    await screen.findByRole('link', { name: 'Reviewer' }, T);
    for (const name of ['Admin', 'Editor', 'Viewer']) {
      expect(within(rowOf(`project:${name.toLowerCase()}`)).getByText('System')).toBeTruthy();
    }
    const reviewer = rowOf('project:reviewer');
    expect(within(reviewer).getByText('Custom')).toBeTruthy();
    expect(within(reviewer).getByText('1 user in 1 project')).toBeTruthy();
    expect(within(rowOf('project:admin')).getByRole('link', { name: 'View Admin' })).toBeTruthy();
    expect(within(reviewer).getByRole('link', { name: 'Edit Reviewer' })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Workspace roles' }));
    await screen.findByRole('link', { name: 'Owner' }, T);
    expect(rowOf('admin')).toBeTruthy();
    expect(rowOf('member')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Reviewer' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New role' }).getAttribute('href')).toBe(
      '/settings/instance-roles/new',
    );
  });

  it('New role opens the editor for the tab', async () => {
    signedIn();
    renderApp('/settings/roles');
    const link = await screen.findByRole('link', { name: 'New role' }, T);
    expect(link.getAttribute('href')).toBe('/settings/project-roles/new');
  });

  it('a member without role permissions sees no table', async () => {
    const demo = signedIn();
    demo.setDemoRole('editor');
    renderApp('/settings/roles');
    expect(await screen.findByText('You cannot manage roles', {}, T)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('deletes a project role nobody holds, after a confirmation', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    renderApp('/settings/roles');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Reviewer' }, T));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/This cannot be undone/, {}, T)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete role' }));
    await waitFor(() => expect(findCustomRole(demo, tenantId, 'project:reviewer')).toBeUndefined());
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Reviewer' })).toBeNull());
  });

  it('refuses to delete a project role that is in use and offers only Close', async () => {
    const demo = signedIn();
    const tenantId = addMember(demo, 'u-sam', 'Sam Shaw');
    const team = demo.defaultProjectFor(tenantId);
    demo.projectRelations.push({ tenantId, projectId: team.id, userId: 'u-sam', role: 'project:reviewer' });
    renderApp('/settings/roles');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Reviewer' }, T));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('This role is in use', {}, T)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Delete role' })).toBeNull();
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    expect(findCustomRole(demo, tenantId, 'project:reviewer')).toBeTruthy();
  });

  it('a workspace role in use is deleted only after members are given another role', async () => {
    const demo = signedIn();
    const tenantId = addMember(demo, 'u-sam', 'Sam Shaw', 'global:triage');
    addDemoRole(demo, {
      slug: 'global:triage',
      displayName: 'Triage',
      description: null,
      scopes: ['tag:read'],
      tenantId,
      systemRole: false,
      roleType: 'global',
    });
    renderApp('/settings/roles?type=global');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Triage' }, T));
    const dialog = await screen.findByRole('dialog');
    const choose = await within(dialog).findByLabelText('Give members this role', {}, T);
    const del = within(dialog).getByRole('button', { name: 'Delete role' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(within(choose).queryByRole('option', { name: 'Owner' })).toBeNull();
    await user.selectOptions(choose, 'member');
    expect(del.disabled).toBe(false);
    await user.click(del);
    await waitFor(() => expect(findCustomRole(demo, tenantId, 'global:triage')).toBeUndefined());
    const membership = demo.memberships.find((m) => m.userId === 'u-sam');
    expect(membership?.globalRole).toBe('member');
  });
});

describe('assignments tab', () => {
  it('lists the projects that use a project role and their members', async () => {
    const demo = signedIn();
    const tenantId = addMember(demo, 'u-sam', 'Sam Shaw');
    const team = demo.defaultProjectFor(tenantId);
    demo.projectRelations.push({ tenantId, projectId: team.id, userId: 'u-sam', role: 'project:reviewer' });
    renderApp('/settings/project-roles/edit/project%3Areviewer');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Assignments' }, T));
    const table = await screen.findByRole('table', {}, T);
    expect(within(table).getByText(team.name)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: `Show members in ${team.name}` }));
    const list = await screen.findByRole('list', { name: `Members in ${team.name}` }, T);
    expect(within(list).getByText('Sam Shaw')).toBeTruthy();
  });

  it('says so when no project uses the role', async () => {
    signedIn();
    renderApp('/settings/project-roles/edit/project%3Areviewer');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Assignments' }, T));
    expect(await screen.findByText('Not used yet', {}, T)).toBeTruthy();
  });

  it('lists the members of a workspace role', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    demo.users.push({ id: 'u-ann', email: 'ann@example.com', name: 'Ann Arbor', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-ann', role: 'admin' });
    renderApp('/settings/instance-roles/view/admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Assignments' }, T));
    const list = await screen.findByRole('list', { name: 'Members with this role' }, T);
    expect(within(list).getByText('Ann Arbor')).toBeTruthy();
  });
});
