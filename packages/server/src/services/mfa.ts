/**
 * P6-18 (L2): two-factor sign-in with an authenticator app (TOTP, nodes-base `totp`) and recovery codes.
 * The secret lives in `user_mfa`, encrypted with the binding `{ tenantId: 'user', credentialId: userId }`;
 * recovery codes are SHA-256 hashes, shown once. Setup, enable and disable need a password session
 * (`assertGlobalAccountChange`, called by the routes). `verifyLoginStep` is the sign-in step
 * `AuthService.login` runs (context.ts wires it as `mfaStep`).
 *
 * A TOTP code works once: its time step must be greater than `user_mfa.last_step`, which is advanced by one
 * conditional UPDATE (`advanceStep`), so a replayed code and two requests at once are refused. Windows as n8n:
 * sign-in and disable accept 2 steps either side of now, enabling 10.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { totp } from '@workflow/nodes-base';
import type { ServiceDeps } from '../context';
import type { UserRow } from '../db/schema';
import { ApiError } from '../http/errors';
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

export const MFA_STEP_SECONDS = 30;
export const SIGN_IN_WINDOW = 2;
export const ENABLE_WINDOW = 10;
export const RECOVERY_CODE_COUNT = 10;
export const INVALID_MFA_MESSAGE = 'Invalid mfa token or recovery code';
export const MFA_REQUIRED_MESSAGE = 'Enter the code from your authenticator app';
export const MFA_EXPIRED_MESSAGE = 'MFA code expired. Close the modal and enable MFA again';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 text of the bytes, no padding */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** the stored form of a recovery code: SHA-256 hex of the trimmed, lower case text */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

