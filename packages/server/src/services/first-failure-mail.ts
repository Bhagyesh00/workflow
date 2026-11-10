/**
 * P6-17 (L1): the first production failure mail of a workspace (n8n's workflow-statistics first failure):
 * only with mail set up; `repos.tenants.markFirstProductionFailure` first, so two workers send one; skipped
 * when any workflow of the workspace has an error workflow; to the owner of the workflow's personal
 * project, else the workspace owner. services/executions.ts `finish` calls it (C0) on a failed run that is
 * not manual, without waiting; it never throws.
 * Stub from C0: it PASSES (sends nothing) until L1.
 */
import type { ServiceDeps } from '../context';

export async function maybeSendFirstFailure(
  _deps: ServiceDeps,
  _tenantId: string,
  _workflowId: string,
): Promise<void> {
  // stub (L1): PASSES, no mail
}
