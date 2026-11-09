/**
 * MCP build tools: find node types and read their parameters (P5-13). Both read the node type
 * registry through L1's `searchNodes` and `nodeDetails`, so the names a client gets are the ones
 * `create_workflow` and `update_workflow` accept. Nothing here reads a stored workflow or credential.
 */
import { z } from 'zod';
import { nodeDetails, searchNodes } from '../../../ai-builder/tools';
import type { McpToolDefinition } from '../../types';
import { McpToolError } from '../../workflow-gate';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const MAX_QUERIES = 10;
const MAX_TYPES = 5;

const searchInput = z.object({
  queries: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(MAX_QUERIES)
    .describe('Short phrases for what the node does, for example ["webhook", "send email"]'),
});

const detailsInput = z.object({
  types: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(MAX_TYPES)
    .describe('Exact node type names from search_nodes, for example "core.webhook"'),
});

export const searchNodesTool: McpToolDefinition<z.output<typeof searchInput>> = {
  name: 'search_nodes',
  description:
    'Find node types by what they do. Give several short queries at once. Returns the exact type names to use in create_workflow and update_workflow, with their latest version and whether the node is a trigger.',
  scopes: ['workflow:read', 'workflow:write'],
  access: 'workflow:read',
  input: searchInput,
  annotations: READ,
  async handler(ctx, _caller, input) {
    return { results: searchNodes(ctx.registries.nodeTypes, input.queries) };
  },
};

export const getNodeTypesTool: McpToolDefinition<z.output<typeof detailsInput>> = {
  name: 'get_node_types',
  description:
    'The parameters, inputs, outputs and credential types of up to 5 node types. Read it before you add or configure a node. A name that is not a node type comes back under "unknown".',
  scopes: ['workflow:read', 'workflow:write'],
  access: 'workflow:read',
  input: detailsInput,
  annotations: READ,
  async handler(ctx, _caller, input) {
    const types = [...new Set(input.types)];
    const found = [];
    const unknown: string[] = [];
    for (const type of types) {
      const details = nodeDetails(ctx.registries.nodeTypes, type);
      if (details) found.push(details);
      else unknown.push(type);
    }
    if (!found.length) {
      throw new McpToolError(
        `Unknown node type ${unknown.map((t) => `"${t}"`).join(', ')}. Use search_nodes to find the exact type name.`,
      );
    }
    return { nodeTypes: found, ...(unknown.length ? { unknown } : {}) };
  },
};

export const nodeTools: McpToolDefinition<any>[] = [searchNodesTool, getNodeTypesTool];
