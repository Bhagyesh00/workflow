/**
 * Workspace sign-in for public pages (forms and chats; `@workflow/nodes-base/utils/user-auth`). Only
 * signed-in workspace members get through. The session cookie never reaches a page URL, so sign-in comes
 * back with a one-time code; the page's GET swaps it for a 60 minute token of `tokenKind`, kept in the
 * cookie `cookieName` on `cookiePath` and sent by the page as `x-auth-token`. Tokens and codes are never
 * logged, output or put in a redirect. The form check (form/user-auth.ts) and the Chat Trigger call it with
 * their own kind, cookie and texts.
 */
import type {
  DataObject,
  FormAuthHelper,
  FormUser,
  WebhookContext,
  WebhookResponse,
} from '@workflow/workflow';

/** n8n's FORM_USER_AUTH_TOKEN_TTL_SECONDS */
const TOKEN_TTL_SECONDS = 60 * 60;
const CODE_PARAMETER = 'code';

export interface UserAuthParams {
  /** `trigger`: the trigger's own page; `waiting`: a later page of a waiting run */
  scope: 'trigger' | 'waiting';
  /** only members who may run this workflow (editors and above) get through */
  requireExecuteAccess: boolean;
  /** the token kind minted and checked: `form-user` or `chat-user` (CHAT_TOKEN_KINDS.user) */
  tokenKind: string;
  /** the cookie that keeps the token, for example `ncb-chat-auth-wf-<workflowId>` */
  cookieName: string;
  /** the cookie's Path */
  cookiePath: string;
  texts: { noSignIn: string; noPermission: string; signInAgain: string };
  /** the HTML page of a refusal */
  refusalPage(message: string): string;
}

export interface UserAuthResult {
  /** false: send `response` instead of the page */
  allowed: boolean;
  /** the signed-in user; the caller adds it to the output when Include User in Output is on */
  user?: FormUser;
  /** the token the page sends back as `x-auth-token` (a chat page's fetch omits cookies) */
  token?: string;
  /** set on the reply in every case; carries the auth cookie */
  headers: Record<string, string>;
  /** the reply when not allowed: a 302 to sign-in, or a 403 */
  response?: WebhookResponse;
}

function headerValue(ctx: WebhookContext, name: string): string | undefined {
  const value = ctx.getHeaderData()[name];
  return Array.isArray(value) ? value[0] : value;
}

/** the address the browser asked for; the route passes it on, a context has no other way to know */
const requestPath = (ctx: WebhookContext) => ctx.getRequestObject().url?.split('?')[0];

/** this page's path: a later page's signed URL, or the address of the trigger's page */
function pagePath(ctx: WebhookContext, scope: UserAuthParams['scope']): string | undefined {
  if (scope === 'trigger') return requestPath(ctx);
  const url = ctx.getResumeFormUrl();
  return url ? new URL(url).pathname : undefined;
}

