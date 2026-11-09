/**
 * P6-41: the sidebar's project block on the demo backend: Overview, Shared with you, Personal, the Projects
 * list with Add project, favorite projects; a user sees only their projects; the old list entries are gone
 * from the sidebar (they are tabs of the project pages).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../src/api/queries';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

async function mainNav() {
  return screen.findByRole('navigation', { name: 'Main' }, { timeout: 20_000 });
}

afterEach(() => useUiStore.setState({ sidebarCollapsed: false }));

describe('project sidebar', () => {
  it('lists Overview, Shared with you, Personal and the team projects, and moves the old entries out', async () => {
    const demo = signedIn();
    const team = demo.defaultProjectFor(demo.auth().tenant.id);
    renderApp('/home/workflows');
    const nav = await mainNav();
    expect(await within(nav).findByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Shared with you' }).getAttribute('href')).toBe(
      '/shared/workflows',
    );
    const personal = demo.personalProject(demo.auth().tenant.id, demo.auth().user.id);
    expect(within(nav).getByRole('link', { name: 'Personal' }).getAttribute('href')).toBe(
      `/projects/${personal.id}/workflows`,
    );
    const projects = within(nav).getByRole('navigation', { name: 'Projects' });
    expect(within(projects).getByRole('link', { name: team.name }).getAttribute('href')).toBe(
      `/projects/${team.id}/workflows`,
    );
    expect(within(projects).getByRole('button', { name: 'Add project' })).toBeTruthy();
    // Inbox needs the reviews switch; Settings stays, and so does the Assistant rule
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
    for (const old of ['Workflows', 'Executions', 'Credentials', 'Data tables'])
      expect(within(nav).queryByRole('link', { name: old })).toBeNull();
  });

  it('marks the page family the route is in', async () => {
    const demo = signedIn();
    const team = demo.defaultProjectFor(demo.auth().tenant.id);
    const { router } = renderApp('/home/workflows');
    const nav = await mainNav();
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page'),
    );
    await act(() => router.navigate(`/projects/${team.id}/credentials`));
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: team.name }).getAttribute('aria-current')).toBe('page'),
    );
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('Add project makes a team project the user administers and opens its settings', async () => {
    const demo = signedIn();
    const { router } = renderApp('/home/workflows');
    const nav = await mainNav();
    await userEvent.setup().click(await within(nav).findByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/[^/]+\/settings$/));
    const created = demo.projects.find((p) => p.name === 'My project');
    expect(created?.type).toBe('team');
    expect(router.state.location.pathname).toBe(`/projects/${created!.id}/settings`);
    expect(
      demo.projectRelations.find((r) => r.projectId === created!.id && r.userId === demo.auth().user.id)
        ?.role,
    ).toBe('project:admin');
    // the new project is in the list
    expect(await within(nav).findByRole('link', { name: 'My project' })).toBeTruthy();
  });

  it('shows a member only the projects they belong to, and no Add project', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const mine = demo.createProject({ tenantId, name: 'Mine', type: 'team' });
    demo.createProject({ tenantId, name: 'Hidden', type: 'team' });
    demo.projectRelations.push({
      tenantId,
      projectId: mine.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.setDemoRole('member');
    renderApp('/home/workflows');
    const nav = await mainNav();
    expect(await within(nav).findByRole('link', { name: 'Mine' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Hidden' })).toBeNull();
    expect(within(nav).queryByRole('button', { name: 'Add project' })).toBeNull();
  });

  it('lists favorite projects', async () => {
    const demo = signedIn();
    const team = demo.defaultProjectFor(demo.auth().tenant.id);
    const { queryClient } = renderApp('/home/workflows');
    const nav = await mainNav();
    await within(nav).findByRole('link', { name: 'Overview' });
    expect(within(nav).queryByRole('navigation', { name: 'Favorite projects' })).toBeNull();
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.favorites)).toBeTruthy());
    act(() =>
      queryClient.setQueryData(queryKeys.favorites, [
        {
          resourceType: 'project',
          resourceId: team.id,
          name: team.name,
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    const favorites = await within(nav).findByRole('navigation', { name: 'Favorite projects' });
    expect(within(favorites).getByRole('link', { name: team.name }).getAttribute('href')).toBe(
      `/projects/${team.id}/workflows`,
    );
  });

  it('keeps names and icons on the collapsed rail', async () => {
    const demo = signedIn();
    const team = demo.defaultProjectFor(demo.auth().tenant.id);
    useUiStore.setState({ sidebarCollapsed: true });
    renderApp('/home/workflows');
    const nav = await mainNav();
    expect(await within(nav).findByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Shared with you' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: team.name })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Add project' })).toBeTruthy();
    expect(backend()).toBe(demo);
  });
});
