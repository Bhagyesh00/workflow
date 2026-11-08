/**
 * Assistant tools: tags, folders and test executions (P5-69, lane L5). Reads are viewer and their text
 * is untrusted (tag and folder names are written by people). Writes are editor, as the REST routes
 * (/rest/tags is read here, /rest/folders, /rest/workflows/move, DELETE /rest/executions/:id), name a
 * permission key and show a card whose facts are read from the workspace. A workflow, folder or tag
 * id of another workspace is a 404 before any card. `delete_folder` has a null `grantKey`: a card every
 * time. Every service call takes the run's tenant and actor.
 */

import { z } from 'zod';
import type { ServerContext } from '../../../context';
import { deleteExecution, executionListQuery, listExecutions } from '../../../routes/executions';
import { createTag, tagDTO } from '../../../routes/resources';
import { folderCreateSchema, folderDeleteSchema, folderListQuerySchema } from '../../folders';
import { assertNotArchived } from '../../workflow-rules';
import type { AssistantCaller, AssistantRunScope, AssistantToolDefinition } from '../types';

const actorOf = (run: AssistantRunScope) => ({ userId: run.actor.userId ?? run.user.id, ip: run.actor.ip });
const fact = (label: string, value: unknown) => ({ label, value: String(value) });

const folderRef = z.union([z.uuid(), z.literal('root')]);

/** a manual run is a test run; these statuses are still going and are left alone */
const ACTIVE = new Set(['new', 'running', 'waiting']);
const PAGE = 250;
/** pages looked at per call (1000 executions); `more` tells the model to call again */
const PAGES_MAX = 4;

async function findTestExecutions(ctx: ServerContext, tenantId: string, workflowId: string) {
  const ids: string[] = [];
  let skippedActive = 0;
  let cursor: string | undefined;
  let more = false;
  for (let pageNo = 0; pageNo < PAGES_MAX; pageNo++) {
    const found = await listExecutions(
      ctx,
      tenantId,
      executionListQuery.parse({ workflowId, limit: PAGE, ...(cursor ? { cursor } : {}) }),
    );
    for (const row of found.data) {
      if (row.mode !== 'manual') continue;
      if (ACTIVE.has(row.status)) skippedActive++;
      else ids.push(row.id);
    }
    cursor = found.nextCursor ?? undefined;
    if (!cursor) break;
    if (pageNo === PAGES_MAX - 1) more = true;
  }
  return { ids, skippedActive, more };
}

async function workflowName(
  ctx: ServerContext,
  caller: AssistantCaller,
  workflowId: string,
): Promise<string> {
  return (await ctx.workflows.get(caller.tenant.id, workflowId)).name;
}

const noInput = z.object({});

const listTags: AssistantToolDefinition<z.output<typeof noInput>> = {
  name: 'list_tags',
  description: 'List the workflow tags of the workspace.',
  input: noInput,
  minRole: 'viewer',
  untrusted: 'tags',
  async handler(ctx, run) {
    return { data: (await ctx.repos.tags.list(run.tenant.id)).map(tagDTO) };
  },
};

const tagWorkflowInput = z.object({
  workflowId: z.uuid().describe('The id of the workflow'),
  tags: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(20)
    .describe('Tag names to add; a tag that does not exist is created'),
});

