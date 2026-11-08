/**
 * The workflow gate of the tenant MCP server (P5-04): which workflows an MCP tool may read in detail,
 * run or change. Details, run and write need `settings.availableInMCP` and a workflow that is not
 * archived; a workflow of another tenant reads as missing. n8n's refusal texts. Also the helpers every
 * tool shares: the error a client may read (`McpToolError`), the actor of a call and the credential
 * sanitizer of node lists (only `{ id, name }` per credential slot, as n8n's MCP schemas).
 */
import type { WorkflowNode } from '@workflow/workflow';
import { and, eq, inArray } from 'drizzle-orm';
import type { ServerContext } from '../../context';
import { type WorkflowRow, workflows } from '../../db/schema';
import type { Actor } from '../workflows';
import type { McpCaller } from './types';

/** what the tool does with the workflow */
export type McpWorkflowAccess = 'details' | 'run' | 'write';

/** n8n's texts for a refused workflow */
export const MCP_WORKFLOW_TEXTS = {
  notFound: "Workflow not found or you don't have permission to access it.",
  archived: (id: string) => `Workflow '${id}' is archived and cannot be accessed.`,
  notAvailable:
    'Workflow is not available in MCP. Enable MCP access for this workflow in its settings to use it from MCP clients.',
} as const;

/**
 * A refusal or failure whose message the MCP client may read (a tool result with `isError`). Any
 * other error of a tool is answered with the generic -32603 and no detail.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** true when the workflow's settings expose it to MCP clients */
export function isAvailableInMcp(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    (settings as Record<string, unknown>).availableInMCP === true
  );
}

/** who did it, for services that record an audit row */
export function mcpActor(caller: McpCaller): Actor {
  return { userId: caller.user.id };
}

/**
 * The caller's tenant's workflow, when `access` is allowed over MCP; throws with n8n's text
 * otherwise (not found, archived, not available in MCP). Every access needs the flag and a live workflow.
 */
export async function assertWorkflowForMcp(
  ctx: ServerContext,
  caller: McpCaller,
  workflowId: string,
  _access: McpWorkflowAccess,
): Promise<WorkflowRow> {
  const row = await ctx.repos.workflows.get(caller.tenant.id, workflowId);
  if (!row || row.tenantId !== caller.tenant.id) throw new McpToolError(MCP_WORKFLOW_TEXTS.notFound);
  if (row.isArchived) throw new McpToolError(MCP_WORKFLOW_TEXTS.archived(row.id));
  if (!isAvailableInMcp(row.settings)) throw new McpToolError(MCP_WORKFLOW_TEXTS.notAvailable);
  return row;
}

/** the ids of `ids` (the caller's tenant only) that are exposed to MCP and not archived */
export async function workflowsAvailableInMcp(
  ctx: ServerContext,
  tenantId: string,
  ids: string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!unique.length) return new Set();
  const rows = await ctx.database.db
    .select({ id: workflows.id, settings: workflows.settings, isArchived: workflows.isArchived })
    .from(workflows)
    .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, unique)));
  return new Set(rows.filter((r) => !r.isArchived && isAvailableInMcp(r.settings)).map((r) => r.id));
}

/**
 * The nodes as an MCP client may see them: each credential slot keeps only its `id` and `name`
 * (never data, never extra fields). The input is not changed.
 */
export function sanitizeNodeCredentials(nodes: unknown): WorkflowNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((raw) => {
    const node = structuredClone(raw) as WorkflowNode & { credentials?: unknown };
    const slots = node.credentials;
    if (slots === undefined || slots === null) return node;
    if (typeof slots !== 'object' || Array.isArray(slots)) {
      delete node.credentials;
      return node;
    }
    const clean: Record<string, { id: string | null; name: string }> = {};
    for (const [type, ref] of Object.entries(slots as Record<string, unknown>)) {
      const value = (typeof ref === 'object' && ref !== null ? ref : {}) as Record<string, unknown>;
      clean[type] = {
        id: typeof value.id === 'string' ? value.id : null,
        name: typeof value.name === 'string' ? value.name : '',
      };
    }
    (node as { credentials?: unknown }).credentials = clean;
    return node;
  });
}
