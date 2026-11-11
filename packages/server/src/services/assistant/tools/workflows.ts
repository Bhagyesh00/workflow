/**
 * Assistant tools: workflows (P5-69, lane L4; n8n IA/docs/tools.md, the single-purpose workflow tools).
 * Each tool calls the service its REST route calls (routes/workflows.ts), at that route's scope (`access`), with
 * `run.tenant.id` and `run.actor`; the adapter checks that scope on the workflow the input names (`target`)
 * before the card and again before an approved call runs. Reads (`list_workflows`, `get_workflow`,
 * `list_workflow_versions`, `validate_workflow`) are tools without a card, and what they return is untrusted data: workflow
 * definitions go through `sanitizeForModel` (no credentials, values redacted, structure only when
 * `sendValues` is false). Writes are tools behind a card with a thread grant
 * `<tool>:<workflowId>`; the card's facts are read by the server from the tenant's rows. Archive never
 * deletes; restore never publishes; a publish blocked by an open review comes back as text.
 */
import { lintForBuilder, type WorkflowDefinition } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import type { WorkflowRow } from '../../../db/schema';
import { ApiError } from '../../../http/errors';
import { sanitizeForModel } from '../../ai-builder/context';
import { toDefinition } from '../../workflow-model';
import {
  type ApprovalCopy,
  type AssistantCaller,
  type AssistantRunScope,
  type AssistantToolDefinition,
  authOf,
  listNarrowing,
  listScopeInput,
  projectIdInput,
} from '../types';

const workflowId = z.uuid().describe('The id of the workflow');
const versionId = z.uuid().describe('The id of a saved version of the workflow');
const approvalSummary = z
  .string()
  .max(500)
  .optional()
  .describe('One sentence for the person: what this change does and why');

/** the workflow a call names: its project decides (`target` of the tools below, checked by the adapter) */
const onWorkflow = (input: { workflowId: string }) => ({ workflowId: input.workflowId });

/** the caller's workflow, or "Workflow not found" (another tenant's id never matches) */
async function workflowRow(ctx: ServerContext, caller: AssistantCaller, id: string): Promise<WorkflowRow> {
  return ctx.workflows.get(caller.tenant.id, id);
}

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** the card's facts for one workflow: its name and whether it is published, read from the row */
async function workflowCard(
  ctx: ServerContext,
  caller: AssistantCaller,
  id: string,
  title: string,
  summary: string | undefined,
  extra: Array<{ label: string; value: string }> = [],
): Promise<ApprovalCopy> {
  const row = await workflowRow(ctx, caller, id);
  return {
    title,
    resourceName: row.name,
    ...(summary ? { approvalSummary: summary } : {}),
    details: {
      facts: [
        { label: 'Workflow', value: row.name },
        { label: 'Published', value: yesNo(row.active) },
        ...(row.isArchived ? [{ label: 'Archived', value: 'Yes' }] : []),
        ...extra,
      ],
    },
  };
}

/** the short form a write tool answers with */
function workflowState(dto: {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  versionId: string;
  publishedVersionId: string | null;
}) {
  return {
    id: dto.id,
    name: dto.name,
    published: dto.active,
    archived: dto.isArchived,
    versionId: dto.versionId,
    publishedVersionId: dto.publishedVersionId,
  };
}

const workflowArtifact = (result: unknown) => {
  const r = result as { id?: unknown; name?: unknown } | null;
  return r && typeof r.id === 'string' && typeof r.name === 'string'
    ? { type: 'workflow' as const, id: r.id, name: r.name }
    : null;
};

// ---------------------------------------------------------------------------------------------
// reads

