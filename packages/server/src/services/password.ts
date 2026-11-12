/**
 * P6-19 (L3): password reset, profile, password and email change. Tokens live in `user_tokens` (hash only,
 * 20 minutes, one use by an atomic `used_at`), and every token travels in a POST body, never in a URL the
 * server logs. Forgot password answers the same for an unknown email; a reset ends every other session.
 * Account-wide changes need a password session (`assertGlobalAccountChange`).
 */
import type { ServiceDeps } from '../context';
import type { UserRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { isUniqueViolation } from '../repositories/util';
import { passwordProblem, randomToken, type SessionMeta, sha256 } from './auth';

/** minutes a reset or email change link works */
export const TOKEN_MINUTES = 20;
const TOKEN_MS = TOKEN_MINUTES * 60_000;

export const MAIL_NOT_SET_UP_MESSAGE =
  'Email sending must be set up in order to request a password reset email';
export const INVALID_LINK_MESSAGE = 'This link is invalid or has expired. Request a new one.';
export const SSO_RESET_MESSAGE =
  'Password reset is unavailable because your workspace signs in with single sign-on';
export const LDAP_RESET_MESSAGE =
  'Your password cannot be reset here because your account signs in through your directory. Contact your administrator.';
export const MANAGED_ACCOUNT_MESSAGE =
  'This account is managed by your identity provider. Ask your administrator to change it.';
export const EMAIL_IN_USE_MESSAGE = 'This email address is already in use';
export const MFA_REQUIRED_MESSAGE = 'If MFA enabled, mfaCode is required.';
export const INVALID_MFA_TOKEN_MESSAGE = 'Invalid MFA token.';
export const OTHER_WORKSPACES_RESET_MESSAGE =
  "Couldn't make a reset link: this account also belongs to other workspaces. The person can use Forgot password on the sign-in page.";

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
  /** required when the user has MFA on */
  mfaCode?: string;
}

/** the new address and one proof: the current password, or (MFA on) an MFA code */
export interface ChangeEmailInput {
  email: string;
  currentPassword?: string;
  mfaCode?: string;
}

