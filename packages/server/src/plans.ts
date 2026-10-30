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
}

export const PLANS: Record<string, PlanLimits> = {
  starter: {
    executionsPerMonth: 2_500,
    activeWorkflows: 5,
    concurrentExecutions: 5,
    maxExecutionTimeout: 300,
    pruneDays: 7,
  },
  pro: {
    executionsPerMonth: 50_000,
    activeWorkflows: 100,
    concurrentExecutions: 20,
    maxExecutionTimeout: 1_800,
    pruneDays: 30,
  },
  unlimited: {
    executionsPerMonth: null,
    activeWorkflows: null,
    concurrentExecutions: null,
    maxExecutionTimeout: null,
    pruneDays: null,
  },
};

export interface TenantSettings {
  brand?: { name?: string; logoUrl?: string; primaryColor?: string };
  timezone?: string;
  limits?: Partial<PlanLimits>;
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

export function currentPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}
