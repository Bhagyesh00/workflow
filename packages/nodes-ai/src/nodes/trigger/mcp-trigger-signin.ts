/**
 * "Workspace sign-in" (OAuth) for the MCP Server Trigger: checks the Bearer token of an MCP request
 * against `ctx.getMcpAuth()` for the trigger's URL (`resource`) and, when asked, the user's right to run
 * the workflow. Lane L10 fills it; until then every request is refused with 401, so nothing throws.
 */
import type { FormUser, WebhookContext, WebhookResponse } from '@workflow/workflow';

export type McpSignInResult =
  | { allowed: true; user: FormUser }
  | { allowed: false; response: WebhookResponse };

export async function checkWorkspaceSignIn(
  _ctx: WebhookContext,
  _resource: string,
  _requireExecuteAccess: boolean,
): Promise<McpSignInResult> {
  // stub (L10): refuse every request until the token check exists
  return {
    allowed: false,
    response: {
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: { error: 'unauthorized', error_description: 'Workspace sign-in is not available yet' },
    },
  };
}