const listWorkflows: AssistantToolDefinition<{
  query?: string;
  status: 'active' | 'archived' | 'all';
  published?: boolean;
  projectId?: string;
  scope: 'all' | 'personal' | 'shared';
  limit: number;
  cursor?: string;
}> = {
  name: 'list_workflows',
  description:
    'List the workspace\'s workflows, newest change first. "status" active (default) hides archived workflows, archived shows only them, all shows both. "published" filters by whether the workflow runs in production.',
  input: z.object({
    query: z.string().max(128).optional().describe('Part of the workflow name'),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    published: z.boolean().optional(),
    projectId: projectIdInput,
    scope: listScopeInput,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(512).optional().describe('The nextCursor of an earlier page'),
  }),
  access: 'workflow:list',
  target: (input) => (input.projectId ? { projectId: input.projectId } : null),
  untrusted: 'workflow-list',
  async handler(ctx, run, input) {
    const narrow = await listNarrowing(ctx, run, input);
    if (narrow.none) return { workflows: [], nextCursor: null };
    // only what the caller may list: the service applies the access filter of `workflow:list`
    const page = await ctx.workflows.listFor(authOf(run), {
      search: input.query,
      active: input.published,
      projectId: narrow.projectId,
      onlySharedWithMe: narrow.onlySharedWithMe,
      archived: input.status === 'active' ? 'false' : input.status === 'archived' ? 'true' : 'all',
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      workflows: page.data.map((w) => ({
        id: w.id,
        name: w.name,
        published: w.active,
        archived: w.isArchived,
        folderId: w.folderId,
        projectId: w.projectId,
        project: w.homeProject?.name ?? null,
        tags: w.tags.map((t) => t.name),
        updatedAt: w.updatedAt,
      })),
      nextCursor: page.nextCursor,
      ...(page.nextCursor ? { note: 'More workflows match: pass nextCursor for the next page' } : {}),
    };
  },
};

const getWorkflow: AssistantToolDefinition<{ workflowId: string; versionId?: string }> = {
  name: 'get_workflow',
  description:
    'Read a workflow (or one saved version of it): its nodes with their parameters, connections and settings. Credentials are never shown, only which nodes use one.',
  input: z.object({ workflowId, versionId: versionId.optional() }),
  access: 'workflow:read',
  target: onWorkflow,
  untrusted: 'workflow',
  artifact: (_input, result) => workflowArtifact(result),
  async handler(ctx, run, input) {
    const row = await workflowRow(ctx, run, input.workflowId);
    let definition: WorkflowDefinition = toDefinition(row);
    if (input.versionId) {
      const version = await ctx.workflows.getVersion(run.tenant.id, row.id, input.versionId);
      definition = {
        ...definition,
        name: version.name,
        nodes: version.nodes as WorkflowDefinition['nodes'],
        connections: version.connections as WorkflowDefinition['connections'],
        settings: version.settings as WorkflowDefinition['settings'],
        pinData: undefined,
      };
    }
    return {
      id: row.id,
      name: row.name,
      published: row.active,
      archived: row.isArchived,
      versionId: input.versionId ?? row.versionId,
      publishedVersionId: row.publishedVersionId,
      ...(run.sendValues ? {} : { note: 'Parameter values are hidden by a workspace setting' }),
      workflow: sanitizeForModel(definition, { sendValues: run.sendValues }),
    };
  },
};

const listWorkflowVersions: AssistantToolDefinition<{
  workflowId: string;
  limit: number;
  cursor?: string;
}> = {
  name: 'list_workflow_versions',
  description: 'List the saved versions of a workflow, newest first (names, descriptions and dates only).',
  input: z.object({
    workflowId,
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  }),
  access: 'workflow:read',
  target: onWorkflow,
  untrusted: 'workflow-versions',
  async handler(ctx, run, input) {
    const page = await ctx.workflows.listVersions(run.tenant.id, input.workflowId, input.limit, input.cursor);
    const row = await workflowRow(ctx, run, input.workflowId);
    return {
      workflowId: row.id,
      currentVersionId: row.versionId,
      publishedVersionId: row.publishedVersionId,
      versions: page.data,
      nextCursor: page.nextCursor,
    };
  },
};

const validateWorkflow: AssistantToolDefinition<{ workflowId: string }> = {
  name: 'validate_workflow',
  description:
    'Check a saved workflow for problems without running it: what would stop it from being published, and the canvas warnings for each node.',
  input: z.object({ workflowId }),
  access: 'workflow:read',
  target: onWorkflow,
  untrusted: 'validation',
  async handler(ctx, run, input) {
    const row = await workflowRow(ctx, run, input.workflowId);
    const definition = toDefinition(row);
    const activation = await ctx.workflows.validate(run.tenant.id, row.id);
    const nodeTypes = ctx.registries.nodeTypes;
    const lint = lintForBuilder(
      { nodes: definition.nodes, connections: definition.connections, pinData: definition.pinData },
      { get: (type) => nodeTypes.get(type)?.description },
    );
    const errors = lint.filter((issue) => issue.severity === 'error').length;
    return {
      valid: activation.length === 0 && errors === 0,
      publishIssues: activation.map((issue) => ({ node: issue.node, message: issue.message })),
      issues: lint.map((issue) => ({
        severity: issue.severity,
        ...(issue.node ? { node: issue.node } : {}),
        ...(issue.code ? { code: issue.code } : {}),
        message: issue.message,
        ...(issue.hint ? { hint: issue.hint } : {}),
      })),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// writes (a card each)

type WorkflowWrite = { workflowId: string; approvalSummary?: string };

const archiveWorkflow: AssistantToolDefinition<WorkflowWrite> = {
  name: 'archive_workflow',
  description:
    "Archive a workflow (a soft delete: it can be unarchived). A published workflow is unpublished first. Needs the person's approval.",
  input: z.object({ workflowId, approvalSummary }),
  access: 'workflow:delete',
  target: onWorkflow,
  permission: 'deleteWorkflow',
  grantKey: (input) => `archive_workflow:${input.workflowId}`,
  approval: (ctx, caller, input) =>
    workflowCard(ctx, caller, input.workflowId, 'Archive workflow', input.approvalSummary),
  async handler(ctx, run, input) {
    await ctx.collaboration.assertNoLock(run.tenant.id, input.workflowId);
    const dto = await ctx.workflowArchive.archive(run.tenant.id, input.workflowId, run.actor);
    return workflowState(dto);
  },
};

const unarchiveWorkflow: AssistantToolDefinition<WorkflowWrite> = {
  name: 'unarchive_workflow',
  description:
    "Unarchive a workflow. It stays unpublished; publish it on its own when wanted. Needs the person's approval.",
  input: z.object({ workflowId, approvalSummary }),
  access: 'workflow:delete',
  target: onWorkflow,
  permission: 'deleteWorkflow',
  grantKey: (input) => `unarchive_workflow:${input.workflowId}`,
  approval: (ctx, caller, input) =>
    workflowCard(ctx, caller, input.workflowId, 'Unarchive workflow', input.approvalSummary),
  async handler(ctx, run, input) {
    const dto = await ctx.workflowArchive.unarchive(run.tenant.id, input.workflowId, run.actor);
    return workflowState(dto);
  },
};

/** a publish blocked by an open review (409) is an answer for the model, not a failure */
async function asReviewText<T>(work: () => Promise<T>): Promise<T | string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) {
      return `The workflow was not published: ${error.message}`;
    }
    throw error;
  }
}

const publishWorkflow: AssistantToolDefinition<WorkflowWrite & { versionId?: string }> = {
  name: 'publish_workflow',
  description:
    "Publish a workflow so its triggers run in production: the latest draft, or the saved version named by versionId. Needs the person's approval.",
  input: z.object({
    workflowId,
    versionId: versionId.optional().describe('A saved version to publish; omit for the latest draft'),
    approvalSummary,
  }),
  access: 'workflow:publish',
  target: onWorkflow,
  permission: 'publishWorkflow',
  grantKey: (input) => `publish_workflow:${input.workflowId}`,
  approval: (ctx, caller, input) =>
    workflowCard(ctx, caller, input.workflowId, 'Publish workflow', input.approvalSummary, [
      { label: 'Version', value: input.versionId ?? 'The latest draft' },
    ]),
  artifact: (_input, result) => workflowArtifact(result),
  async handler(ctx, run, input) {
    await ctx.collaboration.assertNoLock(run.tenant.id, input.workflowId);
    return asReviewText(async () =>
      workflowState(
        await ctx.workflows.setActive(run.tenant.id, input.workflowId, true, run.actor, {
          versionId: input.versionId,
        }),
      ),
    );
  },
};

const unpublishWorkflow: AssistantToolDefinition<WorkflowWrite> = {
  name: 'unpublish_workflow',
  description:
    "Unpublish a workflow: its triggers stop running in production. The draft is kept. Needs the person's approval.",
  input: z.object({ workflowId, approvalSummary }),
  access: 'workflow:unpublish',
  target: onWorkflow,
  permission: 'publishWorkflow',
  grantKey: (input) => `unpublish_workflow:${input.workflowId}`,
  approval: (ctx, caller, input) =>
    workflowCard(ctx, caller, input.workflowId, 'Unpublish workflow', input.approvalSummary),
  async handler(ctx, run, input) {
    await ctx.collaboration.assertNoLock(run.tenant.id, input.workflowId);
    return workflowState(await ctx.workflows.setActive(run.tenant.id, input.workflowId, false, run.actor));
  },
};

const restoreWorkflowVersion: AssistantToolDefinition<WorkflowWrite & { versionId: string }> = {
  name: 'restore_workflow_version',
  description:
    "Make a saved version the workflow's draft again (the current draft is replaced; it stays in the history). It does not publish. Needs the person's approval.",
  input: z.object({ workflowId, versionId, approvalSummary }),
  access: 'workflow:update',
  target: onWorkflow,
  permission: 'restoreWorkflowVersion',
  grantKey: (input) => `restore_workflow_version:${input.workflowId}`,
  async approval(ctx, caller, input) {
    const version = await ctx.workflows.getVersion(caller.tenant.id, input.workflowId, input.versionId);
    const label = version.versionName ?? version.createdAt;
    return workflowCard(ctx, caller, input.workflowId, 'Restore a version', input.approvalSummary, [
      { label: 'Version', value: label },
    ]);
  },
  async handler(ctx, run, input) {
    await ctx.collaboration.assertNoLock(run.tenant.id, input.workflowId);
    const dto = await ctx.workflows.restoreVersion(
      run.tenant.id,
      input.workflowId,
      input.versionId,
      run.actor,
    );
    return {
      ...workflowState(dto),
      restoredFrom: input.versionId,
      note: 'The draft now matches that version. Nothing was published.',
    };
  },
};

const updateWorkflowVersion: AssistantToolDefinition<
  WorkflowWrite & { versionId: string; name?: string | null; description?: string | null }
> = {
  name: 'update_workflow_version',
  description:
    "Name or describe a saved version of a workflow (null clears the field). Only the name and description change. Needs the person's approval.",
  input: z
    .object({
      workflowId,
      versionId,
      name: z.string().trim().min(1).max(128).nullable().optional(),
      description: z.string().max(2000).nullable().optional(),
      approvalSummary,
    })
    .refine((v) => v.name !== undefined || v.description !== undefined, {
      message: 'Give name or description',
    }),
  access: 'workflow:update',
  target: onWorkflow,
  permission: 'updateWorkflow',
  grantKey: (input) => `update_workflow_version:${input.workflowId}`,
  async approval(ctx, caller, input) {
    await ctx.workflows.getVersion(caller.tenant.id, input.workflowId, input.versionId);
    return workflowCard(ctx, caller, input.workflowId, 'Rename a version', input.approvalSummary, [
      { label: 'Version', value: input.versionId },
      ...(input.name !== undefined ? [{ label: 'New name', value: input.name ?? '(none)' }] : []),
      ...(input.description !== undefined
        ? [{ label: 'New description', value: input.description ?? '(none)' }]
        : []),
    ]);
  },
  artifact: (_input, result) => workflowArtifact(result),
  async handler(ctx, run: AssistantRunScope, input) {
    const version = await ctx.workflows.updateVersion(
      run.tenant.id,
      input.workflowId,
      input.versionId,
      { versionName: input.name, description: input.description },
      run.actor,
    );
    const row = await workflowRow(ctx, run, input.workflowId);
    return {
      id: row.id,
      name: row.name,
      versionId: version.versionId,
      versionName: version.versionName ?? null,
      description: version.description ?? null,
    };
  },
};

export const workflowsTools: AssistantToolDefinition[] = [
  listWorkflows,
  getWorkflow,
  listWorkflowVersions,
  validateWorkflow,
  archiveWorkflow,
  unarchiveWorkflow,
  publishWorkflow,
  unpublishWorkflow,
  restoreWorkflowVersion,
  updateWorkflowVersion,
];
