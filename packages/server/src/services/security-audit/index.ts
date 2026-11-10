/**
 * P6-54 (L9): the workspace security audit (public POST /audit, `securityAudit:generate`). Five categories,
 * read page by page (200 rows each): credentials, database, nodes, filesystem, instance. Only this tenant's
 * data; platform env values never returned.
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { SecurityAuditOptions, SecurityAuditReport } from './types';

export async function generateSecurityAudit(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: SecurityAuditOptions,
): Promise<SecurityAuditReport> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