const tagWorkflow: AssistantToolDefinition<z.output<typeof tagWorkflowInput>> = {
  name: 'tag_workflow',
  description: 'Add tags to a workflow (existing tags stay). Tags that do not exist yet are created.',
  input: tagWorkflowInput,
  minRole: 'editor',
  permission: 'tagWorkflow',
  grantKey: () => 'tagWorkflow',
  async approval(ctx, caller, input) {
    const name = await workflowName(ctx, caller, input.workflowId);
    const fresh: string[] = [];
    for (const tag of new Set(input.tags)) {
      if (!(await ctx.repos.tags.getByName(caller.tenant.id, tag))) fresh.push(tag);
    }
    return {
      title: 'Tag a workflow',
      resourceName: name,
      details: {
        facts: [
          fact('Workflow', name),
          fact('Tags to add', [...new Set(input.tags)].join(', ')),
          fact('New tags', fresh.length ? fresh.join(', ') : 'None'),
        ],
      },
    };
  },
  async handler(ctx, run, input) {
    const tenantId = run.tenant.id;
    const row = await ctx.workflows.get(tenantId, input.workflowId);
    assertNotArchived(row, 'update');
    const keep = ((await ctx.repos.workflows.tagsFor(tenantId, [row.id])).get(row.id) ?? []).map((t) => t.id);
    const ids = new Set(keep);
    for (const tag of new Set(input.tags)) {
      const found =
        (await ctx.repos.tags.getByName(tenantId, tag)) ??
        (await createTag(ctx, tenantId, tag).catch(async (error) => {
          // a parallel create of the same name: use that tag
          const raced = await ctx.repos.tags.getByName(tenantId, tag);
          if (!raced) throw error;
          return raced;
        }));
      ids.add(found.id);
    }
    await ctx.repos.workflows.setTags(tenantId, row.id, [...ids]);
    const actor = actorOf(run);
    await ctx.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.updated',
      resourceType: 'workflow',
      resourceId: row.id,
      metadata: { tagIds: [...ids] },
      ip: actor.ip,
    });
    const tags = (await ctx.repos.workflows.tagsFor(tenantId, [row.id])).get(row.id) ?? [];
    return { workflowId: row.id, tags };
  },
};

const cleanupInput = z.object({
  workflowId: z.uuid().describe('The id of the workflow whose manual (test) executions are deleted'),
});

const cleanupTestExecutions: AssistantToolDefinition<z.output<typeof cleanupInput>> = {
  name: 'cleanup_test_executions',
  description:
    'Delete the finished manual (test) executions of one workflow. Running or waiting ones are left alone. Scheduled, webhook and other production executions are never touched.',
  input: cleanupInput,
  minRole: 'editor',
  permission: 'cleanupTestExecutions',
  grantKey: (input) => `cleanupTestExecutions:${input.workflowId}`,
  async approval(ctx, caller, input) {
    const name = await workflowName(ctx, caller, input.workflowId);
    const found = await findTestExecutions(ctx, caller.tenant.id, input.workflowId);
    return {
      title: 'Delete test executions',
      resourceName: name,
      details: {
        facts: [
          fact('Workflow', name),
          fact('Test executions to delete', `${found.ids.length}${found.more ? ' or more' : ''}`),
          fact('Still running, left alone', found.skippedActive),
        ],
      },
    };
  },
  async handler(ctx, run, input) {
    const tenantId = run.tenant.id;
    await ctx.workflows.get(tenantId, input.workflowId);
    const found = await findTestExecutions(ctx, tenantId, input.workflowId);
    let deleted = 0;
    for (const id of found.ids) {
      if (run.signal.aborted) break;
      await deleteExecution(ctx, tenantId, id);
      deleted++;
    }
    return { deleted, skippedActive: found.skippedActive, more: found.more };
  },
};

