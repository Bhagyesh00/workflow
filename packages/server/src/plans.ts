/**
 * Plan limits (ARCHITECTURE.md §10). A tenant's effective limits are its plan's defaults
 * overridden by `tenants.settings.limits`. `null` means unlimited.
 */
import type { AssistantPermissions, RedactionFloor } from '@workflow/workflow';
import type { Config } from './config';

export interface PlanLimits {
  executionsPerMonth: number | null;
  activeWorkflows: number | null;
  concurrentExecutions: number | null;
  /** seconds */
  maxExecutionTimeout: number | null;
  /** executions older than this are pruned */
  pruneDays: number | null;
  /** data table storage per workspace; unlike the others, null = DATA_TABLES_MAX_SIZE_BYTES applies */
  dataTableBytes: number | null;
  /** P6-03: team projects per workspace (null = unlimited, on every plan); POST /projects checks it (L1) */
  maxTeamProjects: number | null;
}

export const PLANS: Record<string, PlanLimits> = {
  starter: {
    executionsPerMonth: 2_500,
    activeWorkflows: 5,
    concurrentExecutions: 5,
    maxExecutionTimeout: 300,
    pruneDays: 7,
    dataTableBytes: null,
    maxTeamProjects: null,
  },
  pro: {
    executionsPerMonth: 50_000,
    activeWorkflows: 100,
    concurrentExecutions: 20,
    maxExecutionTimeout: 1_800,
    pruneDays: 30,
    dataTableBytes: null,
    maxTeamProjects: null,
  },
  unlimited: {
    executionsPerMonth: null,
    activeWorkflows: null,
    concurrentExecutions: null,
    maxExecutionTimeout: null,
    pruneDays: null,
    dataTableBytes: null,
    maxTeamProjects: null,
  },
};

export interface TenantSettings {
  brand?: { name?: string; logoUrl?: string; primaryColor?: string };
  timezone?: string;
  limits?: Partial<PlanLimits>;
  /** P3-19: review requests before publish (admins turn it on; off by default) */
  workflowReviews?: { enabled?: boolean };
  /**
   * P5-09: the AI workflow builder's model (admins set it): a chat model credential of this tenant, the
   * chat model node type that uses it (`isBuilderModelNode`) and the model id
   */
  ai?: { credentialId: string; nodeType: string; model: string; allowSendingParameterValues?: boolean };
  /** P5-04, P5-14: the tenant MCP server (off by default), auto expose of new workflows, OAuth redirect allow list */
  mcp?: { enabled?: boolean; autoExposeNewWorkflows?: boolean; allowedRedirectUris?: string[] };
  /**
   * P5-67 to P5-73: the Assistant (admins set it). Unset `enabled` is on unless `INSTANCE_AI_ENABLED` says
   * otherwise; its own model (credential, node type, model id), web search credential, MCP access, tool
   * permissions (read through `resolveAssistantPermissions`) and data sharing
   */
  assistant?: {
    enabled?: boolean;
    credentialId?: string;
    nodeType?: string;
    model?: string;
    searchCredentialId?: string | null;
    searchDisabled?: boolean;
    mcpAccessEnabled?: boolean;
    permissions?: Partial<AssistantPermissions>;
    allowSendingParameterValues?: boolean;
  };
  /**
   * P6-33: the personal space policy (`securitySettings:manage`); an absent flag is on. The access
   * service reads it for `project:personalOwner` (`personalOwnerScopes`), GET /settings returns it.
   */
  securityPolicy?: { personalSpacePublishing?: boolean; personalSpaceSharing?: boolean };
  /** P6-18: MFA for every member (`user:enforceMfa`, POST /settings/mfa-enforce); not in `settingsPatch` */
  mfa?: { enforced?: boolean };
  /**
   * P6-02: SCIM (`scim:manage`): on or off, what a SCIM delete does to the membership, and what happens to the
   * person's work (moved to `transferProjectId` or deleted); not in `settingsPatch`
   */
  scim?: {
    enabled?: boolean;
    onDelete?: 'disable' | 'delete';
    dataAction?: 'transfer' | 'delete';
    transferProjectId?: string;
  };
  /** P6-17: set once, atomically, when the first production run failed and its mail went out */
  firstProductionFailure?: { at: string };
  /**
   * P6-53 (L8): the workspace's redaction floor (`/settings/security` `redaction.floor`); absent is `off`. A
   * workflow's `redactionPolicy` may not be weaker; new workflows are seeded from it.
   */
  redactionFloor?: RedactionFloor;
  /** P6-83 (L15): the public API rate limits per API key; absent fields take `config.publicApiRateLimit` */
  publicApiRateLimit?: PublicApiRateLimit;
  /**
   * P6-78 (L7): Git environments. `readOnly` makes this a protected workspace (services/protected.ts
   * `isProtected`); set only by the source control switch (`setReadOnly`, one `mergeSettings`), never by
   * PATCH /settings; GET /settings returns it as `sourceControl.readOnly`
   */
  sourceControl?: { readOnly?: boolean };
}

/**
 * P6-83: public API rate limits per API key (n8n's names). 0 = no limit; windows in seconds. Not enabled:
 * today's fixed 600 per minute per key applies.
 */
export interface PublicApiRateLimit {
  enabled: boolean;
  globalReadLimit: number;
  globalReadWindow: number;
  globalWriteLimit: number;
  globalWriteWindow: number;
  endpointReadLimit: number;
  endpointReadWindow: number;
  endpointWriteLimit: number;
  endpointWriteWindow: number;
}

export function effectiveLimits(plan: string, settings: TenantSettings | null | undefined): PlanLimits {
  const base = PLANS[plan] ?? PLANS.unlimited;
  return { ...base, ...(settings?.limits ?? {}) };
}

/** execution timeout in ms: workflow setting (or default), capped by the plan and the instance maximum */
export function executionTimeoutMs(
  config: Config,
  limits: PlanLimits,
  workflowTimeoutS: number | undefined,
): number {
  const requested =
    workflowTimeoutS && workflowTimeoutS > 0 ? workflowTimeoutS : config.executionTimeout.defaultS;
  const caps = [config.executionTimeout.maxS];
  if (limits.maxExecutionTimeout) caps.push(limits.maxExecutionTimeout);
  return Math.min(requested, ...caps) * 1000;
}

/** the workspace's data table quota: the plan's override, else the instance setting */
export function dataTableQuotaBytes(config: Config, limits: PlanLimits): number {
  return limits.dataTableBytes ?? config.dataTables.maxSizeBytes;
}

export function currentPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}
