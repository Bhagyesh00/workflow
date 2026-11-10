/**
 * P6-01 (L6): the SSO sign-in rules shared by SAML (L7), OIDC (L8) and LDAP (L10), per decisions
 * "Security, final". `signIn` refuses a method that is not the workspace's active one (GHSA-pf83-w3f9-8m37),
 * finds the identity by (workspace, provider type, provider id), links a current member or pending
 * invitation of this workspace by a verified email, or creates the user just in time only when the email has
 * no account anywhere (Q-A2); the provisioning (`ctx.provisioning.resolve`) may block before any write. The
 * session carries its `authMethod`; a SAML or OIDC session is `mfaVerified: true` (the identity provider did
 * the second step, as n8n), an LDAP one only when the MFA step passed (a bind is only a password). The fence: a session that signed in with SSO cannot enter another workspace (and services/auth.ts
 * `assertGlobalAccountChange` keeps it from changing the account); a password session into a SAML or OIDC
 * workspace needs the owner or the member's manual login flag, into an LDAP workspace the owner.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { Role, TenantAuthSettingsRow, TenantRow, UserRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { createRepositories } from '../../repositories';
import type { MembershipSignInRule, PendingInvitation, SsoProviderType } from '../../repositories/sso';
import {
  type AuthResult,
  randomToken,
  type SessionAuthMethod,
  type SessionMeta,
  type Tenants,
} from '../auth';
import { isMfaEnforced, MFA_ENROLLMENT_REQUIRED_MESSAGE } from '../mfa-gate';
import { isSsoMethod } from './settings';

/** a person an identity provider (or the directory) vouched for, in one workspace's terms */
export interface SsoProfile {
  providerType: SsoProviderType;
  /** the provider's stable id of the person (SAML NameID, OIDC `sub`, the LDAP id attribute) */
  providerId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** what the provider says about the email; absent = not said */
  emailVerified?: boolean;
  /** every claim or attribute, for the provisioning (role claims, rules) */
  claims: DataObject;
}

export interface SsoSignInOptions {
  authMethod: Exclude<SessionAuthMethod, 'password'>;
  /** the session passed the second step; default true for SAML and OIDC, false for LDAP */
  mfaVerified?: boolean;
}

/** 403 `sso_required`: a password sign-in or session entry the workspace's SSO does not let in */
export const SSO_REQUIRED_MESSAGE = 'This workspace signs in with single sign-on. Use SSO to sign in.';

/**
 * The refusals of `signIn`, by code. SAML and OIDC send the browser back to the sign-in page with
 * `?ssoError=<code>`; the page shows its own text for each code.
 */
export const SSO_SIGN_IN_ERRORS = {
  sso_method_inactive: 'This sign-in method is not turned on for the workspace.',
  sso_profile_invalid: "The identity provider didn't send an email address and a user id.",
  sso_email_unverified: "The identity provider hasn't verified this email address.",
  sso_user_disabled: 'Your access to this workspace is turned off. Ask an admin of the workspace.',
  sso_invite_required: 'This email has an account. Ask an admin of the workspace for an invite.',
  sso_user_unknown: 'This email has no access to the workspace. Ask an admin of the workspace for an invite.',
  sso_access_blocked: "Your identity provider doesn't give you access to this workspace.",
} as const;
export type SsoSignInErrorCode = keyof typeof SSO_SIGN_IN_ERRORS;

/** n8n's meaning (user.service.ts:535-545): under SSO the identity provider adds people, unless SCIM is on */
export const SSO_INVITES_BLOCKED_MESSAGE =
  'SSO is enabled, so users are managed by the Identity Provider and cannot be added through invites';
const SSO_INVITE_ACCEPT_MESSAGE =
  'This workspace signs in with single sign-on. Use SSO to accept the invitation.';
const LDAP_INVITE_ACCEPT_MESSAGE =
  'This workspace signs in with LDAP. Sign in with your LDAP user name and password to accept the invitation.';
const SSO_ENTRY_FENCED_MESSAGE =
  'This session signed in with single sign-on to another workspace. Sign in to this workspace to open it.';

