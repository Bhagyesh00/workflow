/**
 * Phase 6 S2 C0f2 contracts: the member and API key routes moved out of mock-backend.ts answer as before and the
 * pages render as before; `/auth/me` and `/settings` carry the new fields; `/auth/login` answers 401
 * `mfa_required` after `setDemoMfa(true)` and takes `workspace`; `GET /auth/sso-options` and
 * `GET /sso/provisioning/config` are FULL with `setDemoSso` and `setDemoProvisioning`; the new settings routes
 * render and the Authentication link hides for a role without the scope. Stubs (501) are the lanes' and are not
 * asserted here.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Me, ProvisioningConfig, Settings, SsoOptions } from '../src/api/types';
import { type DemoMembership, MISSING_SCOPE } from '../src/demo/mock-backend';
import { DEMO_PROVISIONING_OFF } from '../src/demo/mock-provisioning';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await backend().handle({ method, path, body, query });
  return {
    status: res.status,
    body: res.body as { data?: unknown; error?: { code: string; message: string } },
  };
}

async function data<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await call(method, path, body, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as T;
}

const OWNER = { email: 'owner@example.com', password: 'secret-pass-1' };

/** a second member of the signed-in workspace */
function addSam(role = 'member'): string {
  const demo = backend();
  demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
  demo.memberships.push({ tenantId: demo.session!.tenantId, userId: 'u-sam', role });
  return 'u-sam';
}

describe('moved member routes (mock-members.ts, today’s behaviour)', () => {
  it('lists, invites, changes a role and removes as before', async () => {
    signedIn();
    const sam = addSam();
    const list = await data<unknown[]>('GET', '/members');
    expect(list).toEqual([
      { userId: backend().session!.userId, email: 'owner@example.com', name: 'Olive Owner', role: 'owner' },
      { userId: sam, email: 'sam@example.com', name: 'Sam Shaw', role: 'member' },
    ]);
    const invite = await data<Record<string, unknown>>('POST', '/members/invite', {
      email: 'New@Example.com',
      role: 'admin',
    });
    expect(Object.keys(invite)).toEqual(['inviteUrl']);
    expect(String(invite.inviteUrl)).toMatch(/\/invitation\/.+$/);
    expect(backend().invitations.at(-1)).toMatchObject({ email: 'new@example.com', role: 'admin' });
    expect(await data('PATCH', `/members/${sam}`, { role: 'admin' })).toEqual({
      userId: sam,
      email: 'sam@example.com',
      name: 'Sam Shaw',
      role: 'admin',
    });
    expect((await call('PATCH', `/members/${sam}`, { role: 'editor' })).body.error?.code).toBe(
      'invalid_role',
    );
    expect((await call('PATCH', '/members/nobody', { role: 'admin' })).status).toBe(404);
    expect(await data('DELETE', `/members/${sam}`)).toEqual({ ok: true });
    expect(backend().memberships.some((m) => m.userId === sam)).toBe(false);
  });

  it('keeps the scope gates of invite, role change and removal', async () => {
    signedIn();
    const sam = addSam();
    backend().setDemoRole('member');
    for (const [method, path, body] of [
      ['POST', '/members/invite', { email: 'x@example.com' }],
      ['PATCH', `/members/${sam}`, { role: 'admin' }],
      ['DELETE', `/members/${sam}`, undefined],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error?.message).toBe(MISSING_SCOPE);
    }
    expect((await call('GET', '/members')).status).toBe(200);
  });

  it('takes the new optional membership fields without changing the list answer', async () => {
    signedIn();
    const extra: DemoMembership = {
      tenantId: backend().session!.tenantId,
      userId: 'u-dee',
      role: 'member',
      status: 'disabled',
      lastActiveAt: null,
      managedByScim: true,
      allowSsoManualLogin: false,
    };
    backend().users.push({ id: 'u-dee', email: 'dee@example.com', name: 'Dee', password: 'x' });
    backend().memberships.push(extra);
    const list = await data<Array<Record<string, unknown>>>('GET', '/members');
    expect(list.find((m) => m.userId === 'u-dee')).toEqual({
      userId: 'u-dee',
      email: 'dee@example.com',
      name: 'Dee',
      role: 'member',
    });
  });
});

