/**
 * P6-11 (L9): role provisioning from the identity provider (n8n's provisioning): manual, workspace roles, or
 * workspace and project roles; by claims or by rules (services/sso/role-rules.ts), exclusive. `resolve` runs
 * at every SSO sign-in before any account is made; a block denies it. A workspace role change goes through
 * `changeMemberRole(..., { source: 'provisioning' })`; a project role change calls
 * `privateCredentials.afterAccessChange` for the person and the project. While a scope is managed, manual
 * role edits are refused (`assertInstanceRolesEditable`, `assertProjectRolesEditable`). The owner is never
 * assigned a role, blocked or changed by it.
 *
 * Config: `tenant_auth_settings.provisioning` holds the fields of `ProvisioningConfig` plus
 * `defaultInstanceRole`, the default condition: a global role slug, `block` (deny access), or null (a person
 * no claim or rule matches keeps the role they have; a new person is a `member`).
 */
import {
  ASSIGNABLE_PROJECT_ROLE_SLUGS,
  type DataObject,
  GLOBAL_ROLE_SLUGS,
  IMPLICIT_TEAM_PROJECT_MEMBER_ROLES,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { Role, TenantRow, UserRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { createRepositories } from '../../repositories';
import { PERSONAL_OWNER_ROLE } from '../../repositories/projects';
import type { RoleMappingRuleRecord } from '../../repositories/role-mapping';
import { isUuid, pgErrorCode } from '../../repositories/util';
import { changeMemberRole } from '../member-disable';
import { RULE_EXPRESSION_MAX_LENGTH, ruleExpressionProblem, ruleMatches } from './role-rules';

/** what the provider's claims give a person at sign-in; undefined fields change nothing */
export interface ProvisioningDecision {
  /** true: the sign-in is refused before any account is made (the default condition "block") */
  blocked: boolean;
  /** the workspace role slug to set (never `owner`) */
  instanceRole?: string;
  /** project id to project role slug; replaces the person's project roles when given */
  projectRoles?: Record<string, string>;
}

/** what blocks deleting a custom role: the rules that assign it */
export interface RuleBlocker {
  id: string;
  type: 'instance' | 'project';
  expression: string;
}

/** the default condition that denies access (not a role slug: custom slugs hold a `global:` prefix) */
export const BLOCK_ACCESS = 'block';
/** the id `ruleBlockers` gives the default condition */
export const DEFAULT_CONDITION_ID = 'default';

/** a role mapping rule as the routes answer it */
export interface RoleMappingRuleDTO {
  id: string;
  type: 'instance' | 'project';
  expression: string;
  role: string;
  order: number;
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningConfigDTO {
  scopesProvisionInstanceRole: boolean;
  scopesProvisionProjectRoles: boolean;
  scopesUseExpressionMapping: boolean;
  scopesName: string;
  scopesInstanceRoleClaimName: string;
  scopesProjectsRolesClaimName: string;
  /** a global role slug, `block`, or null */
  defaultInstanceRole: string | null;
}

const DEFAULT_CONFIG: ProvisioningConfigDTO = {
  scopesProvisionInstanceRole: false,
  scopesProvisionProjectRoles: false,
  scopesUseExpressionMapping: false,
  scopesName: 'workflow',
  scopesInstanceRoleClaimName: 'instance_role',
  scopesProjectsRolesClaimName: 'projects',
  defaultInstanceRole: null,
};

const claimName = z.string().trim().min(1).max(256);
const configPatch = z
  .object({
    scopesProvisionInstanceRole: z.boolean(),
    scopesProvisionProjectRoles: z.boolean(),
    scopesUseExpressionMapping: z.boolean(),
    scopesName: z.string().trim().min(1).max(128).regex(/^\S+$/, 'A scope name has no spaces'),
    scopesInstanceRoleClaimName: claimName,
    scopesProjectsRolesClaimName: claimName,
    defaultInstanceRole: z.string().trim().min(1).max(128).nullable(),
  })
  .partial();

const RULE_ROLE_MAX = 128;
const MAX_PROJECT_CLAIMS = 500;

function managedMessage(what: string): string {
  return `${what} come from your identity provider. Change them there, or turn provisioning off first.`;
}

const dto = (rule: RoleMappingRuleRecord): RoleMappingRuleDTO => ({
  id: rule.id,
  type: rule.type,
  expression: rule.expression,
  role: rule.role,
  order: rule.order,
  projectIds: rule.projectIds,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
});

/** a claim as a list of strings: an array, or one string split at commas and white space */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export class ProvisioningService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  /** the stored config with the defaults filled in */
  private async readConfig(tenantId: string): Promise<ProvisioningConfigDTO> {
    const row = await this.repos.sso.get(tenantId);
    const stored = (row?.provisioning ?? {}) as Record<string, unknown>;
    const pick = <K extends keyof ProvisioningConfigDTO>(key: K): ProvisioningConfigDTO[K] => {
      const value = stored[key];
      return typeof value === typeof DEFAULT_CONFIG[key] && value !== undefined
        ? (value as ProvisioningConfigDTO[K])
        : DEFAULT_CONFIG[key];
    };
    const named = (key: 'scopesName' | 'scopesInstanceRoleClaimName' | 'scopesProjectsRolesClaimName') => {
      const value = pick(key);
      return value.trim() ? value : DEFAULT_CONFIG[key];
    };
    const def = stored.defaultInstanceRole;
    return {
      scopesProvisionInstanceRole: pick('scopesProvisionInstanceRole'),
      scopesProvisionProjectRoles: pick('scopesProvisionInstanceRole') && pick('scopesProvisionProjectRoles'),
      scopesUseExpressionMapping: pick('scopesUseExpressionMapping'),
      scopesName: named('scopesName'),
      scopesInstanceRoleClaimName: named('scopesInstanceRoleClaimName'),
      scopesProjectsRolesClaimName: named('scopesProjectsRolesClaimName'),
      defaultInstanceRole: typeof def === 'string' && def ? def : null,
    };
  }

  /** a workspace role the provider may give: `admin`, `member` or a custom global role; never `owner` */
  private async instanceRoleValid(tenantId: string, slug: string): Promise<boolean> {
    if (!slug || slug.length > RULE_ROLE_MAX || slug === 'owner') return false;
    if ((GLOBAL_ROLE_SLUGS as readonly string[]).includes(slug)) return true;
    return (await this.repos.roles.get(tenantId, slug))?.roleType === 'global';
  }

  /** a project role the provider may give: an assignable system role or a custom project role */
  private async projectRoleValid(tenantId: string, slug: string): Promise<boolean> {
    if (!slug || slug.length > RULE_ROLE_MAX || slug === PERSONAL_OWNER_ROLE) return false;
    if ((ASSIGNABLE_PROJECT_ROLE_SLUGS as readonly string[]).includes(slug)) return true;
    return (await this.repos.roles.get(tenantId, slug))?.roleType === 'project';
  }

  private async teamProject(tenantId: string, projectId: string): Promise<boolean> {
    if (!isUuid(projectId)) return false;
    return (await this.repos.projects.get(tenantId, projectId))?.type === 'team';
  }

  /** the workspace role for these claims, undefined when no claim or rule gives one */
  private async instanceRoleFor(
    tenantId: string,
    config: ProvisioningConfigDTO,
    claims: DataObject,
  ): Promise<string | undefined> {
    if (config.scopesUseExpressionMapping) {
      for (const rule of await this.repos.roleMapping.list(tenantId, 'instance')) {
        if (ruleMatches(rule.expression, claims) && (await this.instanceRoleValid(tenantId, rule.role))) {
          return rule.role;
        }
      }
      return undefined;
    }
    const claim = claims[config.scopesInstanceRoleClaimName];
    const slug =
      typeof claim === 'string' ? claim.trim() : Array.isArray(claim) ? String(claim[0] ?? '').trim() : '';
    if (slug && (await this.instanceRoleValid(tenantId, slug))) return slug;
    // an unknown role, an owner claim or no claim: the default condition decides (the value stays out of the log)
    this.deps.logger.warn({ tenantId }, 'The identity provider gave no usable workspace role');
    return undefined;
  }

  /** project id to role for these claims (claim mode: the last entry of a project wins; rules: the first match) */
  private async projectRolesFor(
    tenantId: string,
    config: ProvisioningConfigDTO,
    claims: DataObject,
  ): Promise<Record<string, string>> {
    const wanted = new Map<string, string>();
    if (config.scopesUseExpressionMapping) {
      for (const rule of await this.repos.roleMapping.list(tenantId, 'project')) {
        if (!ruleMatches(rule.expression, claims)) continue;
        if (!(await this.projectRoleValid(tenantId, rule.role))) continue;
        for (const projectId of rule.projectIds) if (!wanted.has(projectId)) wanted.set(projectId, rule.role);
      }
    } else {
      for (const entry of stringList(claims[config.scopesProjectsRolesClaimName]).slice(
        0,
        MAX_PROJECT_CLAIMS,
      )) {
        // `projectId:role`; a project id holds no colon, a role slug may (`project:editor`)
        const cut = entry.indexOf(':');
        if (cut <= 0) continue;
        const projectId = entry.slice(0, cut).toLowerCase();
        let role = entry.slice(cut + 1);
        if (!role.includes(':')) role = `project:${role}`;
        if (!(await this.projectRoleValid(tenantId, role))) continue;
        wanted.set(projectId, role);
      }
    }
    const out: Record<string, string> = {};
    for (const [projectId, role] of wanted) {
      if (await this.teamProject(tenantId, projectId)) out[projectId] = role;
    }
    return out;
  }

  /**
   * What the claims give this person. Runs before any account or link is written. The owner is never changed
   * or blocked. The default condition decides when no claim or rule gives a workspace role.
   */
  async resolve(tenant: TenantRow, claims: DataObject, user?: UserRow | null): Promise<ProvisioningDecision> {
    const config = await this.readConfig(tenant.id);
    if (!config.scopesProvisionInstanceRole && !config.scopesProvisionProjectRoles) return { blocked: false };
    const membership = user
      ? await this.repos.memberships.getIncludingDisabled(tenant.id, user.id)
      : undefined;
    if (membership?.role === 'owner') return { blocked: false };

    const decision: ProvisioningDecision = { blocked: false };
    if (config.scopesProvisionInstanceRole) {
      const role = await this.instanceRoleFor(tenant.id, config, claims);
      if (role) {
        decision.instanceRole = role;
      } else if (config.defaultInstanceRole === BLOCK_ACCESS) {
        return { blocked: true };
      } else if (
        config.defaultInstanceRole &&
        (await this.instanceRoleValid(tenant.id, config.defaultInstanceRole))
      ) {
        decision.instanceRole = config.defaultInstanceRole;
      }
    }
    if (config.scopesProvisionProjectRoles) {
      decision.projectRoles = await this.projectRolesFor(tenant.id, config, claims);
    }
    return decision;
  }

  /** applies a decision to a member (after `resolve`, inside the sign-in) */
  async apply(tenantId: string, userId: string, decision: ProvisioningDecision): Promise<void> {
    if (decision.blocked) return;
    const ctx = this.deps.context();
    let membership = await this.repos.memberships.getIncludingDisabled(tenantId, userId);
    // the owner never changes
    if (!membership || membership.role === 'owner') return;

    if (decision.instanceRole !== undefined && decision.instanceRole !== membership.role) {
      if (!(await this.instanceRoleValid(tenantId, decision.instanceRole))) return;
      await changeMemberRole(ctx, tenantId, userId, decision.instanceRole as Role, {
        source: 'provisioning',
      });
      membership = (await this.repos.memberships.getIncludingDisabled(tenantId, userId)) ?? membership;
    }

    const wanted = decision.projectRoles;
    // owners and admins already reach every team project
    if (!wanted || (IMPLICIT_TEAM_PROJECT_MEMBER_ROLES as readonly string[]).includes(membership.role))
      return;
    const changed = new Set<string>();
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const current = (await repos.projects.relations.listForUser(tenantId, userId)).filter(
        (relation) => relation.role !== PERSONAL_OWNER_ROLE,
      );
      const byProject = new Map(current.map((relation) => [relation.projectId, relation.role]));
      for (const [projectId, role] of Object.entries(wanted)) {
        if (!(await this.teamProject(tenantId, projectId))) continue;
        const before = byProject.get(projectId);
        if (before === role) continue;
        if (before === undefined) await repos.projects.relations.add(tenantId, projectId, userId, role);
        else await repos.projects.relations.updateRole(tenantId, projectId, userId, role);
        changed.add(projectId);
        await repos.audit.add(tenantId, {
          userId: null,
          action: before === undefined ? 'project.member.added' : 'project.member.role_changed',
          resourceType: 'project',
          resourceId: projectId,
          metadata: { projectId, userId, role, ...(before ? { from: before } : {}), source: 'provisioning' },
        });
      }
      for (const [projectId, role] of byProject) {
        if (projectId in wanted) continue;
        await repos.projects.relations.remove(tenantId, projectId, userId);
        changed.add(projectId);
        await repos.audit.add(tenantId, {
          userId: null,
          action: 'project.member.removed',
          resourceType: 'project',
          resourceId: projectId,
          metadata: { projectId, userId, role, source: 'provisioning' },
        });
      }
    });
    // a lowered or removed project role takes the person's private credential entries with it
    for (const projectId of changed)
      await ctx.privateCredentials.afterAccessChange(tenantId, { userId, projectId });
  }

  /** refused while workspace roles come from the provider */
  async assertInstanceRolesEditable(tenantId: string): Promise<void> {
    if (await this.managed(tenantId, 'scopesProvisionInstanceRole')) {
      throw new ApiError(400, 'roles_managed_by_sso', managedMessage('Workspace roles'));
    }
  }

  /** refused while project roles come from the provider */
  async assertProjectRolesEditable(tenantId: string): Promise<void> {
    if (await this.managed(tenantId, 'scopesProvisionProjectRoles')) {
      throw new ApiError(400, 'roles_managed_by_sso', managedMessage('Project roles'));
    }
  }

  /** a scope is managed while its flag is on and the workspace signs in with a provider (not email) */
  private async managed(
    tenantId: string,
    flag: 'scopesProvisionInstanceRole' | 'scopesProvisionProjectRoles',
  ): Promise<boolean> {
    const row = await this.repos.sso.get(tenantId);
    if (!row || row.method === 'email') return false;
    return (await this.readConfig(tenantId))[flag];
  }

  /** the rules that assign the role `slug` (services/roles.ts `delete` names them in its 409) */
  async ruleBlockers(tenantId: string, slug: string): Promise<RuleBlocker[]> {
    const blockers: RuleBlocker[] = (await this.repos.roleMapping.listByRole(tenantId, slug)).map((rule) => ({
      id: rule.id,
      type: rule.type,
      expression: rule.expression,
    }));
    if ((await this.readConfig(tenantId)).defaultInstanceRole === slug) {
      blockers.push({ id: DEFAULT_CONDITION_ID, type: 'instance', expression: 'default condition' });
    }
    return blockers;
  }

  /** GET /rest/sso/provisioning/config */
  async getConfig(tenantId: string): Promise<DataObject> {
    return { ...(await this.readConfig(tenantId)) };
  }

  /** PATCH /rest/sso/provisioning/config; audit `provisioning.updated` */
  async saveConfig(tenantId: string, input: DataObject, actorId: string | null): Promise<DataObject> {
    const parsed = configPatch.safeParse(input ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest(parsed.error.issues[0]?.message || 'The provisioning settings are not valid');
    }
    const patch = parsed.data;
    const before = await this.readConfig(tenantId);
    const next: ProvisioningConfigDTO = { ...before, ...patch } as ProvisioningConfigDTO;
    if (patch.scopesProvisionInstanceRole === false && patch.scopesProvisionProjectRoles === undefined) {
      // project roles ride on workspace roles
      next.scopesProvisionProjectRoles = false;
    }
    if (next.scopesProvisionProjectRoles && !next.scopesProvisionInstanceRole) {
      throw ApiError.badRequest('Project roles need workspace roles to come from the identity provider too.');
    }
    if (next.defaultInstanceRole !== null && next.defaultInstanceRole !== BLOCK_ACCESS) {
      if (!(await this.instanceRoleValid(tenantId, next.defaultInstanceRole))) {
        throw ApiError.badRequest('The default role must be a workspace role other than owner, or block.');
      }
    }
    let deletedRules = 0;
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.sso.upsert(tenantId, { provisioning: { ...next } });
      // project management turned off: the project rules go with it
      if (before.scopesProvisionProjectRoles && !next.scopesProvisionProjectRoles) {
        deletedRules = await repos.roleMapping.deleteByType(tenantId, 'project');
      }
      await repos.audit.add(tenantId, {
        userId: actorId,
        action: 'provisioning.updated',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: {
          fields: Object.keys(patch),
          instanceRoles: next.scopesProvisionInstanceRole,
          projectRoles: next.scopesProvisionProjectRoles,
          mapping: next.scopesUseExpressionMapping ? 'rules' : 'claims',
          ...(deletedRules ? { projectRulesDeleted: deletedRules } : {}),
        },
      });
    });
    return { ...next };
  }

  // ---- role mapping rules ----

  async listRules(tenantId: string, type?: 'instance' | 'project'): Promise<RoleMappingRuleDTO[]> {
    return (await this.repos.roleMapping.list(tenantId, type)).map(dto);
  }

  async getRule(tenantId: string, id: string): Promise<RoleMappingRuleDTO> {
    const rule = await this.repos.roleMapping.get(tenantId, id);
    if (!rule) throw ApiError.notFound('Role mapping rule');
    return dto(rule);
  }

  private assertExpression(expression: string): void {
    if (expression.length > RULE_EXPRESSION_MAX_LENGTH) {
      throw ApiError.badRequest(`An expression holds at most ${RULE_EXPRESSION_MAX_LENGTH} characters.`);
    }
    const problem = ruleExpressionProblem(expression);
    if (problem) throw ApiError.badRequest(`The expression doesn't work: ${problem}`);
  }

  private async assertRole(tenantId: string, type: 'instance' | 'project', role: string): Promise<void> {
    const ok =
      type === 'instance'
        ? await this.instanceRoleValid(tenantId, role)
        : await this.projectRoleValid(tenantId, role);
    if (!ok) {
      throw ApiError.badRequest(
        type === 'instance'
          ? `"${role}" is not a workspace role a rule may give (owner never is).`
          : `"${role}" is not a project role a rule may give.`,
      );
    }
  }

  private async assertProjects(tenantId: string, projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) throw ApiError.badRequest('A project rule names at least one project.');
    for (const projectId of projectIds) {
      // another workspace's project, a personal project and a missing one are all "not found"
      if (!(await this.teamProject(tenantId, projectId))) throw ApiError.notFound('Project');
    }
  }

  async createRule(
    tenantId: string,
    actorId: string | null,
    input: { type: 'instance' | 'project'; expression: string; role: string; projectIds?: string[] },
  ): Promise<RoleMappingRuleDTO> {
    this.assertExpression(input.expression);
    await this.assertRole(tenantId, input.type, input.role);
    if (input.type === 'project') await this.assertProjects(tenantId, input.projectIds ?? []);
    else if (input.projectIds?.length) throw ApiError.badRequest('A workspace rule has no projects.');
    try {
      const rule = await this.repos.roleMapping.create(tenantId, {
        type: input.type,
        expression: input.expression,
        role: input.role,
        projectIds: input.type === 'project' ? input.projectIds : undefined,
      });
      await this.auditRule(tenantId, actorId, 'created', rule);
      return dto(rule);
    } catch (error) {
      if (pgErrorCode(error) === '23503') throw ApiError.notFound('Project');
      throw error;
    }
  }

  async updateRule(
    tenantId: string,
    actorId: string | null,
    id: string,
    patch: { type?: 'instance' | 'project'; expression?: string; role?: string; projectIds?: string[] },
  ): Promise<RoleMappingRuleDTO> {
    const existing = await this.repos.roleMapping.get(tenantId, id);
    if (!existing) throw ApiError.notFound('Role mapping rule');
    if (patch.type !== undefined && patch.type !== existing.type) {
      throw ApiError.badRequest("A rule's type can't change. Create a new rule instead.");
    }
    if (patch.expression !== undefined) this.assertExpression(patch.expression);
    if (patch.role !== undefined) await this.assertRole(tenantId, existing.type, patch.role);
    if (patch.projectIds !== undefined) {
      if (existing.type === 'instance') {
        if (patch.projectIds.length) throw ApiError.badRequest('A workspace rule has no projects.');
      } else {
        await this.assertProjects(tenantId, patch.projectIds);
      }
    }
    try {
      const rule = await this.repos.roleMapping.update(tenantId, id, {
        expression: patch.expression,
        role: patch.role,
        projectIds: existing.type === 'project' ? patch.projectIds : undefined,
      });
      if (!rule) throw ApiError.notFound('Role mapping rule');
      await this.auditRule(tenantId, actorId, 'updated', rule);
      return dto(rule);
    } catch (error) {
      if (pgErrorCode(error) === '23503') throw ApiError.notFound('Project');
      throw error;
    }
  }

  /** moves a rule to the 0-based `position` among the rules of its type; the rules of that type, in order */
  async moveRule(
    tenantId: string,
    actorId: string | null,
    id: string,
    position: number,
  ): Promise<RoleMappingRuleDTO[]> {
    const rule = await this.repos.roleMapping.move(tenantId, id, position);
    if (!rule) throw ApiError.notFound('Role mapping rule');
    await this.auditRule(tenantId, actorId, 'moved', rule);
    return this.listRules(tenantId, rule.type);
  }

  async deleteRule(tenantId: string, actorId: string | null, id: string): Promise<void> {
    const rule = await this.repos.roleMapping.get(tenantId, id);
    if (!rule || !(await this.repos.roleMapping.delete(tenantId, id))) {
      throw ApiError.notFound('Role mapping rule');
    }
    await this.auditRule(tenantId, actorId, 'deleted', rule);
  }

  private async auditRule(
    tenantId: string,
    actorId: string | null,
    change: string,
    rule: RoleMappingRuleRecord,
  ): Promise<void> {
    await this.repos.audit.add(tenantId, {
      userId: actorId,
      action: 'provisioning.updated',
      resourceType: 'role_mapping_rule',
      resourceId: rule.id,
      metadata: { rule: change, type: rule.type, role: rule.role, order: rule.order },
    });
  }
}
