/**
 * Plan limits (ARCHITECTURE.md §10). A tenant's effective limits are its plan's defaults
 * overridden by `tenants.settings.limits`. `null` means unlimited.
 */
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
}

export const PLANS: Record<string, PlanLimits> = {
  starter: {
    executionsPerMonth: 2_500,
    activeWorkflows: 5,
    concurrentExecutions: 5,
    maxExecutionTimeout: 300,
    pruneDays: 7,
    dataTableBytes: null,
  },
  pro: {
    executionsPerMonth: 50_000,
    activeWorkflows: 100,
    concurrentExecutions: 20,
    maxExecutionTimeout: 1_800,
    pruneDays: 30,
    dataTableBytes: null,
  },
  unlimited: {
    executionsPerMonth: null,
    activeWorkflows: null,
    concurrentExecutions: null,
    maxExecutionTimeout: null,
    pruneDays: null,
    dataTableBytes: null,
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
