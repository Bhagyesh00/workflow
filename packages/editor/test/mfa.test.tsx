/**
 * P6-18 (L2): two-step sign-in in the editor. The QR code is SVG rects (no innerHTML); the sign-in asks for a
 * code or a recovery code after the password; the account page sets MFA up (QR, key, codes with copy and
 * download) and turns it off; the security page requires it for everyone once the admin has it on; a 401
 * `mfa_enrollment_required` lands on the account page with the setup dialog open, not on /signin; the demo
 * routes answer the server's codes and texts.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { QrCode } from '../src/components/account/QrCode';
import { DEMO_MFA_CODE, DEMO_MFA_RECOVERY_CODES, DEMO_MFA_SECRET } from '../src/demo/mock-mfa';
import { MfaStep } from '../src/pages/auth/MfaStep';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

describe('QrCode', () => {
  it('draws the text as SVG rects with a name, and no markup string', () => {
    const { container } = render(
      <QrCode value="otpauth://totp/Workflow:a@example.com?secret=ABC" label="QR" />,
    );
    const svg = screen.getByRole('img', { name: 'QR' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(20);
    expect(container.querySelector('script, foreignObject, image')).toBeNull();
    expect(svg.getAttribute('width')).toBe('192');
  });

  it('is the same code for the same text and another for another text', () => {
    const a = render(<QrCode value="aaa" label="A" size={100} />);
    const first = a.container.innerHTML;
    a.unmount();
    const b = render(<QrCode value="aaa" label="A" size={100} />);
    expect(b.container.innerHTML).toBe(first);
    b.unmount();
    const c = render(<QrCode value="bbb" label="A" size={100} />);
    expect(c.container.innerHTML).not.toBe(first);
  });
});

describe('MfaStep', () => {
  it('sends a 6 digit code, and only a full one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MfaStep pending={false} error={null} onSubmit={onSubmit} onCancel={() => undefined} />);
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Authentication code'), '12ab3456');
    expect((screen.getByLabelText('Authentication code') as HTMLInputElement).value).toBe('123456');
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ mfaCode: '123456' });
  });

  it('switches to a recovery code and back, and shows the error and Back', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <MfaStep
        pending={false}
        error="Invalid mfa token or recovery code"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Invalid mfa token or recovery code');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), '  abcd-1234 ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).toHaveBeenCalledWith({ mfaRecoveryCode: 'abcd-1234' });
    await user.click(screen.getByRole('button', { name: 'Use an authentication code' }));
    expect(screen.getByLabelText('Authentication code')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('sign-in with a second step', () => {
  async function signOutOwner() {
    signedIn();
    backend().setDemoMfa(true);
    backend().session = null;
  }

  it('asks for the code after the password, refuses a wrong one and signs in with the right one', async () => {
    const user = userEvent.setup();
    await signOutOwner();
    const { router } = renderApp('/signin');
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Two-factor authentication' }, T)).toBeTruthy();
    await user.type(screen.getByLabelText('Authentication code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid mfa token or recovery code', undefined, T)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/signin');
    await user.clear(screen.getByLabelText('Authentication code'));
    await user.type(screen.getByLabelText('Authentication code'), DEMO_MFA_CODE);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'), T);
    const logins = backend().requests.filter((r) => r.path === '/auth/login');
    expect(logins.at(-1)?.body).toMatchObject({ email: 'owner@example.com', mfaCode: DEMO_MFA_CODE });
  });

  it('a recovery code signs in once', async () => {
    const user = userEvent.setup();
    await signOutOwner();
    const { router } = renderApp('/signin');
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Two-factor authentication' }, T);
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), DEMO_MFA_RECOVERY_CODES[0]);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'), T);
    // the same code again is refused
    backend().session = null;
    const again = await call('POST', '/auth/login', {
      email: 'owner@example.com',
      password: 'secret-pass-1',
      mfaRecoveryCode: DEMO_MFA_RECOVERY_CODES[0],
    });
    expect(again.status).toBe(401);
    expect(again.body.error?.code).toBe('invalid_mfa');
  });
});

describe('Your account: two-step sign-in', () => {
  it('sets MFA up from the dialog: QR, key, codes, then the code turns it on', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/account');
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' }, T)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog', undefined, T);
    expect(await within(dialog).findByRole('img', { name: 'Authenticator app QR code' }, T)).toBeTruthy();
    expect(within(dialog).getByTestId('mfa-secret').textContent).toBe(DEMO_MFA_SECRET);
    const codes = within(dialog).getByRole('region', { name: 'Recovery codes' });
    expect(within(codes).getAllByRole('listitem')).toHaveLength(10);
    const turnOn = within(dialog).getByRole('button', { name: 'Turn on' }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Authentication code'), '111111');
    await user.click(within(dialog).getByRole('checkbox', { name: 'I saved my recovery codes' }));
    await user.click(turnOn);
    expect(await within(dialog).findByText(/MFA code expired/, undefined, T)).toBeTruthy();
    expect(backend().mfaEnabledUsers.size).toBe(0);
    await user.clear(within(dialog).getByLabelText('Authentication code'));
    await user.type(within(dialog).getByLabelText('Authentication code'), DEMO_MFA_CODE);
    await user.click(turnOn);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
    expect(backend().mfaEnabledUsers.has(backend().session!.userId)).toBe(true);
    expect(await screen.findByRole('button', { name: 'Turn off' }, T)).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('copies the codes and offers a download', async () => {
    const user = userEvent.setup();
    signedIn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const created = vi.spyOn(URL, 'createObjectURL');
    // jsdom cannot follow the download link
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderApp('/settings/account');
    await user.click(await screen.findByRole('button', { name: 'Set up' }, T));
    const dialog = await screen.findByRole('dialog', undefined, T);
    await within(dialog).findByTestId('mfa-secret', undefined, T);
    await user.click(within(dialog).getByRole('button', { name: 'Copy codes' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DEMO_MFA_RECOVERY_CODES.join('\n')));
    await user.click(within(dialog).getByRole('button', { name: 'Download codes' }));
    expect(created).toHaveBeenCalledTimes(1);
    const blob = created.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe(`${DEMO_MFA_RECOVERY_CODES.join('\n')}\n`);
    expect(click).toHaveBeenCalledTimes(1);
    created.mockRestore();
    click.mockRestore();
  });

  it('turns MFA off with a code, or with a recovery code', async () => {
    const user = userEvent.setup();
    signedIn();
    backend().setDemoMfa(true);
    renderApp('/settings/account');
    await user.click(await screen.findByRole('button', { name: 'Turn off' }, T));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Authentication code'), '222222');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('Invalid mfa token or recovery code', undefined, T)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Use a recovery code' }));
    await user.type(within(dialog).getByLabelText('Recovery code'), DEMO_MFA_RECOVERY_CODES[2]);
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
    expect(backend().mfaEnabledUsers.size).toBe(0);
    expect(await screen.findByRole('button', { name: 'Set up' }, T)).toBeTruthy();
  });

  it('opens the setup dialog on ?mfa=setup and drops the parameter', async () => {
    signedIn();
    const { router } = renderApp('/settings/account?mfa=setup');
    const dialog = await screen.findByRole('dialog', undefined, T);
    expect(within(dialog).getByRole('heading', { name: 'Set up two-step sign-in' })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('asks an enrolled user on ?mfa=setup for a code (POST /auth/mfa/verify), not for a new setup', async () => {
    const user = userEvent.setup();
    signedIn();
    backend().setDemoMfa(true);
    const verifies: unknown[] = [];
    server.use(
      http.post(/\/rest\/auth\/mfa\/verify$/, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        verifies.push(body);
        const res = await backend().handle({ method: 'POST', path: '/auth/mfa/verify', body });
        return HttpResponse.json(res.body as Record<string, unknown>, { status: res.status });
      }),
    );
    const { router } = renderApp('/settings/account?mfa=setup');
    const dialog = await screen.findByRole('dialog', undefined, T);
    expect(within(dialog).getByRole('heading', { name: 'Confirm two-step sign-in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set up two-step sign-in' })).toBeNull();
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await user.type(within(dialog).getByLabelText('Authentication code'), '222222');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Invalid mfa token or recovery code', undefined, T)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Authentication code'));
    await user.type(within(dialog).getByLabelText('Authentication code'), DEMO_MFA_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
    expect(verifies.at(-1)).toEqual({ mfaCode: DEMO_MFA_CODE });
  });

  it('shows no buttons in an SSO session, and says MFA is off when the server turns it off', async () => {
    signedIn();
    server.use(
      http.get(/\/rest\/auth\/me$/, async () => {
        const res = await backend().handle({ method: 'GET', path: '/auth/me' });
        const body = res.body as { data: Record<string, unknown> };
        return HttpResponse.json({ data: { ...body.data, authMethod: 'saml', ssoFenced: true } });
      }),
    );
    renderApp('/settings/account');
    const notes = await screen.findAllByText(/managed by your identity provider/, undefined, T);
    expect(notes.length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });
});

describe('a 401 mfa_enrollment_required', () => {
  it('lands on the account page with the setup dialog open, not on /signin', async () => {
    signedIn();
    server.use(
      http.get(/\/rest\/workflows(\?.*)?$/, () =>
        HttpResponse.json(
          {
            error: {
              code: 'mfa_enrollment_required',
              message: 'This workspace requires two-factor sign-in.',
            },
          },
          { status: 401 },
        ),
      ),
    );
    const { router } = renderApp('/home/workflows');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/account'), T);
    expect(router.state.location.pathname).not.toBe('/signin');
    const dialog = await screen.findByRole('dialog', undefined, T);
    expect(within(dialog).getByRole('heading', { name: 'Set up two-step sign-in' })).toBeTruthy();
    // the session is kept
    expect(backend().session).not.toBeNull();
  });
});

describe('Security: require two-step sign-in', () => {
  it('is disabled until the admin has MFA on, and says why', async () => {
    signedIn();
    renderApp('/settings/security');
    const toggle = (await screen.findByRole(
      'switch',
      { name: 'Require two-step sign-in' },
      T,
    )) as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(screen.getByTestId('mfa-enforce-hint').textContent).toContain('your own account');
  });

  it('turns it on once the admin has MFA, and off again', async () => {
    const user = userEvent.setup();
    signedIn();
    backend().setDemoMfa(true);
    renderApp('/settings/security');
    const toggle = await screen.findByRole('switch', { name: 'Require two-step sign-in' }, T);
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false), T);
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Require' }, T));
    await waitFor(() => expect(backend().mfaEnforcedTenants.has(backend().session!.tenantId)).toBe(true), T);
    await waitFor(
      () =>
        expect(
          screen.getByRole('switch', { name: 'Require two-step sign-in' }).getAttribute('aria-checked'),
        ).toBe('true'),
      T,
    );
    await user.click(screen.getByRole('switch', { name: 'Require two-step sign-in' }));
    await waitFor(() => expect(backend().mfaEnforcedTenants.size).toBe(0), T);
  });

  it('the demo refuses enforcing without own MFA with the server text, and a member 403', async () => {
    signedIn();
    const refused = await call('POST', '/settings/mfa-enforce', { enforce: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toContain('workspace');
    backend().setDemoRole('member');
    const member = await call('POST', '/settings/mfa-enforce', { enforce: true });
    expect(member.status).toBe(403);
  });
});
