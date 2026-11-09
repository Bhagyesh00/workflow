/**
 * MCP tool: `search_projects` (P6-35; research-B section 2). Lists the projects the caller can read
 * (`project:read`: its personal project, the team projects it belongs to, and every team project for an
 * owner or admin), so a client can pass a `projectId` to `search_workflows`, `create_workflow`,
 * `search_data_tables`, `create_data_table`, `search_folders` and `create_folder`. A name that equals the
 * query comes first, then names that contain it. Only id, name, type and icon leave: no member list.
 */
import { z } from 'zod';
import type { McpToolDefinition } from '../types';
import { mcpAuth } from '../workflow-gate';

const input = z.object({
  query: z.string().max(128).optional().describe('Part of the project name; an exact name comes first'),
  limit: z.number().int().min(1).max(100).default(50),
});

/** 0 for an exact name (any case), 1 for a name that starts with the query, 2 for the rest */
function matchRank(name: string, query: string): number {
  const a = name.toLowerCase();
  const q = query.toLowerCase();
  if (a === q) return 0;
  return a.startsWith(q) ? 1 : 2;
}

export const searchProjectsTool: McpToolDefinition<z.output<typeof input>> = {
  name: 'search_projects',
  description:
    'Search the projects you can read by name (exact matches first). Use a project id as projectId in the search and create tools.',
  scopes: ['project:read'],
  access: 'project:read',
  input,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, args) {
    const auth = mcpAuth(caller);
    const readable = new Set(await ctx.access.accessibleProjectIds(auth, 'project:read'));
    const query = args.query?.trim().toLowerCase();
    const rows = (await ctx.repos.projects.listAll(caller.tenant.id)).filter(
      (project) => readable.has(project.id) && (!query || project.name.toLowerCase().includes(query)),
    );
    const ordered = query
      ? rows
          .map((project, index) => ({ project, index, rank: matchRank(project.name, query) }))
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
          .map((entry) => entry.project)
      : rows;
    return {
      data: ordered.slice(0, args.limit).map((project) => ({
        id: project.id,
        name: project.name,
        type: project.type,
        icon: project.icon ?? null,
      })),
    };
  },
};

export const projectsTools: McpToolDefinition<any>[] = [searchProjectsTool];
