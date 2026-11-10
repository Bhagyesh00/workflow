/**
 * P6-18 (L2): two-factor sign-in with an authenticator app (TOTP, nodes-base `totp`) and recovery codes.
 * The secret lives in `user_mfa`, encrypted with the binding `{ tenantId: 'user', credentialId: userId }`;
 * recovery codes are SHA-256 hashes, shown once. Setup, enable and disable need a password session
 * (`assertGlobalAccountChange`). `verifyLoginStep` is the sign-in step `AuthService.login` runs
 * (context.ts wires it as `mfaStep`).
 * Stub from C0: `verifyLoginStep` PASSES (`{ mfaVerified: false }`, today's sign-in), `isEnabled` reads
 * `repos.userMfa` (FULL); the rest throws until L2.
 */
import type { ServiceDeps } from '../context';
import type { UserRow } from '../db/schema';
import type { LoginInput } from './auth';

/** GET /auth/mfa/setup: a new secret and new codes on each call until enabled (named deviation) */
export interface MfaSetup {
  secret: string;
  /** the otpauth URI (issuer the brand name, label the email) the QR code shows */
  otpauthUrl: string;
  recoveryCodes: string[];
}

/** exactly one of the two */
export interface MfaDisableInput {
  mfaCode?: string;
  mfaRecoveryCode?: string;
}

export class MfaService {
  constructor(readonly deps: ServiceDeps) {}

  async setup(_user: UserRow): Promise<MfaSetup> {
    throw new Error('not implemented (L2)');
  }

  /** turns MFA on with a code from the app and marks the current session verified */
  async enable(_user: UserRow, _code: string, _sessionId: string): Promise<void> {
    throw new Error('not implemented (L2)');
  }

  async disable(_user: UserRow, _input: MfaDisableInput): Promise<void> {
    throw new Error('not implemented (L2)');
  }

  /** POST /auth/mfa/verify: the code is valid now */
  async verify(_user: UserRow, _code: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** FULL: MFA is on for this user (`user_mfa.enabled_at` set) */
  async isEnabled(userId: string): Promise<boolean> {
    return this.deps.repos.userMfa.isEnabled(userId);
  }

  /**
   * The sign-in step: MFA on and no code is 401 `mfa_required`, a wrong code 401; `mfaVerified` goes on the
   * session. Stub (L2) PASSES: `{ mfaVerified: false }`, as today.
   */
  async verifyLoginStep(_user: UserRow, _input: LoginInput): Promise<{ mfaVerified: boolean }> {
    return { mfaVerified: false };
  }

  /** a code (or recovery code) is valid for this user, used by the password reset and email change (L3) */
  async checkCode(_user: UserRow, _code: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** the CLI `mfa:disable --email`: clears the user's MFA row; false when there was none */
  async disableByEmail(_email: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }
}
