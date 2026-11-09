/**
 * MCP tools: folders of the caller's projects (P5-04, P6-35; research-B section 2, part a). A folder belongs
 * to one project (`projectId` on search and create, from `search_projects`). Search lists what the caller's
 * `folder:list` reaches, create needs `folder:create` on the project (the parent's, the named one or the
 * caller's default), update `folder:update` on the folder, and moving workflows `workflow:update` on each
 * workflow (available in MCP) plus `folder:read` on the target folder; the move stays inside one project.
 */
import { z } from 'zod';
import { ApiError, parse } from '../../../http/errors';
import { folderCreateSchema, folderListQuerySchema, folderUpdateSchema } from '../../folders';
import type { McpToolDefinition } from '../types';
import { assertWorkflowForMcp, mcpActor, mcpAuth, requireMcpScope } from '../workflow-gate';

const folderId = z.uuid().describe('The id of the folder');
const folderName = z.string().trim().min(1).max(128);
const parentFolderId = z.uuid().nullable().describe('The parent folder; null for the top level');

const searchInput = z.object({
  query: z.string().max(128).optional().describe('Part of the folder name'),
  parentFolderId: z
    .union([z.uuid(), z.literal('root')])
    .optional()
    .describe('A folder id or "root"'),
  projectId: z.uuid().optional().describe('Only the folders of this project (from search_projects)'),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const searchFolders: McpToolDefinition<z.output<typeof searchInput>> = {
  name: 'search_folders',
  description:
    'Search the folders of your projects by name, optionally of one project or inside one parent folder.',
  scopes: ['project:read'],
  access: 'folder:list',
  input: searchInput,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const query = parse(folderListQuerySchema, {
      search: input.query,
      parentFolderId: input.parentFolderId,
      limit: input.limit,
      cursor: input.cursor,
    });
    return ctx.folders.listFor(mcpAuth(caller), { ...query, projectId: input.projectId });
  },
};

const createInput = z.object({
  name: folderName,
  parentFolderId: parentFolderId.optional(),
  projectId: z
    .uuid()
    .optional()
    .describe("The project to create it in (from search_projects); default: the parent folder's, else yours"),
});

const createFolder: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_folder',
  description: 'Create a folder, at the top level or inside a parent folder.',
  scopes: ['project:write'],
  access: 'folder:create',
  input: createInput,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const body = parse(folderCreateSchema, { name: input.name, parentFolderId: input.parentFolderId });
    // the project of a create: the parent's (a named project must be the same), else the named one, else the default
    let projectId: string;
    if (body.parentFolderId) {
      const parent = await ctx.repos.folders.get(caller.tenant.id, body.parentFolderId);
      if (!parent) throw ApiError.notFound('Folder');
      if (input.projectId && input.projectId !== parent.projectId) {
        throw ApiError.badRequest('The parent folder belongs to another project.');
      }
      projectId = parent.projectId;
    } else {
      projectId = await ctx.access.targetProject(mcpAuth(caller), input.projectId);
    }
    await requireMcpScope(ctx, caller, 'folder:create', { projectId });
    return ctx.folders.create(caller.tenant.id, { ...body, projectId }, mcpActor(caller));
  },
};

const updateInput = z.object({
  folderId,
  name: folderName.optional(),
  parentFolderId: parentFolderId.optional(),
});

const updateFolder: McpToolDefinition<z.output<typeof updateInput>> = {
  name: 'update_folder',
  description: 'Rename a folder or move it under another parent (null for the top level).',
  scopes: ['project:write'],
  access: 'folder:update',
  input: updateInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    const body = parse(folderUpdateSchema, { name: input.name, parentFolderId: input.parentFolderId });
    await requireMcpScope(ctx, caller, 'folder:update', { folderId: input.folderId });
    return ctx.folders.update(caller.tenant.id, input.folderId, body, mcpActor(caller));
  },
};

const moveInput = z.object({
  workflowIds: z.array(z.uuid()).min(1).max(100),
  folderId: z.uuid().nullable().describe('The target folder; null for the top level'),
});

const moveWorkflowsToFolder: McpToolDefinition<z.output<typeof moveInput>> = {
  name: 'move_workflows_to_folder',
  description: 'Move workflows available in MCP into a folder (null for the top level).',
  scopes: ['workflow:write'],
  access: 'workflow:update',
  input: moveInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    const ids = [...new Set(input.workflowIds)];
    for (const id of ids) await assertWorkflowForMcp(ctx, caller, id, 'write');
    if (input.folderId) await requireMcpScope(ctx, caller, 'folder:read', { folderId: input.folderId });
    return ctx.workflowArchive.move(caller.tenant.id, ids, input.folderId, mcpActor(caller));
  },
};

export const foldersTools: McpToolDefinition<any>[] = [
  searchFolders,
  createFolder,
  updateFolder,
  moveWorkflowsToFolder,
];