const listFoldersInput = z.object({
  parentFolderId: folderRef.optional().describe('A folder id, or "root" for the top level'),
  search: z.string().max(128).optional().describe('Part of the folder name'),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const listFolders: AssistantToolDefinition<z.output<typeof listFoldersInput>> = {
  name: 'list_folders',
  description: 'List the folders of the workspace, optionally inside one parent folder or by name.',
  input: listFoldersInput,
  minRole: 'viewer',
  untrusted: 'folders',
  async handler(ctx, run, input) {
    return ctx.folders.list(run.tenant.id, folderListQuerySchema.parse(input));
  },
};

const createFolderInput = z.object({
  name: z.string().trim().min(1).max(128),
  parentFolderId: z
    .uuid()
    .nullable()
    .optional()
    .describe('The parent folder; null or left out for the top level'),
});

const createFolder: AssistantToolDefinition<z.output<typeof createFolderInput>> = {
  name: 'create_folder',
  description: 'Create a folder, at the top level or inside a parent folder.',
  input: createFolderInput,
  minRole: 'editor',
  permission: 'createFolder',
  grantKey: () => 'createFolder',
  async approval(ctx, caller, input) {
    const parent = input.parentFolderId
      ? (await ctx.folders.get(caller.tenant.id, input.parentFolderId)).name
      : 'Top level';
    return {
      title: 'Create a folder',
      resourceName: input.name,
      details: { facts: [fact('Name', input.name), fact('Inside', parent)] },
    };
  },
  async handler(ctx, run, input) {
    const body = folderCreateSchema.parse({ name: input.name, parentFolderId: input.parentFolderId });
    return ctx.folders.create(run.tenant.id, body, actorOf(run));
  },
};

const deleteFolderInput = z.object({
  folderId: z.uuid().describe('The id of the folder'),
  transferToFolderId: folderRef
    .optional()
    .describe(
      'Where its workflows and subfolders go: a folder id or "root". Left out: every workflow inside is archived',
    ),
});

const deleteFolder: AssistantToolDefinition<z.output<typeof deleteFolderInput>> = {
  name: 'delete_folder',
  description:
    'Delete a folder. Name where its workflows go with transferToFolderId; left out, every workflow inside is archived. This cannot be undone, so a person approves it every time.',
  input: deleteFolderInput,
  minRole: 'editor',
  permission: 'deleteFolder',
  grantKey: () => null,
  async approval(ctx, caller, input) {
    const tenantId = caller.tenant.id;
    const folder = await ctx.folders.get(tenantId, input.folderId);
    const subtree = await ctx.repos.folders.subtreeIds(tenantId, folder.id);
    const inside = (await ctx.repos.folders.workflowsIn(tenantId, subtree)).filter((w) => !w.isArchived);
    let outcome: string;
    if (input.transferToFolderId === undefined) {
      outcome = `The ${inside.length} workflow(s) inside and the subfolders are archived or deleted`;
    } else if (input.transferToFolderId === 'root') {
      outcome = 'Workflows and subfolders move to the top level';
    } else {
      const target = await ctx.folders.get(tenantId, input.transferToFolderId);
      outcome = `Workflows and subfolders move to "${target.name}"`;
    }
    return {
      title: 'Delete a folder',
      resourceName: folder.name,
      details: {
        facts: [
          fact('Folder', [...folder.path.map((p) => p.name)].join(' / ') || folder.name),
          fact('Workflows inside', inside.length),
          fact('What happens to them', outcome),
        ],
      },
    };
  },
  async handler(ctx, run, input) {
    const body = folderDeleteSchema.parse({ transferToFolderId: input.transferToFolderId });
    await ctx.folders.delete(run.tenant.id, input.folderId, body, actorOf(run));
    return { deleted: true, folderId: input.folderId };
  },
};

const moveInput = z.object({
  workflowId: z.uuid().describe('The id of the workflow'),
  folderId: z.uuid().nullable().describe('The target folder; null for the top level'),
});

const moveWorkflowToFolder: AssistantToolDefinition<z.output<typeof moveInput>> = {
  name: 'move_workflow_to_folder',
  description: 'Move a workflow into a folder (null for the top level).',
  input: moveInput,
  minRole: 'editor',
  permission: 'moveWorkflowToFolder',
  grantKey: () => 'moveWorkflowToFolder',
  async approval(ctx, caller, input) {
    const name = await workflowName(ctx, caller, input.workflowId);
    const target = input.folderId
      ? (await ctx.folders.get(caller.tenant.id, input.folderId)).name
      : 'Top level';
    return {
      title: 'Move a workflow',
      resourceName: name,
      details: { facts: [fact('Workflow', name), fact('Move to', target)] },
    };
  },
  async handler(ctx, run, input) {
    const tenantId = run.tenant.id;
    const row = await ctx.workflows.get(tenantId, input.workflowId);
    return ctx.workflowArchive.move(tenantId, [row.id], input.folderId, actorOf(run));
  },
};

export const workspaceTools: AssistantToolDefinition[] = [
  listTags,
  tagWorkflow,
  cleanupTestExecutions,
  listFolders,
  createFolder,
  deleteFolder,
  moveWorkflowToFolder,
];
