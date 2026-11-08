/**
 * The workflow gate of the tenant MCP server (P5-04, filled by L8): which workflows an MCP tool may
 * read in detail, run or change. Details, run and write need `settings.availableInMCP` and a workflow
 * that is not archived; a workflow of another tenant reads as missing. n8n's refusal texts.
 */
import type { ServerContext } from '../../context';
import type { WorkflowRow } from '../../db/schema';
import type { McpCaller } from './types';

/** what the tool does with the workflow */
export type McpWorkflowAccess = 'details' | 'run' | 'write';

/**
 * The caller's tenant's workflow, when `access` is allowed over MCP; throws with n8n's text
 * otherwise (not found, not available in MCP, archived).
 */
export async function assertWorkflowForMcp(
  _ctx: ServerContext,
  _caller: McpCaller,
  _workflowId: string,
  _access: McpWorkflowAccess,
): Promise<WorkflowRow> {
  throw new Error('not implemented (L8)');
}
