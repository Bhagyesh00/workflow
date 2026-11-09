/**
 * MCP build tool: `create_workflow` (P5-13). The client sends the workflow as JSON (the editor's
 * `workflowDataSchema` shape); nothing is interpreted or run. Order: node types by the registry's
 * map, the credentials of the workspace, the validation (a refusal lists every error), then the
 * normal `WorkflowService.create`. The new workflow is available in MCP, so the client that made
 * it can go on with `update_workflow`, unless the client says otherwise.
 */
import { z } from 'zod';
import type { workflowCreateSchema } from '../../../../http/schemas';
import { validateDefinition } from '../../../ai-builder/tools';
import type { McpToolDefinition } from '../../types';
import { McpToolError, mcpActor, mcpAuth, requireMcpScope } from '../../workflow-gate';
import { assertCredentialsInTenant } from './credential-check';
import {
  assertNodeTypesKnown,
  definitionFromInput,
  freshWebhookIds,
  refuseOnErrors,
  workflowInput,
} from './validate';

const createInput = z.object({
  workflow: workflowInput.describe(
    'The workflow as JSON: name, nodes, connections, settings (see get_workflow_format_reference)',
  ),
  projectId: z
    .uuid()
    .optional()
    .describe(
      "The project to create it in (from search_projects); default: the folder's project, else yours",
    ),
  folderId: z.uuid().nullable().optional().describe('The folder to create it in; default: the top level'),
  tagIds: z.array(z.uuid()).max(100).optional().describe('Tag ids from list_workflow_tags'),
});

export const createWorkflowTool: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_workflow',
  description:
    'Create a workflow from a JSON definition. The definition is validated first; when it has errors nothing is created and every issue is listed. The workflow is created unpublished and available in MCP, so you can change it with update_workflow and run it with test_workflow.',
  scopes: ['workflow:write'],
  access: 'workflow:create',
  input: createInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const definition = definitionFromInput(input.workflow);
    assertNodeTypesKnown(ctx, definition);
    freshWebhookIds(ctx, definition);
    // the project: the folder's (a named project must be the same), else the named one, else the caller's default
    let projectId: string;
    if (input.folderId) {
      const folder = await ctx.repos.folders.get(caller.tenant.id, input.folderId);
      if (!folder) throw new McpToolError('Folder not found');
      if (input.projectId && input.projectId !== folder.projectId) {
        throw new McpToolError('The folder belongs to another project.');
      }
      projectId = folder.projectId;
    } else {
      projectId = await ctx.access.targetProject(mcpAuth(caller), input.projectId);
    }
    await requireMcpScope(ctx, caller, 'workflow:create', { projectId });
    await requireMcpScope(
      ctx,
      caller,
      'folder:read',
      input.folderId ? { folderId: input.folderId } : { projectId },
    );
    await assertCredentialsInTenant(ctx, caller.tenant.id, definition, projectId);
    const validation = await validateDefinition(ctx, caller.tenant.id, definition);
    const issues = refuseOnErrors(validation, 'The workflow is not valid. Nothing was created. Issues:');
    // the creating client's flag is on, unless it wrote one
    const settings = { ...(definition.settings ?? {}) };
    if (settings.availableInMCP === undefined) settings.availableInMCP = true;
    const created = await ctx.workflows.create(
      caller.tenant.id,
      {
        name: definition.name,
        nodes: definition.nodes,
        connections: definition.connections,
        settings,
        pinData: definition.pinData ?? {},
        stickyNotes: definition.stickyNotes ?? [],
        nodeGroups: definition.nodeGroups ?? [],
        projectId,
        folderId: input.folderId ?? null,
        ...(input.tagIds ? { tagIds: input.tagIds } : {}),
      } as unknown as z.output<typeof workflowCreateSchema> & { projectId: string },
      mcpActor(caller),
    );
    return {
      workflowId: created.id,
      name: created.name,
      versionId: created.versionId,
      availableInMCP: created.settings.availableInMCP === true,
      issues,
    };
  },
};

export const createTools: McpToolDefinition<any>[] = [createWorkflowTool];
