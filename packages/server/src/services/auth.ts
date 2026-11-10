/**
 * Authentication (ARCHITECTURE.md §10): argon2id passwords, opaque session tokens (only the
 * sha256 is stored), invitations and API keys.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from '../config';
import type { Database } from '../db/client';
import type { LegacyRole, Role, SystemRole, TenantRow, UserRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories, type Repositories } from '../repositories';
import { PUBLIC_API_AUDIENCE } from '../repositories/accounts';
import type { SsoProfile } from './sso/login';

export const SESSION_COOKIE = 'wf_session';
// the session lifetime is `config.sessionTtlMs` (USER_MANAGEMENT_JWT_DURATION_HOURS, default 14 days)
/** a session is extended at most once per this interval (sliding expiry) */
export const SESSION_REFRESH_MS = 3_600_000;
const INVITATION_TTL_MS = 7 * 86_400_000;

/** the system words a workspace role can be besides a custom global slug */
const MEMBER_ROLES: ReadonlySet<string> = new Set<SystemRole>(['owner', 'admin', 'member']);

/**
 * P6-39 (C2-Q3): an invitation sent before the cutover may still hold an old word. On accept it becomes
 * `member` plus this project role on the workspace's oldest team project (as migration 0024 did for the
 * memberships). The invite route refuses these words, so no new invitation holds one.
 */
