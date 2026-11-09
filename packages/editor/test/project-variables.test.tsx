/**
 * P6-45: `/projects/:id/variables`: a project variable is set from the project's tab, wins in that project,
 * stays off the workspace page, and a project viewer reads without editing.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const project = demo.createProject({ tenantId, name: 'Growth', type: 'team' });
  const other = demo.createProject({ tenantId, name: 'Ops', type: 'team' });
  const addMember = (id: string, name: string, projectRole: string) => {
    demo.users.push({ id, email: `${id.slice(2)}@example.com`, name, password: 'x' });
    demo.memberships.push({ tenantId, userId: id, role: 'member' });
    demo.projectRelations.push({ tenantId, projectId: project.id, userId: id, role: projectRole });
  };
  return { demo, tenantId, project, other, addMember };
}

describe('project variables tab', () => {
  it('creates a variable in the project, shows it and keeps it off the workspace page', async () => {
    const { demo, project } = setup();
    renderApp(`/projects/${project.id}/variables`);
    const user = userEvent.setup();
    expect(await screen.findByText('No variables in this project', {}, T)).toBeTruthy();
    await user.type(screen.getByLabelText('Key'), 'region');
    await user.type(screen.getByLabelText('Value'), 'eu');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(demo.variables.map((v) => [v.key, v.value, v.projectId])).toEqual([
        ['region', 'eu', project.id],
      ]),
    );
    expect(await screen.findByLabelText('Value of region', {}, T)).toBeTruthy();
  });

  it('lists only the variables of this project', async () => {
    const { demo, project, other, tenantId } = setup();
    demo.variables.push(
      { id: 'v1', key: 'mine', value: '1', projectId: project.id, tenantId },
      { id: 'v2', key: 'theirs', value: '2', projectId: other.id, tenantId },
      { id: 'v3', key: 'everyone', value: '3', tenantId },
    );
    renderApp(`/projects/${project.id}/variables`);
    expect(await screen.findByLabelText('Value of mine', {}, T)).toBeTruthy();
    expect(screen.queryByLabelText('Value of theirs')).toBeNull();
    expect(screen.queryByLabelText('Value of everyone')).toBeNull();
  });

  it('edits and deletes a project variable', async () => {
    const { demo, project, tenantId } = setup();
    demo.variables.push({ id: 'v1', key: 'region', value: 'eu', projectId: project.id, tenantId });
    renderApp(`/projects/${project.id}/variables`);
    const user = userEvent.setup();
    const value = await screen.findByLabelText('Value of region', {}, T);
    await user.clear(value);
    await user.type(value, 'us');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().variables[0]?.value).toBe('us'));
    await user.click(await screen.findByRole('button', { name: 'Delete region' }, T));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete variable' }));
    await waitFor(() => expect(backend().variables).toHaveLength(0));
  });

  it('a workspace variable page shows no project variable', async () => {
    const { demo, project, tenantId } = setup();
    demo.variables.push(
      { id: 'v1', key: 'inproject', value: '1', projectId: project.id, tenantId },
      { id: 'v2', key: 'inworkspace', value: '2', tenantId },
    );
    renderApp('/settings/variables');
    expect(await screen.findByLabelText('Value of inworkspace', {}, T)).toBeTruthy();
    expect(screen.queryByLabelText('Value of inproject')).toBeNull();
  });

  it('a project viewer reads the variables but cannot add, change or delete', async () => {
    const { demo, project, tenantId, addMember } = setup();
    addMember('u-vic', 'Vic Viewer', 'project:viewer');
    demo.variables.push({ id: 'v1', key: 'region', value: 'eu', projectId: project.id, tenantId });
    demo.signIn('vic@example.com');
    renderApp(`/projects/${project.id}/variables`);
    const value = (await screen.findByLabelText('Value of region', {}, T)) as HTMLInputElement;
    expect(value.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete region' })).toBeNull();
  });

  it('a project editor can add a variable', async () => {
    const { demo, project, addMember } = setup();
    addMember('u-ed', 'Eddie Editor', 'project:editor');
    demo.signIn('ed@example.com');
    renderApp(`/projects/${project.id}/variables`);
    expect(await screen.findByRole('button', { name: 'Add' }, T)).toBeTruthy();
  });
});
