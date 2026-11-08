/**
 * MCP tool: the workspace's credentials (P5-04; research-B section 2, part a). Only `id`, `name` and
 * `type` of each, picked by name: no data, no secret, no owner field ever reaches a client.
 */
import { z } from 'zod';
import type { McpToolDefinition } from '../types';

const listCredentials: McpToolDefinition<{ type?: string }> = {
  name: 'list_credentials',
  description:
    'List the credentials of the workspace (id, name and type only), to reference one in a workflow node.',
  scopes: ['credential:read'],
  minRole: 'viewer',
  input: z.object({ type: z.string().min(1).max(128).optional().describe('Only credentials of this type') }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const rows = await ctx.repos.credentials.list(caller.tenant.id, input.type);
    return { data: rows.map((row) => ({ id: row.id, name: row.name, type: row.type })) };
  },
};

export const credentialsTools: McpToolDefinition<any>[] = [listCredentials];
