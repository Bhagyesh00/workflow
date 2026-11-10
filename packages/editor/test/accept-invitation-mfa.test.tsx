/**
 * P6-18: accepting an invitation with an existing account that has MFA on. The server answers 401
 * `mfa_required` to the password alone; the page then asks for the code (or a recovery code) and sends it with
 * the name and password, as the sign-in page does.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { authApi } from '../src/api/endpoints';
import { renderApp } from './utils';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('accept invitation: MFA step', () => {
  it('asks for the code after 401 mfa_required and sends it with the password', async () => {
    const user = userEvent.setup();
    const accept = vi
      .spyOn(authApi, 'acceptInvitation')
      .mockRejectedValueOnce(new ApiError(401, 'mfa_required', 'Enter the code from your authenticator app'))
      .mockRejectedValueOnce(new ApiError(401, 'invalid_mfa', 'Invalid mfa token or recovery code'));
    renderApp('/invitation/invite-token-1234567890');
    await user.type(await screen.findByLabelText('Your name'), 'Ada');
    await user.type(screen.getByLabelText('Password'), 'analytical-1');
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Two-factor authentication')).toBeTruthy();
    expect(accept).toHaveBeenNthCalledWith(1, 'invite-token-1234567890', {
      name: 'Ada',
      password: 'analytical-1',
    });
    const code = screen.getByLabelText('Authentication code');
    await user.type(code, '123456');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
    expect(accept).toHaveBeenNthCalledWith(2, 'invite-token-1234567890', {
      name: 'Ada',
      password: 'analytical-1',
      mfaCode: '123456',
    });
    expect(await screen.findByText('Invalid mfa token or recovery code')).toBeTruthy();
  });
});
