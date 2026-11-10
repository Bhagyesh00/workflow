/**
 * P6-19 (L3): forgot password, reset password (the token leaves the address bar and travels in a POST body),
 * confirm email change, the profile section of Settings > Your account (name, email, password; read only in
 * an SSO session) and the Members row action that copies a reset link. The demo routes answer the server's
 * codes and texts; the demo mailbox holds the links a server would mail.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { demoMailbox } from '../src/demo/mock-password';
import { addMembership, backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

function account(email = 'ada@example.com') {
  return backend().createAccount({
    email,
    password: 'analytical-1',
    name: 'Ada',
    workspaceName: 'Engines',
  });
}

/** the token in the newest mail of the kind */
function tokenOf(kind: 'passwordReset' | 'emailChangeRequested'): string {
  const mail = [...demoMailbox(backend())].reverse().find((m) => m.kind === kind);
  return new URL(mail?.link ?? 'http://x/?token=').searchParams.get('token') ?? '';
}

describe('ForgotPasswordPage', () => {
  it('gives the same answer for a known and an unknown email, and mails only the known one', async () => {
    const user = userEvent.setup();
    account();
    const first = renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    const known = await screen.findAllByText(/a link to choose a new password is on its way/, undefined, T);
    expect(known[0].textContent).toContain('ada@example.com');
    expect(demoMailbox(backend()).filter((m) => m.kind === 'passwordReset')).toHaveLength(1);

    first.unmount();
    renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(
      (await screen.findAllByText(/a link to choose a new password is on its way/, undefined, T)).length,
    ).toBeGreaterThan(0);
    expect(demoMailbox(backend()).filter((m) => m.kind === 'passwordReset')).toHaveLength(1);
  });

  it('shows the server text when the request is refused', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/rest\/auth\/forgot-password$/, () =>
        HttpResponse.json(
          {
            error: {
              code: 'mail_not_configured',
              message: 'Email sending must be set up in order to request a password reset email',
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/Email sending must be set up/, undefined, T)).toBeTruthy();
  });
});

