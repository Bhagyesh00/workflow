/**
 * Workflow CRUD with optimistic concurrency and version snapshots, manual runs, test webhook
 * listeners and version diffs.
 */
import { randomUUID } from 'node:crypto';
import {
  type ContextDeps,
  createInitialState,
  createPollContext,
  createTriggerContext,
  type NodeTypes,
  toolRootOf,
} from '@workflow/core';
import {
  CHAT_TEST_TOKEN_TTL_S,
  CHAT_TOKEN_KINDS,
  CHAT_TRIGGER_TYPE,
  ExpressionEvaluator,
  type Item,
  planPartialRun,
  type RunData,
  type Scope,
  serializeError,
  sortByPosition,
  validateWorkflowNodeGroups,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../config';
import type { ServerContext } from '../context';
import type { Database } from '../db/client';
import { type ProjectRow, type TenantRow, type WorkflowRow, workflows } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { decodeCursor, encodeCursor, page } from '../http/pagination';
import type {
  publishSchema,
  runSchema,
  versionPatchSchema,
  workflowCreateSchema,
  workflowDataSchema,
  workflowUpdateSchema,
} from '../http/schemas';
import type { TenantSettings } from '../plans';
import { createRepositories, type Repositories, type TagRef } from '../repositories';
import { type AccessFilter, MISSING_SCOPE_MESSAGE } from './access';
import type { ActiveWorkflowManager, ValidationIssue } from './active-workflows';
import { assertCredentialsUsable } from './credential-usable';
import type { ExecutionService } from './executions';
import type { FavoriteService } from './favorites';
import type { FormTokenService } from './form-tokens';
import { isAvailableInMcp } from './mcp/workflow-gate';
import type { PublishHistoryService } from './publish-history';
import { TEST_WEBHOOK_TTL_MS, type TestWebhookStore } from './test-webhooks';
import { closeBounded } from './trigger-retry';
import { hookUrl, nodeWebhooks, webhookUrlBase } from './webhook-paths';
import { cloneDefinition, toDefinition, toDTO, type WorkflowDTO } from './workflow-model';
import type { WorkflowReviewService } from './workflow-reviews';
import { assertDeletable, assertFolderInTenant, assertNotArchived } from './workflow-rules';

type CreateInput = z.output<typeof workflowCreateSchema>;
type WorkflowSettings = NonNullable<z.output<typeof workflowUpdateSchema>['settings']>;

/**
 * `settings.availableInMCP` changes outside versioning (MCP toggle-access, as n8n), so a save keeps
 * the stored flag unless the client changed it: its value differs from the one in the snapshot of
 * the version the client read (`expected`). `keep` (a restore) always keeps the stored flag.
 */
async function withStoredMcpAccess(
  repos: Repositories,
  tenantId: string,
  id: string,
  settings: WorkflowSettings,
  stored: Record<string, unknown>,
  { expected, keep }: { expected?: string; keep: boolean },
): Promise<WorkflowSettings> {
  if (!keep) {
    const read = expected ? await repos.versions.get(tenantId, id, expected) : undefined;
    if (!read || isAvailableInMcp(settings) !== isAvailableInMcp(read.settings)) return settings;
  }
  const { availableInMCP: _sent, ...rest } = settings;
  return typeof stored.availableInMCP === 'boolean'
    ? { ...rest, availableInMCP: stored.availableInMCP }
    : rest;
}
type UpdateInput = z.output<typeof workflowUpdateSchema>;
type RunInput = z.output<typeof runSchema>;
type WorkflowData = z.output<typeof workflowDataSchema>;
/** POST /workflows/:id/activate body (P3-10) */
export type PublishBody = z.output<typeof publishSchema>;
export type VersionPatch = z.output<typeof versionPatchSchema>;

export interface WorkflowListQuery {
  search?: string;
  tagId?: string;
  active?: boolean;
  /** P3-07: a folder id or 'root'; omitted = every folder */
  folderId?: string;
  /** P3-07: 'false' (default) | 'true' | 'all' */
  archived?: 'false' | 'true' | 'all';
  /** P3-01 command bar: node types matching the search, and tag names */
  nodeTypes?: string[];
  matchTags?: boolean;
  limit: number;
  cursor?: string;
  /** P6-22 (the access service's list filter): the rows the caller may see; absent = every row */
  filter?: AccessFilter;
  /** P6-22: only rows owned by or shared with this project */
  projectId?: string;
  /** P6-22: only rows shared into `projectId` */
  onlySharedWithMe?: boolean;
}

/** a project as list rows and GET one name it (`homeProject`, `sharedWithProjects`) */
export interface WorkflowProjectRef {
  id: string;
  name: string;
  type: ProjectRow['type'];
  icon: ProjectRow['icon'];
}

/** the access fields of a workflow row (P6-22): owner project, sharees and, when asked, the caller's scopes */
export interface WorkflowAccessFields {
  projectId: string;
  homeProject: WorkflowProjectRef | null;
  sharedWithProjects: WorkflowProjectRef[];
  scopes?: Scope[];
}

export const MANUAL_TRIGGER = 'core.manualTrigger';
const MANUAL_TRIGGER_WAIT_MS = 10_000;

export interface Actor {
  userId?: string;
  ip?: string;
}

export interface WorkflowServiceDeps {
  config: Config;
  database: Database;
  repos: Repositories;
  nodeTypes: NodeTypes;
  executions: ExecutionService;
  activeWorkflows: ActiveWorkflowManager;
  testWebhooks: TestWebhookStore;
  /** P3-07 / P3-16 / P3-19 services; context gives the rest lazily */
  favorites: FavoriteService;
  publishHistory: PublishHistoryService;
  reviews: WorkflowReviewService;
  /** P5-56: signs a chat trigger's `chatTestToken`; absent = the context's (tests build the service without it) */
  formTokens?: FormTokenService;
  context: () => ServerContext;
}

function assertGraph(
  definition: Pick<WorkflowDefinition, 'nodes' | 'connections' | 'name'>,
  nodeTypes: NodeTypes,
) {
  try {
    return new Workflow(
      { ...definition, connections: definition.connections ?? {} } as WorkflowDefinition,
      nodeTypes,
    );
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
}

/** the `activationError` of a save response */
function errorOf(error: unknown): { message: string; details?: unknown } {
  return {
    message: (error as Error).message,
    details: error instanceof ApiError ? error.details : undefined,
  };
}

/** 400 invalid_node_groups with the rule texts (P3-04, as n8n's save check); sticky notes can be members */
function assertNodeGroups(
  definition: Pick<WorkflowDefinition, 'name' | 'nodes' | 'connections' | 'nodeGroups' | 'stickyNotes'>,
  nodeTypes: NodeTypes,
) {
  const problems = validateWorkflowNodeGroups(
    { ...definition, connections: definition.connections ?? {} } as WorkflowDefinition,
    (type) => nodeTypes.get(type)?.description,
  );
  if (problems.length) {
    throw new ApiError(400, 'invalid_node_groups', problems.map((p) => p.message).join(' '), problems);
  }
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  async dto(tenantId: string, row: WorkflowRow): Promise<WorkflowDTO> {
    const tags = await this.repos.workflows.tagsFor(tenantId, [row.id]);
    return toDTO(row, tags.get(row.id) ?? []);
  }

  async get(tenantId: string, id: string): Promise<WorkflowRow> {
    const row = await this.repos.workflows.get(tenantId, id);
    if (!row) throw ApiError.notFound('Workflow');
    return row;
  }

  async list(tenantId: string, query: WorkflowListQuery) {
    const rows = await this.repos.workflows.list(tenantId, { ...query, cursor: decodeCursor(query.cursor) });
    const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.updatedAt, r.id));
    const tags = await this.repos.workflows.tagsFor(
      tenantId,
      data.map((r) => r.id),
    );
    return {
      data: data.map((r) => ({
        id: r.id,
        name: r.name,
        active: r.active,
        isArchived: r.isArchived,
        folderId: r.folderId,
        projectId: r.projectId,
        publishedVersionId: r.publishedVersionId,
        tags: tags.get(r.id) ?? [],
        updatedAt: r.updatedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        nodeTypes: r.nodeTypes ?? [],
      })),
      nextCursor,
    };
  }

  /**
   * The list of GET /workflows for a caller (P6-22): the access filter of `workflow:list`, the project filter
   * (`projectId` needs `workflow:list` in that project; `onlySharedWithMe` reads the caller's personal
   * project), and every row with its `homeProject`, `sharedWithProjects` and, with `includeScopes`, `scopes`.
   */
  async listFor(auth: AuthContext, query: WorkflowListQuery & { includeScopes?: boolean }) {
    const { access, repos } = this.deps.context();
    const tenantId = auth.tenant.id;
    const { includeScopes, ...rest } = query;
    let projectId = rest.projectId;
    if (projectId) {
      const held = await access.scopesForAuth(auth, { projectId });
      if (!held.has('workflow:list')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    } else if (rest.onlySharedWithMe) {
      projectId = (await repos.projects.getPersonal(tenantId, auth.user.id))?.id;
      if (!projectId) return { data: [], nextCursor: null };
    }
    const filter = await access.listFilter(auth, 'workflow:list');
    const result = await this.list(tenantId, { ...rest, projectId, filter });
    const fields = await this.accessFields(auth, result.data, includeScopes === true);
    return { ...result, data: result.data.map((row) => ({ ...row, ...fields.get(row.id) })) };
  }

  /** `homeProject`, `sharedWithProjects` and (with `includeScopes`) the caller's `scopes` of each row */
  async accessFields(
    auth: AuthContext,
    rows: Array<{ id: string; projectId: string }>,
    includeScopes: boolean,
  ): Promise<Map<string, WorkflowAccessFields>> {
    const { access } = this.deps.context();
    const tenantId = auth.tenant.id;
    const result = new Map<string, WorkflowAccessFields>();
    if (!rows.length) return result;
    const refs = new Map<string, WorkflowProjectRef>();
    for (const p of await this.repos.projects.listAll(tenantId)) {
      refs.set(p.id, { id: p.id, name: p.name, type: p.type, icon: p.icon ?? null });
    }
    const shared = await this.repos.workflows.sharedProjectIds(
      tenantId,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      result.set(row.id, {
        projectId: row.projectId,
        homeProject: refs.get(row.projectId) ?? null,
        sharedWithProjects: (shared.get(row.id) ?? []).flatMap((id) => refs.get(id) ?? []),
      });
    }
    if (includeScopes) {
      for (let i = 0; i < rows.length; i += 10) {
        await Promise.all(
          rows.slice(i, i + 10).map(async (row) => {
            const held = await access.scopesForAuth(auth, { workflowId: row.id });
            result.get(row.id)!.scopes = [...held].sort();
          }),
        );
      }
    }
    return result;
  }

  /** a workflow as GET one, POST and PATCH answer it: the DTO plus its access fields and the caller's scopes */
  async dtoFor<T extends WorkflowDTO>(auth: AuthContext, dto: T, row?: WorkflowRow) {
    const projectId = row?.projectId ?? (await this.get(auth.tenant.id, dto.id)).projectId;
    const fields = await this.accessFields(auth, [{ id: dto.id, projectId }], true);
    return { ...dto, ...fields.get(dto.id)! };
  }

  private async checkTags(repos: Repositories, tenantId: string, tagIds: string[]): Promise<string[]> {
    const unique = [...new Set(tagIds)];
    const existing = await repos.tags.existing(tenantId, unique);
    if (existing.length !== unique.length) throw ApiError.badRequest('Unknown tag id');
    return unique;
  }

  async create(
    tenantId: string,
    input: CreateInput & { projectId: string },
    actor: Actor,
  ): Promise<WorkflowDTO> {
    assertGraph(input as unknown as WorkflowDefinition, this.deps.nodeTypes);
    assertNodeGroups(input as unknown as WorkflowDefinition, this.deps.nodeTypes);
    await assertFolderInTenant(this.repos, tenantId, input.folderId);
    // P6 S1: the project the caller resolved (`AccessService.targetProject`)
    const { projectId } = input;
    // P6-22: a workflow and its folder are in one project
    if (input.folderId) {
      const folder = await this.repos.folders.get(tenantId, input.folderId);
      if (folder && folder.projectId !== projectId) {
        throw ApiError.badRequest('The folder belongs to another project.');
      }
    }
    // P6 S1: every credential the workflow uses must be usable in its project (L4 fills the check)
    await assertCredentialsUsable(this.deps, tenantId, projectId, input as unknown as WorkflowDefinition);
    const id = randomUUID();
    const versionId = randomUUID();
    const settings: NonNullable<CreateInput['settings']> = { ...(input.settings ?? {}) };
    // P5-04: a new workflow is available in MCP when the tenant auto exposes new workflows (unless the input says)
    // (it needs `workflow:update` on the new workflow, so a caller who cannot edit it does not expose it)
    const canExpose = actor.userId
      ? (await this.deps.context().access.scopesFor(tenantId, actor.userId, { projectId })).has(
          'workflow:update',
        )
      : true;
    if (settings.availableInMCP === undefined && canExpose) {
      const tenant = await this.repos.tenants.get(tenantId);
      if ((tenant?.settings as TenantSettings | null | undefined)?.mcp?.autoExposeNewWorkflows === true) {
        settings.availableInMCP = true;
      }
    }
    const content = {
      name: input.name,
      nodes: input.nodes,
      connections: input.connections,
      settings,
      pinData: input.pinData ?? {},
      stickyNotes: input.stickyNotes ?? [],
      nodeGroups: input.nodeGroups ?? [],
    };
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const tagIds = input.tagIds ? await this.checkTags(repos, tenantId, input.tagIds) : [];
      const row = await repos.workflows.create(tenantId, {
        ...content,
        id,
        versionId,
        projectId,
        createdBy: actor.userId,
        folderId: input.folderId ?? null,
      });
      await repos.versions.create(tenantId, {
        id: versionId,
        workflowId: id,
        name: content.name,
        nodes: content.nodes,
        connections: content.connections,
        settings: content.settings,
        stickyNotes: content.stickyNotes,
        nodeGroups: content.nodeGroups,
        authorId: actor.userId ?? null,
        message: 'Created',
      });
      if (tagIds.length) await repos.workflows.setTags(tenantId, id, tagIds);
      return row;
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.created',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
    return this.dto(tenantId, row);
  }

  /**
   * Save changes. `expectedVersionId` must match the stored version (409 otherwise); every save
   * creates a version snapshot and writes the draft only (P3-10). On a published workflow a
   * settings change restarts its triggers with the new settings; when they fail to start, the
   * workflow is unpublished and the reason returned in `activationError`. `publishIfActive` (the
   * public API's PUT) publishes the saved version of a published workflow; a failed publish keeps
   * the old version running and is returned in `activationError`.
   */
  async update(
    tenantId: string,
    id: string,
    input: Omit<UpdateInput, 'versionId'> & { versionId?: string },
    actor: Actor,
    message?: string,
    options: { publishIfActive?: boolean; keepMcpAccess?: boolean } = {},
  ): Promise<WorkflowDTO & { activationError?: { message: string; details?: unknown } }> {
    const { versionId: expected, tagIds, versionMessage, autosaved, ...patch } = input;
    const existing = await this.get(tenantId, id);
    assertNotArchived(existing, 'update');
    // P6 S1: a save checks the credentials it would store against the workflow's project (L4 fills the check)
    if (patch.nodes) {
      await assertCredentialsUsable(this.deps, tenantId, existing.projectId, {
        name: patch.name ?? existing.name,
        nodes: patch.nodes as WorkflowNode[],
        connections: (patch.connections ?? existing.connections) as WorkflowDefinition['connections'],
      });
    }
    if (patch.nodes || patch.connections) {
      assertGraph(
        {
          name: patch.name ?? existing.name,
          nodes: (patch.nodes ?? existing.nodes) as WorkflowNode[],
          connections: (patch.connections ?? existing.connections) as WorkflowDefinition['connections'],
        },
        this.deps.nodeTypes,
      );
    }
    // the same members as on create: nodes and sticky notes (a removed sticky is checked too)
    if (patch.nodes || patch.connections || patch.nodeGroups || patch.stickyNotes) {
      assertNodeGroups(
        {
          name: patch.name ?? existing.name,
          nodes: (patch.nodes ?? existing.nodes) as WorkflowNode[],
          connections: (patch.connections ?? existing.connections) as WorkflowDefinition['connections'],
          nodeGroups: (patch.nodeGroups ?? existing.nodeGroups) as WorkflowNodeGroup[],
          stickyNotes: (patch.stickyNotes ?? existing.stickyNotes) as WorkflowDefinition['stickyNotes'],
        },
        this.deps.nodeTypes,
      );
    }
    const newVersionId = randomUUID();
    let previous: WorkflowRow | undefined;
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      // locked, so a parallel MCP toggle-access waits and the stored flag read here is current
      [previous] = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
        .for('update');
      const settings =
        patch.settings && previous
          ? await withStoredMcpAccess(repos, tenantId, id, patch.settings, previous.settings, {
              expected,
              keep: options.keepMcpAccess === true,
            })
          : patch.settings;
      const updated = await repos.workflows.update(tenantId, id, expected, {
        ...patch,
        settings,
        versionId: newVersionId,
      });
      if (!updated) throw ApiError.notFound('Workflow');
      if (updated === 'conflict') {
        const current = await repos.workflows.get(tenantId, id);
        throw ApiError.conflict(
          'The workflow was changed by someone else. Reload it to see the latest version.',
          {
            currentVersionId: current?.versionId,
          },
        );
      }
      await repos.versions.create(tenantId, {
        id: newVersionId,
        workflowId: id,
        name: updated.name,
        nodes: updated.nodes,
        connections: updated.connections,
        settings: updated.settings,
        stickyNotes: updated.stickyNotes,
        nodeGroups: updated.nodeGroups,
        authorId: actor.userId ?? null,
        message: message ?? versionMessage ?? null,
        autosaved: autosaved ?? false,
      });
      if (tagIds) await repos.workflows.setTags(tenantId, id, await this.checkTags(repos, tenantId, tagIds));
      return updated;
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.updated',
      resourceType: 'workflow',
      resourceId: id,
      metadata: { versionId: newVersionId },
      ip: actor.ip,
    });

    // a save writes the draft only (P3-10); the published version keeps running
    let activationError: { message: string; details?: unknown } | undefined;
    let current = row;
    const settingsChanged =
      patch.settings !== undefined && JSON.stringify(previous?.settings) !== JSON.stringify(row.settings);
    if (row.active && options.publishIfActive) {
      // public API PUT: publish the saved version through the same call; a failure keeps the old one
      try {
        await this.setActive(tenantId, id, true, actor, { versionId: newVersionId });
        current = await this.get(tenantId, id);
      } catch (error) {
        activationError = errorOf(error);
        // the old version keeps running, but its settings are already the new ones (as below)
        current = await this.get(tenantId, id);
        if (settingsChanged && current.active) {
          const reload = await this.reloadOrUnpublish(tenantId, current, actor);
          current = reload.row;
          // a trigger failure unpublished it: that reason matters more than the refused publish
          activationError = reload.error ?? activationError;
        }
      }
    } else if (row.active && settingsChanged) {
      // settings are live: the published triggers restart with them, without a new publish
      const reload = await this.reloadOrUnpublish(tenantId, row, actor);
      current = reload.row;
      activationError = reload.error;
    }
    const dto = await this.dto(tenantId, current);
    return activationError ? { ...dto, activationError } : dto;
  }

  /**
   * Restart the published triggers of `row` so they read its live settings. When they fail to start,
   * the workflow is unpublished (publish history 'deactivated') and the reason is returned.
   */
  private async reloadOrUnpublish(
    tenantId: string,
    row: WorkflowRow,
    actor: Actor,
  ): Promise<{ row: WorkflowRow; error?: { message: string; details?: unknown } }> {
    try {
      await this.deps.activeWorkflows.reloadTriggers(tenantId, row.id);
      return { row };
    } catch (error) {
      const unpublished = await this.deps.activeWorkflows.deactivate(tenantId, row.id);
      await this.deps.publishHistory.record('deactivated', {
        tenantId,
        workflowId: row.id,
        versionId: row.publishedVersionId,
        userId: actor.userId ?? null,
      });
      return { row: unpublished, error: errorOf(error) };
    }
  }

  /** the editor deletes archived workflows only; the public API passes `force` (P3-07) */
  async delete(tenantId: string, id: string, actor: Actor, options: { force?: boolean } = {}): Promise<void> {
    const row = await this.get(tenantId, id);
    assertDeletable(row, { force: options.force });
    if (row.active) await this.deps.activeWorkflows.deactivate(tenantId, id);
    await this.deps.activeWorkflows.stopTestTrigger(tenantId, id);
    const executionIds = await this.repos.executions.idsForWorkflow(tenantId, id);
    // before the row goes: the FK set-null would hide the open review request
    await this.deps.reviews.afterWorkflowDeleted(tenantId, id);
    await this.deps.favorites.removeForResource(tenantId, 'workflow', id);
    await this.repos.workflows.delete(tenantId, id);
    for (const executionId of executionIds)
      await this.deps.executions.removeBinaryData(tenantId, executionId);
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.deleted',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
  }

  /**
   * Publish (true) or unpublish (P3-10, as n8n activate / deactivate). `body.versionId` names the
   * version to publish (default the current draft); `versionName` and `description` are stored on
   * it once it is live. An open review blocks the publish (409, ctx.reviews). A failed publish
   * leaves the published version as it was.
   */
  async setActive(
    tenantId: string,
    id: string,
    active: boolean,
    actor: Actor,
    body: PublishBody = {},
  ): Promise<WorkflowDTO> {
    const existing = await this.get(tenantId, id);
    if (!active) {
      const row = await this.deps.activeWorkflows.deactivate(tenantId, id);
      if (existing.active) {
        await this.deps.publishHistory.record('deactivated', {
          tenantId,
          workflowId: id,
          versionId: existing.publishedVersionId,
          userId: actor.userId ?? null,
        });
      }
      await this.repos.audit.add(tenantId, {
        userId: actor.userId,
        action: 'workflow.deactivated',
        resourceType: 'workflow',
        resourceId: id,
        metadata: { versionId: existing.publishedVersionId },
        ip: actor.ip,
      });
      return this.dto(tenantId, row);
    }

    await this.deps.reviews.assertCanPublish(tenantId, id, actor.userId);
    const versionId = body.versionId ?? existing.versionId;
    if (!(await this.repos.versions.get(tenantId, id, versionId))) throw ApiError.notFound('Version');
    let row = await this.deps.activeWorkflows.activate(tenantId, id, { versionId });
    if (body.versionName !== undefined || body.description !== undefined) {
      await this.repos.versions.update(tenantId, id, versionId, {
        versionName: body.versionName,
        description: body.description,
      });
      row = await this.get(tenantId, id);
    }
    await this.deps.publishHistory.record('activated', {
      tenantId,
      workflowId: id,
      versionId,
      userId: actor.userId ?? null,
    });
    await this.deps.reviews.afterWorkflowPublished(tenantId, id, versionId);
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.activated',
      resourceType: 'workflow',
      resourceId: id,
      metadata: { versionId },
      ip: actor.ip,
    });
    return this.dto(tenantId, row);
  }

  // -------------------------------------------------------------------------------------------
  // versions

  async listVersions(tenantId: string, id: string, limit: number, cursor?: string) {
    await this.get(tenantId, id);
    const rows = await this.repos.versions.list(tenantId, id, limit, decodeCursor(cursor));
    const { data, nextCursor } = page(rows, limit, (r) => encodeCursor(r.createdAt, r.versionId));
    return {
      data: data.map((v) => ({
        versionId: v.versionId,
        authorName: v.authorName ?? null,
        message: v.message ?? null,
        versionName: v.versionName ?? null,
        description: v.description ?? null,
        autosaved: v.autosaved,
        createdAt: v.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async getVersion(tenantId: string, id: string, versionId: string) {
    await this.get(tenantId, id);
    const v = await this.repos.versions.get(tenantId, id, versionId);
    if (!v) throw ApiError.notFound('Version');
    return {
      versionId: v.id,
      workflowId: v.workflowId,
      name: v.name,
      nodes: v.nodes,
      connections: v.connections,
      settings: v.settings,
      stickyNotes: v.stickyNotes,
      nodeGroups: v.nodeGroups,
      authorName: v.authorName,
      message: v.message,
      versionName: v.versionName,
      description: v.description,
      autosaved: v.autosaved,
      createdAt: v.createdAt.toISOString(),
    };
  }

  /** PATCH /workflows/:id/versions/:versionId: name or describe a version (P3-10, L10) */
  async updateVersion(
    tenantId: string,
    id: string,
    versionId: string,
    patch: VersionPatch,
    actor: Actor,
  ): Promise<Awaited<ReturnType<WorkflowService['getVersion']>>> {
    await this.get(tenantId, id);
    const updated = await this.repos.versions.update(tenantId, id, versionId, {
      versionName: patch.versionName,
      description: patch.description,
    });
    if (!updated) throw ApiError.notFound('Version');
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.version_updated',
      resourceType: 'workflow',
      resourceId: id,
      metadata: { versionId },
      ip: actor.ip,
    });
    return this.getVersion(tenantId, id, versionId);
  }

  async restoreVersion(tenantId: string, id: string, versionId: string, actor: Actor) {
    const snapshot = await this.getVersion(tenantId, id, versionId);
    return this.update(
      tenantId,
      id,
      {
        name: snapshot.name,
        nodes: snapshot.nodes as UpdateInput['nodes'],
        connections: snapshot.connections as UpdateInput['connections'],
        settings: snapshot.settings as UpdateInput['settings'],
        stickyNotes: snapshot.stickyNotes as UpdateInput['stickyNotes'],
        nodeGroups: snapshot.nodeGroups as UpdateInput['nodeGroups'],
      },
      actor,
      `Restored version ${versionId}`,
      // MCP access is not part of a version: a restore keeps the current flag
      { keepMcpAccess: true },
    );
  }

  /** structural diff between two versions (`against` = another version id, "current" or "published") */
  async diffVersions(tenantId: string, id: string, versionId: string, against: string) {
    const from = await this.getVersion(tenantId, id, versionId);
    let againstId = against;
    if (against === 'published') {
      const row = await this.get(tenantId, id);
      if (!row.publishedVersionId) throw ApiError.notFound('Published version');
      againstId = row.publishedVersionId;
    }
    const to =
      against === 'current'
        ? { ...toDefinition(await this.get(tenantId, id)), versionId: 'current' }
        : await this.getVersion(tenantId, id, againstId);
    return {
      from: versionId,
      to: against,
      ...diffDefinitions(
        {
          name: from.name,
          nodes: from.nodes as WorkflowNode[],
          connections: from.connections,
          settings: from.settings,
        },
        {
          name: to.name,
          nodes: to.nodes as WorkflowNode[],
          connections: to.connections,
          settings: to.settings ?? {},
        },
      ),
    };
  }

  // -------------------------------------------------------------------------------------------
  // runs and test webhooks

  /** the saved workflow, or the editor's unsaved copy bound to the saved id */
  private definitionFor(row: WorkflowRow, data?: WorkflowData): WorkflowDefinition {
    if (!data) return toDefinition(row);
    const definition = cloneDefinition(data as unknown as WorkflowDefinition);
    // unsaved editor data is no saved version: its runs record none (P3-10)
    return {
      ...definition,
      id: row.id,
      staticData: structuredClone(row.staticData),
      active: row.active,
      versionId: undefined,
    };
  }

  async run(tenant: TenantRow, id: string, input: RunInput, actor: Actor): Promise<{ executionId: string }> {
    const row = await this.get(tenant.id, id);
    const definition = this.definitionFor(row, input.workflowData);
    const workflow = assertGraph(definition, this.deps.nodeTypes);
    if (input.destinationNode && !workflow.nodes[input.destinationNode]) {
      throw ApiError.badRequest(`Node "${input.destinationNode}" does not exist`);
    }
    if (input.startNode && !workflow.nodes[input.startNode]) {
      throw ApiError.badRequest(`Node "${input.startNode}" does not exist`);
    }
    // a tool test stops at the root of the tool, so the root's parents decide where it starts
    const toolRoot =
      input.agentRequest && input.destinationNode
        ? toolRootOf(workflow, input.destinationNode).name
        : undefined;
    const start = input.startNode
      ? workflow.nodes[input.startNode]
      : (chooseManualStartNode(workflow, toolRoot ?? input.destinationNode) ??
        (toolRoot ? workflow.nodes[toolRoot] : undefined));
    if (!start) throw ApiError.badRequest('The workflow has no node to start from');

    const pinData = Object.fromEntries(
      Object.entries((input.pinData ?? definition.pinData ?? {}) as Record<string, Item[]>).filter(
        ([name]) => workflow.nodes[name],
      ),
    );
    // binary data of a trigger's sample items is stored under the id of the execution that uses it
    const executionId = randomUUID();
    let triggerItems = input.triggerItems as Item[] | undefined;
    const reusesStart = this.reusesStartOutput(workflow, start, input, pinData, toolRoot);
    try {
      if (!triggerItems && !pinData[start.name] && !reusesStart) {
        triggerItems = await this.manualTriggerItems(tenant, row.projectId, workflow, start, executionId);
        if (!triggerItems) await this.deps.executions.removeBinaryData(tenant.id, executionId);
      }
      await this.deps.executions.start({
        tenantId: tenant.id,
        workflow: definition,
        workflowId: row.id,
        executionId,
        mode: 'manual',
        startNode: start.name,
        triggerItems,
        runData: input.runData as RunData | undefined,
        dirtyNodeNames: input.dirtyNodeNames,
        destinationNode: input.destinationNode,
        agentRequest: input.agentRequest,
        pinData: Object.keys(pinData).length ? pinData : undefined,
        userId: actor.userId,
      });
    } catch (error) {
      await this.deps.executions.removeBinaryData(tenant.id, executionId);
      throw error;
    }
    return { executionId };
  }

  /**
   * A step run (P3-06) keeps the start node's earlier output, so the trigger is not called, unless the
   * partial-run plan runs that node again: it is dirty, or its last run failed or never happened. The plan is
   * the one the engine makes from the same input; when it cannot be made, the engine reports why.
   */
  private reusesStartOutput(
    workflow: Workflow,
    start: WorkflowNode,
    input: RunInput,
    pinData: Record<string, Item[]>,
    toolRoot?: string,
  ): boolean {
    const destination = toolRoot ?? input.destinationNode;
    if (!destination || !input.runData) return false;
    try {
      const plan = planPartialRun(workflow.definition, {
        root: start.name,
        destination,
        runData: input.runData as RunData,
        pinData,
        dirtyNodeNames: input.dirtyNodeNames,
      });
      // the engine feeds trigger items to the plan's root only
      return plan.root !== start.name || !plan.startNodes.includes(start.name);
    } catch {
      return true;
    }
  }

  /**
   * Manual runs of trigger/poll nodes: let the node produce sample data (manualTriggerFunction or
   * one poll) instead of starting with an empty item.
   */
  private async manualTriggerItems(
    tenant: TenantRow,
    /** P6 S1: the workflow row's project */
    projectId: string,
    workflow: Workflow,
    node: WorkflowNode,
    executionId: string,
  ) {
    const type = this.deps.nodeTypes.get(node.type);
    if (!type || type.execute || node.disabled || (!type.trigger && !type.poll)) return undefined;
    const services = await this.deps.executions.buildServices({
      tenant,
      executionId,
      projectId,
      mode: 'manual',
      workflowId: workflow.id,
    });
    const abort = new AbortController();
    const deps: ContextDeps = {
      workflow,
      node,
      services,
      evaluator: new ExpressionEvaluator({ timeoutMs: 1000 }),
      signal: abort.signal,
    };
    try {
      if (type.poll) {
        const result = await type.poll(createPollContext(deps, 'manual'));
        return result?.[0]?.length ? (JSON.parse(JSON.stringify(result[0])) as Item[]) : undefined;
      }
      let emitted: Item[] | undefined;
      let failed: Error | undefined;
      let wake!: () => void;
      const wait = new Promise<void>((r) => {
        wake = r;
      });
      const ctx = createTriggerContext(deps, {
        activationMode: 'manual',
        emit: (data) => {
          emitted ??= data?.[0] ?? [];
          wake();
        },
        emitError: (error) => {
          failed = error;
          wake();
        },
      });
      const response = await type.trigger!(ctx);
      try {
        if (!emitted && response?.manualTriggerFunction) await response.manualTriggerFunction();
        if (!emitted && !failed) {
          await Promise.race([wait, new Promise((r) => setTimeout(r, MANUAL_TRIGGER_WAIT_MS))]);
        }
      } finally {
        const close = response?.closeFunction;
        if (close) await closeBounded(close).catch(() => {});
      }
      if (failed) throw failed;
      return emitted?.length ? (JSON.parse(JSON.stringify(emitted)) as Item[]) : undefined;
    } catch (error) {
      throw new ApiError(400, 'trigger_error', `${node.name}: ${(error as Error).message}`);
    } finally {
      abort.abort();
    }
  }

  async listenTestWebhook(
    tenant: TenantRow,
    id: string,
    input: { nodeName: string; workflowData?: WorkflowData; destinationNode?: string },
    actor: Actor,
  ) {
    const row = await this.get(tenant.id, id);
    const definition = this.definitionFor(row, input.workflowData);
    const workflow = assertGraph(definition, this.deps.nodeTypes);
    const node = workflow.nodes[input.nodeName];
    if (!node) throw ApiError.badRequest(`Node "${input.nodeName}" does not exist`);
    const type = this.deps.nodeTypes.get(node.type);
    let hooks: ReturnType<typeof nodeWebhooks> = [];
    try {
      hooks = type ? nodeWebhooks(workflow, node, type) : [];
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    if (!hooks.length) throw ApiError.badRequest(`Node "${node.name}" does not receive webhooks`);
    // the provider keeps one hook per registration, so the test URL would replace the production one
    if (row.active && type?.webhookMethods) {
      throw ApiError.badRequest('Deactivate the workflow to listen for test events on this trigger');
    }
    if (input.destinationNode !== undefined && !workflow.nodes[input.destinationNode]) {
      throw ApiError.badRequest(`Node "${input.destinationNode}" does not exist`);
    }
    await this.deps.activeWorkflows.registerTestWebhooks(tenant, definition, node.name);
    const expiresAt = Date.now() + TEST_WEBHOOK_TTL_MS;
    // a chat trigger's registration gets a fresh id, and its test token names it: a token from an earlier
    // listen is refused once this one replaced it (L2's handleTest answers 403 before using the registration)
    const chat = node.type === CHAT_TRIGGER_TYPE;
    const listenId = chat ? randomUUID() : undefined;
    for (const hook of hooks) {
      await this.deps.testWebhooks.add({
        tenantId: tenant.id,
        workflowId: row.id,
        nodeName: node.name,
        method: hook.method,
        path: hook.path,
        workflow: definition,
        userId: actor.userId,
        listenId,
        destinationNode: input.destinationNode,
        expiresAt,
      });
    }
    const formTokens = this.deps.formTokens ?? this.deps.context().formTokens;
    const chatTestToken = listenId
      ? formTokens.sign(
          {
            kind: CHAT_TOKEN_KINDS.test,
            tenantId: tenant.id,
            workflowId: row.id,
            node: node.name,
            listenId,
          },
          CHAT_TEST_TOKEN_TTL_S,
        )
      : undefined;
    const base = this.deps.config.baseUrl;
    // a form's GET and POST hooks share one path, so one URL
    const formTestUrls = [
      ...new Set(
        hooks
          .filter((hook) => webhookUrlBase(hook.description) === 'form')
          .map((hook) => `${base}/form-test/${tenant.slug}/${hook.path}`),
      ),
    ];
    return {
      testUrl: hookUrl(this.deps.config, hooks[0].description, true, tenant.slug, hooks[0].path),
      expiresAt: new Date(expiresAt).toISOString(),
      formTestUrls,
      ...(chatTestToken ? { chatTestToken } : {}),
    };
  }

  /**
   * "Listen for test event" on a trigger node without a webhook (P4-21): the saved draft's node runs in
   * manual mode for up to 120 s, and its first event starts a test run the editor adopts.
   */
  async listenTestTrigger(
    tenant: TenantRow,
    id: string,
    nodeName: string,
    actor: Actor = {},
  ): Promise<{ expiresAt: string }> {
    const row = await this.get(tenant.id, id);
    const definition = toDefinition(row);
    const workflow = assertGraph(definition, this.deps.nodeTypes);
    const node = workflow.nodes[nodeName];
    if (!node) throw ApiError.badRequest(`Node "${nodeName}" does not exist`);
    const type = this.deps.nodeTypes.get(node.type);
    if (!type?.trigger || type.execute || type.description.webhooks?.length || node.disabled) {
      throw ApiError.badRequest(`Node "${node.name}" does not listen for events`);
    }
    return this.deps.activeWorkflows.listenTestTrigger(tenant, workflow, node, type, {
      userId: actor.userId,
      onStarted: (executionId) =>
        this.deps
          .context()
          .push.send(tenant.id, 'testWebhookReceived', { workflowId: id, executionId }, { workflowId: id }),
      onFailed: (executionId, error) => this.failTestListen(tenant, definition, node, executionId, error),
    });
  }

  /**
   * The listen call has answered, so the failure can only reach the editor as a run: a failed manual
   * execution, as n8n shows it, which the editor adopts like the one of a first event.
   */
  private async failTestListen(
    tenant: TenantRow,
    definition: WorkflowDefinition,
    node: WorkflowNode,
    executionId: string,
    error: Error,
  ): Promise<void> {
    const message = `${node.name}: ${error.message}`;
    const workflowId = definition.id ?? null;
    const now = new Date();
    try {
      await this.repos.executions.create(
        tenant.id,
        {
          id: executionId,
          workflowId,
          workflowName: definition.name ?? '',
          mode: 'manual',
          status: 'error',
          startedAt: now,
          stoppedAt: now,
          errorMessage: message,
          workflowVersionId: definition.versionId ?? null,
        },
        {
          workflowData: cloneDefinition(definition) as unknown as Record<string, unknown>,
          runOptions: { startNode: node.name },
        },
      );
      const state = createInitialState();
      state.resultData.error = serializeError(new Error(message));
      state.resultData.lastNodeExecuted = node.name;
      await this.repos.executions.saveState(tenant.id, executionId, state);
    } catch (failure) {
      // the editor still hears why it stopped listening
      this.deps
        .context()
        .logger.warn(
          { err: failure, tenantId: tenant.id, workflowId },
          'Could not store a failed test listen',
        );
    }
    const { push } = this.deps.context();
    const about = { workflowId: workflowId ?? undefined };
    push.send(tenant.id, 'testWebhookReceived', { workflowId, executionId }, about);
    push.send(
      tenant.id,
      'executionFinished',
      { executionId, workflowId, status: 'error', error: { message } },
      about,
    );
  }

  /** why the triggers of a workflow are down; as in n8n, a workflow out of reach is a 400 */
  async activationError(tenantId: string, id: string): Promise<string | null> {
    const row = await this.repos.workflows.get(tenantId, id);
    if (!row) throw ApiError.badRequest(`Workflow with ID "${id}" could not be found`);
    return this.deps.activeWorkflows.activationErrorOf(id) ?? null;
  }

  /** stops what listenTestTrigger started, on whichever main holds it */
  async stopTestTrigger(tenant: TenantRow, id: string): Promise<void> {
    await this.get(tenant.id, id);
    await this.deps.activeWorkflows.stopTestTrigger(tenant.id, id);
  }

  /** "Stop listening": drop the test registrations of one node and the provider hook they set up */
  async stopTestWebhook(tenant: TenantRow, id: string, nodeName: string): Promise<void> {
    await this.get(tenant.id, id);
    await this.deps.activeWorkflows.unregisterTestWebhook(tenant.id, id, nodeName);
    await this.deps.testWebhooks.removeForNode(tenant.id, id, nodeName);
  }

  async webhookUrls(tenant: TenantRow, id: string) {
    const row = await this.get(tenant.id, id);
    const workflow = new Workflow(toDefinition(row), this.deps.nodeTypes);
    const urls: Array<{ nodeName: string; method: string; testUrl: string; productionUrl: string }> = [];
    for (const node of sortByPosition(Object.values(workflow.nodes))) {
      const type = this.deps.nodeTypes.get(node.type);
      if (!type?.description.webhooks?.length) continue;
      try {
        for (const hook of nodeWebhooks(workflow, node, type)) {
          urls.push({
            nodeName: node.name,
            method: hook.method,
            testUrl: hookUrl(this.deps.config, hook.description, true, tenant.slug, hook.path),
            productionUrl: hookUrl(this.deps.config, hook.description, false, tenant.slug, hook.path),
          });
        }
      } catch {
        /* invalid configuration: no URL to show */
      }
    }
    return urls;
  }

  /** dry-run activation checks (platform extension) */
  async validate(tenantId: string, id: string, data?: WorkflowData): Promise<ValidationIssue[]> {
    const row = await this.get(tenantId, id);
    return this.deps.activeWorkflows.validate(tenantId, this.definitionFor(row, data), row.id);
  }
}

/** manual runs prefer a Manual Trigger; partial runs start from a trigger upstream of the destination */
export function chooseManualStartNode(
  workflow: Workflow,
  destinationNode?: string,
): WorkflowNode | undefined {
  const enabled = (names: string[]) => names.map((n) => workflow.nodes[n]).filter((n) => n && !n.disabled);
  if (destinationNode) {
    const candidates = enabled([...workflow.getParentNodes(destinationNode, 'main'), destinationNode]);
    const triggers = candidates.filter((n) => workflow.isTriggerNode(n));
    const manual = triggers.filter((n) => n.type === MANUAL_TRIGGER);
    if (manual.length) return sortByPosition(manual)[0];
    if (triggers.length) return sortByPosition(triggers)[0];
    const roots = candidates.filter((n) => workflow.getMainInputs(n.name).flat().length === 0);
    return sortByPosition(roots)[0];
  }
  const manual = Object.values(workflow.nodes).filter((n) => n.type === MANUAL_TRIGGER && !n.disabled);
  if (manual.length) return sortByPosition(manual)[0];
  return workflow.getStartNode();
}

interface Comparable {
  name: string;
  nodes: WorkflowNode[];
  connections: unknown;
  settings: unknown;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function connectionList(connections: unknown): string[] {
  const out: string[] = [];
  for (const [source, byType] of Object.entries(
    (connections ?? {}) as Record<string, Record<string, unknown[]>>,
  )) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((dests, output) => {
        for (const d of (dests ?? []) as Array<{ node: string; index: number }>) {
          out.push(`${source}[${type}:${output}] -> ${d.node}[${d.index}]`);
        }
      });
    }
  }
  return out.sort();
}

export function diffDefinitions(a: Comparable, b: Comparable) {
  const byIdA = new Map(a.nodes.map((n) => [n.id, n]));
  const byIdB = new Map(b.nodes.map((n) => [n.id, n]));
  const added = b.nodes.filter((n) => !byIdA.has(n.id)).map((n) => n.name);
  const removed = a.nodes.filter((n) => !byIdB.has(n.id)).map((n) => n.name);
  const changed: Array<{ name: string; previousName?: string; fields: string[] }> = [];
  for (const [nodeId, before] of byIdA) {
    const after = byIdB.get(nodeId);
    if (!after) continue;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...keys].filter(
      (k) =>
        stable((before as unknown as Record<string, unknown>)[k]) !==
        stable((after as unknown as Record<string, unknown>)[k]),
    );
    if (fields.length) {
      changed.push({
        name: after.name,
        ...(before.name !== after.name ? { previousName: before.name } : {}),
        fields,
      });
    }
  }
  const ca = new Set(connectionList(a.connections));
  const cb = new Set(connectionList(b.connections));
  const settingsA = (a.settings ?? {}) as Record<string, unknown>;
  const settingsB = (b.settings ?? {}) as Record<string, unknown>;
  const settingKeys = [...new Set([...Object.keys(settingsA), ...Object.keys(settingsB)])].filter(
    (k) => stable(settingsA[k]) !== stable(settingsB[k]),
  );
  return {
    name: a.name !== b.name ? { from: a.name, to: b.name } : null,
    nodes: { added, removed, changed },
    connections: { added: [...cb].filter((c) => !ca.has(c)), removed: [...ca].filter((c) => !cb.has(c)) },
    settings: { changed: settingKeys },
  };
}

export type { TagRef };
