/**
 * P6-17 (L1): the share mails (n8n's workflow, credential and project shared notices). Each goes to the
 * people of the given projects (or the given users), skips the actor, and never throws: a mail that fails
 * is logged, the share stands. Called after the write by services/sharing.ts and services/projects.ts (C0).
 * Nothing is sent while mail is not set up.
 */
import type { ServiceDeps } from '../context';

interface Recipient {
  userId: string;
  email: string;
}

/** the people of `projectIds` (every relation), once each, without the actor and without disabled members */
async function projectPeople(
  deps: ServiceDeps,
  tenantId: string,
  actorId: string,
  projectIds: string[],
): Promise<Recipient[]> {
  const members = new Map((await deps.repos.memberships.listForTenant(tenantId)).map((m) => [m.userId, m]));
  const seen = new Set<string>([actorId]);
  const out: Recipient[] = [];
  for (const projectId of projectIds) {
    for (const relation of await deps.repos.projects.relations.listForProject(tenantId, projectId)) {
      const member = members.get(relation.userId);
      if (seen.has(relation.userId) || !member || member.disabledAt) continue;
      seen.add(relation.userId);
      out.push({ userId: relation.userId, email: member.email });
    }
  }
  return out;
}

async function context(deps: ServiceDeps, tenantId: string, actorId: string) {
  const [tenant, actor] = await Promise.all([
    deps.repos.tenants.get(tenantId),
    deps.repos.users.get(actorId),
  ]);
  if (!tenant || !actor) return undefined;
  return {
    workspaceName: tenant.name,
    actorName: actor.name,
    baseUrl: deps.config.baseUrl.replace(/\/+$/, ''),
  };
}

/** runs `work` when mail is set up; a failure is logged (no names, no links) and swallowed */
async function guarded(deps: ServiceDeps, kind: string, work: () => Promise<void>): Promise<void> {
  if (!deps.context().mailer.isConfigured()) return;
  try {
    await work();
  } catch (error) {
    deps.logger.warn({ err: error, kind }, 'Share mail could not be sent');
  }
}

async function sendEach(
  deps: ServiceDeps,
  kind: string,
  recipients: Recipient[],
  send: (to: string) => Promise<unknown>,
): Promise<void> {
  for (const recipient of recipients) {
    try {
      await send(recipient.email);
    } catch (error) {
      deps.logger.warn({ err: error, kind, userId: recipient.userId }, 'Share mail could not be sent');
    }
  }
}

/** a workflow was shared with `projectIds` (the projects added, not the whole list) */
export async function workflowShared(
  deps: ServiceDeps,
  tenantId: string,
  actorId: string,
  workflowId: string,
  projectIds: string[],
): Promise<void> {
  await guarded(deps, 'workflow', async () => {
    const [ctx, workflow] = await Promise.all([
      context(deps, tenantId, actorId),
      deps.repos.workflows.get(tenantId, workflowId),
    ]);
    if (!ctx || !workflow) return;
    const mailer = deps.context().mailer;
    const recipients = await projectPeople(deps, tenantId, actorId, projectIds);
    await sendEach(deps, 'workflow', recipients, (to) =>
      mailer.sendWorkflowShared(to, {
        workspaceName: ctx.workspaceName,
        actorName: ctx.actorName,
        workflowName: workflow.name,
        workflowUrl: `${ctx.baseUrl}/workflow/${workflow.id}`,
      }),
    );
  });
}

/** a credential was shared with `projectIds` (the projects added) */
export async function credentialShared(
  deps: ServiceDeps,
  tenantId: string,
  actorId: string,
  credentialId: string,
  projectIds: string[],
): Promise<void> {
  await guarded(deps, 'credential', async () => {
    const [ctx, credential] = await Promise.all([
      context(deps, tenantId, actorId),
      deps.repos.credentials.get(tenantId, credentialId),
    ]);
    if (!ctx || !credential) return;
    const mailer = deps.context().mailer;
    const recipients = await projectPeople(deps, tenantId, actorId, projectIds);
    await sendEach(deps, 'credential', recipients, (to) =>
      mailer.sendCredentialShared(to, {
        workspaceName: ctx.workspaceName,
        actorName: ctx.actorName,
        credentialName: credential.name,
        credentialsUrl: `${ctx.baseUrl}/home/credentials`,
      }),
    );
  });
}

/** `userIds` were added to the team project `projectId` */
export async function projectShared(
  deps: ServiceDeps,
  tenantId: string,
  actorId: string,
  projectId: string,
  userIds: string[],
): Promise<void> {
  await guarded(deps, 'project', async () => {
    const ctx = await context(deps, tenantId, actorId);
    if (!ctx) return;
    const members = new Map((await deps.repos.memberships.listForTenant(tenantId)).map((m) => [m.userId, m]));
    const project = await deps.repos.projects.get(tenantId, projectId);
    if (!project) return;
    const mailer = deps.context().mailer;
    const seen = new Set<string>([actorId]);
    for (const userId of userIds) {
      const member = members.get(userId);
      if (seen.has(userId) || !member || member.disabledAt) continue;
      seen.add(userId);
      try {
        const relation = await deps.repos.projects.relations.get(tenantId, projectId, userId);
        await mailer.sendProjectShared(member.email, {
          workspaceName: ctx.workspaceName,
          actorName: ctx.actorName,
          projectName: project.name,
          role: (relation?.role ?? 'member').replace(/^project:/, ''),
          projectUrl: `${ctx.baseUrl}/projects/${project.id}`,
        });
      } catch (error) {
        deps.logger.warn({ err: error, kind: 'project', userId }, 'Share mail could not be sent');
      }
    }
  });
}
