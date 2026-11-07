/**
 * The form "User Auth" option (P4-16, n8n "n8n User Auth"): only signed-in workspace members open the
 * form. The session cookie never reaches a form URL, so sign-in comes back with a one-time code; the
 * form's GET swaps it for a 60 minute token, kept in one cookie per workflow or execution and sent by
 * the page as `x-auth-token`. Tokens and codes are never logged, output or put in a redirect. The logic is
 * in utils/user-auth.ts (shared with the Chat Trigger); this file gives it the form's kind, cookies and texts.
 */
import type { FormUser, NodeProperty, WebhookContext, WebhookResponse } from '@workflow/workflow';
import { checkUserAuth } from '../../../utils/user-auth';
import { renderMessagePage } from './render';

const TOKEN_KIND = 'form-user';

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

export async function checkFormUserAuth(
  ctx: WebhookContext,
  params: FormUserAuthParams,
): Promise<FormUserAuthResult> {
  const trigger = params.scope === 'trigger';
  const { token: _token, ...result } = await checkUserAuth(ctx, {
    scope: params.scope,
    requireExecuteAccess: params.requireExecuteAccess,
    tokenKind: TOKEN_KIND,
    cookieName: trigger
      ? `ncb-form-auth-wf-${ctx.getWorkflow().id ?? ''}`
      : `ncb-form-auth-ex-${ctx.getExecutionId()}`,
    cookiePath: trigger
      ? (ctx.getRequestObject().url?.split('?')[0] ?? '')
      : `/form-waiting/${ctx.getExecutionId()}`,
    texts: {
      noSignIn: "This form needs a workspace sign-in, and sign-in isn't available here.",
      noPermission: "You don't have permission to open this form.",
      signInAgain: 'Your form sign-in has ended. Open the form again to sign in.',
    },
    refusalPage: (message) => renderMessagePage({ title: 'Problem loading form', message }),
  });
  return result;
}
