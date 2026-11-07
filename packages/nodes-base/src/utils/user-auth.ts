/**
 * Workspace sign-in for public pages (forms and chats; `@workflow/nodes-base/utils/user-auth`). Only
 * signed-in workspace members get through. The session cookie never reaches a page URL, so sign-in comes
 * back with a one-time code; the page's GET swaps it for a 60 minute token of `tokenKind`, kept in the
 * cookie `cookieName` on `cookiePath` and sent by the page as `x-auth-token`. Tokens and codes are never
 * logged, output or put in a redirect. The form check (form/user-auth.ts) and the Chat Trigger call it with
 * their own kind, cookie and texts.
 */
import type { FormUser, WebhookContext, WebhookResponse } from '@workflow/workflow';

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

export async function checkUserAuth(_ctx: WebhookContext, _params: UserAuthParams): Promise<UserAuthResult> {
  throw new Error('not implemented (L3)');
}
