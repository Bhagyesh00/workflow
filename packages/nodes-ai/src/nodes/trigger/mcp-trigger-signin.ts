/**
 * "Workspace sign-in" (OAuth) for the MCP Server Trigger: checks the Bearer token of an MCP request
 * against `ctx.getMcpAuth()` for the trigger's URL (`resource`) and, when asked ("Require Workflow
 * Execute Permission"), the user's right to run the workflow (editor or above in its workspace).
 * A missing or refused token is 401 with `WWW-Authenticate` (Bearer, `resource_metadata`), so an MCP
 * client starts the OAuth flow; a signed-in user without the right is 403.
 */
import type { FormUser, WebhookContext, WebhookResponse } from '@workflow/workflow';

export type McpSignInResult =
  | { allowed: true; user: FormUser }
  | { allowed: false; response: WebhookResponse };

export const MCP_SIGNIN_TEXTS = {
  unavailable: 'Workspace sign-in is not available on this server',
  required: 'Sign in with your workspace to use this MCP server',
  invalid: 'The access token is not valid for this MCP server',
  forbidden: 'You do not have permission to run this workflow',
} as const;

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

function refuse(statusCode: number, error: string, description: string, challenge?: string): McpSignInResult {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (challenge) headers['www-authenticate'] = challenge;
  return {
    allowed: false,
    response: { statusCode, headers, body: { error, error_description: description } },
  };
}

function authorizationHeader(ctx: WebhookContext): string | undefined {
  const value = ctx.getHeaderData().authorization;
  return Array.isArray(value) ? value[0] : value;
}

export async function checkWorkspaceSignIn(
  ctx: WebhookContext,
  resource: string,
  requireExecuteAccess: boolean,
): Promise<McpSignInResult> {
  const auth = ctx.getMcpAuth?.();
  if (!auth) return refuse(500, 'server_error', MCP_SIGNIN_TEXTS.unavailable);
  const challenge = auth.challenge(resource);
  const header = authorizationHeader(ctx);
  const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (!token) return refuse(401, 'invalid_token', MCP_SIGNIN_TEXTS.required, challenge);
  const verified = await auth.verifyAccessToken(token, resource);
  if (!verified) {
    return refuse(401, 'invalid_token', MCP_SIGNIN_TEXTS.invalid, `${challenge}, error="invalid_token"`);
  }
  if (requireExecuteAccess) {
    const workflowId = ctx.getWorkflow().id;
    if (!workflowId || !(await auth.canExecute(verified.user.id, workflowId))) {
      return refuse(403, 'insufficient_scope', MCP_SIGNIN_TEXTS.forbidden);
    }
  }
  return { allowed: true, user: verified.user };
}
