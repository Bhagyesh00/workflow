/**
 * P6-13: Settings > Authentication: the hub rows by scope, the SSO page (an admin sets up SAML and OIDC, the
 * copy fields, the test link, the confirm before turning a method on, one method at a time), the secret staying
 * blank on read, other roles seeing nothing, and the SAML onboarding page. The demo routes answer the server's
 * codes and texts.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDemoRole } from '../src/demo/mock-roles';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(method: 'GET' | 'PUT' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

const METADATA_URL = 'https://idp.example.com/metadata';
const OIDC = {
  discoveryEndpoint: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'client-abc',
  clientSecret: 'super-secret-value',
};

afterEach(() => vi.restoreAllMocks());

describe('Authentication hub', () => {
  it('lists SSO, LDAP, two-factor, provisioning and SCIM for an admin and links to each', async () => {
    signedIn();
    renderApp('/settings/authentication');
    expect(await screen.findByRole('heading', { name: 'Authentication' }, T)).toBeTruthy();
    const links = (await screen.findAllByRole('link', {}, T)).map((a) => a.getAttribute('href'));
    for (const to of [
      '/settings/sso',
      '/settings/ldap',
      '/settings/security',
      '/settings/provisioning',
      '/settings/scim',
    ]) {
      expect(links).toContain(to);
    }
    expect(await screen.findByText('Single sign-on', undefined, T)).toBeTruthy();
  });

  it('shows the state of the active method', async () => {
    signedIn();
    await call('POST', '/sso/saml/config', { metadataUrl: METADATA_URL });
    await call('POST', '/sso/saml/config/toggle', { loginEnabled: true });
    renderApp('/settings/authentication');
    expect(await screen.findByText('People sign in with SAML.', undefined, T)).toBeTruthy();
  });

  it('shows no hub, no SSO page and no Authentication link to a member', async () => {
    signedIn();
    backend().setDemoRole('member');
    renderApp('/settings/authentication');
    expect(
      await screen.findByText(/don't have access to the authentication settings/, undefined, T),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Authentication' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Single sign-on/ })).toBeNull();
  });

  it('lists only the rows a role holds the scope for, with the nav link, when it holds no sign-in method scope', async () => {
    const mock = signedIn();
    addDemoRole(mock, {
      tenantId: mock.auth().tenant.id,
      slug: 'global:idp-operator',
      displayName: 'IdP operator',
      description: null,
      systemRole: false,
      roleType: 'global',
      scopes: ['scim:manage', 'provisioning:manage'],
    });
    mock.setDemoRole('global:idp-operator');
    const first = renderApp('/settings/account');
    const link = await screen.findByRole('link', { name: 'Authentication' }, T);
    expect(link.getAttribute('href')).toBe('/settings/authentication');
    first.unmount();
    renderApp('/settings/authentication');
    expect(await screen.findByText('SCIM', undefined, T)).toBeTruthy();
    const links = (await screen.findAllByRole('link', {}, T)).map((a) => a.getAttribute('href'));
    expect(links).toContain('/settings/scim');
    expect(links).toContain('/settings/provisioning');
    expect(links).not.toContain('/settings/sso');
    expect(links).not.toContain('/settings/ldap');
    expect(screen.queryByText(/don't have access to the authentication settings/)).toBeNull();
  });

  it('shows a member who opens the SSO page no form', async () => {
    signedIn();
    backend().setDemoRole('member');
    renderApp('/settings/sso');
    expect(
      await screen.findByText(/don't have access to the single sign-on settings/, undefined, T),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Metadata URL')).toBeNull();
  });
});

describe('SSO settings page', () => {
  it('lets an admin set up SAML, shows the values for the provider and tests the sign-in', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    signedIn();
    renderApp('/settings/sso');
    expect(await screen.findByRole('heading', { name: 'SAML settings' }, T)).toBeTruthy();
    // nothing saved: the switch and the test wait
    expect((screen.getByRole('switch', { name: 'Allow SAML sign-in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Test SAML sign-in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('Email attribute') as HTMLInputElement).value).toMatch(/emailaddress$/);

    await user.type(screen.getByLabelText('Metadata URL'), METADATA_URL);
    await user.selectOptions(screen.getByLabelText('Sign-in binding'), 'post');
    await user.clear(screen.getByLabelText('Sign-in button label'));
    await user.type(screen.getByLabelText('Sign-in button label'), 'Acme SSO');
    await user.click(screen.getByLabelText(/Refuse sign-ins whose email/));
    await user.click(screen.getByRole('button', { name: 'Save SAML settings' }));

    await waitFor(
      () =>
        expect(backend().requests.some((r) => r.path === '/sso/saml/config' && r.method === 'POST')).toBe(
          true,
        ),
      T,
    );
    const sent = backend()
      .requests.filter((r) => r.path === '/sso/saml/config' && r.method === 'POST')
      .at(-1);
    expect(sent?.body).toMatchObject({
      metadataUrl: METADATA_URL,
      loginBinding: 'post',
      loginLabel: 'Acme SSO',
      emailVerifiedRequired: true,
    });
    expect(sent?.body).not.toHaveProperty('loginEnabled');

    const entity = (await screen.findByLabelText('Entity ID', { exact: true }, T)) as HTMLInputElement;
    expect(entity.value).toMatch(/\/sso\/saml\/.+\/metadata$/);
    expect(entity.readOnly).toBe(true);
    expect(
      (screen.getByLabelText('Assertion consumer service URL', { exact: true }) as HTMLInputElement).value,
    ).toMatch(/\/acs$/);
    expect(screen.getByRole('button', { name: 'Copy Entity ID' })).toBeTruthy();

    const test = screen.getByRole('button', { name: 'Test SAML sign-in' }) as HTMLButtonElement;
    await waitFor(() => expect(test.disabled).toBe(false), T);
    await user.click(test);
    await waitFor(() => expect(open).toHaveBeenCalled(), T);
    expect(String(open.mock.calls[0]?.[0])).toMatch(/initsso\?test=/);
    expect(open.mock.calls[0]?.[2]).toContain('noopener');
  });

  it('asks before turning SAML on, then moves the workspace to SAML and blocks OIDC until it is off', async () => {
    const user = userEvent.setup();
    signedIn();
    await call('POST', '/sso/saml/config', { metadataUrl: METADATA_URL });
    renderApp('/settings/sso');
    const toggle = (await screen.findByRole(
      'switch',
      { name: 'Allow SAML sign-in' },
      T,
    )) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false), T);

    await user.click(toggle);
    expect(await screen.findByText('Turn on SAML sign-in?', undefined, T)).toBeTruthy();
    // cancelled: nothing changes
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((await call('GET', '/sso/method')).body.data).toEqual({ method: 'email' });

    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Turn on SAML' }, T));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'), T);
    expect((await call('GET', '/sso/method')).body.data).toEqual({ method: 'saml' });
    expect(backend().session && (await call('GET', '/auth/sso-options')).body.data).toMatchObject({
      method: 'saml',
      label: 'SAML',
    });

    // OIDC cannot be turned on while SAML is
    await user.selectOptions(screen.getByLabelText('Protocol'), 'oidc');
    expect(await screen.findByRole('heading', { name: 'OpenID Connect settings' }, T)).toBeTruthy();
    expect(await screen.findByText(/SAML sign-in is on\. Turn it off first\./, undefined, T)).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Allow OIDC sign-in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // turning SAML off needs no confirmation
    await user.selectOptions(screen.getByLabelText('Protocol'), 'saml');
    await user.click(await screen.findByRole('switch', { name: 'Allow SAML sign-in' }, T));
    await waitFor(
      async () => expect((await call('GET', '/sso/method')).body.data).toEqual({ method: 'email' }),
      T,
    );
  });

  it('keeps the OIDC client secret blank on read and keeps it on a blank save', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/sso');
    await screen.findByRole('heading', { name: 'SAML settings' }, T);
    await user.selectOptions(screen.getByLabelText('Protocol'), 'oidc');
    await screen.findByRole('heading', { name: 'OpenID Connect settings' }, T);

    await user.type(screen.getByLabelText('Discovery URL'), OIDC.discoveryEndpoint);
    await user.type(screen.getByLabelText('Client ID'), OIDC.clientId);
    await user.type(screen.getByLabelText('Client secret'), OIDC.clientSecret);
    await user.selectOptions(screen.getByLabelText('Prompt'), 'login');
    await user.type(screen.getByLabelText('Authentication context class references'), 'urn:a, urn:b');
    await user.type(screen.getByLabelText('Additional scopes'), 'groups offline_access');
    await user.click(screen.getByLabelText(/Sign people out of the identity provider too/));
    await user.click(screen.getByRole('button', { name: 'Save OIDC settings' }));

    await waitFor(
      () => expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe(''),
      T,
    );
    const first = backend()
      .requests.filter((r) => r.path === '/sso/oidc/config' && r.method === 'POST')
      .at(-1);
    expect(first?.body).toMatchObject({
      clientId: OIDC.clientId,
      clientSecret: OIDC.clientSecret,
      prompt: 'login',
      authenticationContextClassReference: ['urn:a', 'urn:b'],
      additionalScopes: 'groups offline_access',
      rpInitiatedLogoutEnabled: true,
    });
    // the answer never holds the secret
    const read = await call('GET', '/sso/oidc/config');
    expect(read.body.data.clientSecret).toBe('');
    expect(JSON.stringify(read.body)).not.toContain(OIDC.clientSecret);
    expect(
      ((await screen.findByLabelText('Redirect URL', { exact: true }, T)) as HTMLInputElement).value,
    ).toMatch(/\/callback$/);

    // a later save with the secret left blank sends no secret and still works
    await user.type(screen.getByLabelText('Client ID'), '-2');
    await user.click(screen.getByRole('button', { name: 'Save OIDC settings' }));
    await waitFor(
      () => expect((screen.getByLabelText('Client ID') as HTMLInputElement).value).toBe(`${OIDC.clientId}-2`),
      T,
    );
    const second = backend()
      .requests.filter((r) => r.path === '/sso/oidc/config' && r.method === 'POST')
      .at(-1);
    expect(second).not.toBe(first);
    expect(second?.body).not.toHaveProperty('clientSecret');
    expect((await call('GET', '/sso/oidc/config')).body.data.clientId).toBe(`${OIDC.clientId}-2`);
  });

  it('shows the server error when a save is refused', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/sso');
    await screen.findByRole('heading', { name: 'SAML settings' }, T);
    await user.type(screen.getByLabelText('Metadata URL'), 'http://idp.example.com/metadata');
    await user.click(screen.getByRole('button', { name: 'Save SAML settings' }));
    expect(await screen.findByText('The metadata URL must start with https://', undefined, T)).toBeTruthy();
  });
});

describe('SSO demo routes', () => {
  it('answer the server codes and texts', async () => {
    signedIn();
    expect((await call('PUT', '/sso/method', { method: 'saml' })).body.error).toMatchObject({
      code: 'sso_config_missing',
      message: 'Save the SAML settings before turning SAML on.',
    });
    expect((await call('POST', '/sso/oidc/config', { clientId: 'x' })).body.error?.message).toBe(
      'The discovery endpoint is required',
    );
    await call('POST', '/sso/saml/config', { metadataUrl: METADATA_URL });
    await call('POST', '/sso/oidc/config', { ...OIDC });
    expect((await call('PUT', '/sso/method', { method: 'saml' })).status).toBe(200);
    expect((await call('PUT', '/sso/method', { method: 'oidc' })).body.error?.code).toBe(
      'sso_switch_through_email',
    );
    expect((await call('PUT', '/sso/method', { method: 'bogus' })).status).toBe(400);
    expect((await call('PATCH', '/members/nobody/sso-settings', { allowSsoManualLogin: true })).status).toBe(
      404,
    );
    backend().setDemoRole('member');
    for (const [method, path] of [
      ['GET', '/sso/method'],
      ['GET', '/sso/saml/config'],
      ['POST', '/sso/oidc/config'],
      ['PATCH', '/members/x/sso-settings'],
    ] as const) {
      const res = await call(method, path, {});
      expect(res.status).toBe(403);
      expect(res.body.error?.message).toBe('User is missing a scope required to perform this action');
    }
  });
});

describe('SAML onboarding page', () => {
  /**
   * The demo signs in by password only. These make `/auth/me` name a SAML session and make `PATCH /auth/me`
   * answer what the server answers a SAML session: 403 `sso_session_fenced`, except a name when the person has
   * no other workspace (the server's `updateProfile`).
   */
  function asSamlSession(options: { otherWorkspace: boolean }) {
    const demo = backend();
    const handle = demo.handle.bind(demo);
    vi.spyOn(demo, 'handle').mockImplementation(async (request) => {
      if (request.path === '/auth/me' && request.method === 'PATCH' && options.otherWorkspace) {
        return {
          status: 403,
          body: {
            error: { code: 'sso_session_fenced', message: 'This session signed in with single sign-on' },
          },
        };
      }
      const res = await handle(request);
      if (request.path === '/auth/me' && request.method === 'GET' && res.status === 200) {
        const data = (res.body as { data: Record<string, unknown> }).data;
        return { ...res, body: { data: { ...data, authMethod: 'saml', ssoFenced: true } } };
      }
      return res;
    });
  }

  it('asks a SAML session for a name even when the server gave it the email name, saves it and goes to the app', async () => {
    const user = userEvent.setup();
    const demo = signedIn();
    // the server names a person without a name claim after the first part of the email
    demo.auth().user.name = 'owner';
    asSamlSession({ otherWorkspace: false });
    const { router } = renderApp('/saml/onboarding');
    expect(await screen.findByText('Add your name', undefined, T)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Your name/), 'Sam Saml');
    await user.click(button);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/workflows$/), T);
    expect(backend().auth().user.name).toBe('Sam Saml');
    expect(backend().requests.some((r) => r.path === '/auth/me' && r.method === 'PATCH')).toBe(true);
  });

  it('goes to the page the person came for (next) after Continue and after Skip, and drops an unsafe next', async () => {
    const user = userEvent.setup();
    signedIn();
    asSamlSession({ otherWorkspace: false });
    const first = renderApp('/saml/onboarding?next=%2Fsettings%2Faccount');
    await user.type(await screen.findByLabelText(/Your name/, undefined, T), 'Sam Saml');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/settings/account'), T);
    first.unmount();
    const second = renderApp('/saml/onboarding?next=%2Fsettings%2Fmembers');
    await user.click(await screen.findByRole('link', { name: 'Skip for now' }, T));
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/settings/members'), T);
    second.unmount();
    const third = renderApp('/saml/onboarding?next=%2F%2Fevil.example.com');
    await user.click(await screen.findByRole('link', { name: 'Skip for now' }, T));
    await waitFor(() => expect(third.router.state.location.pathname).toMatch(/\/workflows$/), T);
  });

  it('shows the server refusal of a person with another workspace and still lets them skip', async () => {
    const user = userEvent.setup();
    signedIn();
    asSamlSession({ otherWorkspace: true });
    renderApp('/saml/onboarding');
    await user.type(await screen.findByLabelText(/Your name/, undefined, T), 'Sam Saml');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/signed in with single sign-on/, undefined, T)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip for now' })).toBeTruthy();
  });

  it('sends a password session to the app and a signed-out visitor to sign-in', async () => {
    signedIn();
    const first = renderApp('/saml/onboarding');
    await waitFor(() => expect(first.router.state.location.pathname).toMatch(/\/workflows$/), T);
    first.unmount();
    backend().session = null;
    const second = renderApp('/saml/onboarding');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/signin'), T);
  });
});