/** the query of this request without the code */
function cleanQuery(ctx: WebhookContext): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(ctx.getQueryData())) {
    if (name === CODE_PARAMETER) continue;
    for (const one of Array.isArray(value) ? value : [value]) params.append(name, String(one));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** what a token has to hold to open this page: it opens one workflow, or one execution's later pages */
function tokenBinding(ctx: WebhookContext, params: UserAuthParams): DataObject {
  const binding: DataObject = {
    kind: params.tokenKind,
    tenantId: ctx.getTenantId(),
    workflowId: ctx.getWorkflow().id ?? '',
  };
  if (params.scope === 'waiting') binding.executionId = ctx.getExecutionId();
  return binding;
}

/** the helper's second check goes to the database: a removed member is out at once */
async function userOfToken(
  ctx: WebhookContext,
  helper: FormAuthHelper,
  token: string,
  binding: DataObject,
): Promise<FormUser | null> {
  const payload = ctx.verifyFormToken(token);
  if (!payload) return null;
  const { userId: _userId, ...held } = payload;
  const sameKeys = Object.keys(held).length === Object.keys(binding).length;
  if (!sameKeys || !Object.entries(binding).every(([key, value]) => held[key] === value)) return null;
  return helper.verifyToken(token);
}

/** a code opens only the page it was issued for, in the page's own workspace and of its own kind */
async function userOfCode(
  ctx: WebhookContext,
  helper: FormAuthHelper,
  code: string,
  path: string,
  tokenKind: string,
): Promise<FormUser | null> {
  const granted = await helper.exchangeCode(code);
  if (!granted) return null;
  const payload = ctx.verifyFormToken(granted);
  if (payload?.kind !== tokenKind || payload.tenantId !== ctx.getTenantId() || payload.path !== path) {
    return null;
  }
  return helper.verifyToken(granted);
}

function readCookie(ctx: WebhookContext, name: string): string | undefined {
  for (const pair of (headerValue(ctx, 'cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

/** a URL path as a cookie attribute: it cannot end the attribute or start another */
const safeCookiePath = (path: string) => path.replace(/[^\w\-./~%:@]/g, (char) => encodeURIComponent(char));

function issueCookie(
  ctx: WebhookContext,
  params: UserAuthParams,
  user: FormUser,
): { token: string; cookie: string } {
  const token = ctx.signFormToken({ ...tokenBinding(ctx, params), userId: user.id }, TOKEN_TTL_SECONDS);
  // over plain http a browser drops a Secure cookie and the visitor would go back to sign-in for ever
  const secure = ctx.getRequestObject().secure ? '; Secure' : '';
  const cookie = `${params.cookieName}=${token}; Path=${safeCookiePath(params.cookiePath)}; Max-Age=${TOKEN_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
  return { token, cookie };
}

function refusal(
  params: UserAuthParams,
  isPage: boolean,
  statusCode: number,
  message: string,
): UserAuthResult {
  const response: WebhookResponse = isPage
    ? {
        statusCode,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: params.refusalPage(message),
      }
    : { statusCode, body: { message } };
  return { allowed: false, headers: {}, response };
}

const redirect = (location: string, headers: Record<string, string> = {}): UserAuthResult => ({
  allowed: false,
  headers: {},
  response: { statusCode: 302, headers: { location, 'cache-control': 'no-store', ...headers } },
});

export async function checkUserAuth(ctx: WebhookContext, params: UserAuthParams): Promise<UserAuthResult> {
  const { scope, requireExecuteAccess, texts } = params;
  const isPage = ctx.getRequestObject().method !== 'POST';
  const helper = ctx.getFormAuth();
  const path = pagePath(ctx, scope);
  if (!helper || !path) return refusal(params, isPage, 403, texts.noSignIn);

  const mayEnter = async (user: FormUser) =>
    !requireExecuteAccess || helper.canExecute(user.id, ctx.getWorkflow().id ?? '');
  const query = cleanQuery(ctx);

  if (isPage) {
    const code = ctx.getQueryData()[CODE_PARAMETER];
    if (typeof code === 'string' && code) {
      const user = await userOfCode(ctx, helper, code, path, params.tokenKind);
      if (user) {
        if (!(await mayEnter(user))) return refusal(params, isPage, 403, texts.noPermission);
        return redirect(`${path}${query}`, { 'set-cookie': issueCookie(ctx, params, user).cookie });
      }
    }
  }

  const binding = tokenBinding(ctx, params);
  const tokens = [isPage ? readCookie(ctx, params.cookieName) : undefined, headerValue(ctx, 'x-auth-token')];
  for (const held of tokens) {
    const user = held ? await userOfToken(ctx, helper, held, binding) : null;
    if (!user) continue;
    if (!(await mayEnter(user))) return refusal(params, isPage, 403, texts.noPermission);
    if (!isPage) return { allowed: true, user, token: held, headers: {} };
    const issued = issueCookie(ctx, params, user);
    return { allowed: true, user, token: issued.token, headers: { 'set-cookie': issued.cookie } };
  }

  // the page's fetch cannot follow a redirect to sign-in: the POST gets an answer it can show
  if (!isPage) return refusal(params, isPage, 401, texts.signInAgain);
  return redirect(helper.signInUrl(`${path}${query}`));
}
