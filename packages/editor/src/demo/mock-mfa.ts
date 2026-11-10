/**
 * P6-18: the demo's two-factor sign-in: setup, enable, disable, verify and the workspace's enforcement.
 * mock-backend.ts reads `MockBackend.mfaEnabledUsers` (`/auth/me` `mfaEnabled`, the `/auth/login` step) and
 * calls `MockBackend.mfaCheck` for a code; this file writes both. The demo has no authenticator app to
 * ask, so the secret is fixed (`DEMO_MFA_SECRET`, an app that takes it shows real codes, but the demo accepts
 * `DEMO_MFA_CODE`) and so are the recovery codes; a recovery code works once per user. The texts match the
 * server's (`mfa_required`, `invalid_mfa`, the expired text of the enable step).
 */
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

/** the demo's fixed secret (base32), shown in the setup dialog */
export const DEMO_MFA_SECRET = 'JBSWY3DPEHPK3PXP';
/** the one authentication code the demo accepts */
export const DEMO_MFA_CODE = '123456';
/** the demo's recovery codes, shown at setup */
export const DEMO_MFA_RECOVERY_CODES: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `demo${String(i + 1).padStart(4, '0')}-recovery`,
);

const EXPIRED = 'MFA code expired. Close the modal and enable MFA again';
const INVALID = 'Invalid mfa token or recovery code';

function codeOf(body: Record<string, unknown>): string | undefined {
  return typeof body.mfaCode === 'string' && body.mfaCode.trim() !== '' ? body.mfaCode.trim() : undefined;
}
function recoveryOf(body: Record<string, unknown>): string | undefined {
  return typeof body.mfaRecoveryCode === 'string' && body.mfaRecoveryCode.trim() !== ''
    ? body.mfaRecoveryCode.trim().toLowerCase()
    : undefined;
}

export function registerMfaRoutes(backend: MockBackend): void {
  /** users who started the setup and have not finished it */
  const pending = new Set<string>();
  /** recovery codes already used, per user */
  const used = new Map<string, Set<string>>();

  const usable = (userId: string, recovery: string): boolean =>
    DEMO_MFA_RECOVERY_CODES.includes(recovery) && !used.get(userId)?.has(recovery);

  backend.mfaCheck = (userId, code, recoveryCode) => {
    if (code !== undefined) return code === DEMO_MFA_CODE;
    if (recoveryCode === undefined) return false;
    const recovery = recoveryCode.trim().toLowerCase();
    if (!usable(userId, recovery)) return false;
    used.set(userId, (used.get(userId) ?? new Set()).add(recovery));
    return true;
  };

  backend.on('GET', '/auth/mfa/setup', () => {
    const { user } = backend.auth();
    if (backend.mfaEnabledUsers.has(user.id))
      throw new HttpError(400, 'bad_request', 'Two-factor sign-in is already on');
    pending.add(user.id);
    return {
      secret: DEMO_MFA_SECRET,
      otpauthUrl: `otpauth://totp/Workflow:${encodeURIComponent(user.email)}?secret=${DEMO_MFA_SECRET}&issuer=Workflow&algorithm=SHA1&digits=6&period=30`,
      recoveryCodes: [...DEMO_MFA_RECOVERY_CODES],
    };
  });

  backend.on('POST', '/auth/mfa/enable', ({ body }) => {
    const { user } = backend.auth();
    if (!pending.has(user.id) || codeOf(body) !== DEMO_MFA_CODE)
      throw new HttpError(400, 'bad_request', EXPIRED);
    pending.delete(user.id);
    used.delete(user.id);
    backend.mfaEnabledUsers.add(user.id);
    return { ok: true };
  });

  backend.on('POST', '/auth/mfa/disable', ({ body }) => {
    const { user } = backend.auth();
    const code = codeOf(body);
    const recovery = recoveryOf(body);
    if ((code === undefined) === (recovery === undefined))
      throw new HttpError(400, 'bad_request', 'Send either an MFA code or a recovery code');
    if (!backend.mfaEnabledUsers.has(user.id))
      throw new HttpError(400, 'bad_request', 'Two-factor sign-in is not on');
    if (!backend.mfaCheck(user.id, code, recovery)) throw new HttpError(401, 'invalid_mfa', INVALID);
    backend.mfaEnabledUsers.delete(user.id);
    return { ok: true };
  });

  backend.on('POST', '/auth/mfa/verify', ({ body }) => {
    const { user } = backend.auth();
    if (!backend.mfaEnabledUsers.has(user.id) || codeOf(body) !== DEMO_MFA_CODE)
      throw new HttpError(401, 'invalid_mfa', INVALID);
    return { ok: true };
  });

  backend.on('POST', '/settings/mfa-enforce', ({ body }) => {
    const { user, tenant } = backend.requireScope('user:enforceMfa');
    if (typeof body.enforce !== 'boolean')
      throw new HttpError(400, 'bad_request', 'enforce must be true or false');
    if (body.enforce) {
      if (!backend.mfaEnabledUsers.has(user.id))
        throw new HttpError(
          400,
          'bad_request',
          'You must turn on two-factor sign-in for your own account before requiring it for the workspace',
        );
      backend.mfaEnforcedTenants.add(tenant.id);
    } else {
      backend.mfaEnforcedTenants.delete(tenant.id);
    }
    return { enforced: body.enforce };
  });
}
