/**
 * P6-02 (L13): Settings > Authentication > SCIM provisioning: the enable switch and its SSO hint, the base
 * URL, the token shown once (create, rotate, revoke), the removal policy with the transfer picker, a member
 * without `scim:manage`, and the demo routes with the server's texts.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

/** the workspace's SSO method as `GET /sso/method` answers it */
function ssoMethodIs(method: 'email' | 'saml' | 'oidc' | 'ldap') {
  server.use(http.get(/\/rest\/sso\/method$/, () => HttpResponse.json({ data: { method } })));
}

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const team = demo.createProject({ tenantId, name: 'Receiving team', type: 'team' });
  return { demo, tenantId, team };
}

async function call(method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

describe('the SCIM page', () => {
  it('shows the base URL, no token and the switch off', async () => {
    setup();
    ssoMethodIs('saml');
    renderApp('/settings/scim');
    expect(await screen.findByText('SCIM provisioning', {}, T)).toBeTruthy();
    expect((screen.getByLabelText('SCIM base URL') as HTMLInputElement).value).toBe(
      'https://workflow.example.com/scim/v2',
    );
    expect(screen.getByTestId('scim-token-state').textContent).toContain('No token yet');
    expect(
      screen.getByRole('switch', { name: 'Enable SCIM provisioning' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke token' })).toBeNull();
  });

  it('turns SCIM on when SAML is the sign-in', async () => {
    setup();
    backend().setDemoSso({ method: 'saml', redirect: false });
    ssoMethodIs('saml');
    renderApp('/settings/scim');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Enable SCIM provisioning' }, T);
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'), T);
    expect((await call('GET', '/scim/config')).body.data.enabled).toBe(true);
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'), T);
  });

  it('disables the switch with a hint while email sign-in is on', async () => {
    setup();
    ssoMethodIs('email');
    renderApp('/settings/scim');
    const hint = await screen.findByTestId('scim-sso-hint', {}, T);
    expect(hint.textContent).toContain('Turn on SAML or OIDC single sign-on first');
    expect(
      (screen.getByRole('switch', { name: 'Enable SCIM provisioning' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('leaves the decision to the server when the sign-in method cannot be read', async () => {
    setup();
    server.use(
      http.get(/\/rest\/sso\/method$/, () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );
    renderApp('/settings/scim');
    const toggle = await screen.findByRole('switch', { name: 'Enable SCIM provisioning' }, T);
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    const user = userEvent.setup();
    await user.click(toggle);
    expect(
      await screen.findByText(
        'Turn on SAML or OIDC single sign-on before you enable SCIM provisioning.',
        {},
        T,
      ),
    ).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('creates a token shown once, then shows only its last four; rotate asks first; revoke removes it', async () => {
    setup();
    ssoMethodIs('saml');
    const { queryClient } = renderApp('/settings/scim');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create token' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Copy your SCIM token' }, T);
    const token = within(dialog).getByTestId('new-scim-token').textContent ?? '';
    expect(token).toMatch(/^wfs_scim_[A-Za-z0-9_-]{43}$/);
    await user.click(within(dialog).getByRole('button', { name: 'I copied it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy your SCIM token' })).toBeNull());
    // the token leaves the mutation cache too
    const cached = () =>
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      );
    await waitFor(() => expect(cached()).not.toContain(token), T);
    await waitFor(
      () => expect(screen.getByTestId('scim-token-state').textContent).toContain(token.slice(-4)),
      T,
    );
    // the page and the server's config never show the token again
    expect(document.body.textContent).not.toContain(token);
    expect(JSON.stringify((await call('GET', '/scim/config')).body)).not.toContain(token);

    await user.click(screen.getByRole('button', { name: 'Rotate token' }));
    const confirm = await screen.findByRole('dialog', { name: 'Create a new token?' }, T);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('new-scim-token')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Rotate token' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Create a new token?' }, T)).getByRole('button', {
        name: 'Create new token',
      }),
    );
    const next = (await screen.findByTestId('new-scim-token', {}, T)).textContent ?? '';
    expect(next).not.toBe(token);
    await user.click(screen.getByRole('button', { name: 'I copied it' }));

    await user.click(screen.getByRole('button', { name: 'Revoke token' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Revoke the token?' }, T)).getByRole('button', {
        name: 'Revoke token',
      }),
    );
    await waitFor(
      () => expect(screen.getByTestId('scim-token-state').textContent).toContain('No token yet'),
      T,
    );
    expect((await call('GET', '/scim/config')).body.data).toMatchObject({ hasToken: false, tokenHint: null });
  });

  it('saves the removal policy with a transfer target', async () => {
    const { team } = setup();
    ssoMethodIs('saml');
    renderApp('/settings/scim');
    const user = userEvent.setup();
    const save = (await screen.findByRole('button', { name: 'Save' }, T)) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // the work choice only appears for a removal
    expect(screen.queryByText('Their work')).toBeNull();
    await user.click(screen.getByLabelText(/^Remove the member/));
    expect(screen.getByText('Their work')).toBeTruthy();
    await waitFor(() => expect(save.disabled).toBe(false));
    const picker = screen.getByLabelText('Move work to') as HTMLSelectElement;
    await waitFor(
      () => expect(within(picker).getByRole('option', { name: 'Receiving team' })).toBeTruthy(),
      T,
    );
    expect(within(picker).getByRole('option', { name: "The owner's personal project" })).toBeTruthy();
    await user.selectOptions(picker, team.id);
    await user.click(save);
    await waitFor(
      async () =>
        expect((await call('GET', '/scim/config')).body.data).toMatchObject({
          onDelete: 'delete',
          dataAction: 'transfer',
          transferProjectId: team.id,
        }),
      T,
    );
    await waitFor(() => expect(save.disabled).toBe(true), T);

    // deleting the work needs no target
    await user.click(screen.getByLabelText('Delete it'));
    expect(screen.queryByLabelText('Move work to')).toBeNull();
    await user.click(save);
    await waitFor(
      async () =>
        expect((await call('GET', '/scim/config')).body.data).toMatchObject({
          dataAction: 'delete',
          transferProjectId: null,
        }),
      T,
    );
  });

  it('shows a member without scim:manage a note, and asks nothing', async () => {
    const { demo, tenantId } = setup();
    demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-sam', role: 'member' });
    demo.signIn('sam@example.com');
    renderApp('/settings/scim');
    expect(await screen.findByText('Only admins can manage SCIM provisioning.', {}, T)).toBeTruthy();
    expect(demo.requests.some((r) => r.path.startsWith('/scim'))).toBe(false);
  });
});

describe('the demo SCIM routes', () => {
  it('answer the server texts: 403 for a member, 400 without SSO, 404 for another workspace project', async () => {
    const { demo, tenantId } = setup();
    expect((await call('PATCH', '/scim/config', { enabled: true })).body.error?.message).toBe(
      'Turn on SAML or OIDC single sign-on before you enable SCIM provisioning.',
    );
    demo.setDemoSso({ method: 'oidc', redirect: false });
    expect((await call('PATCH', '/scim/config', { enabled: true })).body.data.enabled).toBe(true);
    expect((await call('PATCH', '/scim/config', { enabled: 'yes' })).status).toBe(400);
    expect(
      (
        await call('PUT', '/scim/deprovisioning', {
          onDelete: 'disable',
          dataAction: 'transfer',
          transferProjectId: 'nope',
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('PUT', '/scim/deprovisioning', { onDelete: 'x', dataAction: 'transfer' })).status,
    ).toBe(400);

    demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-sam', role: 'member' });
    demo.signIn('sam@example.com');
    const refused = await call('GET', '/scim/config');
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe('User is missing a scope required to perform this action');
  });

  it('list team projects and the personal projects of active members as transfer targets', async () => {
    const { demo, tenantId, team } = setup();
    demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
    demo.memberships.push({ tenantId, userId: 'u-sam', role: 'member', status: 'disabled' });
    const samHome = demo.createProject({
      tenantId,
      name: 'Sam Shaw',
      type: 'personal',
      ownerUserId: 'u-sam',
    });
    const targets = (await call('GET', '/scim/transfer-targets')).body.data as Array<{
      id: string;
      type: string;
    }>;
    expect(targets.map((t) => t.id)).toContain(team.id);
    expect(targets.map((t) => t.id)).not.toContain(samHome.id);
  });
});