const OLD_INVITATION_ROLES: Readonly<Record<LegacyRole, string>> = {
  editor: 'project:editor',
  viewer: 'project:viewer',
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** an API key `wfk_<prefix>_<secret>` and its prefix; only sha256(key) is stored */
function newApiKeySecret(): { prefix: string; key: string } {
  const prefix = randomBytes(4).toString('hex');
  return { prefix, key: `wfk_${prefix}_${randomToken(32)}` };
}

/** at least 8 characters with a letter and a digit */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 8) return 'The password must be at least 8 characters long';
  if (password.length > 256) return 'The password is too long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'The password must contain a letter and a digit';
  }
  return undefined;
}

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
/** verified against when the user does not exist, so timing does not reveal accounts */
const DUMMY_HASH = hash('dummy-password-0', ARGON2);

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'workspace';
}

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface TenantDTO {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

export function userDTO(user: UserRow): UserDTO {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

export function tenantDTO(tenant: TenantRow): TenantDTO {
  return { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan };
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthResult {
  user: UserRow;
  tenant: TenantRow;
  role: Role;
  /** raw session token for the cookie */
  token: string;
}

/** how a session signed in (`sessions.auth_method`); every way but password is fenced (P6-01) */
export type SessionAuthMethod = 'password' | 'saml' | 'oidc' | 'ldap';

/** P6-01, P6-12, P6-18: the sign-in body (routes/auth.ts `loginSchema`) */
export interface LoginInput {
  email: string;
  password: string;
  /** the workspace slug the person signs in to (the sign-in page's workspace field) */
  workspace?: string;
  /** six digits from the authenticator app */
  mfaCode?: string;
  mfaRecoveryCode?: string;
}

/** a workspace of the user, as `memberships.listForUser` lists it */
export interface MemberTenant {
  id: string;
  name: string;
  slug: string;
  role: Role;
}
export type Tenants = MemberTenant[];

/** P6-12: a person the directory verified (LDAP bind), with no session yet; `user` null = no account yet */
export interface DirectoryMatch {
  tenant: TenantRow;
  profile: SsoProfile;
  user: UserRow | null;
}

/**
 * The sign-in steps other services own (wired by context.ts through `useSignInSteps`): the SSO rules
 * (L6), the LDAP login (L10) and the MFA step (L2). Until wired, the defaults below keep today's sign-in.
 */
export interface SignInSteps {
  /** after the password: the workspaces this user may enter with a password; none left is 403 `sso_required` */
  passwordTenants(user: UserRow, tenants: Tenants, workspace?: string): Promise<Tenants>;
  /** before the password check: a directory login (LDAP), or undefined to go on with the password */
  directoryLogin(input: LoginInput, meta: SessionMeta): Promise<DirectoryMatch | undefined>;
  /** the session of a directory match (`ssoLogin.signIn` with `authMethod: 'ldap'`) */
  directorySignIn(match: DirectoryMatch, meta: SessionMeta): Promise<AuthResult>;
  /** the MFA step: throws 401 `mfa_required` or a wrong code; `mfaVerified` goes on the session */
  mfaStep(user: UserRow, input: LoginInput): Promise<{ mfaVerified: boolean }>;
  /** before an invitation is accepted (no write before it) */
  assertInviteAcceptable(tenantId: string): Promise<void>;
  /** a session entering a workspace (switch): throws 403 when SSO fences it */
  assertSessionEntry(auth: AuthContext, tenantId: string): Promise<void>;
}

/** today's sign-in: every workspace, no directory, no MFA, every invitation, a switch to any membership */
const DEFAULT_SIGN_IN_STEPS: SignInSteps = {
  passwordTenants: async (_user, tenants) => tenants,
  directoryLogin: async () => undefined,
  directorySignIn: async () => {
    throw new Error('directory sign-in is not wired');
  },
  mfaStep: async () => ({ mfaVerified: false }),
  assertInviteAcceptable: async () => {},
  assertSessionEntry: async () => {},
};

/** P6-01: a session that signed in through SSO or LDAP cannot change what the account holds everywhere */
export const SSO_SESSION_FENCED_MESSAGE =
  'This session signed in with single sign-on, so it cannot change the account. Sign in with your password to change it.';

export class AuthService {
  private steps: SignInSteps = DEFAULT_SIGN_IN_STEPS;

  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly repos: Repositories,
  ) {}

  /** where the SSO, LDAP and MFA steps come from (context.ts), as `CredentialService.useSecrets` */
  useSignInSteps(steps: SignInSteps): void {
    this.steps = steps;
  }

  /**
   * P6-01: account-wide changes (name, email, password, MFA) need a password session; a session that
   * signed in with SAML, OIDC or LDAP gets 403 `sso_session_fenced`. An API key has no `authMethod`.
   */
  assertGlobalAccountChange(auth: AuthContext): void {
    if (auth.authMethod && auth.authMethod !== 'password') {
      throw new ApiError(403, 'sso_session_fenced', SSO_SESSION_FENCED_MESSAGE);
    }
  }

  hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2);
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private async uniqueSlug(repos: Repositories, name: string): Promise<string> {
    const base = slugify(name);
    if (!(await repos.tenants.slugExists(base))) return base;
    for (let i = 2; i < 50; i++) {
      const candidate = `${base}-${i}`;
      if (!(await repos.tenants.slugExists(candidate))) return candidate;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  /** a new session; `authMethod` defaults to password and `mfaVerified` to false */
  async createSession(
    userId: string,
    tenantId: string,
    meta: SessionMeta,
    options: { authMethod?: SessionAuthMethod; mfaVerified?: boolean } = {},
  ): Promise<string> {
    const token = randomToken();
    await this.repos.sessions.create({
      id: sha256(token),
      userId,
      tenantId,
      expiresAt: new Date(Date.now() + this.config.sessionTtlMs),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512),
      authMethod: options.authMethod ?? 'password',
      mfaVerified: options.mfaVerified ?? false,
    });
    return token;
  }

  async signup(
    input: { email: string; password: string; name: string; workspaceName: string },
    meta: SessionMeta,
    options: { ignoreSignupSetting?: boolean } = {},
  ): Promise<AuthResult> {
    if (!this.config.signupEnabled && !options.ignoreSignupSetting) {
      throw ApiError.forbidden('Sign-up is disabled on this instance');
    }
    const problem = passwordProblem(input.password);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    if (await this.repos.users.getByEmail(input.email)) {
      throw ApiError.conflict('An account with this email already exists');
    }
    const passwordHash = await this.hashPassword(input.password);
    const { user, tenant } = await this.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const user = await repos.users.create({ email: input.email, name: input.name, passwordHash });
      const tenant = await repos.tenants.create({
        name: input.workspaceName,
        slug: await this.uniqueSlug(repos, input.workspaceName),
        plan: this.config.defaultPlan,
      });
      await repos.memberships.add(tenant.id, user.id, 'owner');
      // P6-39: the owner's personal project; team projects are made on the projects page (n8n)
      await repos.projects.ensurePersonal(tenant.id, user);
      return { user, tenant };
    });
    const token = await this.createSession(user.id, tenant.id, meta);
    await this.repos.audit.add(tenant.id, { userId: user.id, action: 'auth.signup', ip: meta.ip });
    return { user, tenant, role: 'owner', token };
  }

  /**
   * Sign-in. A directory login (LDAP, L10) goes first: on a match, the MFA step for a known user, then the
   * directory session (as n8n checks MFA after the LDAP check). With no match, the password as before, then
   * the workspaces SSO still lets in by password (none left: 403 `sso_required`), then the MFA step.
   */
  async login(input: LoginInput, meta: SessionMeta): Promise<AuthResult> {
    const match = await this.steps.directoryLogin(input, meta);
    if (match) {
      if (match.user) await this.steps.mfaStep(match.user, input);
      return this.steps.directorySignIn(match, meta);
    }
    const user = await this.repos.users.getByEmail(input.email);
    const ok = user
      ? await this.verifyPassword(user.passwordHash, input.password)
      : await this.verifyPassword(await DUMMY_HASH, input.password).then(() => false);
    if (!user || !ok) {
      if (user) {
        const [first] = await this.repos.memberships.listForUser(user.id);
        if (first)
          await this.repos.audit.add(first.id, { userId: user.id, action: 'auth.login_failed', ip: meta.ip });
      }
      throw new ApiError(401, 'invalid_credentials', 'Wrong email or password');
    }
    const memberOf = await this.repos.memberships.listForUser(user.id);
    if (!memberOf.length) throw ApiError.forbidden('This account does not belong to any workspace');
    const tenants = await this.steps.passwordTenants(user, memberOf, input.workspace);
    if (!tenants.length) {
      throw new ApiError(
        403,
        'sso_required',
        'This workspace signs in with single sign-on. Use SSO to sign in.',
      );
    }
    const { mfaVerified } = await this.steps.mfaStep(user, input);
    const first = (input.workspace && tenants.find((t) => t.slug === input.workspace)) || tenants[0];
    const tenant = (await this.repos.tenants.get(first.id))!;
    await this.repos.users.touchLogin(user.id);
    const token = await this.createSession(user.id, tenant.id, meta, { authMethod: 'password', mfaVerified });
    await this.repos.audit.add(tenant.id, { userId: user.id, action: 'auth.login', ip: meta.ip });
    return { user, tenant, role: first.role, token };
  }

  async logout(sessionId: string, tenantId: string, userId: string, ip?: string): Promise<void> {
    await this.repos.sessions.delete(sessionId);
    await this.repos.audit.add(tenantId, { userId, action: 'auth.logout', ip });
  }

  /** moves the session to another workspace of the user; SSO may fence the entry (`assertSessionEntry`, L6) */
  async switchTenant(auth: AuthContext, tenantId: string) {
    if (!auth.sessionId) throw ApiError.unauthorized();
    const membership = await this.repos.memberships.get(tenantId, auth.user.id);
    if (!membership) throw ApiError.notFound('Workspace');
    await this.steps.assertSessionEntry(auth, tenantId);
    await this.repos.sessions.switchTenant(auth.sessionId, tenantId);
    const tenant = (await this.repos.tenants.get(tenantId))!;
    return { tenant, role: membership.role };
  }

  // -------------------------------------------------------------------------------------------
  // invitations

  /**
   * P6-31: a role a member may hold in a workspace: a system role (owner, admin, member) or the slug of one
   * of the workspace's custom roles of type global. Anything else, the old words included, is a 400.
   */
  async assertMemberRole(tenantId: string, role: string): Promise<void> {
    if (MEMBER_ROLES.has(role)) return;
    const custom = await this.repos.roles.get(tenantId, role);
    if (custom?.roleType !== 'global') throw ApiError.badRequest(`Unknown role "${role}"`);
  }

  async invite(tenantId: string, inviter: { id: string; role: Role }, email: string, role: Role) {
    await this.assertMemberRole(tenantId, role);
    if (role === 'owner' && inviter.role !== 'owner')
      throw ApiError.forbidden('Only owners can invite owners');
    const existing = await this.repos.users.getByEmail(email);
    // a disabled member is still a member: enable them instead of inviting again
    if (existing && (await this.repos.memberships.getIncludingDisabled(tenantId, existing.id))) {
      throw ApiError.conflict('This user is already a member of the workspace');
    }
    const token = randomToken();
    const invitation = await this.repos.invitations.create({
      tenantId,
      email: email.toLowerCase(),
      role,
      tokenHash: sha256(token),
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    return { invitation, token };
  }

  /** accept an invitation: creates the user, or verifies the password of an existing one */
  async acceptInvitation(
    token: string,
    input: { name: string; password: string },
    meta: SessionMeta,
  ): Promise<AuthResult> {
    const invitation = await this.repos.invitations.getPendingByTokenHash(sha256(token));
    if (!invitation) throw ApiError.notFound('Invitation');
    // P6-01: SSO may refuse the entry; before any write
    await this.steps.assertInviteAcceptable(invitation.tenantId);
    let user = await this.repos.users.getByEmail(invitation.email);
    if (user) {
      if (!(await this.verifyPassword(user.passwordHash, input.password))) {
        throw new ApiError(401, 'invalid_credentials', 'Wrong password for the existing account');
      }
    } else {
      const problem = passwordProblem(input.password);
      if (problem) throw new ApiError(400, 'weak_password', problem);
      user = await this.repos.users.create({
        email: invitation.email,
        name: input.name,
        passwordHash: await this.hashPassword(input.password),
      });
    }
    const accepted = await this.repos.invitations.markAccepted(invitation.tenantId, invitation.id);
    if (!accepted) throw ApiError.notFound('Invitation');
    const oldProjectRole = Object.hasOwn(OLD_INVITATION_ROLES, invitation.role)
      ? OLD_INVITATION_ROLES[invitation.role as LegacyRole]
      : undefined;
    const role: Role = oldProjectRole ? 'member' : invitation.role;
    await this.repos.memberships.add(invitation.tenantId, user.id, role);
    // P6-03: every member has a personal project in the workspace
    await this.repos.projects.ensurePersonal(invitation.tenantId, user);
    // with no team project left there is no shared work to grant: the member joins with its personal project
    // only, and the audit line says so (`projectId: null`), so an admin can add it to a project
    const team = oldProjectRole ? await this.repos.projects.oldestTeam(invitation.tenantId) : null;
    if (oldProjectRole && team) {
      await this.repos.projects.relations.add(invitation.tenantId, team.id, user.id, oldProjectRole);
    }
    const tenant = (await this.repos.tenants.get(invitation.tenantId))!;
    const sessionToken = await this.createSession(user.id, tenant.id, meta);
    await this.repos.audit.add(tenant.id, {
      userId: user.id,
      action: 'member.joined',
      resourceType: 'user',
      resourceId: user.id,
      metadata: {
        role,
        ...(oldProjectRole
          ? { invitedAs: invitation.role, projectRole: oldProjectRole, projectId: team?.id ?? null }
          : {}),
      },
      ip: meta.ip,
    });
    return { user, tenant, role, token: sessionToken };
  }

  // -------------------------------------------------------------------------------------------
  // API keys: `wfk_<prefix>_<secret>`

  /**
   * empty scopes = every route the user's role allows; `audience` says where the key works
   * (`public-api` for /api/v1, `mcp-server-api` for the tenant MCP server) and nowhere else;
   * `expiresAt` (P6-21) null or absent = never expires
   */
  async createApiKey(
    tenantId: string,
    userId: string,
    name: string,
    scopes: string[] = [],
    audience: string = PUBLIC_API_AUDIENCE,
    expiresAt: Date | null = null,
  ) {
    const { prefix, key } = newApiKeySecret();
    const row = await this.repos.apiKeys.create({
      tenantId,
      userId,
      name,
      prefix,
      keyHash: sha256(key),
      scopes,
      audience,
      expiresAt,
    });
    return {
      id: row.id,
      name: row.name,
      prefix,
      key,
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * P6-21: a new secret on the same row (new prefix and hash; name, scopes and expiry kept), shown once.
   * The owner's own `public-api` key only (another's or an MCP key is 404); an expired key is a 400.
   */
  async rotateApiKey(tenantId: string, userId: string, id: string) {
    const current = (await this.repos.apiKeys.list(tenantId, userId)).find((k) => k.id === id);
    if (!current) throw ApiError.notFound('API key');
    if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest('Cannot rotate an expired API key');
    }
    const { prefix, key } = newApiKeySecret();
    const row = await this.repos.apiKeys.rotate(tenantId, userId, id, { prefix, keyHash: sha256(key) });
    if (!row) throw ApiError.notFound('API key');
    return {
      id: row.id,
      name: row.name,
      prefix,
      key,
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * resolve an API key to its tenant, user and the user's current role; a key of another audience
   * (an MCP key on the public API, a public key on the MCP server) is refused like an unknown key
   */
  async authenticateApiKey(key: string, audience: string = PUBLIC_API_AUDIENCE) {
    if (!/^wfk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(key)) return undefined;
    const row = await this.repos.apiKeys.getByHash(sha256(key));
    if (!row || row.audience !== audience) return undefined;
    // P6-21: an expired key is refused like an unknown key
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    const membership = await this.repos.memberships.get(row.tenantId, row.userId);
    if (!membership) return undefined;
    const [user, tenant] = await Promise.all([
      this.repos.users.get(row.userId),
      this.repos.tenants.get(row.tenantId),
    ]);
    if (!user || !tenant) return undefined;
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      await this.repos.apiKeys.touch(row.tenantId, row.id);
    }
    return { user, tenant, role: membership.role, apiKeyId: row.id, apiKeyScopes: row.scopes };
  }
}
