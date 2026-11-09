/**
 * MCP settings of a workspace (P5-04): access on or off (`MCP_MANAGED_BY_ENV` makes the PATCH 409 and
 * uses `MCP_ACCESS_ENABLED`), the user's own MCP key (label `MCP Server API Key`, audience
 * `mcp-server-api`, shown once on create and rotate, then `wfk_<prefix>_...`), the workflows the caller can
 * edit and `toggle-access` (`workflowIds` max 100, `folderId`, `allWorkflows`, each only on workflows the
 * caller holds `workflow:update` on, by project: P6-35).
 * Built by routes/mcp-settings.ts from the context; the constructor does no work. Every query is
 * scoped by the caller's tenant with bound values.
 */
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config';
import type { ServerContext } from '../../context';
import { type TenantRow, tenants, workflows } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { TenantSettings } from '../../plans';
import { escapeLike } from '../../repositories/executions';
import { sharedRowConditions } from '../../repositories/shares';
import { isUuid, now } from '../../repositories/util';
import { MISSING_SCOPE_MESSAGE } from '../access';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL, mcpServerUrl } from './types';
import { isAvailableInMcp } from './workflow-gate';

export interface McpSettingsDTO {
  mcpAccessEnabled: boolean;
  /** set by the environment (`MCP_MANAGED_BY_ENV`): the page shows it read only */
  managedByEnv: boolean;
  autoExposeNewWorkflows: boolean;
  /** the tenant MCP server's URL (`mcpServerUrl`, on the MCP base URL): what a client connects to */
  serverUrl: string;
}

export interface McpSettingsPatch {
  mcpAccessEnabled?: boolean;
  autoExposeNewWorkflows?: boolean;
}

export interface McpApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  /** the whole key, only in the reply that created it; else `wfk_<prefix>_...` */
  key: string;
  /** true when `key` is the whole key, shown this once */
  revealed: boolean;
  createdAt: string;
}

export interface McpToggleAccessInput {
  availableInMCP: boolean;
  workflowIds?: string[];
  folderId?: string;
  allWorkflows?: boolean;
  projectId?: string;
}

/** a row of GET /mcp/workflows (editor `McpWorkflowSummary`) */
export interface McpWorkflowSummaryDTO {
  id: string;
  name: string;
  active: boolean;
  availableInMCP: boolean;
  folderId: string | null;
  updatedAt: string;
}

/** the most workflows one toggle names, as n8n */
export const MCP_TOGGLE_MAX_WORKFLOWS = 100;

/** the most rows GET /mcp/workflows answers */
export const MCP_WORKFLOWS_LIST_MAX = 500;

export const MCP_SETTINGS_TEXTS = {
  managedByEnv: 'MCP settings are managed by the environment and cannot be changed here',
  toggleTarget:
    'Name the workflows to change: workflowIds, folderId, projectId or allWorkflows (exactly one)',
} as const;

export const mcpSettingsPatchSchema = z
  .object({
    mcpAccessEnabled: z.boolean().optional(),
    autoExposeNewWorkflows: z.boolean().optional(),
  })
  .strict();

export const mcpWorkflowsQuerySchema = z.object({
  search: z.string().max(128).optional(),
  folderId: z.union([z.uuid(), z.literal('root')]).optional(),
});

