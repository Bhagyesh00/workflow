/**
 * P6-13: the Members page under SSO: the Invite button is disabled with a tooltip while SAML or OIDC (or role
 * provisioning) manages members, a reader without `provisioning:manage` (403) counts as "not provisioned", and
 * the per-member password sign-in switch shows only under SSO, for `user:update`, and saves.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useInviteGate } from '../src/lib/invite-gate';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };

function addMember(id: string, name: string, extra: Record<string, unknown> = {}) {
  const demo = backend();
  demo.users.push({ id, email: `${id}@example.com`, name, password: 'x' });
  demo.memberships.push({ tenantId: demo.auth().tenant.id, userId: id, role: 'member', ...extra });
}

const rowOf = async (text: string) => {
  const hits = await screen.findAllByText(new RegExp(`^${text}`), {}, T);
  return hits.map((h) => h.closest('li[class*="border-b"]')).find(Boolean) as HTMLElement;
};

function Probe() {
  const gate = useInviteGate();
  return <p data-testid="gate">{gate.disabled ? `off: ${gate.reason}` : 'on'}</p>;
}

describe('Invite under SSO', () => {
  it('is enabled when the workspace signs in by email', async () => {
    signedIn();
    renderApp('/settings/members');
    const invite = (await screen.findByRole('button', { name: 'Invite' }, T)) as HTMLButtonElement;
    await waitFor(() => expect(backend().requests.some((r) => r.path === '/auth/sso-options')).toBe(true), T);
    expect(invite.disabled).toBe(false);
    expect(invite.title).toBe('');
  });

  it('is disabled with a tooltip while SAML manages members', async () => {
    const demo = signedIn();
    demo.setDemoSso({ method: 'saml', label: 'Acme', redirect: false });
    renderApp('/settings/members');
    const invite = (await screen.findByRole('button', { name: 'Invite' }, T)) as HTMLButtonElement;
    await waitFor(() => expect(invite.disabled).toBe(true), T);
    expect(invite.title).toBe('Members are managed by your identity provider while SAML sign-in is on.');
  });

  it('is disabled while OIDC manages members', async () => {
    const demo = signedIn();
    demo.setDemoSso({ method: 'oidc', label: null, redirect: false });
    renderApp('/settings/members');
    const invite = (await screen.findByRole('button', { name: 'Invite' }, T)) as HTMLButtonElement;
    await waitFor(() => expect(invite.disabled).toBe(true), T);
    expect(invite.title).toContain('OIDC');
  });

  it('is disabled with a tooltip while the identity provider provides workspace roles', async () => {
    const demo = signedIn();
    demo.setDemoProvisioning({
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: false,
      scopesUseExpressionMapping: false,
      scopesName: 'workflow',
      scopesInstanceRoleClaimName: 'instance_role',
      scopesProjectsRolesClaimName: 'projects',
    });
    renderApp('/settings/members');
    const invite = (await screen.findByRole('button', { name: 'Invite' }, T)) as HTMLButtonElement;
    await waitFor(() => expect(invite.disabled).toBe(true), T);
    expect(invite.title).toBe(
      'Roles come from your identity provider, so people are added there and not by invitation.',
    );
  });

  it('treats a 403 from the provisioning config as "not provisioned"', async () => {
    const demo = signedIn();
    demo.setDemoProvisioning({
      scopesProvisionInstanceRole: true,
      scopesProvisionProjectRoles: false,
      scopesUseExpressionMapping: false,
      scopesName: 'workflow',
      scopesInstanceRoleClaimName: 'instance_role',
      scopesProjectsRolesClaimName: 'projects',
    });
    demo.setDemoRole('member');
    expect((await demo.handle({ method: 'GET', path: '/sso/provisioning/config' })).status).toBe(403);
    withProviders(<Probe />);
    await waitFor(
      () =>
        expect(
          backend().requests.filter((r) => r.path === '/sso/provisioning/config').length,
        ).toBeGreaterThan(0),
      T,
    );
    await waitFor(() => expect(screen.getByTestId('gate').textContent).toBe('on'), T);
  });
});

describe('password sign-in switch on a member row', () => {
  it('is not shown while the workspace signs in by email', async () => {
    signedIn();
    addMember('u-ann', 'Ann Member');
    renderApp('/settings/members');
    await rowOf('Ann Member');
    await waitFor(() => expect(backend().requests.some((r) => r.path === '/auth/sso-options')).toBe(true), T);
    expect(screen.queryByRole('switch', { name: /Allow password sign-in/ })).toBeNull();
  });

  it('shows under SSO on members but not on the owner, and saves', async () => {
    const user = userEvent.setup();
    const demo = signedIn();
    demo.setDemoSso({ method: 'saml', label: null, redirect: false });
    addMember('u-ann', 'Ann Member');
    renderApp('/settings/members');
    const ann = await rowOf('Ann Member');
    const toggle = (await within(ann).findByRole(
      'switch',
      { name: 'Allow password sign-in for Ann Member' },
      T,
    )) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const owner = await rowOf('Olive Owner');
    expect(within(owner).queryByRole('switch', { name: /Allow password sign-in/ })).toBeNull();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'), T);
    const sent = backend()
      .requests.filter((r) => r.method === 'PATCH' && r.path === '/members/u-ann/sso-settings')
      .at(-1);
    expect(sent?.body).toEqual({ allowSsoManualLogin: true });
    expect(backend().memberships.find((m) => m.userId === 'u-ann')?.allowSsoManualLogin).toBe(true);

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'), T);
    expect(backend().memberships.find((m) => m.userId === 'u-ann')?.allowSsoManualLogin).toBe(false);
  });

  it('reads the saved flag of a member', async () => {
    const demo = signedIn();
    demo.setDemoSso({ method: 'oidc', label: null, redirect: false });
    addMember('u-bo', 'Bo Allowed', { allowSsoManualLogin: true });
    renderApp('/settings/members');
    const row = await rowOf('Bo Allowed');
    const toggle = await within(row).findByRole(
      'switch',
      { name: 'Allow password sign-in for Bo Allowed' },
      T,
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
