/**
 * P6-54 (L9): the workspace security audit (public POST /audit, `securityAudit:generate`). Five categories,
 * read page by page (200 rows each): credentials, database, nodes, filesystem, instance. Only this tenant's
 * data; platform env values never returned.
 */
import { redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { ApiError } from '../../http/errors';
import { credentialsReport } from './credentials';
import { databaseReport } from './database';
import { filesystemReport } from './filesystem';
import { instanceReport } from './instance';
import { nodesReport } from './nodes';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditRiskReport,
  type AuditRunOptions,
  auditTitle,
  type SecurityAuditOptions,
  type SecurityAuditReport,
} from './types';

type Reporter = (
  deps: ServiceDeps,
  tenantId: string,
  options: AuditRunOptions,
) => Promise<AuditRiskReport | null>;

const REPORTERS: Record<AuditCategory, Reporter> = {
  credentials: credentialsReport,
  database: databaseReport,
  nodes: nodesReport,
  filesystem: filesystemReport,
  instance: instanceReport,
};

/** the categories asked for (all when none), each once, in report order; an unknown one is a 400 with the valid list */
function resolveCategories(requested: readonly string[] | undefined): AuditCategory[] {
  if (!requested || requested.length === 0) return [...AUDIT_CATEGORIES];
  for (const category of requested) {
    if (!(AUDIT_CATEGORIES as readonly string[]).includes(category)) {
      throw ApiError.badRequest(
        redactSecrets(
          `Unknown audit category "${String(category).slice(0, 64)}". Valid categories are: ${AUDIT_CATEGORIES.join(', ')}`,
        ),
      );
    }
  }
  return AUDIT_CATEGORIES.filter((category) => requested.includes(category));
}

export async function generateSecurityAudit(
  deps: ServiceDeps,
  tenantId: string,
  options: SecurityAuditOptions,
): Promise<SecurityAuditReport> {
  const run: AuditRunOptions = {
    daysAbandonedWorkflow: options.daysAbandonedWorkflow ?? deps.config.securityAudit.daysAbandonedWorkflow,
    requestedDaysAbandonedWorkflow: options.daysAbandonedWorkflow,
    categories: resolveCategories(options.categories),
  };
  const report: SecurityAuditReport = {};
  for (const category of run.categories) {
    const result = await REPORTERS[category](deps, tenantId, run);
    if (result && result.sections.length > 0) report[auditTitle(category)] = result;
  }
  return report;
}
