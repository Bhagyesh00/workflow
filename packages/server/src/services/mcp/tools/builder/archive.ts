/**
 * MCP build tools: `archive_workflow` and `restore_workflow_version` (P5-13). Both act on a workflow
 * available in MCP that is not archived, through the same services as the REST routes: archive
 * unpublishes first and stays reversible in the editor; a restore writes the old version as a new
 * draft version and never touches the published one.
 */
import { z } from 'zod';
import type { McpToolDefinition } from '../../types';
import { assertWorkflowForMcp, mcpActor } from '../../workflow-gate';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const archiveInput = z.object({ workflowId: z.uuid().describe('The id of the workflow') });

const restoreInput = z.object({
  workflowId: z.uuid().describe('The id of the workflow'),
  versionId: z.uuid().describe('A version id from get_workflow_history'),
});

export const archiveWorkflowTool: McpToolDefinition<z.output<typeof archiveInput>> = {
  name: 'archive_workflow',
  description:
    'Archive a workflow available in MCP. A published workflow is unpublished first. An archived workflow cannot be changed or run until it is unarchived in the editor.',
  scopes: ['workflow:write'],
  access: 'workflow:delete',
  input: archiveInput,
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'delete');
    const archived = await ctx.workflowArchive.archive(caller.tenant.id, row.id, mcpActor(caller));
    return {
      workflowId: archived.id,
      name: archived.name,
      archived: archived.isArchived,
      wasPublished: row.active,
    };
  },
};

export const restoreWorkflowVersionTool: McpToolDefinition<z.output<typeof restoreInput>> = {
  name: 'restore_workflow_version',
  description:
    'Restore a saved version of a workflow available in MCP as its new draft. It becomes a new version; the published version keeps running until you publish_workflow.',
  scopes: ['workflow:write'],
  access: 'workflow:update',
  input: restoreInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'write');
    const restored = await ctx.workflows.restoreVersion(
      caller.tenant.id,
      row.id,
      input.versionId,
      mcpActor(caller),
    );
    return {
      workflowId: restored.id,
      name: restored.name,
      versionId: restored.versionId,
      restoredFrom: input.versionId,
      nodes: restored.nodes.map((n) => ({ name: n.name, type: n.type })),
    };
  },
};

export const archiveTools: McpToolDefinition<any>[] = [archiveWorkflowTool, restoreWorkflowVersionTool];
