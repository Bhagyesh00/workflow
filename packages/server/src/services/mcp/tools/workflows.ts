/**
 * MCP tools: search, details, versions and publishing of workflows (P5-04; research-B section 2, part a).
 * Search shows every live workflow with its `availableInMCP` flag; details, versions, diff and publishing
 * pass the workflow gate. Node lists go through `sanitizeNodeCredentials`. `minRole` is the REST route's.
 */
import { diffWorkflows, type WorkflowDefinition } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import type { WorkflowRow } from '../../../db/schema';
import { toDefinition } from '../../workflow-model';
import type { McpToolDefinition } from '../types';
import {
  assertWorkflowForMcp,
  isAvailableInMcp,
  McpToolError,
  mcpActor,
  sanitizeNodeCredentials,
  workflowsAvailableInMcp,
} from '../workflow-gate';
import { triggerInfo } from './run';

const workflowId = z.uuid().describe('The id of the workflow');
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** a saved version (or the current draft) as a definition the diff reads; credentials sanitized */
function asDefinition(source: {
  name: string;
  nodes: unknown;
  connections: unknown;
  settings?: unknown;
}): WorkflowDefinition {
  return {
    name: source.name,
    nodes: sanitizeNodeCredentials(source.nodes),
    connections: (source.connections ?? {}) as WorkflowDefinition['connections'],
    settings: (source.settings ?? {}) as WorkflowDefinition['settings'],
  } as WorkflowDefinition;
}

async function versionDefinition(
  ctx: ServerContext,
  tenantId: string,
  row: WorkflowRow,
  ref: string,
): Promise<WorkflowDefinition> {
  if (ref === 'current') return asDefinition(toDefinition(row));
  let versionId = ref;
  if (ref === 'published') {
    if (!row.publishedVersionId) throw new McpToolError('The workflow has no published version');
    versionId = row.publishedVersionId;
  }
  const version = await ctx.repos.versions.get(tenantId, row.id, versionId);
  if (!version) throw new McpToolError(`Version '${versionId}' not found`);
  return asDefinition(version);
}

const versionRef = z
  .union([z.uuid(), z.enum(['current', 'published'])])
  .describe('A version id, "current" (the draft) or "published"');

