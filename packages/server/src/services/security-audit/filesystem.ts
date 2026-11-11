/**
 * P6-54 (L9): the filesystem category of the security audit. Filesystem: nodes that read or write files on the server.
 * The platform has no node that reads or writes a file of the host (files are binary data held by the
 * workspace), so the category is valid and has no risk to report.
 */
import type { ServiceDeps } from '../../context';
import type { AuditRiskReport, AuditRunOptions } from './types';

/** null when the category finds no risk */
export async function filesystemReport(
  _deps: ServiceDeps,
  _tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  return null;
}
