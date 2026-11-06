/**
 * The form "User Auth" option (P4-16, n8n "n8n User Auth"): only signed-in workspace members open the
 * form. The session cookie never reaches a form URL, so sign-in comes back with a one-time code; the
 * form's GET swaps it for a 60 minute token, kept in one cookie per workflow or execution and sent by
 * the page as `x-auth-token`. Tokens and codes are never logged, output or put in a redirect.
 */
import type {
  DataObject,
  FormAuthHelper,
  FormUser,
  NodeProperty,
  WebhookContext,
  WebhookRequest,
  WebhookResponse,
} from '@workflow/workflow';
import { headerValue } from './access';
import { renderMessagePage } from './render';

/** n8n's FORM_USER_AUTH_TOKEN_TTL_SECONDS */
const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_KIND = 'form-user';
const CODE_PARAMETER = 'code';

const onUserAuth = { show: { authentication: ['n8nUserAuth'] } };

/** the Form Trigger's fields for this authentication mode */
export const userAuthProperties: NodeProperty[] = [
  {
    displayName: 'Trusted Source',
    name: 'trustedSource',
    type: 'options',
    default: 'workspaceSignIn',
    noDataExpression: true,
    description: 'Who says the person opening the form is signed in',
    options: [{ name: 'Workspace sign-in', value: 'workspaceSignIn' }],
    displayOptions: onUserAuth,
  },
  {
    displayName: 'Require Workflow Execute Permission',
    name: 'requireExecuteAccess',
    type: 'boolean',
    default: false,
    description: 'Whether only members who may run this workflow, editors and above, can open the form',
    displayOptions: onUserAuth,
  },
];

export interface FormUserAuthParams {
  /**
   * Which page asks. `trigger`: cookie `ncb-form-auth-wf-<workflowId>`. `waiting`: a later page,
   * cookie `ncb-form-auth-ex-<executionId>` with Path=/form-waiting/<id>.
   */
  scope: 'trigger' | 'waiting';
  /** the trigger's Require Workflow Execute Permission (a later page passes the trigger's value) */
  requireExecuteAccess: boolean;
}

export interface FormUserAuthResult {
  /** false: send `response` instead of the form */
  allowed: boolean;
  /** the signed-in user; the caller adds it to the output when Include User in Output is on */
  user?: FormUser;
  /** set on the reply in every case; carries the form-auth cookie */
  headers: Record<string, string>;
  /** the reply when not allowed: a 302 to sign-in, or a 403 */
  response?: WebhookResponse;
}

/** the address the browser asked for; the route passes it on, a context has no other way to know */
const requestPath = (ctx: WebhookContext) =>
  (ctx.getRequestObject() as WebhookRequest & { url?: string }).url?.split('?')[0];

