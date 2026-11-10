/**
 * Form user auth (P4-16, n8n "n8n User Auth"): a one-time code from the signed-in session, swapped by
 * the form for a 60 minute token. Codes and tokens are never logged, and a stored code is only a hash.
 * The same code opens a hosted chat (P5-57) and, since P6-87, a Webhook with "Workspace sign-in (OAuth2)":
 * a `/webhook` path is accepted only when it is that node (never any webhook), and its token is of kind
 * `webhook-user`.
 */
import { randomBytes } from 'node:crypto';
import { CHAT_TOKEN_KINDS, type FormAuthHelper, type FormUser } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { sha256 } from './auth';
import { isWebhookSignInNode, triggerNodesAt, WEBHOOK_METHODS } from './mcp/oauth/metadata';
import { normalizePath } from './webhook-paths';

const CODE_TTL_MS = 60_000;
/** n8n's FORM_USER_AUTH_TOKEN_TTL_SECONDS */
const TOKEN_TTL_SECONDS = 60 * 60;
const FORM_TOKEN_KIND = 'form-user';
/** the token kind of a Webhook with workspace sign-in (nodes-base utils/workspace-signin.ts uses the same) */
export const WEBHOOK_TOKEN_KIND = 'webhook-user';
/** the address of a Chat Trigger: its codes and tokens are of the chat kind (P5-57) */
const CHAT_PATH = /^\/webhook(-test)?\/[^/]+\/.+\/chat$/;
/** 32 random bytes in base64url */
const CODE_SHAPE = /^[\w-]{43}$/;

interface IssuedCode {
  userId: string;
  tenantId: string;
  /** the form, chat or webhook it opens */
  path: string;
  /** the kind of token the code is swapped for; set by `issueCode` from what the path is */
  kind?: string;
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

  /** the token for a code, null for a used or expired code; a chat path's code gives a `chat-user` token */
  async exchangeCode(code: string): Promise<string | null> {
    if (!CODE_SHAPE.test(code)) return null;
    const issued = await this.take(code);
    if (!issued) return null;
    return this.deps.context().formTokens.sign(
      {
        kind: issued.kind ?? (CHAT_PATH.test(issued.path) ? CHAT_TOKEN_KINDS.user : FORM_TOKEN_KIND),
        userId: issued.userId,
        tenantId: issued.tenantId,
        path: issued.path,
      },
      TOKEN_TTL_SECONDS,
    );
  }

  /** the user of a valid token who is still a member of its workspace */
  async verifyToken(token: string): Promise<FormUser | null> {
    const payload = this.deps.context().formTokens.verify(token);
    // the page's own check binds the kind: a form token never opens a chat or a webhook, and so on
    const kind = payload?.kind;
    if (kind !== FORM_TOKEN_KIND && kind !== CHAT_TOKEN_KINDS.user && kind !== WEBHOOK_TOKEN_KIND)
      return null;
    const { userId, tenantId } = payload as { userId: unknown; tenantId: unknown };
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

  /**
   * `workflow:execute` for this user on the workflow, in the workspace the workflow belongs to (P6-27: their
   * scopes there, through their projects; a workspace they are not in, or a workflow they hold no scope on, is false)
   */
  async canExecute(userId: string, workflowId: string): Promise<boolean> {
    const { repos } = this.deps;
    const { access } = this.deps.context();
    const memberships = await repos.memberships.listForUser(userId);
    for (const { id: tenantId } of memberships) {
      if (!(await repos.workflows.get(tenantId, workflowId))) continue;
      if ((await access.scopesFor(tenantId, userId, { workflowId })).has('workflow:execute')) return true;
    }
    return false;
  }

  /**
   * a one-time code, good for 60 seconds, for a member of the workspace the form belongs to; the session must
   * be allowed into that workspace (P6-01: SSO fences a session of another workspace)
   */
  async issueCode(auth: AuthContext, returnTo: string): Promise<string> {
    const userId = auth.user.id;
    const path = returnTo.split('?')[0];
    const target = await this.targetOf(path);
    if (!target || !(await this.deps.repos.memberships.get(target.tenantId, userId))) {
      // an unknown form and someone else's form look the same
      throw new ApiError(403, 'forbidden', "You aren't a member of the workspace this form belongs to");
    }
    const { tenantId, kind } = target;
    await this.deps.context().ssoLogin.assertSessionEntry(auth, tenantId);
    const code = randomBytes(32).toString('base64url');
    await this.keep(code, { userId, tenantId, path, kind });
    return code;
  }

  /**
   * What a path opens: `/form[-test]/<tenantSlug>/...` or `/form-waiting/<executionId>/...` (a form),
   * `/webhook[-test]/<tenantSlug>/...` (a Chat Trigger's `/chat` path, or a Webhook with workspace sign-in; any
   * other webhook is not a target), undefined for anything else
   */
  private async targetOf(path: string): Promise<{ tenantId: string; kind: string } | undefined> {
    const { repos } = this.deps;
    const [, base, owner] = path.split('/');
    if (!owner) return undefined;
    if (base === 'form-waiting') {
      const tenantId = await repos.executions.findTenantOf(owner);
      return tenantId ? { tenantId, kind: FORM_TOKEN_KIND } : undefined;
    }
    const tenant = await repos.tenants.getBySlug(owner);
    if (!tenant) return undefined;
    if (base === 'form' || base === 'form-test') return { tenantId: tenant.id, kind: FORM_TOKEN_KIND };
    if (base !== 'webhook' && base !== 'webhook-test') return undefined;
    if (await this.isWebhookSignIn(tenant.id, base === 'webhook-test', path)) {
      return { tenantId: tenant.id, kind: WEBHOOK_TOKEN_KIND };
    }
    return CHAT_PATH.test(path) ? { tenantId: tenant.id, kind: CHAT_TOKEN_KINDS.user } : undefined;
  }

  /** whether the path is a Webhook node with "Workspace sign-in (OAuth2)" that serves now */
  private async isWebhookSignIn(tenantId: string, test: boolean, path: string): Promise<boolean> {
    let rest: string;
    try {
      rest = normalizePath(
        path
          .split('/')
          .slice(3)
          .map((segment) => decodeURIComponent(segment))
          .join('/'),
      );
    } catch {
      return false;
    }
    if (!rest) return false;
    const nodes = await triggerNodesAt(this.deps.context(), tenantId, test, rest, WEBHOOK_METHODS);
    return nodes.some(isWebhookSignInNode);
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