describe('moved API key routes (mock-api-keys.ts, today’s behaviour)', () => {
  it('creates, lists and deletes a key as before', async () => {
    signedIn();
    const created = await data<Record<string, unknown>>('POST', '/api-keys', {
      name: 'CI',
      scopes: ['workflow:read'],
    });
    expect(Object.keys(created).sort()).toEqual(['id', 'key', 'name', 'scopes']);
    expect(String(created.key)).toMatch(/^wfk_[^_]+_[0-9a-f]+$/);
    const list = await data<Array<Record<string, unknown>>>('GET', '/api-keys');
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual([
      'createdAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'scopes',
    ]);
    expect(list[0]).toMatchObject({
      id: created.id,
      name: 'CI',
      scopes: ['workflow:read'],
      lastUsedAt: null,
    });
    expect(await data('DELETE', `/api-keys/${created.id}`)).toEqual({ ok: true });
    expect(await data('GET', '/api-keys')).toEqual([]);
  });
});

describe('moved settings pages render as before', () => {
  it('account, members and API keys', async () => {
    signedIn();
    addSam();
    const first = renderApp('/settings/account');
    expect(await screen.findByRole('heading', { name: 'Your account' }, T)).toBeTruthy();
    first.unmount();
    const second = renderApp('/settings/members');
    expect(await screen.findByRole('heading', { name: 'Members' }, T)).toBeTruthy();
    expect(await screen.findAllByText('Sam Shaw', {}, T)).not.toHaveLength(0);
    second.unmount();
    renderApp('/settings/api-keys');
    expect(await screen.findByRole('heading', { name: 'API keys' }, T)).toBeTruthy();
    expect(await screen.findByText('No API keys', {}, T)).toBeTruthy();
  });
});

describe('/auth/me and /settings fields', () => {
  it('me answers authMethod, mfaEnabled and ssoFenced; mfaEnabled follows setDemoMfa', async () => {
    signedIn();
    const me = await data<Me & Record<string, unknown>>('GET', '/auth/me');
    expect(me).toMatchObject({ authMethod: 'password', mfaEnabled: false, ssoFenced: false });
    backend().setDemoMfa(true);
    expect(backend().mfaEnabledUsers.has(backend().session!.userId)).toBe(true);
    expect((await data<Me>('GET', '/auth/me')).mfaEnabled).toBe(true);
    backend().setDemoMfa(false);
    expect((await data<Me>('GET', '/auth/me')).mfaEnabled).toBe(false);
  });

  it('settings features carry mail, mfa and publicApi', async () => {
    const settings = await data<Settings>('GET', '/settings');
    expect(settings.features).toMatchObject({ mail: false, mfa: true, publicApi: true, demo: true });
  });
});