function newRecoveryCode(): string {
  const hex = randomBytes(8).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8)}`;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const invalidMfa = () => new ApiError(401, 'invalid_mfa', INVALID_MFA_MESSAGE);

export class MfaService {
  constructor(readonly deps: ServiceDeps) {}

  private binding(userId: string) {
    return { tenantId: 'user', credentialId: userId };
  }

  private assertAvailable(): void {
    if (!this.deps.config.mfaEnabled) {
      throw ApiError.badRequest('Two-factor sign-in is turned off on this server');
    }
  }

  /**
   * The time step of `code` for `secret` within `window` steps of now, or undefined. Every step is compared
   * in constant time and none is skipped, so the answer's timing does not tell which step matched.
   */
  private matchStep(secret: string, code: string, window: number): number | undefined {
    if (!/^\d{6}$/.test(code)) return undefined;
    const now = Date.now();
    const current = Math.floor(now / 1000 / MFA_STEP_SECONDS);
    let found: number | undefined;
    for (let offset = -window; offset <= window; offset++) {
      const { token } = totp({ secret, timestampMs: now + offset * MFA_STEP_SECONDS * 1000 });
      if (sameText(token, code)) found = current + offset;
    }
    return found;
  }

  /** a TOTP code is good for this user's stored secret, and not used before (`last_step`) */
  private async acceptTotp(
    userId: string,
    secretEnc: string,
    code: string,
    window: number,
  ): Promise<boolean> {
    let secret: string;
    try {
      secret = this.deps.context().cipher.decrypt<string>(secretEnc, this.binding(userId));
    } catch {
      return false;
    }
    const step = this.matchStep(secret, code, window);
    if (step === undefined) return false;
    return this.deps.repos.userMfa.advanceStep(userId, step);
  }

  /** a recovery code is one of the user's, and is used up by this call */
  private async acceptRecovery(userId: string, code: string): Promise<boolean> {
    if (!code.trim() || code.length > 64) return false;
    return this.deps.repos.userMfa.useRecoveryCode(userId, hashRecoveryCode(code));
  }

  async setup(user: UserRow): Promise<MfaSetup> {
    this.assertAvailable();
    const { repos, config } = this.deps;
    const existing = await repos.userMfa.get(user.id);
    if (existing?.enabledAt) throw ApiError.badRequest('Two-factor sign-in is already on');
    const secret = base32Encode(randomBytes(20));
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const secretEnc = this.deps.context().cipher.encrypt(secret, this.binding(user.id));
    try {
      await repos.userMfa.savePending(user.id, secretEnc, recoveryCodes.map(hashRecoveryCode));
    } catch {
      throw ApiError.badRequest('Two-factor sign-in is already on');
    }
    const issuer = config.brand.name;
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: '6',
      period: String(MFA_STEP_SECONDS),
    });
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}`;
    const otpauthUrl = `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
    return { secret, otpauthUrl, recoveryCodes };
  }

  /** turns MFA on with a code from the app and marks the current session verified */
  async enable(user: UserRow, code: string, sessionId: string): Promise<void> {
    this.assertAvailable();
    const { repos } = this.deps;
    const row = await repos.userMfa.get(user.id);
    if (!row || row.enabledAt) {
      throw ApiError.badRequest(row ? 'Two-factor sign-in is already on' : MFA_EXPIRED_MESSAGE);
    }
    if (!(await this.acceptTotp(user.id, row.secretEnc, code, ENABLE_WINDOW))) {
      throw ApiError.badRequest(MFA_EXPIRED_MESSAGE);
    }
    if (!(await repos.userMfa.enable(user.id))) throw ApiError.badRequest(MFA_EXPIRED_MESSAGE);
    await repos.sessions.setMfaVerified(sessionId);
  }

  async disable(user: UserRow, input: MfaDisableInput): Promise<void> {
    const code = input.mfaCode?.trim() || undefined;
    const recovery = input.mfaRecoveryCode?.trim() || undefined;
    if ((code === undefined) === (recovery === undefined)) {
      throw ApiError.badRequest('Send either an MFA code or a recovery code');
    }
    const row = await this.deps.repos.userMfa.get(user.id);
    if (!row?.enabledAt) throw ApiError.badRequest('Two-factor sign-in is not on');
    const ok =
      code !== undefined
        ? await this.acceptTotp(user.id, row.secretEnc, code, SIGN_IN_WINDOW)
        : await this.acceptRecovery(user.id, recovery as string);
    if (!ok) throw invalidMfa();
    // also takes `mfa_verified` from the user's password and LDAP sessions (UserMfaRepository.delete)
    await this.deps.repos.userMfa.delete(user.id);
  }

  /** POST /auth/mfa/verify: the code is valid now (and used up) */
  async verify(user: UserRow, code: string): Promise<boolean> {
    const row = await this.deps.repos.userMfa.get(user.id);
    if (!row?.enabledAt) return false;
    return this.acceptTotp(user.id, row.secretEnc, code, SIGN_IN_WINDOW);
  }

  /** FULL: MFA is on for this user (`user_mfa.enabled_at` set) */
  async isEnabled(userId: string): Promise<boolean> {
    return this.deps.repos.userMfa.isEnabled(userId);
  }

  /**
   * The sign-in step: MFA on and no code is 401 `mfa_required`, a wrong code 401 `invalid_mfa`; the session
   * gets `mfaVerified: true` after a good code. MFA off for the user: the sign-in as before. `MFA_ENABLED`
   * off does not skip the step for a user who has MFA on (it only refuses a new setup).
   */
  async verifyLoginStep(user: UserRow, input: LoginInput): Promise<{ mfaVerified: boolean }> {
    const row = await this.deps.repos.userMfa.get(user.id);
    if (!row?.enabledAt) return { mfaVerified: false };
    const code = input.mfaCode?.trim() || undefined;
    const recovery = input.mfaRecoveryCode?.trim() || undefined;
    if (code === undefined && recovery === undefined) {
      throw new ApiError(401, 'mfa_required', MFA_REQUIRED_MESSAGE);
    }
    const ok =
      code !== undefined
        ? await this.acceptTotp(user.id, row.secretEnc, code, SIGN_IN_WINDOW)
        : await this.acceptRecovery(user.id, recovery as string);
    if (!ok) throw invalidMfa();
    return { mfaVerified: true };
  }

  /** a code (or recovery code) is valid for this user, used by the password reset and email change (L3) */
  async checkCode(user: UserRow, code: string): Promise<boolean> {
    const row = await this.deps.repos.userMfa.get(user.id);
    if (!row?.enabledAt) return false;
    const text = code.trim();
    return /^\d{6}$/.test(text)
      ? this.acceptTotp(user.id, row.secretEnc, text, SIGN_IN_WINDOW)
      : this.acceptRecovery(user.id, text);
  }

  /** the CLI `mfa:disable --email`: clears the user's MFA row and the verified mark of their password sessions */
  async disableByEmail(email: string): Promise<boolean> {
    const user = await this.deps.repos.users.getByEmail(email.trim());
    if (!user) return false;
    return this.deps.repos.userMfa.delete(user.id);
  }
}
