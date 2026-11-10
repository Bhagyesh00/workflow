/**
 * P6-54 (L9): the instance category of the security audit. Instance: unprotected webhooks (authentication none, no validator child) and the workspace settings (workflow reviews, redaction floor, policy default).
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function instanceReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
