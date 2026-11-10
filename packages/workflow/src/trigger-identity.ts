/**
 * Which triggers start a run as a known workspace user (P6-15). A workflow that uses a private
 * credential publishes only when every enabled trigger gives a user identity, because each run
 * must pick that user's own connection. No node: import, so the editor bundles this file too.
 */
import type { DataObject } from './interfaces';

/** the triggers that give a user identity, for the publish error */
export const IDENTITY_TRIGGERS_TEXT =
  'Manual Trigger, When Executed by Another Workflow, Chat Trigger (Hosted Chat with Workspace Sign-in), ' +
  'MCP Server Trigger (Workspace sign-in), Webhook (Workspace sign-in) and Form Trigger (User Auth)';

/** true when a trigger of `nodeType` with these `parameters` starts its runs as a known user */
export function triggerProvidesIdentity(nodeType: string, parameters: DataObject | undefined): boolean {
  const params = parameters ?? {};
  switch (nodeType) {
    case 'core.manualTrigger':
    case 'core.executeWorkflowTrigger':
      return true;
    case 'ai.chatTrigger':
      return (
        params.public === true &&
        params.authentication === 'n8nUserAuth' &&
        (params.mode ?? 'hostedChat') === 'hostedChat'
      );
    case 'ai.mcpTrigger':
    case 'core.webhook':
      return params.authentication === 'n8nOAuth2';
    case 'core.formTrigger':
      return params.authentication === 'n8nUserAuth';
    default:
      return false;
  }
}