/** P6-39: an invitation sent before the cutover may hold an old word; as `AuthService.acceptInvitation` */
const OLD_INVITATION_ROLES: Readonly<Record<string, string>> = {
  editor: 'project:editor',
  viewer: 'project:viewer',
};
const MAX_PROVIDER_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 128;

function refuse(code: SsoSignInErrorCode, status = 403): ApiError {
  return new ApiError(status, code, SSO_SIGN_IN_ERRORS[code]);
}

/** a password (sign-in, switch, consent, form code) may enter this workspace */
export function passwordMayEnter(
  rule: Pick<MembershipSignInRule, 'method' | 'role' | 'allowSsoManualLogin'>,
) {
  if (isSsoMethod(rule.method)) return rule.role === 'owner' || rule.allowSsoManualLogin;
  if (rule.method === 'ldap') return rule.role === 'owner';
  return true;
}

function scimEnabled(tenant: Pick<TenantRow, 'settings'> | undefined): boolean {
  const scim = tenant?.settings?.scim;
  return Boolean(scim && typeof scim === 'object' && (scim as { enabled?: unknown }).enabled === true);
}

function profileName(profile: SsoProfile): string {
  return [profile.firstName, profile.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_NAME_LENGTH);
}

/** the method's own `emailVerifiedRequired` (SAML, OIDC settings) */
function emailVerifiedRequired(row: TenantAuthSettingsRow, method: SsoProviderType): boolean {
  const section = row[method];
  return Boolean(section && (section as { emailVerifiedRequired?: unknown }).emailVerifiedRequired === true);
}

/** how a sign-in reaches a member: the decision made before any write */
type SignInPath =
  | { kind: 'identity'; user: UserRow }
  | { kind: 'member'; user: UserRow }
  | { kind: 'invited'; user: UserRow; invitation: PendingInvitation }
  | { kind: 'new'; invitation?: PendingInvitation };

export class SsoLoginService {
  constructor(readonly deps: ServiceDeps) {}

  async signIn(
    tenant: TenantRow,
    profile: SsoProfile,
    meta: SessionMeta,
    options: SsoSignInOptions,
  ): Promise<AuthResult> {
    let userId: string | null = null;
    try {
      return await this.signInChecked(tenant, profile, meta, options, (id) => {
        userId = id;
      });
    } catch (error) {
      if (error instanceof ApiError && error.code in SSO_SIGN_IN_ERRORS) {
        await this.deps.repos.audit.add(tenant.id, {
          userId,
          action: 'auth.sso_login_failed',
          metadata: { method: options.authMethod, reason: error.code },
          ip: meta.ip,
        });
      }
      throw error;
    }
  }

