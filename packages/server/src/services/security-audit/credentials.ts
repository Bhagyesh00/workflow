/**
 * P6-54 (L9): the credentials category of the security audit. Credentials: not used anywhere, not in published workflows, not in workflows run in the last N days.
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function credentialsReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
