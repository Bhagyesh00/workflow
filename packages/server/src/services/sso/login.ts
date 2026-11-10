/**
 * P6-01 (L6): the SSO sign-in rules shared by SAML (L7), OIDC (L8) and LDAP (L10), per decisions
 * "Security, final". `signIn` finds the identity, links a current member or pending invitation by a verified
 * email, or creates the user just in time (Q-A2), asks the provisioning (`ctx.provisioning.resolve`) and
 * makes a session with its `authMethod` and `mfaVerified: true`. The fence: a session that signed in with
 * SSO cannot enter another workspace or change the account; a password session into an SSO workspace
 * needs the owner or the member's manual login flag.
 * Stub from C0: `passwordTenants`, `assertSessionEntry`, `assertInviteAcceptable` and `assertInviteAllowed`
 * PASS (today's behaviour); `signIn` and `passwordAllowedSomewhere` throw until L6.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TenantRow, UserRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { SsoProviderType } from '../../repositories/sso';
import type { AuthResult, SessionAuthMethod, SessionMeta, Tenants } from '../auth';

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
}

export class SsoLoginService {
  constructor(readonly deps: ServiceDeps) {}

  async signIn(
    _tenant: TenantRow,
    _profile: SsoProfile,
    _meta: SessionMeta,
    _options: SsoSignInOptions,
  ): Promise<AuthResult> {
    throw new Error('not implemented (L6)');
  }

  /**
   * After the password: the workspaces the user may enter with it (SAML or OIDC active: owner or flag only;
   * LDAP: owners by email); none left is 403 `sso_required`. Stub (L6) PASSES: all of them.
   */
  async passwordTenants(_user: UserRow, tenants: Tenants, _workspace?: string): Promise<Tenants> {
    return tenants;
  }

  /**
   * A session entering `tenantId` (switch, MCP consent, form code). Stub (L6) PASSES when it is the
   * session's workspace or the user is a member of it; anything else is the 404 of an unknown workspace
   * (every caller checked the membership first, so today nothing reaches it).
   */
  async assertSessionEntry(auth: AuthContext, tenantId: string): Promise<void> {
    if (auth.tenant.id === tenantId) return;
    if (await this.deps.repos.memberships.get(tenantId, auth.user.id)) return;
    throw ApiError.notFound('Workspace');
  }

  /** before an invitation is accepted by password. Stub (L6) PASSES */
  async assertInviteAcceptable(_tenantId: string): Promise<void> {
    // stub (L6): PASSES
  }

  /** before anyone is invited (refused under SSO unless SCIM is on). Stub (L6) PASSES */
  async assertInviteAllowed(_tenantId: string): Promise<void> {
    // stub (L6): PASSES
  }

  /** whether any membership lets this user sign in with a password ('ldap': only through the directory) */
  async passwordAllowedSomewhere(_userId: string): Promise<'yes' | 'no' | 'ldap'> {
    throw new Error('not implemented (L6)');
  }
}
