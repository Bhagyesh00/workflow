/**
 * P6-43: the lists take the project. Overview lists every project the user sees, with a project badge and a
 * project filter; a project page lists only its own rows; Shared with you lists what other projects shared
 * in; new rows (workflow, folder, data table, credential) go to the project the page works in.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRef } from '../src/api/types';
import { ProjectBadge } from '../src/components/projects/ProjectBadge';
import type { MockBackend } from '../src/demo/mock-backend';
import { demoShares } from '../src/demo/mock-sharing';
import { useProjectStore } from '../src/stores/project-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 20_000 };

beforeEach(() => useProjectStore.getState().setCurrentProject(null));

/** the default team project, a second team project and a workflow in each */
function twoProjects(demo: MockBackend) {
  const tenantId = demo.auth().tenant.id;
  const alpha = demo.defaultProjectFor(tenantId);
  const beta = demo.createProject({ tenantId, name: 'Beta team', type: 'team' });
  const inAlpha = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
  const inBeta = demo.seedWorkflow({ name: 'Beta flow', projectId: beta.id });
  return { tenantId, alpha, beta, inAlpha, inBeta };
}

const ref = (id: string, name: string): ProjectRef => ({ id, name, type: 'team', icon: null });

describe('ProjectBadge', () => {
  it('shows the home project and the count of projects the row is shared with', () => {
    render(
      <ProjectBadge
        resourceType="workflow"
        homeProject={ref('a', 'Alpha team')}
        sharedWithProjects={[ref('b', 'Beta team'), ref('c', 'Gamma team')]}
      />,
    );
    const badge = screen.getByTestId('project-badge');
    expect(badge.textContent).toContain('Alpha team');
    expect(within(badge).getByLabelText('Shared with 2 projects').textContent).toContain('+2');
    expect(within(badge).getByLabelText('Shared with 2 projects').getAttribute('title')).toBe(
      'This workflow is shared with Beta team, Gamma team',
    );
  });

  it('names a personal project Personal, has no count when unshared, and renders nothing without a project', () => {
    const { container, rerender } = render(
      <ProjectBadge
        resourceType="credential"
        homeProject={{ id: 'p', name: 'Olive Owner', type: 'personal', icon: null }}
        sharedWithProjects={[]}
      />,
    );
    expect(screen.getByTestId('project-badge').textContent).toBe('Personal');
    expect(screen.queryByLabelText(/Shared with/)).toBeNull();
    rerender(<ProjectBadge resourceType="credential" homeProject={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('workflows', () => {
  it('Overview lists every project with its badge, and the project filter narrows the list', async () => {
    const demo = signedIn();
    const { beta } = twoProjects(demo);
    renderApp('/home/workflows');
    expect(await screen.findByText('Alpha flow', {}, LONG)).toBeTruthy();
    expect(screen.getByText('Beta flow')).toBeTruthy();
    expect(screen.getAllByTestId('project-badge').map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Beta team')]),
    );
    await userEvent.setup().selectOptions(screen.getByLabelText('Filter by project'), beta.id);
    await waitFor(() => expect(screen.queryByText('Alpha flow')).toBeNull());
    expect(screen.getByText('Beta flow')).toBeTruthy();
  });

  it('a project page lists only that project, with no badge', async () => {
    const demo = signedIn();
    const { beta } = twoProjects(demo);
    renderApp(`/projects/${beta.id}/workflows`);
    expect(await screen.findByText('Beta flow', {}, LONG)).toBeTruthy();
    expect(screen.queryByText('Alpha flow')).toBeNull();
    expect(screen.queryByTestId('project-badge')).toBeNull();
    expect(screen.queryByLabelText('Filter by project')).toBeNull();
  });

  it('Create workflow on a project page creates in that project', async () => {
    const demo = signedIn();
    const { beta } = twoProjects(demo);
    const { router } = renderApp(`/projects/${beta.id}/workflows`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Create workflow' }, LONG));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/workflow\/[^/]+$/), LONG);
    expect(demo.workflows.find((w) => w.name === 'My workflow')?.projectId).toBe(beta.id);
  });

  it('a folder made on a project page belongs to the project and shows only there', async () => {
    const demo = signedIn();
    const { alpha, beta } = twoProjects(demo);
    renderApp(`/projects/${beta.id}/workflows`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New folder' }, LONG));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    await user.type(within(dialog).getByLabelText('Folder name'), 'Beta files');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    expect(await screen.findByTestId('folder-row-Beta files', {}, LONG)).toBeTruthy();
    const mine = await demo.handle({ method: 'GET', path: '/folders', query: { projectId: beta.id } });
    expect((mine.body as { data: Array<{ name: string; projectId?: string }> }).data).toMatchObject([
      { name: 'Beta files', projectId: beta.id },
    ]);
    const other = await demo.handle({ method: 'GET', path: '/folders', query: { projectId: alpha.id } });
    expect((other.body as { data: unknown[] }).data).toEqual([]);
  });

  it('Shared with you lists what other projects shared in, a member does not see the rest', async () => {
    const demo = signedIn();
    const { tenantId, alpha, inAlpha } = twoProjects(demo);
    const hidden = demo.createProject({ tenantId, name: 'Hidden team', type: 'team' });
    const secret = demo.seedWorkflow({ name: 'Hidden secret', projectId: hidden.id });
    const shared = demo.seedWorkflow({ name: 'Hidden but shared', projectId: hidden.id });
    demoShares(demo).push({
      tenantId,
      resourceType: 'workflow',
      resourceId: shared.id,
      projectId: alpha.id,
      role: 'workflow:editor',
    });
    demo.projectRelations.push({
      tenantId,
      projectId: alpha.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.setDemoRole('member');
    const { router } = renderApp('/shared/workflows');
    expect(await screen.findByText('Hidden but shared', {}, LONG)).toBeTruthy();
    expect(screen.queryByText('Alpha flow')).toBeNull();
    expect(screen.queryByText('Hidden secret')).toBeNull();
    const badge = screen.getByTestId('project-badge');
    expect(badge.textContent).toContain('Hidden team');
    expect(within(badge).getByLabelText('Shared with 1 project')).toBeTruthy();
    // Overview shows the member's own project and the shared one, not the project they cannot see
    await router.navigate('/home/workflows');
    expect(await screen.findByText('Alpha flow', {}, LONG)).toBeTruthy();
    expect(screen.getByText('Hidden but shared')).toBeTruthy();
    expect(screen.queryByText('Hidden secret')).toBeNull();
    void inAlpha;
    void secret;
  });
});

describe('credentials', () => {
  function credential(demo: MockBackend, name: string, projectId: string, isGlobal = false) {
    const now = new Date().toISOString();
    demo.credentials.push({
      id: `cred-${name}`,
      tenantId: demo.auth().tenant.id,
      name,
      type: 'testAiApi',
      data: {},
      createdAt: now,
      updatedAt: now,
      projectId,
      isGlobal,
    });
    return `cred-${name}`;
  }

  it('Overview shows the home project and the shared count; a project page shows its own', async () => {
    const demo = signedIn();
    const { tenantId, alpha, beta } = twoProjects(demo);
    credential(demo, 'Alpha key', alpha.id);
    credential(demo, 'Gamma key', beta.id);
    const betaId = credential(demo, 'Beta key', beta.id);
    demoShares(demo).push({
      tenantId,
      resourceType: 'credential',
      resourceId: betaId,
      projectId: alpha.id,
      role: 'credential:user',
    });
    const { router } = renderApp('/home/credentials');
    expect(await screen.findByText('Beta key', {}, LONG)).toBeTruthy();
    const betaRow = screen.getByText('Beta key').closest('li') as HTMLElement;
    expect(within(betaRow).getByTestId('project-badge').textContent).toContain('Beta team');
    expect(within(betaRow).getByLabelText('Shared with 1 project')).toBeTruthy();
    await router.navigate(`/projects/${alpha.id}/credentials`);
    // its own and what was shared to it, not the other project's unshared credential
    await waitFor(() => {
      expect(screen.queryByText('Gamma key')).toBeNull();
      expect(screen.getByText('Alpha key')).toBeTruthy();
      expect(screen.getByText('Beta key')).toBeTruthy();
    }, LONG);
  });
});

describe('data tables', () => {
  it('lists by project and a table made on a project page goes to that project', async () => {
    const demo = signedIn();
    const { alpha, beta } = twoProjects(demo);
    const made = await demo.handle({
      method: 'POST',
      path: '/data-tables',
      body: { name: 'Alpha table', columns: [], projectId: alpha.id },
    });
    expect(made.status).toBe(200);
    const { router } = renderApp(`/projects/${beta.id}/data-tables`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create a data table' }, LONG));
    const dialog = await screen.findByRole('dialog', { name: 'New data table' });
    await user.type(within(dialog).getByLabelText('Name'), 'Beta table');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/data-tables\//), LONG);
    const list = await demo.handle({ method: 'GET', path: '/data-tables', query: { projectId: beta.id } });
    expect((list.body as { data: { data: Array<{ name: string }> } }).data.data.map((t) => t.name)).toEqual([
      'Beta table',
    ]);
    await router.navigate('/home/data-tables');
    expect(await screen.findByRole('link', { name: 'Alpha table' }, LONG)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Beta table' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Filter by project'), alpha.id);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Beta table' })).toBeNull());
    expect(backend().auth().tenant.id).toBeTruthy();
  });
});
