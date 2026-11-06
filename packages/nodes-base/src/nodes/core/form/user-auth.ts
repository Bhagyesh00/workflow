/** Stub of the form "n8n User Auth" option (workspace sign-in); L2 (P4-16) builds it. */
import type { FormUser, NodeProperty, WebhookContext, WebhookResponse } from '@workflow/workflow';

/** the Form Trigger's fields for this authentication mode */
export const userAuthProperties: NodeProperty[] = [];

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
  _ctx: WebhookContext,
  _params: FormUserAuthParams,
): Promise<FormUserAuthResult> {
  throw new Error('not implemented (L2)');
}