/** what forgot password hands the route: the mail to send once the reply has gone out */
export type AfterReply = () => Promise<void>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PasswordService {
  /** every forgot-password call takes between these two times, known email or not (n8n: 200 to 1000 ms) */
  jitterMs: { min: number; max: number } = { min: 200, max: 1000 };

  constructor(readonly deps: ServiceDeps) {}

  private get ctx() {
    return this.deps.context();
  }

  private link(path: string, token: string): string {
    return `${this.deps.config.baseUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  /** a new token of the kind (the user's older ones of that kind are deleted); returns the raw token */
  private async issue(
    userId: string,
    kind: 'password_reset' | 'email_change',
    data?: Record<string, unknown>,
  ): Promise<string> {
    const { userTokens } = this.deps.repos;
    await userTokens.deleteForUser(userId, kind);
    const token = randomToken();
    await userTokens.create({
      userId,
      kind,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + TOKEN_MS),
      data: data ?? null,
    });
    return token;
  }

  /** an audit line in each workspace the user belongs to (the account is global) */
  private async audit(userId: string, action: string, meta: SessionMeta): Promise<void> {
    const { repos } = this.deps;
    for (const tenant of await repos.memberships.listForUser(userId)) {
      await repos.audit.add(tenant.id, { userId, action, ip: meta.ip });
    }
  }

  /** SSO-only and LDAP-only users do not reset a password here; `yes` passes */
  private async assertPasswordSignIn(userId: string): Promise<void> {
    const allowed = await this.ctx.ssoLogin.passwordAllowedSomewhere(userId);
    if (allowed === 'no') throw new ApiError(403, 'sso_required', SSO_RESET_MESSAGE);
    if (allowed === 'ldap') throw new ApiError(403, 'ldap_user', LDAP_RESET_MESSAGE);
  }

  /** a code (or recovery code) of a user with MFA on; a missing code answers n8n's text */
  private async assertMfaCode(user: UserRow, mfaCode: string | undefined): Promise<void> {
    if (!(await this.deps.repos.userMfa.isEnabled(user.id))) return;
    if (!mfaCode) throw ApiError.badRequest(MFA_REQUIRED_MESSAGE);
    if (!(await this.ctx.mfa.checkCode(user, mfaCode))) {
      throw new ApiError(400, 'invalid_mfa', INVALID_MFA_TOKEN_MESSAGE);
    }
  }

  private assertNotManaged(user: UserRow): void {
    if (user.managedByTenantId) throw new ApiError(403, 'account_managed', MANAGED_ACCOUNT_MESSAGE);
  }

  /**
   * POST /auth/forgot-password: the same answer and timing for an unknown email; the mail goes after the
   * reply (the caller runs the returned function once the reply has been sent). Refused only when mail is
   * not set up, or when the user can sign in by password in no workspace.
   */
  async forgotPassword(email: string, meta: SessionMeta): Promise<AfterReply> {
    if (!this.ctx.mailer.isConfigured()) {
      throw new ApiError(500, 'mail_not_configured', MAIL_NOT_SET_UP_MESSAGE);
    }
    const started = Date.now();
    const { min, max } = this.jitterMs;
    const target = min + Math.random() * Math.max(0, max - min);
    const hold = async () => {
      const left = target - (Date.now() - started);
      if (left > 0) await sleep(left);
    };
    let deliver: AfterReply = async () => {};
    try {
      const user = await this.deps.repos.users.getByEmail(email.trim());
      if (user) {
        await this.assertPasswordSignIn(user.id);
        const token = await this.issue(user.id, 'password_reset');
        // P6-58: one audit row for a known user (an unknown address writes none; the timing is held below)
        await this.audit(user.id, 'auth.password_reset_requested', meta);
        const resetUrl = this.link('/reset-password', token);
        deliver = async () => {
          try {
            await this.ctx.mailer.sendPasswordReset(user.email, {
              name: user.name,
              resetUrl,
              expiresInMinutes: TOKEN_MINUTES,
            });
          } catch {
            // the reply is gone; the failure must not name the address or the link
            this.deps.logger.warn('Could not send a password reset mail');
          }
        };
      }
    } finally {
      await hold();
    }
    return deliver;
  }

  /** POST /auth/reset-token/resolve: whether the token is valid, and whether the page must ask for an MFA code */
  async resolveResetToken(token: string): Promise<{ mfaEnabled: boolean }> {
    const row = await this.deps.repos.userTokens.getPending('password_reset', sha256(token));
    if (!row) throw ApiError.badRequest(INVALID_LINK_MESSAGE);
    return { mfaEnabled: await this.deps.repos.userMfa.isEnabled(row.userId) };
  }

  async resetPassword(input: ResetPasswordInput, meta: SessionMeta): Promise<void> {
    const { repos } = this.deps;
    const problem = passwordProblem(input.password);
    if (problem) throw ApiError.badRequest(problem);
    const hash = sha256(input.token);
    const pending = await repos.userTokens.getPending('password_reset', hash);
    const user = pending && (await repos.users.get(pending.userId));
    if (!pending || !user) throw ApiError.badRequest(INVALID_LINK_MESSAGE);
    await this.assertPasswordSignIn(user.id);
    await this.assertMfaCode(user, input.mfaCode);
    // the one use: of two requests with this token only one gets the row
    if (!(await repos.userTokens.consume('password_reset', hash))) {
      throw ApiError.badRequest(INVALID_LINK_MESSAGE);
    }
    await repos.users.updatePassword(user.id, await this.ctx.auth.hashPassword(input.password));
    await repos.userTokens.deleteForUser(user.id, 'password_reset');
    await repos.sessions.deleteForUser(user.id);
    await this.audit(user.id, 'auth.password_reset', meta);
  }

  async confirmEmailChange(token: string, meta: SessionMeta): Promise<void> {
    const { repos } = this.deps;
    const hash = sha256(token);
    const pending = await repos.userTokens.getPending('email_change', hash);
    const user = pending && (await repos.users.get(pending.userId));
    const newEmail = typeof pending?.data?.email === 'string' ? pending.data.email : undefined;
    if (!pending || !user || !newEmail) throw ApiError.badRequest(INVALID_LINK_MESSAGE);
    // the address may have been taken since the request
    const owner = await repos.users.getByEmail(newEmail);
    if (owner && owner.id !== user.id) throw ApiError.conflict(EMAIL_IN_USE_MESSAGE);
    if (!(await repos.userTokens.consume('email_change', hash))) {
      throw ApiError.badRequest(INVALID_LINK_MESSAGE);
    }
    try {
      await repos.users.updateEmail(user.id, newEmail);
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict(EMAIL_IN_USE_MESSAGE);
      throw error;
    }
    await repos.userTokens.deleteForUser(user.id, 'email_change');
    await this.audit(user.id, 'auth.email_changed', meta);
    if (this.ctx.mailer.isConfigured()) {
      try {
        await this.ctx.mailer.sendEmailChangeCompleted(user.email, { name: user.name, newEmail });
      } catch {
        this.deps.logger.warn('Could not send an email change completed mail');
      }
    }
  }

  /** PATCH /auth/me: the account's name; refused for an SSO session and for an account its identity provider manages */
  async updateProfile(auth: AuthContext, input: ProfileInput): Promise<UserRow> {
    // a fenced (SSO) session may name a person who has no other workspace (SAML onboarding)
    if ((await this.deps.repos.sso.otherMembershipCount(auth.user.id, auth.tenant.id)) > 0) {
      this.ctx.auth.assertGlobalAccountChange(auth);
    }
    this.assertNotManaged(auth.user);
    const name = input.name.trim();
    if (!name) throw ApiError.badRequest('Name is required');
    const user = await this.deps.repos.users.updateName(auth.user.id, name);
    if (!user) throw ApiError.notFound('User');
    return user;
  }

  /** ends the other sessions, keeps this one */
  async changePassword(auth: AuthContext, input: ChangePasswordInput, meta: SessionMeta = {}): Promise<void> {
    const { repos } = this.deps;
    this.ctx.auth.assertGlobalAccountChange(auth);
    this.assertNotManaged(auth.user);
    const problem = passwordProblem(input.newPassword);
    if (problem) throw ApiError.badRequest(problem);
    if (!(await this.ctx.auth.verifyPassword(auth.user.passwordHash, input.currentPassword))) {
      throw new ApiError(400, 'invalid_password', 'The current password is not correct');
    }
    await this.assertMfaCode(auth.user, input.mfaCode);
    await repos.users.updatePassword(auth.user.id, await this.ctx.auth.hashPassword(input.newPassword));
    if (auth.sessionId) await repos.sessions.deleteForUserExcept(auth.user.id, auth.sessionId);
    else await repos.sessions.deleteForUser(auth.user.id);
    await repos.userTokens.deleteForUser(auth.user.id, 'password_reset');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'auth.password_changed',
      ip: meta.ip,
    });
  }

  /** POST /auth/change-email: mails a confirm link to the new address; the address changes only on confirm */
  async requestEmailChange(auth: AuthContext, input: ChangeEmailInput): Promise<void> {
    const { repos } = this.deps;
    this.ctx.auth.assertGlobalAccountChange(auth);
    this.assertNotManaged(auth.user);
    const email = input.email.trim().toLowerCase();
    if (email === auth.user.email.toLowerCase()) {
      throw ApiError.badRequest('The new email address matches the current one');
    }
    if (await repos.userMfa.isEnabled(auth.user.id)) {
      if (!input.mfaCode) throw ApiError.badRequest('Two-factor code is required to change email');
      if (!(await this.ctx.mfa.checkCode(auth.user, input.mfaCode))) {
        throw new ApiError(400, 'invalid_mfa', INVALID_MFA_TOKEN_MESSAGE);
      }
    } else {
      if (!input.currentPassword) throw ApiError.badRequest('Current password is required to change email');
      if (!(await this.ctx.auth.verifyPassword(auth.user.passwordHash, input.currentPassword))) {
        throw new ApiError(400, 'invalid_password', 'The current password is not correct');
      }
    }
    if (!this.ctx.mailer.isConfigured()) {
      throw new ApiError(
        500,
        'mail_not_configured',
        'Email sending must be set up in order to change your email',
      );
    }
    if (await repos.users.getByEmail(email)) throw ApiError.conflict(EMAIL_IN_USE_MESSAGE);
    const token = await this.issue(auth.user.id, 'email_change', { email });
    try {
      await this.ctx.mailer.sendEmailChangeRequested(email, {
        name: auth.user.name,
        newEmail: email,
        confirmUrl: this.link('/confirm-email-change', token),
      });
    } catch {
      await repos.userTokens.deleteForUser(auth.user.id, 'email_change');
      throw new ApiError(
        500,
        'mail_failed',
        'Could not send the confirmation mail. Contact your administrator.',
      );
    }
  }

  /**
   * GET /members/:userId/password-reset-link: an admin copies a reset link; an owner's is refused, and so is
   * the link of an account that also belongs to another workspace (the password is global, so the link
   * would hand this workspace's admin the person's access everywhere else).
   */
  async resetLink(auth: AuthContext, userId: string): Promise<{ link: string }> {
    const { repos } = this.deps;
    const member = await repos.memberships.get(auth.tenant.id, userId);
    const user = member && (await repos.users.get(userId));
    if (!member || !user) throw ApiError.notFound('Member');
    if (member.role === 'owner') {
      throw ApiError.forbidden("An owner's password cannot be reset by a link from the members list");
    }
    if ((await repos.sso.otherMembershipCount(user.id, auth.tenant.id)) > 0) {
      throw ApiError.forbidden(OTHER_WORKSPACES_RESET_MESSAGE);
    }
    await this.assertPasswordSignIn(user.id);
    const token = await this.issue(user.id, 'password_reset');
    return { link: this.link('/reset-password', token) };
  }
}
