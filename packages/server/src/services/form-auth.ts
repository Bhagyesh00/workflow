/**
 * Form user auth (P4-16, n8n "n8n User Auth"): a one-time code from the signed-in session, swapped by
 * the form for a 60 minute token. Codes and tokens are never logged, and a stored code is only a hash.
 */
import { randomBytes } from 'node:crypto';
import type { FormAuthHelper, FormUser } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';
import { hasRole, sha256 } from './auth';

const CODE_TTL_MS = 60_000;
/** n8n's FORM_USER_AUTH_TOKEN_TTL_SECONDS */
const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_KIND = 'form-user';
/** 32 random bytes in base64url */
const CODE_SHAPE = /^[\w-]{43}$/;

interface IssuedCode {
  userId: string;
  tenantId: string;
  /** the form it opens */
  path: string;
}

export class FormAuthService implements FormAuthHelper {
  /** used only when the server runs without Redis, so with one process */
  private readonly codes = new Map<string, { value: IssuedCode; expires: number }>();

  constructor(readonly deps: ServiceDeps) {}

  /**
   * Where a visitor without a form token goes. A form cannot see the session, so this page finds out:
   * it asks for the code with the session, and only a visitor with none goes on to /signin.
   */
  signInUrl(returnTo: string): string {
    return `/form-auth?redirect=${encodeURIComponent(returnTo)}`;
  }

  /** the token for a code, null for a used or expired code */
  async exchangeCode(code: string): Promise<string | null> {
    if (!CODE_SHAPE.test(code)) return null;
    const issued = await this.take(code);
    if (!issued) return null;
    return this.deps
      .context()
      .formTokens.sign(
        { kind: TOKEN_KIND, userId: issued.userId, tenantId: issued.tenantId, path: issued.path },
        TOKEN_TTL_SECONDS,
      );
  }

  /** the user of a valid token who is still a member of its workspace */
  async verifyToken(token: string): Promise<FormUser | null> {
    const payload = this.deps.context().formTokens.verify(token);
    if (payload?.kind !== TOKEN_KIND) return null;
    const { userId, tenantId } = payload;
    if (typeof userId !== 'string' || typeof tenantId !== 'string') return null;
    const { repos } = this.deps;
    const [user, membership] = await Promise.all([
      repos.users.get(userId),
      repos.memberships.get(tenantId, userId),
    ]);
    if (!user || !membership) return null;
    const [firstName = '', ...rest] = user.name.trim().split(/\s+/);
    return { id: user.id, email: user.email, firstName, lastName: rest.join(' ') };
  }

  /** editor or above in the workflow's tenant */
  async canExecute(userId: string, workflowId: string): Promise<boolean> {
    const { repos } = this.deps;
    const memberships = await repos.memberships.listForUser(userId);
    for (const { id: tenantId, role } of memberships) {
      if (!hasRole(role, 'editor')) continue;
      if (await repos.workflows.get(tenantId, workflowId)) return true;
    }
    return false;
  }

  /** a one-time code, good for 60 seconds, for a member of the workspace the form belongs to */
  async issueCode(userId: string, returnTo: string): Promise<string> {
    const path = returnTo.split('?')[0];
    const tenantId = await this.tenantOfForm(path);
    if (!tenantId || !(await this.deps.repos.memberships.get(tenantId, userId))) {
      // an unknown form and someone else's form look the same
      throw new ApiError(403, 'forbidden', "You aren't a member of the workspace this form belongs to");
    }
    const code = randomBytes(32).toString('base64url');
    await this.keep(code, { userId, tenantId, path });
    return code;
  }

  /** `/form[-test]/<tenantSlug>/...` or `/form-waiting/<executionId>/...` */
  private async tenantOfForm(path: string): Promise<string | undefined> {
    const { repos } = this.deps;
    const [, base, owner] = path.split('/');
    if (!owner) return undefined;
    if (base === 'form-waiting') return repos.executions.findTenantOf(owner);
    return (await repos.tenants.getBySlug(owner))?.id;
  }

  private storeKey(code: string): string {
    return `${this.deps.config.queue.prefix}:form-auth:code:${sha256(code)}`;
  }

  private async keep(code: string, value: IssuedCode): Promise<void> {
    const key = this.storeKey(code);
    const { redis } = this.deps.context();
    if (redis) {
      await redis.set(key, JSON.stringify(value), 'PX', CODE_TTL_MS);
      return;
    }
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expires <= now) this.codes.delete(k);
    this.codes.set(key, { value, expires: now + CODE_TTL_MS });
  }

  /** read once: the code is gone afterwards, also when two requests race for it */
  private async take(code: string): Promise<IssuedCode | undefined> {
    const key = this.storeKey(code);
    const { redis } = this.deps.context();
    if (redis) {
      // GET + DEL in one transaction (GETDEL needs Redis 6.2 or later)
      const result = await redis.multi().get(key).del(key).exec();
      const raw = result?.[0]?.[1];
      return typeof raw === 'string' && raw ? (JSON.parse(raw) as IssuedCode) : undefined;
    }
    const entry = this.codes.get(key);
    this.codes.delete(key);
    return entry && entry.expires > Date.now() ? entry.value : undefined;
  }
}
