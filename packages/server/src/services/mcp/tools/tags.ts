/** MCP tool: the workspace's workflow tags (P5-04; research-B section 2, part a). */
import { z } from 'zod';
import { tagDTO } from '../../../routes/resources';
import type { McpToolDefinition } from '../types';

const noInput = z.object({});

const listWorkflowTags: McpToolDefinition<z.output<typeof noInput>> = {
  name: 'list_workflow_tags',
  description: 'List the tags of the workspace, to filter search_workflows by tagId.',
  scopes: ['tag:read'],
  access: 'tag:list',
  input: noInput,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller) {
    return { data: (await ctx.repos.tags.list(caller.tenant.id)).map(tagDTO) };
  },
};

export const tagsTools: McpToolDefinition<any>[] = [listWorkflowTags];
