/**
 * P6-19 (L3): password reset, profile, password and email change. Tokens live in `user_tokens` (hash only,
 * 20 minutes, one use by an atomic `used_at`), and every token travels in a POST body, never in a URL the
 * server logs. Forgot password answers the same for an unknown email; a reset ends every other session.
 * Account-wide changes need a password session (`assertGlobalAccountChange`).
 * Stub from C0: every method throws until L3.
 */
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import type { SessionMeta } from './auth';

export interface ResetPasswordInput {
  token: string;
  password: string;
  /** required when the user has MFA on */
  mfaCode?: string;
}

export interface ProfileInput {
  name: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** the new address and one proof: the current password or an MFA code */
export interface ChangeEmailInput {
  email: string;
  currentPassword?: string;
  mfaCode?: string;
}

export class PasswordService {
  constructor(readonly deps: ServiceDeps) {}

  /** POST /auth/forgot-password: the same answer and timing for an unknown email; the mail goes after the reply */
  async forgotPassword(_email: string, _meta: SessionMeta): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** POST /auth/reset-token/resolve: whether the token is valid, and what the page needs (MFA asked) */
  async resolveResetToken(_token: string): Promise<{ valid: boolean; mfaRequired: boolean }> {
    throw new Error('not implemented (L3)');
  }

  async resetPassword(_input: ResetPasswordInput, _meta: SessionMeta): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  async confirmEmailChange(_token: string, _meta: SessionMeta): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  async updateProfile(_auth: AuthContext, _input: ProfileInput): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** ends the other sessions, keeps this one */
  async changePassword(_auth: AuthContext, _input: ChangePasswordInput): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  async requestEmailChange(_auth: AuthContext, _input: ChangeEmailInput): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** GET /members/:userId/password-reset-link: an admin copies a reset link; an owner's is refused */
  async resetLink(_auth: AuthContext, _userId: string): Promise<{ link: string }> {
    throw new Error('not implemented (L3)');
  }
}
