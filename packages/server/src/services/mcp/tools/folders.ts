/**
 * MCP tools: folders of the workspace (P5-04; research-B section 2, part a). A workspace is one tenant,
 * so there is no project to pick (`search_projects` and `projectId` are left out). Search needs
 * `project:read` (viewer), create and update `project:write` (editor), moving workflows `workflow:write`
 * (editor) and a workflow available in MCP for each one moved.
 */
import { z } from 'zod';
import { parse } from '../../../http/errors';
import { folderCreateSchema, folderListQuerySchema, folderUpdateSchema } from '../../folders';
import type { McpToolDefinition } from '../types';
import { assertWorkflowForMcp, mcpActor } from '../workflow-gate';

const folderId = z.uuid().describe('The id of the folder');
const folderName = z.string().trim().min(1).max(128);
const parentFolderId = z.uuid().nullable().describe('The parent folder; null for the top level');

const searchInput = z.object({
  query: z.string().max(128).optional().describe('Part of the folder name'),
  parentFolderId: z
    .union([z.uuid(), z.literal('root')])
    .optional()
    .describe('A folder id or "root"'),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const searchFolders: McpToolDefinition<z.output<typeof searchInput>> = {
  name: 'search_folders',
  description: 'Search the folders of the workspace by name, optionally inside one parent folder.',
  scopes: ['project:read'],
  minRole: 'viewer',
  input: searchInput,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const query = parse(folderListQuerySchema, {
      search: input.query,
      parentFolderId: input.parentFolderId,
      limit: input.limit,
      cursor: input.cursor,
    });
    return ctx.folders.list(caller.tenant.id, query);
  },
};

const createInput = z.object({ name: folderName, parentFolderId: parentFolderId.optional() });

const createFolder: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_folder',
  description: 'Create a folder, at the top level or inside a parent folder.',
  scopes: ['project:write'],
  minRole: 'editor',
  input: createInput,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const body = parse(folderCreateSchema, { name: input.name, parentFolderId: input.parentFolderId });
    return ctx.folders.create(caller.tenant.id, body, mcpActor(caller));
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
  minRole: 'editor',
  input: updateInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    const body = parse(folderUpdateSchema, { name: input.name, parentFolderId: input.parentFolderId });
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
  minRole: 'editor',
  input: moveInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    const ids = [...new Set(input.workflowIds)];
    for (const id of ids) await assertWorkflowForMcp(ctx, caller, id, 'write');
    return ctx.workflowArchive.move(caller.tenant.id, ids, input.folderId, mcpActor(caller));
  },
};

export const foldersTools: McpToolDefinition<any>[] = [
  searchFolders,
  createFolder,
  updateFolder,
  moveWorkflowsToFolder,
];
