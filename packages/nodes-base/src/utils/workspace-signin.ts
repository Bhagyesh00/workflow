/**
 * "Workspace sign-in" (OAuth) of identity triggers (`@workflow/nodes-base/utils/workspace-signin`; P5-14, P6-87).
 *
 * `checkWorkspaceSignIn` checks the Bearer token of a request against `ctx.getMcpAuth()` for the trigger's URL
 * (`resource`) and, when asked ("Require Workflow Execute Permission"), the user's right to run the workflow
 * (editor or above in its workspace). Only the request path goes to the helper, which builds the resource on
 * the configured MCP base URL: the Host header and the scheme the server saw never shape the resource (behind a
 * proxy they differ). A missing or refused token is 401 with `WWW-Authenticate` (Bearer, `resource_metadata`),
 * so a client starts the OAuth flow; a signed-in user without the right is 403. The MCP Server Trigger
 * (nodes-ai mcp-trigger-signin.ts re-exports this) and the Webhook node use it.
 *
 * `checkWebhookSignIn` is the Webhook node's option "Workspace sign-in (OAuth2)": `bearer` takes a token for
 * the webhook's own URL only; `auto` also takes a browser, through the form sign-in page (one-time code, a
 * 60 minute token of kind `webhook-user` kept in a cookie scoped to the webhook's path).
 */
import type { FormUser, WebhookContext, WebhookResponse } from '@workflow/workflow';
import { renderMessagePage } from '../nodes/core/form/render';
import { checkUserAuth } from './user-auth';

export type McpSignInResult =
  | { allowed: true; user: FormUser }
  | { allowed: false; response: WebhookResponse };

export const MCP_SIGNIN_TEXTS = {
  unavailable: 'Workspace sign-in is not available on this server',
  required: 'Sign in with your workspace to use this MCP server',
  invalid: 'The access token is not valid for this MCP server',
  forbidden: 'You do not have permission to run this workflow',
} as const;

/** the texts of a Webhook node's refusals */
export const WEBHOOK_SIGNIN_TEXTS = {
  unavailable: 'Workspace sign-in is not available on this server',
  required: 'Sign in with your workspace to use this webhook',
  invalid: 'The access token is not valid for this webhook',
  forbidden: 'You do not have permission to run this workflow',
} as const;

/** the token kind of a Webhook sign-in (the server's form-auth service mints and checks the same) */
export const WEBHOOK_TOKEN_KIND = 'webhook-user';

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

function refuse(statusCode: number, error: string, description: string, challenge?: string): McpSignInResult {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (challenge) headers['www-authenticate'] = challenge;
  return {
    allowed: false,
    response: { statusCode, headers, body: { error, error_description: description } },
  };
}