export const mcpToggleAccessSchema = z
  .object({
    availableInMCP: z.boolean(),
    workflowIds: z.array(z.uuid()).min(1).max(MCP_TOGGLE_MAX_WORKFLOWS).optional(),
    folderId: z.uuid().optional(),
    allWorkflows: z.boolean().optional(),
    /** a target of its own as in n8n (every workflow of this project the caller can edit); with `allWorkflows` the same */
    projectId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (v) =>
      [
        v.workflowIds !== undefined,
        v.folderId !== undefined,
        v.allWorkflows === true || v.projectId !== undefined,
      ].filter(Boolean).length === 1,
    { message: MCP_SETTINGS_TEXTS.toggleTarget },
  );

function mcpSettingsOf(tenant: Pick<TenantRow, 'settings'>): NonNullable<TenantSettings['mcp']> {
  return ((tenant.settings ?? {}) as TenantSettings).mcp ?? {};
}

/**
 * Whether the tenant MCP server answers for this workspace: the environment's `MCP_ACCESS_ENABLED`
 * when `MCP_MANAGED_BY_ENV`, else the workspace's switch (the environment value until it is set).
 */
export function mcpAccessEnabled(config: Config, tenant: Pick<TenantRow, 'settings'>): boolean {
  if (config.mcp.managedByEnv) return config.mcp.accessEnabled;
  return mcpSettingsOf(tenant).enabled ?? config.mcp.accessEnabled;
}

/** a key as it is shown after its first reply */
function maskedKey(prefix: string): string {
  return `wfk_${prefix}_...`;
}

export class McpSettingsService {
  constructor(readonly ctx: ServerContext) {}

  private dto(tenant: Pick<TenantRow, 'settings' | 'slug'>): McpSettingsDTO {
    return {
      mcpAccessEnabled: mcpAccessEnabled(this.ctx.config, tenant),
      managedByEnv: this.ctx.config.mcp.managedByEnv,
      autoExposeNewWorkflows: mcpSettingsOf(tenant).autoExposeNewWorkflows === true,
      serverUrl: mcpServerUrl(this.ctx.config, tenant.slug),
    };
  }

  async getSettings(auth: AuthContext): Promise<McpSettingsDTO> {
    const tenant = (await this.ctx.repos.tenants.get(auth.tenant.id)) ?? auth.tenant;
    return this.dto(tenant);
  }

  async patchSettings(auth: AuthContext, patch: McpSettingsPatch): Promise<McpSettingsDTO> {
    if (this.ctx.config.mcp.managedByEnv) throw ApiError.conflict(MCP_SETTINGS_TEXTS.managedByEnv);
    const change: Record<string, boolean> = {};
    if (patch.mcpAccessEnabled !== undefined) change.enabled = patch.mcpAccessEnabled;
    if (patch.autoExposeNewWorkflows !== undefined)
      change.autoExposeNewWorkflows = patch.autoExposeNewWorkflows;
    // one statement merges into `settings.mcp`, so a parallel change of other settings is kept
    const [row] = await this.ctx.database.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{mcp}', coalesce(${tenants.settings} -> 'mcp', '{}'::jsonb) || ${JSON.stringify(change)}::jsonb, true)`,
      })
      .where(eq(tenants.id, auth.tenant.id))
      .returning();
    if (!row) throw ApiError.notFound('Workspace');
    await this.ctx.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.settings_updated',
      resourceType: 'tenant',
      resourceId: auth.tenant.id,
      metadata: { ...change },
    });
    return this.dto(row);
  }

  /** the caller's own key; creates it (shown once) when none exists */
  async getApiKey(auth: AuthContext): Promise<McpApiKeyDTO> {
    const existing = await this.ctx.repos.apiKeys.getForUser(auth.tenant.id, auth.user.id, MCP_KEY_AUDIENCE);
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        prefix: existing.prefix,
        key: maskedKey(existing.prefix),
        revealed: false,
        createdAt: existing.createdAt.toISOString(),
      };
    }
    return this.createKey(auth, 'mcp.api_key_created');
  }

  /** replaces the caller's key and shows the new one once */
  async rotateApiKey(auth: AuthContext): Promise<McpApiKeyDTO> {
    await this.ctx.repos.apiKeys.deleteForUser(auth.tenant.id, auth.user.id, MCP_KEY_AUDIENCE);
    return this.createKey(auth, 'mcp.api_key_rotated');
  }

  private async createKey(auth: AuthContext, action: string): Promise<McpApiKeyDTO> {
    const created = await this.ctx.auth.createApiKey(
      auth.tenant.id,
      auth.user.id,
      MCP_KEY_LABEL,
      [],
      MCP_KEY_AUDIENCE,
    );
    await this.ctx.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action,
      resourceType: 'api_key',
      resourceId: created.id,
    });
    return {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      key: created.key,
      revealed: true,
      createdAt: created.createdAt,
    };
  }

  /**
   * The conditions that narrow a workflows query to what the caller may edit (`workflow:update` workspace
   * wide, in a project or through a share); null when the caller can edit nothing.
   */
  private async editable(auth: AuthContext): Promise<SQL[] | null> {
    const filter = await this.ctx.access.listFilter(auth, 'workflow:update');
    return sharedRowConditions({
      tenantId: auth.tenant.id,
      kind: 'workflow',
      id: workflows.id,
      project: workflows.projectId,
      options: { filter },
    });
  }

  /**
   * The workflows the caller can edit (not archived), with their `availableInMCP` flag, newest first. A
   * caller who can edit none (no `workflow:update` anywhere) gets n8n's 403.
   */
  async listWorkflows(auth: AuthContext, query: unknown): Promise<McpWorkflowSummaryDTO[]> {
    const filter = mcpWorkflowsQuerySchema.parse(query ?? {});
    const access = await this.editable(auth);
    if (access === null) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const conditions: SQL[] = [
      eq(workflows.tenantId, auth.tenant.id),
      eq(workflows.isArchived, false),
      ...access,
    ];
    if (filter.search) conditions.push(sql`${workflows.name} ilike ${`%${escapeLike(filter.search)}%`}`);
    if (filter.folderId === 'root') conditions.push(isNull(workflows.folderId));
    else if (filter.folderId) conditions.push(eq(workflows.folderId, filter.folderId));
    const rows = await this.ctx.database.db
      .select({
        id: workflows.id,
        name: workflows.name,
        active: workflows.active,
        settings: workflows.settings,
        folderId: workflows.folderId,
        updatedAt: workflows.updatedAt,
      })
      .from(workflows)
      .where(and(...conditions))
      .orderBy(desc(workflows.updatedAt), desc(workflows.id))
      .limit(MCP_WORKFLOWS_LIST_MAX);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      availableInMCP: isAvailableInMcp(r.settings),
      folderId: r.folderId,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Sets `availableInMCP` on the named workflows, a folder's (with its subfolders) or all the caller can edit
   * (of the named project, with `projectId`); archived workflows and other workspaces' ids are left alone.
   * Every workflow needs `workflow:update` for the caller: a named one it cannot edit is a 403, a folder or
   * `allWorkflows` changes only the ones it can. Returns how many changed.
   */
  async toggleAccess(auth: AuthContext, input: McpToggleAccessInput): Promise<{ updatedCount: number }> {
    const body = mcpToggleAccessSchema.parse(input);
    const tenantId = auth.tenant.id;
    const access = await this.editable(auth);
    const conditions: SQL[] = [eq(workflows.tenantId, tenantId), eq(workflows.isArchived, false)];
    if (body.workflowIds) {
      const ids = [...new Set(body.workflowIds)].filter(isUuid);
      const named = await this.ctx.database.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids)));
      const allowed = access
        ? await this.ctx.database.db
            .select({ id: workflows.id })
            .from(workflows)
            .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids), ...access))
        : [];
      // a workflow of this workspace the caller cannot edit stops the whole change
      if (allowed.length < named.length) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
      conditions.push(inArray(workflows.id, ids));
    } else if (body.folderId) {
      const held = await this.ctx.access.scopesForAuth(auth, { folderId: body.folderId });
      if (!held.has('folder:read')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
      const subtree = await this.ctx.repos.folders.subtreeIds(tenantId, body.folderId);
      conditions.push(inArray(workflows.folderId, subtree.length ? subtree : [body.folderId]));
    } else if (body.projectId) {
      const held = await this.ctx.access.scopesForAuth(auth, { projectId: body.projectId });
      if (!held.has('workflow:update')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
      conditions.push(eq(workflows.projectId, body.projectId));
    }
    if (!access) return { updatedCount: await this.auditToggle(auth, body, 0) };
    conditions.push(...access);
    const value = body.availableInMCP ? sql`'true'::jsonb` : sql`'false'::jsonb`;
    conditions.push(
      sql`coalesce(${workflows.settings} -> 'availableInMCP', 'false'::jsonb) is distinct from ${value}`,
    );
    const rows = await this.ctx.database.db
      .update(workflows)
      .set({
        settings: sql`jsonb_set(coalesce(${workflows.settings}, '{}'::jsonb), '{availableInMCP}', ${value}, true)`,
        // no new versionId (as n8n): a stale editor save keeps this flag (WorkflowService.update)
        updatedAt: now(),
      })
      .where(and(...conditions))
      .returning({ id: workflows.id });
    return { updatedCount: await this.auditToggle(auth, body, rows.length) };
  }

  private async auditToggle(
    auth: AuthContext,
    body: z.output<typeof mcpToggleAccessSchema>,
    updatedCount: number,
  ): Promise<number> {
    await this.ctx.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.workflows_access_updated',
      resourceType: 'workflow',
      metadata: {
        availableInMCP: body.availableInMCP,
        target: body.workflowIds ? 'workflows' : body.folderId ? 'folder' : 'all',
        updatedCount,
      },
    });
    return updatedCount;
  }
}
