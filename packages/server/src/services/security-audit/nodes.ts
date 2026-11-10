/**
 * P6-54 (L9): the nodes category of the security audit. Nodes: the risky types core.code, core.httpRequest, core.ssh, core.ftp.
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function nodesReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
