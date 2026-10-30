/**
 * Authentication (ARCHITECTURE.md §10): argon2id passwords, opaque session tokens (only the
 * sha256 is stored), invitations and API keys.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from '../config';
import type { Database } from '../db/client';
import type { Role, TenantRow, UserRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { createRepositories, type Repositories } from '../repositories';

export const SESSION_COOKIE = 'wf_session';
export const SESSION_TTL_MS = 14 * 86_400_000;
/** a session is extended at most once per this interval (sliding expiry) */
export const SESSION_REFRESH_MS = 3_600_000;
const INVITATION_TTL_MS = 7 * 86_400_000;

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
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

export class AuthService {
  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly repos: Repositories,
  ) {}

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

  async createSession(userId: string, tenantId: string, meta: SessionMeta): Promise<string> {
    const token = randomToken();
    await this.repos.sessions.create({
      id: sha256(token),
      userId,
      tenantId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512),
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
      return { user, tenant };
    });
    const token = await this.createSession(user.id, tenant.id, meta);
    await this.repos.audit.add(tenant.id, { userId: user.id, action: 'auth.signup', ip: meta.ip });
    return { user, tenant, role: 'owner', token };
  }

  async login(input: { email: string; password: string }, meta: SessionMeta): Promise<AuthResult> {
    const user = await this.repos.users.getByEmail(input.email);
    const ok = user
      ? await this.verifyPassword(user.passwordHash, input.password)
      : await this.verifyPassword(await DUMMY_HASH, input.password).then(() => false);
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong email or password');
    const tenants = await this.repos.memberships.listForUser(user.id);
    if (!tenants.length) throw ApiError.forbidden('This account does not belong to any workspace');
    const first = tenants[0];
    const tenant = (await this.repos.tenants.get(first.id))!;
    await this.repos.users.touchLogin(user.id);
    const token = await this.createSession(user.id, tenant.id, meta);
    await this.repos.audit.add(tenant.id, { userId: user.id, action: 'auth.login', ip: meta.ip });
    return { user, tenant, role: first.role, token };
  }

  async logout(sessionId: string, tenantId: string, userId: string, ip?: string): Promise<void> {
    await this.repos.sessions.delete(sessionId);
    await this.repos.audit.add(tenantId, { userId, action: 'auth.logout', ip });
  }

  async switchTenant(sessionId: string, userId: string, tenantId: string) {
    const membership = await this.repos.memberships.get(tenantId, userId);
    if (!membership) throw ApiError.notFound('Workspace');
    await this.repos.sessions.switchTenant(sessionId, tenantId);
    const tenant = (await this.repos.tenants.get(tenantId))!;
    return { tenant, role: membership.role };
  }

  // -------------------------------------------------------------------------------------------
  // invitations

  async invite(tenantId: string, inviter: { id: string; role: Role }, email: string, role: Role) {
    if (role === 'owner' && inviter.role !== 'owner')
      throw ApiError.forbidden('Only owners can invite owners');
    const existing = await this.repos.users.getByEmail(email);
    if (existing && (await this.repos.memberships.get(tenantId, existing.id))) {
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
    await this.repos.memberships.add(invitation.tenantId, user.id, invitation.role);
    const tenant = (await this.repos.tenants.get(invitation.tenantId))!;
    const sessionToken = await this.createSession(user.id, tenant.id, meta);
    await this.repos.audit.add(tenant.id, {
      userId: user.id,
      action: 'member.joined',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role: invitation.role },
      ip: meta.ip,
    });
    return { user, tenant, role: invitation.role, token: sessionToken };
  }

  // -------------------------------------------------------------------------------------------
  // API keys: `wfk_<prefix>_<secret>`

  async createApiKey(tenantId: string, userId: string, name: string) {
    const prefix = randomBytes(4).toString('hex');
    const key = `wfk_${prefix}_${randomToken(32)}`;
    const row = await this.repos.apiKeys.create({ tenantId, userId, name, prefix, keyHash: sha256(key) });
    return { id: row.id, name: row.name, prefix, key, createdAt: row.createdAt.toISOString() };
  }

  /** resolve an API key to its tenant, user and the user's current role */
  async authenticateApiKey(key: string) {
    if (!/^wfk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(key)) return undefined;
    const row = await this.repos.apiKeys.getByHash(sha256(key));
    if (!row) return undefined;
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
    return { user, tenant, role: membership.role, apiKeyId: row.id };
  }
}