describe('ResetPasswordPage', () => {
  it('moves the token out of the address bar, sends it in the body, and the new password signs in', async () => {
    const user = userEvent.setup();
    account();
    await call('POST', '/auth/forgot-password', { email: 'ada@example.com' });
    const token = tokenOf('passwordReset');
    const { router } = renderApp(`/reset-password?token=${token}`);
    await user.type(await screen.findByLabelText('New password', undefined, T), 'brand-new-2');
    expect(router.state.location.search).toBe('');
    expect(router.state.location.pathname).toBe('/reset-password');
    await user.type(screen.getByLabelText('Repeat the new password'), 'brand-new-2');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed', undefined, T)).toBeTruthy();

    const resets = backend().requests.filter((r) => r.path === '/auth/reset-password');
    expect(resets).toHaveLength(1);
    expect(resets[0].body).toEqual({ token, password: 'brand-new-2' });
    // no request carries the token in its path
    expect(backend().requests.some((r) => r.path.includes(token))).toBe(false);

    const old = await call('POST', '/auth/login', { email: 'ada@example.com', password: 'analytical-1' });
    expect(old.status).toBe(401);
    const fresh = await call('POST', '/auth/login', { email: 'ada@example.com', password: 'brand-new-2' });
    expect(fresh.status).toBe(200);
  });

  it('checks the password rule and that both fields match before it sends', async () => {
    const user = userEvent.setup();
    account();
    await call('POST', '/auth/forgot-password', { email: 'ada@example.com' });
    renderApp(`/reset-password?token=${tokenOf('passwordReset')}`);
    await user.type(await screen.findByLabelText('New password', undefined, T), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'different-1');
    expect(screen.getByText('The passwords do not match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 8 characters')).toBeTruthy();
    expect(backend().requests.some((r) => r.path === '/auth/reset-password')).toBe(false);
  });

  it('says so for a link that does not work, and offers a new one', async () => {
    renderApp('/reset-password?token=nope');
    expect(await screen.findByText('This link does not work', undefined, T)).toBeTruthy();
    expect(screen.getByText(/invalid or has expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ask for a new link' }).getAttribute('href')).toBe(
      '/forgot-password',
    );
  });

  it('says so for an address with no token', async () => {
    renderApp('/reset-password');
    expect(await screen.findByText('The link is missing its token.', undefined, T)).toBeTruthy();
  });

  it('asks for the authentication code when the account has two-step sign-in', async () => {
    const user = userEvent.setup();
    const { user: owner } = account();
    backend().mfaEnabledUsers.add(owner.id);
    await call('POST', '/auth/forgot-password', { email: 'ada@example.com' });
    renderApp(`/reset-password?token=${tokenOf('passwordReset')}`);
    await user.type(await screen.findByLabelText('New password', undefined, T), 'brand-new-2');
    await user.type(screen.getByLabelText('Repeat the new password'), 'brand-new-2');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    // nothing is sent without the code
    expect(backend().requests.some((r) => r.path === '/auth/reset-password')).toBe(false);
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Invalid MFA token.', undefined, T)).toBeTruthy();
    await user.clear(screen.getByLabelText('Authentication code'));
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed', undefined, T)).toBeTruthy();
  });
});

describe('ConfirmEmailChangePage', () => {
  it('confirms from a button, the token in the body only', async () => {
    const user = userEvent.setup();
    signedIn();
    await call('POST', '/auth/change-email', { email: 'new@example.com', currentPassword: 'secret-pass-1' });
    const token = tokenOf('emailChangeRequested');
    const { router } = renderApp(`/confirm-email-change?token=${token}`);
    const button = await screen.findByRole('button', { name: 'Confirm new email' }, T);
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(backend().requests.some((r) => r.path === '/auth/confirm-email-change')).toBe(false);
    await user.click(button);
    expect(await screen.findByText('Email address changed', undefined, T)).toBeTruthy();
    expect(backend().requests.find((r) => r.path === '/auth/confirm-email-change')?.body).toEqual({ token });
    expect(backend().users.some((u) => u.email === 'new@example.com')).toBe(true);
  });

  it('shows the server text for a link used twice', async () => {
    const user = userEvent.setup();
    signedIn();
    await call('POST', '/auth/change-email', { email: 'new@example.com', currentPassword: 'secret-pass-1' });
    const token = tokenOf('emailChangeRequested');
    await call('POST', '/auth/confirm-email-change', { token });
    renderApp(`/confirm-email-change?token=${token}`);
    await user.click(await screen.findByRole('button', { name: 'Confirm new email' }, T));
    expect(await screen.findByText(/invalid or has expired/, undefined, T)).toBeTruthy();
  });
});

describe('ProfileSection (Settings > Your account)', () => {
  it('saves a new name', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/account');
    const field = await screen.findByLabelText('Name', undefined, T);
    expect((screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'Olive Q');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(backend().users[0].name).toBe('Olive Q'), T);
    expect(backend().requests.find((r) => r.path === '/auth/me' && r.method === 'PATCH')?.body).toEqual({
      name: 'Olive Q',
    });
  });

  it('changes the password with the current one and shows the server text for a wrong one', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/account');
    await user.click(await screen.findByRole('button', { name: 'Change password' }, T));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Current password'), 'wrong-pass-1');
    await user.type(within(dialog).getByLabelText('New password'), 'brand-new-2');
    await user.type(within(dialog).getByLabelText('Repeat the new password'), 'brand-new-2');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));
    expect(await within(dialog).findByText('The current password is not correct', undefined, T)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Current password'));
    await user.type(within(dialog).getByLabelText('Current password'), 'secret-pass-1');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(backend().users[0].password).toBe('brand-new-2'), T);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
  });

  it('asks the new email and the password, and says a link was sent', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/account');
    await user.click(await screen.findByRole('button', { name: 'Change email' }, T));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('New email'), 'new@example.com');
    await user.type(within(dialog).getByLabelText('Current password'), 'secret-pass-1');
    await user.click(within(dialog).getByRole('button', { name: 'Send confirmation link' }));
    expect(await within(dialog).findByText(/We sent a link to new@example.com/, undefined, T)).toBeTruthy();
    expect(backend().users[0].email).toBe('owner@example.com');
    expect(tokenOf('emailChangeRequested')).not.toBe('');
  });

  it('asks for an authentication code instead of the password when two-step sign-in is on', async () => {
    const user = userEvent.setup();
    signedIn();
    backend().setDemoMfa(true);
    renderApp('/settings/account');
    await user.click(await screen.findByRole('button', { name: 'Change email' }, T));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Current password')).toBeNull();
    await user.type(within(dialog).getByLabelText('New email'), 'new@example.com');
    await user.type(within(dialog).getByLabelText('Authentication code'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Send confirmation link' }));
    expect(await within(dialog).findByText(/We sent a link to new@example.com/, undefined, T)).toBeTruthy();
  });

  it('is read only in an SSO session', async () => {
    signedIn();
    server.use(
      http.get(/\/rest\/auth\/me$/, async () => {
        const res = await backend().handle({ method: 'GET', path: '/auth/me' });
        const body = res.body as { data: Record<string, unknown> };
        return HttpResponse.json({ data: { ...body.data, authMethod: 'saml', ssoFenced: true } });
      }),
    );
    renderApp('/settings/account');
    expect(
      (await screen.findAllByText(/managed by your identity provider/, undefined, T)).length,
    ).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Change email' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Members: copy reset link', () => {
  it('copies a link for a member, not for an owner or for yourself', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    signedIn();
    const member = backend().createAccount({
      email: 'mia@example.com',
      password: 'member-pass-1',
      name: 'Mia Member',
      workspaceName: 'Mia Space',
    });
    backend().signIn('owner@example.com');
    addMembership(member.user.id, 'member');
    renderApp('/settings/members');
    const copy = await screen.findByRole('button', { name: 'Copy password reset link for Mia Member' }, T);
    expect(screen.getAllByRole('button', { name: /Copy password reset link/ })).toHaveLength(1);
    await user.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1), T);
    const link = String((writeText.mock.calls[0] as unknown as [string])[0]);
    expect(link).toContain('/reset-password?token=');
  });

  it('the demo refuses an owner, and a member without the scope', async () => {
    signedIn();
    const ownerId = backend().session!.userId;
    const refused = await call('GET', `/members/${ownerId}/password-reset-link`);
    expect(refused.status).toBe(403);
    backend().setDemoRole('member');
    const member = await call('GET', `/members/${ownerId}/password-reset-link`);
    expect(member.status).toBe(403);
  });
});