/** the path of the request URL (`/<endpoint>/<slug>/<path>`), without scheme, host and query */
export function resourcePath(resource: string): string {
  try {
    // a path resolves on a placeholder origin that is never used; a full URL keeps its own path
    return new URL(resource, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function headerOf(ctx: WebhookContext, name: string): string | undefined {
  const value = ctx.getHeaderData()[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function checkWorkspaceSignIn(
  ctx: WebhookContext,
  resource: string,
  requireExecuteAccess: boolean,
  texts: typeof MCP_SIGNIN_TEXTS | typeof WEBHOOK_SIGNIN_TEXTS = MCP_SIGNIN_TEXTS,
): Promise<McpSignInResult> {
  const auth = ctx.getMcpAuth?.();
  if (!auth) return refuse(500, 'server_error', texts.unavailable);
  const path = resourcePath(resource);
  const challenge = auth.challenge(path);
  const header = headerOf(ctx, 'authorization');
  const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (!token) return refuse(401, 'invalid_token', texts.required, challenge);
  const verified = await auth.verifyAccessToken(token, path);
  if (!verified) {
    return refuse(401, 'invalid_token', texts.invalid, `${challenge}, error="invalid_token"`);
  }
  if (requireExecuteAccess) {
    const workflowId = ctx.getWorkflow().id;
    if (!workflowId || !(await auth.canExecute(verified.user.id, workflowId))) {
      return refuse(403, 'insufficient_scope', texts.forbidden);
    }
  }
  return { allowed: true, user: verified.user };
}

export type WebhookOAuthClient = 'bearer' | 'auto';

export interface WebhookSignInParams {
  /** `bearer`: a token only; `auto`: a token, or a browser through the sign-in page */
  oauthClient: WebhookOAuthClient;
  requireExecuteAccess: boolean;
}

/** a browser opening the address (not a script calling it) */
function isBrowserNavigation(ctx: WebhookContext): boolean {
  if (ctx.getRequestObject().method !== 'GET') return false;
  if (headerOf(ctx, 'sec-fetch-mode') === 'navigate') return true;
  return (headerOf(ctx, 'accept') ?? '').toLowerCase().includes('text/html');
}

/** the request path (`/webhook/<slug>/<path>`) without the query: what a token and a cookie are bound to */
const requestPath = (ctx: WebhookContext) => ctx.getRequestObject().url?.split('?')[0] ?? '';

const hasCookie = (ctx: WebhookContext, name: string) =>
  (headerOf(ctx, 'cookie') ?? '').split(';').some((pair) => pair.trim().startsWith(`${name}=`));

/**
 * The cookie of the browser sign-in. Its name starts like a form's: the webhook route lets only `ncb-form-auth-`
 * and `ncb-chat-auth-` cookies through. Its Path is the webhook's own, and the token inside is of kind
 * `webhook-user` bound to this workflow, so no other trigger takes it.
 */
const cookieNameOf = (ctx: WebhookContext) => `ncb-form-auth-wf-${ctx.getWorkflow().id ?? ''}`;

async function browserSignIn(
  ctx: WebhookContext,
  requireExecuteAccess: boolean,
): Promise<McpSignInResult & { headers?: Record<string, string> }> {
  const result = await checkUserAuth(ctx, {
    scope: 'trigger',
    requireExecuteAccess,
    tokenKind: WEBHOOK_TOKEN_KIND,
    cookieName: cookieNameOf(ctx),
    cookiePath: requestPath(ctx),
    texts: {
      noSignIn: "This webhook needs a workspace sign-in, and sign-in isn't available here.",
      noPermission: "You don't have permission to open this webhook.",
      signInAgain: 'Your sign-in has ended. Open the page again to sign in.',
    },
    refusalPage: (message) => renderMessagePage({ title: 'Problem loading page', message }),
  });
  if (!result.allowed || !result.user) {
    return {
      allowed: false,
      response: result.response ?? {
        statusCode: 403,
        body: { message: "You don't have permission to open this webhook." },
      },
    };
  }
  return { allowed: true, user: result.user };
}

/**
 * Whether a request may enter a Webhook with "Workspace sign-in (OAuth2)", and as whom. `bearer` always needs a
 * token for the webhook's own URL (a token for another resource is refused). `auto` sends a browser (a page
 * navigation, a one-time `code`, the webhook's own cookie or an `x-auth-token`) through the sign-in page and
 * everything else, including a script with no token, to the Bearer check.
 */
export async function checkWebhookSignIn(
  ctx: WebhookContext,
  params: WebhookSignInParams,
): Promise<McpSignInResult> {
  const hasBearer = BEARER.test(headerOf(ctx, 'authorization') ?? '');
  const browser =
    params.oauthClient === 'auto' &&
    !hasBearer &&
    (isBrowserNavigation(ctx) ||
      headerOf(ctx, 'x-auth-token') !== undefined ||
      hasCookie(ctx, cookieNameOf(ctx)));
  if (browser) return browserSignIn(ctx, params.requireExecuteAccess);
  // a host without the sign-in helper refuses the caller (401), never an error page
  if (!ctx.getMcpAuth?.()) {
    return {
      allowed: false,
      response: {
        statusCode: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
        body: { error: 'invalid_token', error_description: WEBHOOK_SIGNIN_TEXTS.unavailable },
      },
    };
  }
  return checkWorkspaceSignIn(ctx, requestPath(ctx), params.requireExecuteAccess, WEBHOOK_SIGNIN_TEXTS);
}
