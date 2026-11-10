/**
 * P6-17 (L1): the first production failure mail of a workspace (n8n's workflow-statistics first failure):
 * only with mail set up; `repos.tenants.markFirstProductionFailure` first, so two workers send one; skipped
 * when any workflow of the workspace has an error workflow; to the owner of the workflow's personal
 * project, else the workspace owner. services/executions.ts `finish` calls it (C0) on a failed run that is
 * not manual, without waiting; it never throws.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import { workflows } from '../db/schema';

export async function maybeSendFirstFailure(
  deps: ServiceDeps,
  tenantId: string,
  workflowId: string,
): Promise<void> {
  try {
    const mailer = deps.context().mailer;
    if (!mailer.isConfigured()) return;
    // a workspace that handles failures itself needs no hint: any workflow with an error workflow skips it
    const [withHandler] = await deps.database.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          sql`coalesce(${workflows.settings} ->> 'errorWorkflow', '') <> ''`,
        ),
      )
      .limit(1);
    if (withHandler) return;
    const workflow = await deps.repos.workflows.get(tenantId, workflowId);
    if (!workflow) return;
    // one UPDATE decides which of two parallel failures sends
    if (!(await deps.repos.tenants.markFirstProductionFailure(tenantId))) return;
    const active = (await deps.repos.memberships.listForTenant(tenantId)).filter((m) => !m.disabledAt);
    const project = await deps.repos.projects.get(tenantId, workflow.projectId);
    const personalOwner =
      project?.type === 'personal' && project.ownerUserId
        ? active.find((m) => m.userId === project.ownerUserId)
        : undefined;
    const recipient = personalOwner ?? active.find((m) => m.role === 'owner');
    if (!recipient) return;
    const tenant = await deps.repos.tenants.get(tenantId);
    if (!tenant) return;
    await mailer.sendFirstProductionFailure(recipient.email, {
      workspaceName: tenant.name,
      workflowName: workflow.name,
      workflowUrl: `${deps.config.baseUrl.replace(/\/+$/, '')}/workflow/${workflow.id}`,
    });
  } catch (error) {
    deps.logger.warn({ err: error, tenantId, workflowId }, 'First failure mail could not be sent');
  }
}
