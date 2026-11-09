/**
 * Security settings (P6-33, L12): the personal space policy, `tenants.settings.securityPolicy`
 * (`TenantSettings.securityPolicy`; absent flags are on). Publishing and sharing in personal projects
 * work by adding or removing scopes of `project:personalOwner` (`personalOwnerScopes`); turning a flag off
 * undoes nothing that exists, the counts say how much exists. The public `/settings/security-policy` is
 * L13's (P6-34).
 */
import { and, countDistinct, eq, isNotNull } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import { credentialShares, credentials, projects, workflowShares, workflows } from '../db/schema';
import { createRepositories } from '../repositories';
import type { TenantSettings } from '../plans';

/** what exists today in personal projects (shown before a flag is turned off) */
export interface SecurityPolicyCounts {
  publishedPersonalWorkflowsCount: number;
  sharedPersonalWorkflowsCount: number;
  sharedPersonalCredentialsCount: number;
}

/** GET /settings/security: the flags (resolved, absent = on) with the counts */
export interface SecurityPolicyDTO extends SecurityPolicyCounts {
  personalSpacePublishing: boolean;
  personalSpaceSharing: boolean;
}

/** POST /settings/security */
export interface SecurityPolicyPatch {
  personalSpacePublishing?: boolean;
  personalSpaceSharing?: boolean;
}

const FLAGS = ['personalSpacePublishing', 'personalSpaceSharing'] as const;

export class SecuritySettingsService {
  constructor(readonly deps: ServiceDeps) {}

  async get(tenantId: string): Promise<SecurityPolicyDTO> {
    const tenant = await this.deps.repos.tenants.get(tenantId);
    const policy = (tenant?.settings as TenantSettings | undefined)?.securityPolicy;
    return {
      personalSpacePublishing: policy?.personalSpacePublishing !== false,
      personalSpaceSharing: policy?.personalSpaceSharing !== false,
      ...(await this.counts(tenantId)),
    };
  }

  /**
   * Saves the flags given (the others keep their value). Nothing that is published or shared is touched:
   * the next scope check reads the new policy, so a flag takes effect on the next call.
   * `actorId` for the audit log.
   */
  async update(tenantId: string, patch: SecurityPolicyPatch, actorId?: string): Promise<SecurityPolicyDTO> {
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const tenant = await repos.tenants.get(tenantId);
      if (!tenant) return;
      const settings = (tenant.settings ?? {}) as TenantSettings;
      const securityPolicy: NonNullable<TenantSettings['securityPolicy']> = {
        ...settings.securityPolicy,
      };
      for (const flag of FLAGS) {
        if (patch[flag] !== undefined) securityPolicy[flag] = patch[flag];
      }
      await repos.tenants.updateSettings(tenantId, {
        ...settings,
        securityPolicy,
      });
      await repos.audit.add(tenantId, {
        userId: actorId,
        action: 'tenant.security_policy_updated',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: {
          personalSpacePublishing: securityPolicy.personalSpacePublishing !== false,
          personalSpaceSharing: securityPolicy.personalSpaceSharing !== false,
        },
      });
    });
    return this.get(tenantId);
  }

  /** published workflows, shared workflows and shared credentials owned by personal projects */
  async counts(tenantId: string): Promise<SecurityPolicyCounts> {
    const { db } = this.deps.database;
    const [published] = await db
      .select({ n: countDistinct(workflows.id) })
      .from(workflows)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, workflows.tenantId), eq(projects.id, workflows.projectId)),
      )
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          eq(projects.type, 'personal'),
          isNotNull(workflows.publishedVersionId),
        ),
      );
    const [sharedWorkflows] = await db
      .select({ n: countDistinct(workflows.id) })
      .from(workflows)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, workflows.tenantId), eq(projects.id, workflows.projectId)),
      )
      .innerJoin(
        workflowShares,
        and(eq(workflowShares.tenantId, workflows.tenantId), eq(workflowShares.workflowId, workflows.id)),
      )
      .where(and(eq(workflows.tenantId, tenantId), eq(projects.type, 'personal')));
    const [sharedCredentials] = await db
      .select({ n: countDistinct(credentials.id) })
      .from(credentials)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, credentials.tenantId), eq(projects.id, credentials.projectId)),
      )
      .innerJoin(
        credentialShares,
        and(
          eq(credentialShares.tenantId, credentials.tenantId),
          eq(credentialShares.credentialId, credentials.id),
        ),
      )
      .where(and(eq(credentials.tenantId, tenantId), eq(projects.type, 'personal')));
    return {
      publishedPersonalWorkflowsCount: Number(published?.n ?? 0),
      sharedPersonalWorkflowsCount: Number(sharedWorkflows?.n ?? 0),
      sharedPersonalCredentialsCount: Number(sharedCredentials?.n ?? 0),
    };
  }
}
