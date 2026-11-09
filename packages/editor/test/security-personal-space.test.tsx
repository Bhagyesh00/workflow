/**
 * P6-33: Settings > Security, personal space: the publishing and sharing switches with the existing counts,
 * the confirm on turning off (cancel changes nothing), turning off undoes nothing, and no section for
 * a member without `securitySettings:manage`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { demoShares } from '../src/demo/mock-sharing';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

/** the owner's workspace with 2 published and 1 shared workflow and 1 shared credential in a personal project */
function setup() {
  const demo = signedIn();
  const { tenant, user } = demo.auth();
  const personal = demo.personalProject(tenant.id, user.id);
  const team = demo.oldestTeamProject(tenant.id);
  const shared = demo.seedWorkflow({
    name: 'Shared flow',
    projectId: personal.id,
    active: true,
  });
  demo.seedWorkflow({
    name: 'Live flow',
    projectId: personal.id,
    active: true,
  });
  demo.seedWorkflow({ name: 'Draft flow', projectId: personal.id });
  demo.seedWorkflow({ name: 'Team live', projectId: team.id, active: true });
  demo.credentials.push({
    id: 'cred-1',
    name: 'Mine',
    type: 'httpHeaderAuth',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: personal.id,
    tenantId: tenant.id,
    data: {},
  } as never);
  demoShares(demo).push(
    {
      tenantId: tenant.id,
      resourceType: 'workflow',
      resourceId: shared.id,
      projectId: team.id,
      role: 'workflow:editor',
    },
    {
      tenantId: tenant.id,
      resourceType: 'credential',
      resourceId: 'cred-1',
      projectId: team.id,
      role: 'credential:user',
    },
  );
  return { demo, tenantId: tenant.id };
}

const policyOf = (tenantId: string) =>
  (
    backend() as unknown as {
      settingsOf(id: string): { securityPolicy: Record<string, boolean> };
    }
  ).settingsOf(tenantId).securityPolicy;

describe('personal space section', () => {
  it('shows both switches on with the existing counts', async () => {
    setup();
    renderApp('/settings/security');
    const publishing = await screen.findByRole('switch', { name: 'Publishing from personal projects' }, T);
    const sharing = screen.getByRole('switch', {
      name: 'Sharing from personal projects',
    });
    expect(publishing.getAttribute('aria-checked')).toBe('true');
    expect(sharing.getAttribute('aria-checked')).toBe('true');
    await waitFor(() =>
      expect(screen.getByTestId('personalSpacePublishing-count').textContent).toContain(
        '2 workflows are published',
      ),
    );
    expect(screen.getByTestId('personalSpaceSharing-count').textContent).toBe(
      '1 workflow is and 1 credential is shared from personal projects now.',
    );
  });

  it('asks before turning off, names the count, and a cancel changes nothing', async () => {
    const { tenantId } = setup();
    renderApp('/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Publishing from personal projects' }, T));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Turn off publishing from personal projects?' },
      T,
    );
    expect(within(dialog).getByText(/2 workflows stay published/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(policyOf(tenantId).personalSpacePublishing).toBe(true);
    expect(
      screen.getByRole('switch', { name: 'Publishing from personal projects' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('turning off after the confirm saves the flag and undoes nothing; turning on needs no confirm', async () => {
    const { demo, tenantId } = setup();
    renderApp('/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Sharing from personal projects' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off sharing from personal projects?' }, T);
    expect(within(dialog).getByText(/1 workflow and 1 credential stay shared/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(policyOf(tenantId).personalSpaceSharing).toBe(false));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Sharing from personal projects' }).getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(policyOf(tenantId).personalSpacePublishing).toBe(true);
    expect(demoShares(demo)).toHaveLength(2);
    expect(demo.workflows.filter((w) => w.publishedVersionId !== null)).toHaveLength(3);
    expect(screen.getByTestId('personalSpaceSharing-count').textContent).toContain('1 workflow is');

    await user.click(screen.getByRole('switch', { name: 'Sharing from personal projects' }));
    await waitFor(() => expect(policyOf(tenantId).personalSpaceSharing).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows no switches to a member without securitySettings:manage', async () => {
    const { demo } = setup();
    demo.setDemoRole('member');
    renderApp('/settings/security');
    expect(
      await screen.findByText('Only admins can change the personal space settings.', {}, T),
    ).toBeTruthy();
    expect(
      screen.queryByRole('switch', {
        name: 'Publishing from personal projects',
      }),
    ).toBeNull();
  });
});