  private async signInChecked(
    tenant: TenantRow,
    profile: SsoProfile,
    meta: SessionMeta,
    options: SsoSignInOptions,
    known: (userId: string) => void,
  ): Promise<AuthResult> {
    const { repos } = this.deps;
    const ctx = this.deps.context();
    const method = options.authMethod;
    // GHSA-pf83-w3f9-8m37: only the workspace's active method signs anyone in
    const row = await repos.sso.get(tenant.id);
    if (!row || row.method !== method || profile.providerType !== method) throw refuse('sso_method_inactive');
    const providerId = typeof profile.providerId === 'string' ? profile.providerId : '';
    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (
      !providerId ||
      providerId.length > MAX_PROVIDER_ID_LENGTH ||
      email.length > 254 ||
      !/^[^@\s]+@[^@\s]+$/.test(email)
    ) {
      throw refuse('sso_profile_invalid', 400);
    }
    // as n8n: a provider that says "not verified" is refused; with the setting on, only "verified" passes
    if (
      profile.emailVerified === false ||
      (emailVerifiedRequired(row, method) && profile.emailVerified !== true)
    ) {
      throw refuse('sso_email_unverified');
    }

    const path = await this.pathOf(tenant, row, method, providerId, email);
    if (path.kind !== 'new') known(path.user.id);
    // the provisioning may block before any account or link is written
    const existing = path.kind === 'new' ? null : path.user;
    const decision = await ctx.provisioning.resolve(tenant, profile.claims ?? {}, existing);
    if (decision.blocked) throw refuse('sso_access_blocked');

    const name = profileName(profile);
    const passwordHash = path.kind === 'new' ? await ctx.auth.hashPassword(randomToken(32)) : '';
    const user = await this.deps.database.db.transaction(async (tx) => {
      const txRepos = createRepositories(tx);
      let user: UserRow;
      if (path.kind === 'new') {
        user = await txRepos.users.create({ email, name: name || email.split('@')[0], passwordHash });
      } else {
        user = path.user;
        // the name comes from the provider only while no other workspace knows the person
        if (
          name &&
          name !== user.name &&
          (await txRepos.sso.otherMembershipCount(user.id, tenant.id)) === 0
        ) {
          user = (await txRepos.users.updateName(user.id, name)) ?? user;
        }
      }
      const invitation = path.kind === 'invited' || path.kind === 'new' ? path.invitation : undefined;
      if (path.kind === 'new' || invitation) {
        const oldProjectRole = invitation ? OLD_INVITATION_ROLES[invitation.role] : undefined;
        const role: Role = invitation && !oldProjectRole ? invitation.role : 'member';
        if (invitation && !(await txRepos.invitations.markAccepted(tenant.id, invitation.id))) {
          throw refuse('sso_invite_required');
        }
        await txRepos.memberships.add(tenant.id, user.id, role);
        // P6-03: every member has a personal project, in the same transaction as the membership
        await txRepos.projects.ensurePersonal(tenant.id, user);
        const team = oldProjectRole ? await txRepos.projects.oldestTeam(tenant.id) : null;
        if (oldProjectRole && team) {
          await txRepos.projects.relations.add(tenant.id, team.id, user.id, oldProjectRole);
        }
        await txRepos.audit.add(tenant.id, {
          userId: user.id,
          action: 'member.joined',
          resourceType: 'user',
          resourceId: user.id,
          metadata: { role, method, ...(invitation ? { invitationId: invitation.id } : { jit: true }) },
          ip: meta.ip,
        });
      }
      if (path.kind !== 'identity') {
        await txRepos.sso.linkIdentity(tenant.id, { providerType: method, providerId, userId: user.id });
      }
      return user;
    });
    known(user.id);

    if (decision.instanceRole !== undefined || decision.projectRoles !== undefined) {
      await ctx.provisioning.apply(tenant.id, user.id, decision);
    }
    const membership = await repos.memberships.get(tenant.id, user.id);
    if (!membership) throw refuse('sso_user_disabled');
    await repos.users.touchLogin(user.id);
    const token = await ctx.auth.createSession(user.id, tenant.id, meta, {
      authMethod: method,
      mfaVerified: options.mfaVerified ?? method !== 'ldap',
    });
    await repos.audit.add(tenant.id, {
      userId: user.id,
      action: 'auth.sso_login',
      metadata: { method },
      ip: meta.ip,
    });
    return { user, tenant, role: membership.role, token };
  }

  /** Q-A2: who this sign-in is, read only; a refusal here leaves nothing written */
  private async pathOf(
    tenant: TenantRow,
    row: TenantAuthSettingsRow,
    method: SsoProviderType,
    providerId: string,
    email: string,
  ): Promise<SignInPath> {
    const { repos } = this.deps;
    const identity = await repos.sso.getIdentity(tenant.id, method, providerId);
    if (identity) {
      // a differing email keeps the identity: the provider's id is the link, and SSO never changes the email
      const user = await repos.users.get(identity.userId);
      const membership = await repos.memberships.getIncludingDisabled(tenant.id, identity.userId);
      if (!user || !membership || membership.disabledAt) throw refuse('sso_user_disabled');
      return { kind: 'identity', user };
    }
    const user = await repos.users.getByEmail(email);
    const invitation = await repos.sso.pendingInvitation(tenant.id, email);
    if (user) {
      const membership = await repos.memberships.getIncludingDisabled(tenant.id, user.id);
      if (membership) {
        if (membership.disabledAt) throw refuse('sso_user_disabled');
        return { kind: 'member', user };
      }
      // never link by email alone: the person must be a member or invited here
      if (invitation) return { kind: 'invited', user, invitation };
      throw refuse('sso_invite_required');
    }
    if (invitation) return { kind: 'new', invitation };
    if (!row.jit) throw refuse('sso_user_unknown');
    return { kind: 'new' };
  }