/** this form's path: a later page's signed URL, or the address of the trigger's form */
function formPath(ctx: WebhookContext, scope: FormUserAuthParams['scope']): string | undefined {
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

/** what a token has to hold to open this form: it opens one workflow, or one execution's later pages */
function tokenBinding(ctx: WebhookContext, scope: FormUserAuthParams['scope']): DataObject {
  const binding: DataObject = {
    kind: TOKEN_KIND,
    tenantId: ctx.getTenantId(),
    workflowId: ctx.getWorkflow().id ?? '',
  };
  if (scope === 'waiting') binding.executionId = ctx.getExecutionId();
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

/** a code opens only the form it was issued for, in the form's own workspace */
async function userOfCode(
  ctx: WebhookContext,
  helper: FormAuthHelper,
  code: string,
  path: string,
): Promise<FormUser | null> {
  const granted = await helper.exchangeCode(code);
  if (!granted) return null;
  const payload = ctx.verifyFormToken(granted);
  if (payload?.kind !== TOKEN_KIND || payload.tenantId !== ctx.getTenantId() || payload.path !== path) {
    return null;
  }
  return helper.verifyToken(granted);
}

function cookieName(ctx: WebhookContext, scope: FormUserAuthParams['scope']): string {
  return scope === 'trigger'
    ? `ncb-form-auth-wf-${ctx.getWorkflow().id ?? ''}`
    : `ncb-form-auth-ex-${ctx.getExecutionId()}`;
}

function readCookie(ctx: WebhookContext, name: string): string | undefined {
  for (const pair of (headerValue(ctx, 'cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

/** a URL path as a cookie attribute: it cannot end the attribute or start another */
const cookiePath = (path: string) => path.replace(/[^\w\-./~%:@]/g, (char) => encodeURIComponent(char));

function issueCookie(
  ctx: WebhookContext,
  user: FormUser,
  scope: FormUserAuthParams['scope'],
  path: string,
): string {
  const token = ctx.signFormToken({ ...tokenBinding(ctx, scope), userId: user.id }, TOKEN_TTL_SECONDS);
  const scopePath = scope === 'trigger' ? cookiePath(path) : `/form-waiting/${ctx.getExecutionId()}`;
  return `${cookieName(ctx, scope)}=${token}; Path=${scopePath}; Max-Age=${TOKEN_TTL_SECONDS}; HttpOnly; SameSite=Lax; Secure`;
}

function refusal(isPage: boolean, statusCode: number, message: string): FormUserAuthResult {
  const response: WebhookResponse = isPage
    ? {
        statusCode,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: renderMessagePage({ title: 'Problem loading form', message }),
      }
    : { statusCode, body: { message } };
  return { allowed: false, headers: {}, response };
}

const redirect = (location: string, headers: Record<string, string> = {}): FormUserAuthResult => ({
  allowed: false,
  headers: {},
  response: { statusCode: 302, headers: { location, 'cache-control': 'no-store', ...headers } },
});

const NO_SIGN_IN = "This form needs a workspace sign-in, and sign-in isn't available here.";
const NO_PERMISSION = "You don't have permission to open this form.";
const SIGN_IN_AGAIN = 'Your form sign-in has ended. Open the form again to sign in.';

export async function checkFormUserAuth(
  ctx: WebhookContext,
  params: FormUserAuthParams,
): Promise<FormUserAuthResult> {
  const { scope, requireExecuteAccess } = params;
  const isPage = ctx.getRequestObject().method !== 'POST';
  const helper = ctx.getFormAuth();
  const path = formPath(ctx, scope);
  if (!helper || !path) return refusal(isPage, 403, NO_SIGN_IN);

  const mayEnter = async (user: FormUser) =>
    !requireExecuteAccess || helper.canExecute(user.id, ctx.getWorkflow().id ?? '');
  const query = cleanQuery(ctx);

  if (isPage) {
    const code = ctx.getQueryData()[CODE_PARAMETER];
    if (typeof code === 'string' && code) {
      const user = await userOfCode(ctx, helper, code, path);
      if (user) {
        if (!(await mayEnter(user))) return refusal(isPage, 403, NO_PERMISSION);
        return redirect(`${path}${query}`, { 'set-cookie': issueCookie(ctx, user, scope, path) });
      }
    }
  }

  const binding = tokenBinding(ctx, scope);
  const tokens = [
    isPage ? readCookie(ctx, cookieName(ctx, scope)) : undefined,
    headerValue(ctx, 'x-auth-token'),
  ];
  for (const token of tokens) {
    const user = token ? await userOfToken(ctx, helper, token, binding) : null;
    if (!user) continue;
    if (!(await mayEnter(user))) return refusal(isPage, 403, NO_PERMISSION);
    const headers: Record<string, string> = isPage
      ? { 'set-cookie': issueCookie(ctx, user, scope, path) }
      : {};
    return { allowed: true, user, headers };
  }

  // the page's fetch cannot follow a redirect to sign-in: the POST gets an answer it can show
  if (!isPage) return refusal(isPage, 401, SIGN_IN_AGAIN);
  return redirect(helper.signInUrl(`${path}${query}`));
}
