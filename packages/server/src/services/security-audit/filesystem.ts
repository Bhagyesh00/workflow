/**
 * P6-54 (L9): the filesystem category of the security audit. Filesystem: nodes that read or write files on the server.
 * Stub from C0; L9 fills it.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function filesystemReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  // stub (L9)
  throw new Error('not implemented (L9)');
}