  /**
   * After the password: the workspaces the user may enter with it (SAML or OIDC active: owner or flag only;
   * LDAP: owners by email); none left is 403 `sso_required`. A named workspace the password may not enter
   * leaves none, so the page shows that workspace's SSO instead of opening another one.
   */
  async passwordTenants(user: UserRow, tenants: Tenants, workspace?: string): Promise<Tenants> {
    const rules = await this.deps.repos.sso.signInRules(user.id);
    const allowed = new Set(rules.filter(passwordMayEnter).map((rule) => rule.tenantId));
    if (workspace) {
      const asked = tenants.find((tenant) => tenant.slug === workspace);
      if (asked && !allowed.has(asked.id)) return [];
    }
    return tenants.filter((tenant) => allowed.has(tenant.id));
  }

  /**
   * A session entering `tenantId` (switch, MCP consent, form code). Its own workspace passes; a session that
   * signed in with SSO or LDAP stays there (403 `sso_session_fenced`); a password session needs the rule of
   * `passwordMayEnter` (403 `sso_required`); not a member is the 404 of an unknown workspace. A session that
   * did not pass the MFA step cannot enter a workspace that enforces MFA (401 `mfa_enrollment_required`, the
   * gate's answer there): the gate only checks the session's own workspace.
   */
  async assertSessionEntry(auth: AuthContext, tenantId: string): Promise<void> {
    if (auth.tenant.id === tenantId) return;
    if (auth.authMethod && auth.authMethod !== 'password') {
      throw new ApiError(403, 'sso_session_fenced', SSO_ENTRY_FENCED_MESSAGE);
    }
    const [rule] = await this.deps.repos.sso.signInRules(auth.user.id, tenantId);
    if (!rule) throw ApiError.notFound('Workspace');
    if (!passwordMayEnter(rule)) throw new ApiError(403, 'sso_required', SSO_REQUIRED_MESSAGE);
    if (auth.mfaVerified) return;
    const target = await this.deps.repos.tenants.get(tenantId);
    if (target && isMfaEnforced(target, this.deps.config.mfaEnabled)) {
      throw new ApiError(401, 'mfa_enrollment_required', MFA_ENROLLMENT_REQUIRED_MESSAGE);
    }
  }

  /**
   * before an invitation is accepted by password: under SAML, OIDC or LDAP the invitee signs in with that
   * method (n8n refuses invite links under any SSO method; the sign-in takes the pending invitation)
   */
  async assertInviteAcceptable(tenantId: string): Promise<void> {
    const method = await this.deps.context().ssoSettings.activeMethod(tenantId);
    if (method === 'email') return;
    throw new ApiError(
      403,
      'sso_required',
      method === 'ldap' ? LDAP_INVITE_ACCEPT_MESSAGE : SSO_INVITE_ACCEPT_MESSAGE,
    );
  }

  /** before anyone is invited: refused under SAML or OIDC unless SCIM is on (n8n user.service.ts:535-545) */
  async assertInviteAllowed(tenantId: string): Promise<void> {
    if (!(await this.deps.context().ssoSettings.isSsoActive(tenantId))) return;
    if (scimEnabled(await this.deps.repos.tenants.get(tenantId))) return;
    throw new ApiError(400, 'sso_invites_blocked', SSO_INVITES_BLOCKED_MESSAGE);
  }

  /**
   * whether any membership lets this user sign in with a password ('ldap': only through the directory). A
   * user with no workspace has no SSO rule, so 'yes'.
   */
  async passwordAllowedSomewhere(userId: string): Promise<'yes' | 'no' | 'ldap'> {
    const rules = await this.deps.repos.sso.signInRules(userId);
    if (!rules.length || rules.some(passwordMayEnter)) return 'yes';
    return rules.some((rule) => rule.method === 'ldap') ? 'ldap' : 'no';
  }
}
