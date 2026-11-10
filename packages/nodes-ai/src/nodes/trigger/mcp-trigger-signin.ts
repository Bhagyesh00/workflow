/**
 * "Workspace sign-in" (OAuth) for the MCP Server Trigger: the code is shared with the Webhook node and lives in
 * nodes-base (utils/workspace-signin.ts, P6-87); this file keeps the trigger's import path. It checks the Bearer
 * token of an MCP request against `ctx.getMcpAuth()` for the trigger's URL (`resource`) and, when asked
 * ("Require Workflow Execute Permission"), the user's right to run the workflow.
 */
export {
  checkWorkspaceSignIn,
  MCP_SIGNIN_TEXTS,
  type McpSignInResult,
  resourcePath,
} from '@workflow/nodes-base/utils/workspace-signin';
