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
import { mcpActor } from '../../workflow-gate';
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
  folderId: z.uuid().nullable().optional().describe('The folder to create it in; default: the top level'),
  tagIds: z.array(z.uuid()).max(100).optional().describe('Tag ids from list_workflow_tags'),
});

export const createWorkflowTool: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_workflow',
  description:
    'Create a workflow from a JSON definition. The definition is validated first; when it has errors nothing is created and every issue is listed. The workflow is created unpublished and available in MCP, so you can change it with update_workflow and run it with test_workflow.',
  scopes: ['workflow:write'],
  minRole: 'editor',
  input: createInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const definition = definitionFromInput(input.workflow);
    assertNodeTypesKnown(ctx, definition);
    freshWebhookIds(ctx, definition);
    await assertCredentialsInTenant(ctx, caller.tenant.id, definition);
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
        folderId: input.folderId ?? null,
        ...(input.tagIds ? { tagIds: input.tagIds } : {}),
      } as unknown as z.output<typeof workflowCreateSchema>,
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
