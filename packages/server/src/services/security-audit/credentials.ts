/**
 * P6-54 (L9): the credentials category of the security audit. Credentials: not used anywhere, not in published workflows, not in workflows run in the last N days.
 */
import type { ServiceDeps } from '../../context';
import { AUDIT_PAGE_SIZE } from '../../repositories/security-audit';
import type { AuditLocation, AuditRiskReport, AuditRunOptions, AuditSection } from './types';
import { eachWorkflow } from './types';

const DAY_MS = 86_400_000;

/** null when the category finds no risk */
export async function credentialsReport(
  deps: ServiceDeps,
  tenantId: string,
  options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  const repo = deps.repos.securityAudit;
  const since = new Date(Date.now() - options.daysAbandonedWorkflow * DAY_MS);
  const ranRecently = new Set(await repo.workflowIdsRunSince(tenantId, since));

  const inAnyWorkflow = new Set<string>();
  const inActiveWorkflow = new Set<string>();
  const inRecentWorkflow = new Set<string>();
  await eachWorkflow(deps, tenantId, (workflow) => {
    for (const node of workflow.nodes) {
      for (const id of credentialIdsOf(node)) {
        inAnyWorkflow.add(id);
        if (workflow.active && !workflow.isArchived) inActiveWorkflow.add(id);
        if (ranRecently.has(workflow.id)) inRecentWorkflow.add(id);
      }
    }
  });

  const unused: AuditLocation[] = [];
  const inactiveOnly: AuditLocation[] = [];
  const dormantOnly: AuditLocation[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await repo.credentialsPage(tenantId, after);
    for (const credential of page) {
      const location: AuditLocation = { kind: 'credential', id: credential.id, name: credential.name };
      if (!inAnyWorkflow.has(credential.id)) {
        unused.push(location);
        continue;
      }
      if (!inActiveWorkflow.has(credential.id)) inactiveOnly.push(location);
      if (!inRecentWorkflow.has(credential.id)) dormantOnly.push(location);
    }
    if (page.length < AUDIT_PAGE_SIZE) break;
    after = page[page.length - 1].id;
  }

  const sections: AuditSection[] = [];
  if (unused.length > 0) {
    sections.push({
      title: 'Credentials that no workflow uses',
      description: 'These credentials are not named by any node in any workflow of the workspace.',
      recommendation: 'Delete the credentials you no longer need, so they cannot be used by mistake.',
      location: unused,
    });
  }
  if (inactiveOnly.length > 0) {
    sections.push({
      title: 'Credentials used only by workflows that are not published',
      description: 'These credentials are named only by workflows that are not published or are archived.',
      recommendation: 'Delete the credentials if those workflows are retired, or publish the workflows.',
      location: inactiveOnly,
    });
  }
  if (dormantOnly.length > 0) {
    // the caller's own number only; the config default is never printed
    const requested = options.requestedDaysAbandonedWorkflow;
    const period = requested === undefined ? 'the abandoned period' : `${requested} days`;
    sections.push({
      title: `Credentials used only by workflows that have not run in ${period}`,
      description: `These credentials are named only by workflows with no run in ${period === 'the abandoned period' ? 'the abandoned period' : `the last ${period}`}.`,
      recommendation:
        'Check whether those workflows are still needed, and delete them and their credentials if not.',
      location: dormantOnly,
    });
  }
  return sections.length > 0 ? { risk: 'credentials', sections } : null;
}

/** the credential ids a node names (strings only) */
function credentialIdsOf(node: unknown): string[] {
  const credentials = (node as { credentials?: unknown } | null)?.credentials;
  if (!credentials || typeof credentials !== 'object') return [];
  const ids: string[] = [];
  for (const ref of Object.values(credentials as Record<string, unknown>)) {
    const id = (ref as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}
