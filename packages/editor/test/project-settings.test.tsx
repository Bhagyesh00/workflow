/**
 * P6-42: the project settings page on the demo backend: name, icon, description, members with search, role
 * dropdown, remove, add from the page, and what a project viewer cannot do.
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
  const project = demo.createProject({ tenantId, name: 'Growth', type: 'team', description: 'Marketing' });
  for (const [id, name, role] of [
    ['u-sam', 'Sam Shaw', 'project:editor'],
    ['u-ann', 'Ann Arbor', 'project:viewer'],
  ] as const) {
    demo.users.push({ id, email: `${id.slice(2)}@example.com`, name, password: 'x' });
    demo.memberships.push({ tenantId, userId: id, role: 'viewer', globalRole: 'member' });
    demo.projectRelations.push({ tenantId, projectId: project.id, userId: id, role });
  }
  return { demo, tenantId, project };
}

describe('project settings page', () => {
  it('shows the name, description, icon picker, members and the danger zone, and saves a change', async () => {
    const { demo, project } = setup();
    renderApp(`/projects/${project.id}/settings`);
    const name = await screen.findByLabelText(/Project name/, {}, T);
    expect((name as HTMLInputElement).value).toBe('Growth');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Marketing');
    expect(screen.getByRole('group', { name: 'Project icon' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, 'Growth team');
    await user.click(screen.getByRole('button', { name: 'Emoji 🚀' }));
    await user.click(save);
    await waitFor(() => expect(demo.projects.find((p) => p.id === project.id)?.name).toBe('Growth team'));
    expect(demo.projects.find((p) => p.id === project.id)?.icon).toEqual({ type: 'emoji', value: '🚀' });
  });

  it('lists members, searches them, changes a role and removes a member', async () => {
    const { demo, project } = setup();
    renderApp(`/projects/${project.id}/settings`);
    expect(await screen.findByText('sam@example.com', {}, T)).toBeTruthy();
    expect(screen.getByText('ann@example.com')).toBeTruthy();
    // the owner reaches the project through the workspace role: read only
    expect(screen.getAllByText('Through the workspace role').length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search members'), 'ann');
    expect(screen.queryByText('sam@example.com')).toBeNull();
    await user.clear(screen.getByLabelText('Search members'));

    const select = (await screen.findByLabelText('Role of sam@example.com')) as HTMLSelectElement;
    await user.selectOptions(select, 'project:viewer');
    await waitFor(() =>
      expect(demo.projectRelations.find((r) => r.userId === 'u-sam')?.role).toBe('project:viewer'),
    );

    await user.click(screen.getByRole('button', { name: 'Remove ann@example.com' }));
    await waitFor(() => expect(demo.projectRelations.some((r) => r.userId === 'u-ann')).toBe(false));
    await waitFor(() => expect(screen.queryByText('ann@example.com')).toBeNull());
  });

  it('a project admin adds a member from the page', async () => {
    const { demo, tenantId, project } = setup();
    demo.users.push({ id: 'u-new', email: 'new@example.com', name: 'Nina New', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-new', role: 'viewer', globalRole: 'member' });
    demo.projectRelations.push({
      tenantId,
      projectId: project.id,
      userId: demo.auth().user.id,
      role: 'project:admin',
    });
    demo.setDemoRole('member');
    renderApp(`/projects/${project.id}/settings`);
    const user = userEvent.setup();
    const pick = (await screen.findByLabelText('Add a member', {}, T)) as HTMLSelectElement;
    await waitFor(() => expect(within(pick).queryByText(/new@example.com/)).toBeTruthy());
    expect(within(pick).queryByText(/sam@example.com/)).toBeNull();
    await user.selectOptions(pick, 'u-new');
    await user.selectOptions(screen.getByLabelText('Role for the new member'), 'project:editor');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await waitFor(() =>
      expect(demo.projectRelations.find((r) => r.userId === 'u-new')?.role).toBe('project:editor'),
    );
    expect(await screen.findByText('new@example.com')).toBeTruthy();
  });

  it('a project viewer sees the settings read only: no Save, no member controls, no danger zone', async () => {
    const { demo, tenantId, project } = setup();
    demo.projectRelations.push({
      tenantId,
      projectId: project.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.setDemoRole('member');
    renderApp(`/projects/${project.id}/settings`);
    const name = (await screen.findByLabelText(/Project name/, {}, T)) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(screen.queryByLabelText('Role of sam@example.com')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Danger zone' })).toBeNull();
    expect(screen.getByText('sam@example.com')).toBeTruthy();
  });

  it('a project that is not there says so', async () => {
    signedIn();
    renderApp('/projects/nope/settings');
    expect(await screen.findByText('Project not found', {}, T)).toBeTruthy();
    expect(backend().projects.some((p) => p.id === 'nope')).toBe(false);
  });
});
