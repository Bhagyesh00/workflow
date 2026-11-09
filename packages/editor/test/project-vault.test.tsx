/**
 * P6-45: the vault section of a project's settings (secret names, Add store, shared stores, empty state),
 * the system role switch on the workspace page, and the page gates by scope.
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
    demo.memberships.push({ tenantId, userId: id, role: 'viewer', globalRole: 'member' });
    demo.projectRelations.push({ tenantId, projectId: project.id, userId: id, role: projectRole });
  };
  return { demo, tenantId, project, other, addMember };
}

const post = (path: string, body: unknown) => backend().handle({ method: 'POST', path, body });
const patch = (path: string, body: unknown) => backend().handle({ method: 'PATCH', path, body });

async function seedStore(path: string, key: string, extra: Record<string, unknown> = {}) {
  await post(path, { providerKey: key, type: 'vault', settings: { url: 'https://vault.example.com' } });
  await patch(`${path}/${key}`, { isEnabled: true, ...extra });
}

describe('project vault section', () => {
  it('shows the empty state with Add store and Share a store for an owner', async () => {
    const { project } = setup();
    renderApp(`/projects/${project.id}/settings`);
    expect(await screen.findByText('No secrets in this project', {}, T)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add store' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Share a store' }).getAttribute('href')).toBe(
      '/settings/external-secrets',
    );
  });

  it('adds a store to the project, turns it on and lists its secret names', async () => {
    const { demo, project } = setup();
    renderApp(`/projects/${project.id}/settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add store' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' }, T);
    await user.type(within(dialog).getByLabelText('Connection name'), 'growthVault');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(demo.ext.secrets).toBeTruthy());
    await screen.findByTestId('project-store-growthVault', {}, T);
    expect(
      (demo.ext.secrets as { connections: Array<{ projectId?: string }> }).connections[0]?.projectId,
    ).toBe(project.id);
    expect(screen.getByText('No secrets in this project')).toBeTruthy();

    const user2 = userEvent.setup();
    await user2.click(screen.getByRole('switch', { name: 'growthVault enabled' }));
    expect(await screen.findByText('apiKey', {}, T)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Secret names' });
    expect(within(table).getAllByText('growthVault')).toHaveLength(3);
  });

  it('lists a workspace store shared with the project, and not one shared with another project', async () => {
    const { project, other } = setup();
    await seedStore('/secret-providers/connections', 'sharedVault', { projectIds: [project.id] });
    await seedStore('/secret-providers/connections', 'opsVault', { projectIds: [other.id] });
    await seedStore('/secret-providers/connections', 'wideVault');
    renderApp(`/projects/${project.id}/settings`);
    const card = await screen.findByTestId('project-store-sharedVault', {}, T);
    expect(within(card).getByText('Shared by the workspace')).toBeTruthy();
    expect(screen.queryByTestId('project-store-opsVault')).toBeNull();
    expect(screen.queryByTestId('project-store-wideVault')).toBeNull();
    expect(screen.getAllByText('sharedVault').length).toBeGreaterThan(0);
    // the workspace page says who a store is shared with
  });

  it('deletes a store of the project after a confirmation', async () => {
    const { project } = setup();
    await seedStore(`/secret-providers/projects/${project.id}/connections`, 'gone');
    renderApp(`/projects/${project.id}/settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete gone' }, T));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete store' }));
    await waitFor(() => expect(screen.queryByTestId('project-store-gone')).toBeNull());
  });

  it('a project admin sees no vault section until the system role switch is on', async () => {
    const { demo, tenantId, project, addMember } = setup();
    addMember('u-pam', 'Pam Admin', 'project:admin');
    demo.signIn('pam@example.com');
    const first = renderApp(`/projects/${project.id}/settings`);
    await screen.findByRole('heading', { name: 'Danger zone' }, T);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'External secrets' })).toBeNull(), T);
    first.unmount();

    demo.signIn('owner@example.com');
    const on = await post('/external-secrets/settings', { systemRolesEnabled: true });
    expect(on.body).toEqual({ data: { systemRolesEnabled: true } });
    demo.signIn('pam@example.com');
    renderApp(`/projects/${project.id}/settings`);
    expect(await screen.findByRole('button', { name: 'Add store' }, T)).toBeTruthy();
    expect(tenantId).toBeTruthy();
  });

  it('a project editor reads secret names with the switch on but cannot add a store', async () => {
    const { demo, project, addMember } = setup();
    await seedStore('/secret-providers/connections', 'sharedVault', { projectIds: [project.id] });
    await post('/external-secrets/settings', { systemRolesEnabled: true });
    addMember('u-ed', 'Eddie Editor', 'project:editor');
    demo.signIn('ed@example.com');
    renderApp(`/projects/${project.id}/settings`);
    expect(await screen.findByText('apiKey', {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add store' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Share a store' })).toBeNull();
  });

  it('refuses the project routes to a project viewer', async () => {
    const { demo, project, addMember } = setup();
    addMember('u-vic', 'Vic Viewer', 'project:viewer');
    demo.signIn('vic@example.com');
    const res = await backend().handle({
      method: 'GET',
      path: `/secret-providers/projects/${project.id}/connections`,
    });
    expect(res.status).toBe(403);
  });
});

describe('external secrets page', () => {
  it('has the system role switch, off by default, and turns it on', async () => {
    setup();
    renderApp('/settings/external-secrets');
    const toggle = await screen.findByRole('switch', { name: 'Project roles use project vaults' }, T);
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    const read = await backend().handle({ method: 'GET', path: '/external-secrets/settings' });
    expect(read.body).toEqual({ data: { systemRolesEnabled: true } });
  });

  it('shares a workspace store with a project from the connection dialog', async () => {
    const { demo, project } = setup();
    renderApp('/settings/external-secrets');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add connection' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' }, T);
    await user.type(within(dialog).getByLabelText('Connection name'), 'sharedVault');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Growth' }, T));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const card = await screen.findByTestId('secret-card-sharedVault', {}, T);
    expect(within(card).getByText(/Shared with.*Growth/)).toBeTruthy();
    const stored = (demo.ext.secrets as { connections: Array<{ projectIds?: string[] }> }).connections[0];
    expect(stored?.projectIds).toEqual([project.id]);
  });

  it('is closed to an old editor and open to a custom role with the vault scope', async () => {
    const { demo } = setup();
    demo.setDemoRole('editor');
    renderApp('/settings/external-secrets');
    expect(await screen.findByText('Only admins can manage external secrets.', {}, T)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'External secrets' })).toBeNull();
  });
});