const searchWorkflows: McpToolDefinition<{
  query?: string;
  active?: boolean;
  tagId?: string;
  limit: number;
  cursor?: string;
}> = {
  name: 'search_workflows',
  description:
    'Search the workspace\'s workflows by name. Each result says whether it is available in MCP ("availableInMCP"); only those can be read in detail, run or changed.',
  scopes: ['workflow:read'],
  minRole: 'viewer',
  input: z.object({
    query: z.string().max(128).optional().describe('Part of the workflow name'),
    active: z.boolean().optional().describe('Only published (true) or unpublished (false) workflows'),
    tagId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    const page = await ctx.workflows.list(caller.tenant.id, {
      search: input.query,
      active: input.active,
      tagId: input.tagId,
      limit: input.limit,
      cursor: input.cursor,
    });
    const available = await workflowsAvailableInMcp(
      ctx,
      caller.tenant.id,
      page.data.map((w) => w.id),
    );
    return {
      data: page.data.map((w) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        availableInMCP: available.has(w.id),
        folderId: w.folderId,
        tags: w.tags.map((t) => ({ id: t.id, name: t.name })),
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
      nextCursor: page.nextCursor,
    };
  },
};

const getWorkflowDetails: McpToolDefinition<{ workflowId: string }> = {
  name: 'get_workflow_details',
  description:
    'Get a workflow available in MCP: its nodes (credential references only), connections, settings and triggers, with how to run it.',
  scopes: ['workflow:read'],
  minRole: 'viewer',
  input: z.object({ workflowId }),
  annotations: READ,
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    const tags = await ctx.repos.workflows.tagsFor(caller.tenant.id, [row.id]);
    const nodes = sanitizeNodeCredentials(row.nodes);
    const triggers = triggerInfo(ctx, nodes);
    return {
      workflow: {
        id: row.id,
        name: row.name,
        active: row.active,
        availableInMCP: isAvailableInMcp(row.settings),
        versionId: row.versionId,
        publishedVersionId: row.publishedVersionId,
        folderId: row.folderId,
        nodes,
        connections: row.connections,
        settings: row.settings,
        tags: (tags.get(row.id) ?? []).map((t) => ({ id: t.id, name: t.name })),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      triggerInfo: {
        triggers,
        howToRun:
          'Run it with execute_workflow: executionMode "manual" runs the draft, "production" the published version. Name the trigger with triggerNodeName when there are several. Webhook, form, chat and schedule triggers are supported; a manual trigger runs in manual mode only.',
      },
    };
  },
};

const getWorkflowHistory: McpToolDefinition<{ workflowId: string; limit: number; cursor?: string }> = {
  name: 'get_workflow_history',
  description: 'List the saved versions of a workflow available in MCP, newest first.',
  scopes: ['workflow:read'],
  minRole: 'viewer',
  input: z.object({
    workflowId,
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    return ctx.workflows.listVersions(caller.tenant.id, input.workflowId, input.limit, input.cursor);
  },
};

const getWorkflowVersion: McpToolDefinition<{ workflowId: string; versionId: string }> = {
  name: 'get_workflow_version',
  description: 'Get one saved version of a workflow available in MCP (credential references only).',
  scopes: ['workflow:read'],
  minRole: 'viewer',
  input: z.object({ workflowId, versionId: z.uuid() }),
  annotations: READ,
  async handler(ctx, caller, input) {
    await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    const version = await ctx.repos.versions.get(caller.tenant.id, input.workflowId, input.versionId);
    if (!version) throw new McpToolError(`Version '${input.versionId}' not found`);
    return {
      versionId: version.id,
      workflowId: version.workflowId,
      name: version.name,
      nodes: sanitizeNodeCredentials(version.nodes),
      connections: version.connections,
      settings: version.settings,
      versionName: version.versionName ?? null,
      description: version.description ?? null,
      message: version.message ?? null,
      autosaved: version.autosaved,
      createdAt: version.createdAt.toISOString(),
    };
  },
};

const getWorkflowVersionsDiff: McpToolDefinition<{
  workflowId: string;
  versionId: string;
  compareTo: string;
}> = {
  name: 'get_workflow_versions_diff',
  description:
    'Compare a saved version of a workflow available in MCP with another version, the current draft or the published version: added, removed, renamed and changed nodes and connections.',
  scopes: ['workflow:read'],
  minRole: 'viewer',
  input: z.object({ workflowId, versionId: versionRef, compareTo: versionRef.default('current') }),
  annotations: READ,
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    const before = await versionDefinition(ctx, caller.tenant.id, row, input.versionId);
    const after = await versionDefinition(ctx, caller.tenant.id, row, input.compareTo);
    return { from: input.versionId, to: input.compareTo, ...diffWorkflows(before, after) };
  },
};

const publishWorkflow: McpToolDefinition<{
  workflowId: string;
  versionId?: string;
  name?: string;
  description?: string;
}> = {
  name: 'publish_workflow',
  description:
    'Publish a workflow available in MCP (its current version, or the named saved version), so its triggers run in production.',
  scopes: ['workflow:write'],
  minRole: 'editor',
  input: z.object({
    workflowId,
    versionId: z.uuid().optional(),
    name: z.string().trim().min(1).max(128).optional().describe('A name for the published version'),
    description: z.string().max(2000).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    await assertWorkflowForMcp(ctx, caller, input.workflowId, 'write');
    const dto = await ctx.workflows.setActive(caller.tenant.id, input.workflowId, true, mcpActor(caller), {
      versionId: input.versionId,
      versionName: input.name,
      description: input.description,
    });
    return { id: dto.id, active: dto.active, publishedVersionId: dto.publishedVersionId };
  },
};

const unpublishWorkflow: McpToolDefinition<{ workflowId: string }> = {
  name: 'unpublish_workflow',
  description: 'Unpublish a workflow available in MCP: its triggers stop running in production.',
  scopes: ['workflow:write'],
  minRole: 'editor',
  input: z.object({ workflowId }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    await assertWorkflowForMcp(ctx, caller, input.workflowId, 'write');
    const dto = await ctx.workflows.setActive(caller.tenant.id, input.workflowId, false, mcpActor(caller));
    return { id: dto.id, active: dto.active, publishedVersionId: dto.publishedVersionId };
  },
};

export const workflowsTools: McpToolDefinition<any>[] = [
  searchWorkflows,
  getWorkflowDetails,
  getWorkflowHistory,
  getWorkflowVersion,
  getWorkflowVersionsDiff,
  publishWorkflow,
  unpublishWorkflow,
];