describe('/auth/login', () => {
  function signedOutOwner() {
    signedIn();
    backend().session = null;
  }

  it('answers 401 mfa_required after setDemoMfa(true) and makes no session', async () => {
    signedOutOwner();
    backend().setDemoMfa(true, OWNER.email);
    const res = await call('POST', '/auth/login', OWNER);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('mfa_required');
    expect(backend().session).toBeNull();
    // a wrong password stays the old answer, before any code is asked
    expect((await call('POST', '/auth/login', { ...OWNER, password: 'nope' })).body.error?.code).toBe(
      'invalid_credentials',
    );
  });

  it('signs in with a code or a recovery code that `mfaCheck` takes, and refuses a bad one', async () => {
    signedOutOwner();
    backend().setDemoMfa(true, OWNER.email);
    backend().mfaCheck = (_userId, code, recoveryCode) => code === '654321' || recoveryCode === 'rc-1';
    const bad = await call('POST', '/auth/login', { ...OWNER, mfaCode: '111111' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toEqual({ code: 'invalid_mfa', message: 'Invalid mfa token or recovery code' });
    expect(backend().session).toBeNull();
    const withCode = await data<Me>('POST', '/auth/login', { ...OWNER, mfaCode: '654321' });
    expect(withCode.user.email).toBe(OWNER.email);
    backend().session = null;
    await data('POST', '/auth/login', { ...OWNER, mfaRecoveryCode: 'rc-1' });
    expect(backend().session).not.toBeNull();
  });

  it('without MFA the old body still signs in; `workspace` picks that membership', async () => {
    signedIn();
    const demo = backend();
    const { tenant: other } = demo.createAccount({
      email: 'other@example.com',
      password: 'secret-pass-2',
      name: 'Other',
      workspaceName: 'Second Space',
    });
    demo.memberships.push({ tenantId: other.id, userId: demo.session!.userId, role: 'admin' });
    const home = demo.session!.tenantId;
    demo.session = null;
    expect((await data<Me>('POST', '/auth/login', OWNER)).tenant.id).toBe(home);
    demo.session = null;
    const picked = await data<Me>('POST', '/auth/login', { ...OWNER, workspace: other.slug });
    expect(picked.tenant.id).toBe(other.id);
    expect(picked.role).toBe('admin');
    demo.session = null;
    expect((await data<Me>('POST', '/auth/login', { ...OWNER, workspace: 'no-such-space' })).tenant.id).toBe(
      home,
    );
  });

  it('the sign-in page takes the mfa_required path instead of the wrong-password error', async () => {
    signedOutOwner();
    backend().setDemoMfa(true, OWNER.email);
    const user = userEvent.setup();
    const { router } = renderApp('/signin');
    await user.type(await screen.findByLabelText('Email', {}, T), OWNER.email);
    await user.type(screen.getByLabelText('Password'), OWNER.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // LoginPage's MfaStep branch (MfaStep itself is L2's stub and renders null)
    expect(await screen.findByRole('heading', { name: 'Two-factor authentication' }, T)).toBeTruthy();
    expect(backend().requests.some((r) => r.path === '/auth/login')).toBe(true);
    expect(screen.queryByText('That email and password do not match an account.')).toBeNull();
    expect(router.state.location.pathname).toBe('/signin');
    expect(backend().session).toBeNull();
  });
});

describe('GET /auth/sso-options (mock-sso.ts, FULL)', () => {
  it('answers email by default, signed out, and what setDemoSso set', async () => {
    expect(backend().session).toBeNull();
    expect(await data<SsoOptions>('GET', '/auth/sso-options', undefined, { workspace: 'any' })).toEqual({
      method: 'email',
      redirect: false,
    });
    const saml: SsoOptions = { method: 'saml', label: 'Okta', redirect: true };
    backend().setDemoSso(saml);
    expect(await data<SsoOptions>('GET', '/auth/sso-options')).toEqual(saml);
    backend().setDemoSso(null);
    expect((await data<SsoOptions>('GET', '/auth/sso-options')).method).toBe('email');
  });
});

describe('GET /sso/provisioning/config (mock-provisioning.ts, FULL)', () => {
  it('answers provisioning off by default and what setDemoProvisioning set, for provisioning:manage only', async () => {
    signedIn();
    expect(await data<ProvisioningConfig>('GET', '/sso/provisioning/config')).toEqual(DEMO_PROVISIONING_OFF);
    const on: ProvisioningConfig = { ...DEMO_PROVISIONING_OFF, scopesProvisionInstanceRole: true };
    backend().setDemoProvisioning(on);
    expect(await data<ProvisioningConfig>('GET', '/sso/provisioning/config')).toEqual(on);
    backend().setDemoRole('member');
    const denied = await call('GET', '/sso/provisioning/config');
    expect(denied.status).toBe(403);
    expect(denied.body.error?.message).toBe(MISSING_SCOPE);
  });
});

describe('new settings routes', () => {
  it.each(['authentication', 'sso', 'ldap', 'provisioning', 'scim'])(
    '/settings/%s renders in the settings layout',
    async (page) => {
      signedIn();
      renderApp(`/settings/${page}`);
      expect(await screen.findByRole('heading', { name: 'Settings' }, T)).toBeTruthy();
      expect(screen.queryByText('This page does not exist')).toBeNull();
    },
  );

  it('shows the Authentication link to an owner and hides it from a member', async () => {
    signedIn();
    const first = renderApp('/settings/account');
    const link = await screen.findByRole('link', { name: 'Authentication' }, T);
    expect(link.getAttribute('href')).toBe('/settings/authentication');
    first.unmount();
    backend().setDemoRole('member');
    renderApp('/settings/account');
    await screen.findByRole('link', { name: 'API keys' }, T);
    // the role has loaded once the account page shows it
    await screen.findAllByText('member', {}, T);
    expect(screen.queryByRole('link', { name: 'Authentication' })).toBeNull();
  });
});
