/**
 * P6-41: the project pages on the demo backend: Overview (`/home/*`), Shared with you, a project and the
 * personal project, with header, tabs in n8n's order, the Create button gated by scopes, the current project
 * set from the route; and the demo's project API (create, change, members, delete with a transfer or a wipe).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDetail } from '../src/api/types';
import { MISSING_SCOPE } from '../src/demo/mock-backend';
import { useProjectStore } from '../src/stores/project-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

async function tabs() {
  const nav = await screen.findByRole('navigation', { name: 'Project sections' }, { timeout: 20_000 });
  return {
    nav,
    names: within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent),
    hrefs: within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href')),
  };
}

beforeEach(() => useProjectStore.getState().setCurrentProject(null));

describe('project pages', () => {
  it('Overview has the title, the four tabs in n8n order and a Create button', async () => {
    signedIn();
    renderApp('/home/workflows');
    expect(await screen.findByRole('heading', { name: 'Overview' }, { timeout: 20_000 })).toBeTruthy();
    const { names, hrefs } = await tabs();
    expect(names).toEqual(['Workflows', 'Credentials', 'Executions', 'Data tables']);
    expect(hrefs).toEqual(['/home/workflows', '/home/credentials', '/home/executions', '/home/data-tables']);
    expect(await screen.findByRole('button', { name: 'Create' })).toBeTruthy();
    expect(useProjectStore.getState().currentProjectId).toBeNull();
  });

  it('Shared with you has Workflows and Credentials and no Create button', async () => {
    signedIn();
    renderApp('/shared/workflows');
    expect(await screen.findByRole('heading', { name: 'Shared with you' }, { timeout: 20_000 })).toBeTruthy();
    expect((await tabs()).names).toEqual(['Workflows', 'Credentials']);
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('a project shows its name and icon, adds Variables and Settings, and sets the current project', async () => {
    const demo = signedIn();
    const team = demo.oldestTeamProject(demo.auth().tenant.id);
    renderApp(`/projects/${team.id}/workflows`);
    expect(await screen.findByRole('heading', { name: team.name }, { timeout: 20_000 })).toBeTruthy();
    await waitFor(async () =>
      expect((await tabs()).names).toEqual([
        'Workflows',
        'Credentials',
        'Executions',
        'Data tables',
        'Variables',
        'Settings',
      ]),
    );
    expect((await tabs()).hrefs.at(-1)).toBe(`/projects/${team.id}/settings`);
    expect(useProjectStore.getState().currentProjectId).toBe(team.id);
  });

  it('the personal project is titled Personal and has no Settings tab', async () => {
    const demo = signedIn();
    const personal = demo.personalProject(demo.auth().tenant.id, demo.auth().user.id);
    renderApp(`/projects/${personal.id}/credentials`);
    expect(await screen.findByRole('heading', { name: 'Personal' }, { timeout: 20_000 })).toBeTruthy();
    await waitFor(async () => expect((await tabs()).names).toContain('Executions'));
    expect((await tabs()).names).not.toContain('Settings');
  });

  it('a project that does not exist, or is in another workspace, says so', async () => {
    const demo = signedIn();
    const other = demo.createProject({ tenantId: 'other-workspace', name: 'Elsewhere', type: 'team' });
    const { router } = renderApp('/projects/nope/workflows');
    expect(await screen.findByText('Project not found', {}, { timeout: 20_000 })).toBeTruthy();
    await act(() => router.navigate(`/projects/${other.id}/workflows`));
    expect(await screen.findByText('Project not found')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).toBeNull();
  });

  it('a member of one project cannot open another', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const hidden = demo.createProject({ tenantId, name: 'Hidden', type: 'team' });
    demo.setDemoRole('member');
    renderApp(`/projects/${hidden.id}/workflows`);
    expect(await screen.findByText('You cannot open this project', {}, { timeout: 20_000 })).toBeTruthy();
    expect(screen.getByText(MISSING_SCOPE)).toBeTruthy();
  });

  it('an old viewer gets no Create button and no Settings tab', async () => {
    const demo = signedIn();
    const team = demo.oldestTeamProject(demo.auth().tenant.id);
    demo.setDemoRole('viewer');
    renderApp(`/projects/${team.id}/workflows`);
    expect(await screen.findByRole('heading', { name: team.name }, { timeout: 20_000 })).toBeTruthy();
    await tabs();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect((await tabs()).names).not.toContain('Settings');
  });
});

describe('Create button', () => {
  it('offers workflow, credential, folder, data table and variable on a project', async () => {
    const demo = signedIn();
    const team = demo.oldestTeamProject(demo.auth().tenant.id);
    renderApp(`/projects/${team.id}/workflows`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Create' }, { timeout: 20_000 }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Workflow', 'Credential', 'Folder', 'Data table', 'Variable']);
  });

  it('Workflow creates in the project and opens it', async () => {
    const demo = signedIn();
    const team = demo.oldestTeamProject(demo.auth().tenant.id);
    const { router } = renderApp(`/projects/${team.id}/workflows`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create' }, { timeout: 20_000 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Workflow' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/workflow\/[^/]+$/), {
      timeout: 20_000,
    });
    const created = demo.workflows.find((w) => w.name === 'My workflow');
    expect(created?.projectId).toBe(team.id);
  });

  it('on Overview it creates in the personal project', async () => {
    const demo = signedIn();
    const personal = demo.personalProject(demo.auth().tenant.id, demo.auth().user.id);
    const { router } = renderApp('/home/workflows');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create' }, { timeout: 20_000 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Workflow' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/workflow\//), { timeout: 20_000 });
    expect(demo.workflows.find((w) => w.name === 'My workflow')?.projectId).toBe(personal.id);
  });

  it('Folder opens the folder dialog and Variable goes to the project variables tab', async () => {
    const demo = signedIn();
    const team = demo.oldestTeamProject(demo.auth().tenant.id);
    const { router } = renderApp(`/projects/${team.id}/workflows`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create' }, { timeout: 20_000 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Folder' }));
    expect(await screen.findByRole('dialog', { name: 'New folder' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Variable' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${team.id}/variables`));
  });

  it('a project viewer relation hides what the role cannot create', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const project = demo.createProject({ tenantId, name: 'Read only', type: 'team' });
    demo.projectRelations.push({
      tenantId,
      projectId: project.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.setDemoRole('member');
    renderApp(`/projects/${project.id}/workflows`);
    expect(await screen.findByRole('heading', { name: 'Read only' }, { timeout: 20_000 })).toBeTruthy();
    await tabs();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });
});

describe('demo project API', () => {
  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) {
    const res = await backend().handle({ method, path, body, query });
    return { status: res.status, body: res.body as { data?: unknown; error?: { message: string } } };
  }
  const detail = (r: { body: { data?: unknown } }) => r.body.data as ProjectDetail;

  beforeEach(() => void signedIn());

  it('creates a team project the caller administers, and rejects a bad name', async () => {
    const res = await call('POST', '/projects', { name: '  Growth ', icon: { type: 'emoji', value: 'X' } });
    expect(res.status).toBe(200);
    const created = detail(res);
    expect(created).toMatchObject({ name: 'Growth', type: 'team', icon: { type: 'emoji', value: 'X' } });
    expect(created.relations.map((r) => r.role)).toEqual(['project:admin']);
    expect(created.scopes).toContain('project:update');
    expect((await call('POST', '/projects', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/projects', { name: 'Bad', icon: { type: 'x', value: 'y' } })).status).toBe(
      400,
    );
  });

  it('refuses create without project:create', async () => {
    backend().setDemoRole('viewer');
    const res = await call('POST', '/projects', { name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toBe(MISSING_SCOPE);
  });

  it('changes a team project and refuses a personal one', async () => {
    const team = detail(await call('POST', '/projects', { name: 'Old' }));
    const patched = detail(
      await call('PATCH', `/projects/${team.id}`, {
        name: 'New',
        description: 'About it',
        icon: { type: 'icon', value: 'rocket' },
      }),
    );
    expect(patched).toMatchObject({ name: 'New', description: 'About it', icon: { value: 'rocket' } });
    const personal = detail(await call('GET', '/projects/personal'));
    const res = await call('PATCH', `/projects/${personal.id}`, { name: 'Mine' });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("Can't update a personal project.");
  });

  it('adds members with conflicts, changes a role and removes a member', async () => {
    const demo = backend();
    const tenantId = demo.auth().tenant.id;
    const sam = demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam', password: 'x' });
    expect(sam).toBeGreaterThan(0);
    demo.memberships.push({ tenantId, userId: 'u-sam', role: 'member' });
    const team = detail(await call('POST', '/projects', { name: 'Crew' }));
    const add = (role: string) =>
      call('POST', `/projects/${team.id}/users`, { relations: [{ userId: 'u-sam', role }] });
    expect((await add('project:editor')).status).toBe(200);
    // already a member with another role: nothing added, a conflict
    const again = await add('project:viewer');
    expect(again.status).toBe(409);
    expect((await add('project:editor')).status).toBe(200);
    expect((await add('project:nope')).status).toBe(400);
    expect((await add('project:personalOwner')).status).toBe(400);
    expect(
      (
        await call('POST', `/projects/${team.id}/users`, {
          relations: [{ userId: 'ghost', role: 'project:editor' }],
        })
      ).status,
    ).toBe(404);
    expect((await call('PATCH', `/projects/${team.id}/users/u-sam`, { role: 'project:viewer' })).status).toBe(
      200,
    );
    expect(
      detail(await call('GET', `/projects/${team.id}`)).relations.find((r) => r.id === 'u-sam')?.role,
    ).toBe('project:viewer');
    const mine = demo.auth().user.id;
    expect((await call('DELETE', `/projects/${team.id}/users/u-sam`)).status).toBe(200);
    expect((await call('DELETE', `/projects/${team.id}/users/u-sam`)).status).toBe(404);
    // the creator holds project:admin, which is removable; the personal owner is not
    const personal = detail(await call('GET', '/projects/personal'));
    const refused = await call('DELETE', `/projects/${personal.id}/users/${mine}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toBe('Project owner cannot be removed from the project');
    expect((await call('POST', `/projects/${personal.id}/users`, { relations: [] })).status).toBe(400);
  });

  it('deleting a project with a transfer moves its work, without one it wipes it', async () => {
    const demo = backend();
    const from = detail(await call('POST', '/projects', { name: 'From' }));
    const to = detail(await call('POST', '/projects', { name: 'To' }));
    demo.seedWorkflow({ name: 'In from', nodes: [], connections: {}, projectId: from.id });
    const moved = await call('DELETE', `/projects/${from.id}`, undefined, { transferId: to.id });
    expect(moved.status).toBe(200);
    expect(demo.workflows.find((w) => w.name === 'In from')?.projectId).toBe(to.id);
    expect((await call('GET', `/projects/${from.id}`)).status).toBe(404);

    demo.seedWorkflow({ name: 'In to', nodes: [], connections: {}, projectId: to.id });
    expect((await call('DELETE', `/projects/${to.id}`)).status).toBe(200);
    expect(demo.workflows.some((w) => w.name === 'In from' || w.name === 'In to')).toBe(false);
    expect(demo.projectRelations.some((r) => r.projectId === to.id)).toBe(false);
  });

  it('refuses to delete a personal project, or to transfer into the project itself', async () => {
    const personal = detail(await call('GET', '/projects/personal'));
    const res = await call('DELETE', `/projects/${personal.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe(
      `Can't delete project. Project with ID ${personal.id} is not a team project.`,
    );
    const team = detail(await call('POST', '/projects', { name: 'Self' }));
    expect((await call('DELETE', `/projects/${team.id}`, undefined, { transferId: team.id })).status).toBe(
      400,
    );
    expect((await call('DELETE', `/projects/${team.id}`, undefined, { transferId: 'nope' })).status).toBe(
      404,
    );
  });

  it('lists the sharing candidates: every personal project and the visible team projects', async () => {
    const demo = backend();
    const tenantId = demo.auth().tenant.id;
    demo.personalProject(tenantId, 'u-other');
    const res = await call('GET', '/projects/sharing-candidates');
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ name: string; type: string }>;
    expect(rows.filter((r) => r.type === 'personal').length).toBe(
      demo.projects.filter((p) => p.tenantId === tenantId && p.type === 'personal').length,
    );
    expect(rows.some((r) => r.type === 'team')).toBe(true);
  });
});
