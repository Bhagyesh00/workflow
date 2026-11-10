/**
 * P6-54 (L9): the database category of the security audit. Database: SQL nodes (app.postgres, app.mySql) with an expression in the query or unused query parameters.
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function databaseReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
