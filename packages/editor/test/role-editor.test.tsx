/**
 * P6-46: the role editor: scope checkboxes by resource from the allow lists, presets, escalation warnings, the
 * instance editor's static personal space block, create and edit on the demo backend, read-only system roles.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROJECT_CUSTOM_ROLE_SCOPES } from '@workflow/workflow';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Scope } from '../src/api/types';
import {
  type RoleDraft,
  RoleEditor,
  toggleGlobalOption,
  toggleProjectScope,
} from '../src/components/roles/RoleEditor';
import { findCustomRole } from '../src/demo/mock-roles';
import { signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };

function Harness({ roleType, initial }: { roleType: 'project' | 'global'; initial?: Scope[] }) {
  const [value, setValue] = useState<RoleDraft>({ displayName: '', description: '', scopes: initial ?? [] });
  return (
    <>
      <RoleEditor roleType={roleType} value={value} onChange={setValue} />
      <output data-testid="scopes">{[...value.scopes].sort().join(',')}</output>
    </>
  );
}

const scopesOf = () => (screen.getByTestId('scopes').textContent ?? '').split(',').filter(Boolean);

describe('scope toggles', () => {
  it('a read brings its list scope, any other operation brings read, publish brings unpublish', () => {
    let scopes = toggleProjectScope([], 'workflow:update', true);
    expect([...scopes].sort()).toEqual(['workflow:list', 'workflow:read', 'workflow:update']);
    scopes = toggleProjectScope(scopes, 'workflow:publish', true);
    expect(scopes).toContain('workflow:unpublish');
    scopes = toggleProjectScope(scopes, 'workflow:publish', false);
    expect(scopes).not.toContain('workflow:unpublish');
    expect(scopes).toContain('workflow:update');
    // read off takes the rest of the resource with it
    scopes = toggleProjectScope(scopes, 'workflow:read', false);
    expect(scopes).toEqual([]);
    expect(toggleProjectScope([], 'dataTable:read', true).sort()).toEqual([
      'dataTable:listProject',
      'dataTable:read',
    ]);
  });

  it('turning a workspace option off also turns off the option that contains it, and keeps shared scopes', () => {
    const manage = toggleGlobalOption([], 'tag', 'Manage', true);
    expect(manage).toContain('tag:delete');
    const off = toggleGlobalOption(manage, 'tag', 'View', false);
    expect(off).toEqual([]);
    const some = toggleGlobalOption(['tag:read', 'tag:list', 'user:list', 'user:read'], 'tag', 'View', false);
    expect(some.sort()).toEqual(['user:list', 'user:read']);
  });
});

describe('RoleEditor', () => {
  it('draws one checkbox per allowed operation of each resource and nothing outside the allow list', async () => {
    withProviders(<Harness roleType="project" />);
    const user = userEvent.setup();
    expect(screen.getByRole('group', { name: 'Workflow' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Data table' })).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Workflow publish' }));
    const scopes = scopesOf();
    expect(scopes).toEqual(
      expect.arrayContaining(['workflow:publish', 'workflow:unpublish', 'workflow:read', 'workflow:list']),
    );
    expect(scopes.every((s) => PROJECT_CUSTOM_ROLE_SCOPES.has(s as Scope))).toBe(true);
    // no workspace-only controls in a project role
    expect(screen.queryByRole('checkbox', { name: /Roles: Manage/ })).toBeNull();
    expect(screen.queryByText('Personal space')).toBeNull();
  });

  it('warns for each of the four ways a role can raise access', async () => {
    withProviders(<Harness roleType="global" />);
    const user = userEvent.setup();
    expect(screen.queryByRole('group', { name: 'Warnings' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Users: Manage' }));
    expect(document.querySelector('[data-warning="manageMembers"]')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Roles: Manage' }));
    expect(document.querySelector('[data-warning="manageRoles"]')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Roles: Manage project roles' }));
    expect(document.querySelector('[data-warning="manageProjectRoles"]')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Credentials: Manage' }));
    expect(document.querySelector('[data-warning="manageCredentials"]')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Users: Manage' }));
    expect(document.querySelector('[data-warning="manageMembers"]')).toBeNull();
  });

  it('the workspace editor shows the static personal space block and the mandatory options checked and locked', () => {
    withProviders(<Harness roleType="global" />);
    expect(screen.getByRole('region', { name: 'Personal space' })).toBeTruthy();
    for (const name of ['Users: View', 'Tags: View']) {
      const box = screen.getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(true);
    }
  });

  it('read only draws every box disabled', () => {
    withProviders(
      <RoleEditor
        roleType="project"
        readOnly
        value={{ displayName: 'Viewer', description: '', scopes: ['workflow:read', 'workflow:list'] }}
        onChange={() => {}}
      />,
    );
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Workflow read' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('role editor page on the demo backend', () => {
  it('an admin builds a project role from the Viewer preset, adds a permission and saves it', async () => {
    const demo = signedIn();
    renderApp('/settings/project-roles/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Viewer' }, T));
    expect((screen.getByRole('checkbox', { name: 'Workflow read' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Workflow update' }) as HTMLInputElement).checked).toBe(
      false,
    );
    const save = screen.getByRole('button', { name: 'Create role' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Name/), 'Triage');
    await user.click(screen.getByRole('checkbox', { name: 'Execution delete' }));
    await user.click(save);
    await waitFor(() => {
      const made = [
        ...(demo.ext.roles as { roles: Array<{ displayName: string; scopes: string[]; roleType: string }> })
          .roles,
      ].find((r) => r.displayName === 'Triage');
      expect(made?.roleType).toBe('project');
      expect(made?.scopes).toEqual(
        expect.arrayContaining(['workflow:read', 'execution:delete', 'execution:read']),
      );
      expect(made?.scopes).not.toContain('workflow:update');
    });
    // back on the roles page, with the new role in the table
    expect(await screen.findByRole('link', { name: 'Triage' }, T)).toBeTruthy();
  });

  it('a duplicate name is refused by the server and the form stays', async () => {
    signedIn();
    renderApp('/settings/project-roles/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Name/, {}, T), 'Reviewer');
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText(/already exists/, {}, T)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create role' })).toBeTruthy();
  });

  it('edits a custom role and saves the new permissions', async () => {
    const demo = signedIn();
    renderApp('/settings/project-roles/edit/project%3Areviewer');
    const user = userEvent.setup();
    const name = await screen.findByLabelText(/Name/, {}, T);
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Reviewer'));
    await user.click(screen.getByRole('checkbox', { name: 'Folder create' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const role = findCustomRole(demo, demo.auth().tenant.id, 'project:reviewer');
      expect(role?.scopes).toContain('folder:create');
      expect(role?.scopes).toContain('workflow:read');
    });
  });

  it('a system role opens read only with no Save button', async () => {
    signedIn();
    renderApp('/settings/project-roles/view/project%3Aviewer');
    expect(await screen.findByRole('heading', { name: 'Viewer' }, T)).toBeTruthy();
    expect(screen.getByText(/built in and cannot be changed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });

  it('a workspace role starts from a preset, shows the warning and keeps the mandatory scopes', async () => {
    const demo = signedIn();
    renderApp('/settings/instance-roles/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Member' }, T));
    await user.type(screen.getByLabelText(/Name/), 'Support lead');
    await user.click(screen.getByRole('checkbox', { name: 'Users: Manage' }));
    expect(within(document.body).getByText(/change anyone’s workspace role/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => {
      const roles = (
        demo.ext.roles as { roles: Array<{ displayName: string; scopes: string[]; roleType: string }> }
      ).roles;
      const made = roles.find((r) => r.displayName === 'Support lead');
      expect(made?.roleType).toBe('global');
      expect(made?.scopes).toEqual(expect.arrayContaining(['user:changeRole', 'user:list', 'tag:read']));
    });
  });

  it('a member without role permissions gets no editor', async () => {
    const demo = signedIn();
    demo.setDemoRole('viewer');
    renderApp('/settings/project-roles/new');
    expect(await screen.findByText('You cannot manage roles', {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create role' })).toBeNull();
  });
});
