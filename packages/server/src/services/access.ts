/**
 * Access (P6-03): what a member may do, as scopes (n8n's model, `@workflow/workflow` permissions).
 *
 * Effective scopes on a resource = the member's global scopes, plus, for each project that reaches the
 * resource and that the member has a relation on, the project role's scopes masked by the resource role
 * that project holds (owner: `workflow:owner`, `credential:owner`, ...; sharee: the share's role). Owners
 * and admins are implicit `project:admin` members of every team project. A resource of another
 * workspace, or an id that is not a uuid, is 404 with the name the service uses today.
 *
 * Old roles (`editor`, `viewer`) keep today's rights through `LEGACY_ROLE_SCOPES` until the cutover (L24).
 */
import {
  DATA_TABLE_ERRORS,
  GLOBAL_ROLE_SCOPES,
  GLOBAL_ROLE_SLUGS,
  type GlobalRoleSlug,
  IMPLICIT_TEAM_PROJECT_MEMBER_ROLES,
  isScope,
  MANDATORY_INSTANCE_SCOPES,
  maskScopes,
  type PersonalSpacePolicy,
  PROJECT_ROLE_SCOPES,
  type ProjectRoleSlug,
  personalOwnerScopes,
  RESOURCE_ROLE_SCOPES,
  type ResourceRoleSlug,
  type Scope,
} from '@workflow/workflow';
import type { CredentialRow, LegacyRole, Role } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import { PERSONAL_OWNER_ROLE } from '../repositories/projects';

/** what a scope is checked on; exactly one key */
export type AccessTarget =
  | { projectId: string }
  | { workflowId: string }
  | { credentialId: string }
  | { dataTableId: string }
  | { folderId: string }
  | { executionId: string }
  | { variableId: string }
  | { secretConnectionKey: string };

/**
 * What a list may show for one scope: everything (`all`), or the rows of `projectIds` plus the workflows
 * and credentials shared into the member's projects (and global credentials for credential reads).
 */
export type AccessFilter =
  | { all: true }
  | { all: false; projectIds: string[]; workflowIds: string[]; credentialIds: string[] };

/** n8n's text for a 403 on a missing scope */
export const MISSING_SCOPE_MESSAGE = 'User is missing a scope required to perform this action';

const set = (scopes: readonly Scope[]): ReadonlySet<Scope> => new Set(scopes);

/** the old `viewer`: what today's `requireRole(request, 'viewer')` routes allow (research-C2-routes "today") */
const LEGACY_VIEWER_SCOPES: readonly Scope[] = [
  'annotationTag:list',
  'apiKey:create',
  'credential:list',
  'dataTable:list',
  'dataTable:listProject',
  'dataTable:read',
  'dataTable:readColumn',
  'dataTable:readRow',
  'execution:list',
  'execution:read',
  'folder:list',
  'folder:read',
  'instanceAi:message',
  'mcp:oauth',
  'mcpApiKey:create',
  'mcpApiKey:rotate',
  'project:list',
  'project:read',
  'projectVariable:list',
  'projectVariable:read',
  'tag:list',
  'tag:read',
  'user:list',
  'variable:list',
  'variable:read',
  'workflow:list',
  'workflow:read',
];

/** the old `editor`: the viewer's rights plus today's `requireRole(request, 'editor')` routes */
const LEGACY_EDITOR_SCOPES: readonly Scope[] = [
  ...LEGACY_VIEWER_SCOPES,
  'annotationTag:create',
  'annotationTag:update',
  'annotationTag:delete',
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'dataTable:create',
  'dataTable:update',
  'dataTable:delete',
  'dataTable:writeColumn',
  'dataTable:writeRow',
  'execution:delete',
  'externalSecret:list',
  'folder:create',
  'folder:update',
  'folder:delete',
  'tag:create',
  'tag:update',
  'tag:delete',
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'workflow:execute',
  'workflow:publish',
  'workflow:unpublish',
];

/**
 * Old workspace roles, workspace wide, equal to today's route rules (research-C2-routes "today" and
 * "scope after", row by row). A viewer has no `credential:read`, `workflow:publish` (the review routes
 * open to viewers today still need an editor in the service), `tag:create`, `tag:update` or
 * `annotationTag:*` writes; an editor keeps `tag:delete` and `annotationTag:*`. Both get the new
 * `project:list` and `project:read`; neither gets `project:create`, `role:*`, `:share` or `:move`.
 * L24 removes this map.
 */
export const LEGACY_ROLE_SCOPES: Readonly<Record<LegacyRole, ReadonlySet<Scope>>> = {
  editor: set(LEGACY_EDITOR_SCOPES),
  viewer: set(LEGACY_VIEWER_SCOPES),
};

const NO_SCOPES: ReadonlySet<Scope> = new Set<Scope>();

const DEFAULT_POLICY: PersonalSpacePolicy = { personalSpacePublishing: true, personalSpaceSharing: true };

function isGlobalSystemRole(role: string): role is GlobalRoleSlug {
  return (GLOBAL_ROLE_SLUGS as readonly string[]).includes(role);
}

function isLegacyRole(role: string): role is LegacyRole {
  return role === 'editor' || role === 'viewer';
}

function resourceMask(role: string): ReadonlySet<Scope> {
  return RESOURCE_ROLE_SCOPES[role as ResourceRoleSlug] ?? NO_SCOPES;
}

/** a resource role passes a scope when it holds it; a `<resource>:list` passes on `<resource>:read` */
function maskAllows(mask: ReadonlySet<Scope>, scope: Scope): boolean {
  if (mask.has(scope)) return true;
  const [resource, operation] = scope.split(':');
  return operation === 'list' && mask.has(`${resource}:read` as Scope);
}

/** the per-request cache key of a target */
export function accessTargetKey(target?: AccessTarget): string {
  if (!target) return 'global';
  const [kind, id] = Object.entries(target)[0] as [string, string];
  return `${kind}:${id}`;
}

/** a project that reaches a resource, and the resource role it holds there (null: no mask) */
interface Reach {
  projectId: string;
  mask: ReadonlySet<Scope> | null;
}

interface ResolvedTarget {
  reach: Reach[];
  /** scopes every member gets on the target (a global credential's read) */
  extra: readonly Scope[];
}

/** what a project role grants, read once per call (custom roles and the policy need queries) */
class RoleScopeReader {
  private policy?: Promise<PersonalSpacePolicy>;
  private readonly custom = new Map<string, Promise<ReadonlySet<Scope>>>();

  constructor(
    private readonly repos: Repositories,
    private readonly tenantId: string,
  ) {}

  scopes(slug: string): Promise<ReadonlySet<Scope>> {
    if (slug === PERSONAL_OWNER_ROLE) {
      return this.loadPolicy().then((policy) => personalOwnerScopes(policy));
    }
    const system = PROJECT_ROLE_SCOPES[slug as ProjectRoleSlug];
    if (system) return Promise.resolve(system);
    let cached = this.custom.get(slug);
    if (!cached) {
      cached = this.repos.roles
        .get(this.tenantId, slug)
        .then((row) => (row?.roleType === 'project' ? set(row.scopes.filter(isScope)) : NO_SCOPES));
      this.custom.set(slug, cached);
    }
    return cached;
  }

  private loadPolicy(): Promise<PersonalSpacePolicy> {
    this.policy ??= this.repos.tenants.get(this.tenantId).then((tenant) => {
      const raw = (tenant?.settings as { securityPolicy?: Partial<PersonalSpacePolicy> } | undefined)
        ?.securityPolicy;
      return {
        personalSpacePublishing: raw?.personalSpacePublishing ?? DEFAULT_POLICY.personalSpacePublishing,
        personalSpaceSharing: raw?.personalSpaceSharing ?? DEFAULT_POLICY.personalSpaceSharing,
      };
    });
    return this.policy;
  }
}

/** `AuthContext.scopeCache` (C0c2 adds the field; the cache lives on the request only) */
type CachedAuth = AuthContext & { scopeCache?: Map<string, ReadonlySet<Scope>> };

export class AccessService {
  constructor(private readonly repos: Repositories) {}

  /** the scopes a workspace role gives everywhere in the workspace */
  async globalScopes(tenantId: string, role: Role): Promise<ReadonlySet<Scope>> {
    if (isGlobalSystemRole(role)) return GLOBAL_ROLE_SCOPES[role];
    if (isLegacyRole(role)) return LEGACY_ROLE_SCOPES[role];
    const custom = await this.repos.roles.get(tenantId, role);
    if (custom?.roleType !== 'global') return NO_SCOPES;
    return set([...custom.scopes.filter(isScope), ...MANDATORY_INSTANCE_SCOPES]);
  }

  /**
   * A member's scopes on one target (any member, not only the caller: reviews read another user's). The
   * target is loaded first: another workspace's id or a non-uuid id is 404. A member of no project
   * reaching the target gets the global scopes only.
   */
  async scopesFor(tenantId: string, userId: string, target: AccessTarget): Promise<ReadonlySet<Scope>> {
    const resolved = await this.resolveTarget(tenantId, target);
    const membership = await this.repos.memberships.get(tenantId, userId);
    if (!membership) return NO_SCOPES;
    const global = await this.globalScopes(tenantId, membership.role);
    const out = new Set<Scope>(global);
    for (const scope of resolved.extra) out.add(scope);
    if (!resolved.reach.length) return out;

    const relations = new Map(
      (await this.repos.projects.relations.listForUser(tenantId, userId)).map((r) => [r.projectId, r.role]),
    );
    const implicit = (IMPLICIT_TEAM_PROJECT_MEMBER_ROLES as readonly string[]).includes(membership.role);
    const reader = new RoleScopeReader(this.repos, tenantId);
    const teamCache = new Map<string, Promise<boolean>>();
    const isTeam = (projectId: string) => {
      let cached = teamCache.get(projectId);
      if (!cached) {
        cached = this.repos.projects.get(tenantId, projectId).then((p) => p?.type === 'team');
        teamCache.set(projectId, cached);
      }
      return cached;
    };
    for (const reach of resolved.reach) {
      const roles: string[] = [];
      const own = relations.get(reach.projectId);
      if (own) roles.push(own);
      if (implicit && (await isTeam(reach.projectId))) roles.push('project:admin');
      for (const role of roles) {
        const scopes = await reader.scopes(role);
        for (const scope of reach.mask ? maskScopes(scopes, reach.mask) : scopes) out.add(scope);
      }
    }
    return out;
  }

  /**
   * The caller's scopes, cached on the request (`auth.scopeCache`, one entry per target): what
   * `requireScope` reads. No target = the global scopes.
   */
  async scopesForAuth(auth: AuthContext, target?: AccessTarget): Promise<ReadonlySet<Scope>> {
    const cached = auth as CachedAuth;
    const key = accessTargetKey(target);
    const hit = cached.scopeCache?.get(key);
    if (hit) return hit;
    const scopes = target
      ? await this.scopesFor(auth.tenant.id, auth.user.id, target)
      : await this.globalScopes(auth.tenant.id, auth.role);
    cached.scopeCache ??= new Map();
    cached.scopeCache.set(key, scopes);
    return scopes;
  }

  /**
   * What a list handler may show for `scope`. A global scope gives `{ all: true }`; otherwise the projects
   * whose role (masked by the owner role, for workflow, execution and credential scopes) holds it, the
   * workflows or credentials shared into the member's projects whose share role passes, and, for
   * `credential:list` and `credential:read`, the global credentials.
   */
  async listFilter(auth: AuthContext, scope: Scope): Promise<AccessFilter> {
    const tenantId = auth.tenant.id;
    const global = await this.scopesForAuth(auth);
    if (global.has(scope)) return { all: true };
    const resource = scope.split(':')[0];
    const kind = resource === 'workflow' || resource === 'execution' ? 'workflow' : resource;
    const ownerMask =
      kind === 'workflow'
        ? RESOURCE_ROLE_SCOPES['workflow:owner']
        : kind === 'credential'
          ? RESOURCE_ROLE_SCOPES['credential:owner']
          : null;

    const reader = new RoleScopeReader(this.repos, tenantId);
    const holding: string[] = [];
    for (const relation of await this.repos.projects.relations.listForUser(tenantId, auth.user.id)) {
      if ((await reader.scopes(relation.role)).has(scope)) holding.push(relation.projectId);
    }
    const projectIds = ownerMask && !maskAllows(ownerMask, scope) ? [] : holding;

    const workflowIds: string[] = [];
    const credentialIds: string[] = [];
    if (kind === 'workflow' || kind === 'credential') {
      const shares = await this.repos.shares.sharesInto(tenantId, kind, holding);
      const ids = new Set<string>();
      for (const share of shares) if (maskAllows(resourceMask(share.role), scope)) ids.add(share.resourceId);
      if (kind === 'credential' && (scope === 'credential:list' || scope === 'credential:read')) {
        for (const id of await this.repos.shares.globalCredentialIds(tenantId)) ids.add(id);
      }
      (kind === 'workflow' ? workflowIds : credentialIds).push(...ids);
    }
    return { all: false, projectIds, workflowIds, credentialIds };
  }

  /**
   * Whether a run of a workflow in `projectId` may use the credential: owned by that project, shared with
   * it, global, or named in `allow` (server paths only, never node data or a body). No user is involved.
   */
  async credentialUsable(
    tenantId: string,
    projectId: string,
    row: Pick<CredentialRow, 'id' | 'tenantId' | 'projectId' | 'isGlobal'>,
    allow?: string[],
  ): Promise<boolean> {
    if (row.tenantId !== tenantId) return false;
    if (allow?.includes(row.id)) return true;
    if (row.projectId === projectId || row.isGlobal) return true;
    const shares = await this.repos.shares.credentialSharesFor(tenantId, row.id);
    return shares.some((share) => share.projectId === projectId);
  }

  /**
   * Which of `credentialIds` the member reaches through their own project relations with
   * `credential:read` (owned by or shared into such a project). Global scopes and global credentials do
   * not count, as n8n's `ignoreGlobalUseScope`.
   */
  async credentialUsableBy(tenantId: string, userId: string, credentialIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!credentialIds.length) return out;
    const reader = new RoleScopeReader(this.repos, tenantId);
    const projects = new Set<string>();
    for (const relation of await this.repos.projects.relations.listForUser(tenantId, userId)) {
      if ((await reader.scopes(relation.role)).has('credential:read')) projects.add(relation.projectId);
    }
    if (!projects.size) return out;
    const wanted = new Set(credentialIds);
    for (const row of await this.repos.credentials.listByIds(tenantId, credentialIds)) {
      if (projects.has(row.projectId)) out.add(row.id);
    }
    for (const share of await this.repos.shares.sharesInto(tenantId, 'credential', [...projects])) {
      if (wanted.has(share.resourceId) && resourceMask(share.role).has('credential:read')) {
        out.add(share.resourceId);
      }
    }
    return out;
  }

  /**
   * The project a create goes to: the given id (404 when it is not a project of the workspace), else the
   * default. Until the cutover (L24) the default is the oldest team project; L24 makes it the caller's
   * personal project. This is the one place that changes.
   */
  async targetProject(auth: AuthContext, projectId?: string | null): Promise<string> {
    if (projectId !== undefined && projectId !== null) {
      const project = await this.repos.projects.get(auth.tenant.id, projectId);
      if (!project) throw ApiError.notFound('Project');
      return project.id;
    }
    return this.repos.projects.defaultProjectFor(auth.tenant.id);
  }

  /**
   * The projects where the caller holds `scope`: every project of the workspace with the global scope,
   * else the projects whose relation role holds it (owners and admins: every team project too).
   */
  async accessibleProjectIds(auth: AuthContext, scope: Scope): Promise<string[]> {
    const tenantId = auth.tenant.id;
    const global = await this.scopesForAuth(auth);
    if (global.has(scope)) return (await this.repos.projects.listAll(tenantId)).map((p) => p.id);
    const reader = new RoleScopeReader(this.repos, tenantId);
    const out = new Set<string>();
    for (const relation of await this.repos.projects.relations.listForUser(tenantId, auth.user.id)) {
      if ((await reader.scopes(relation.role)).has(scope)) out.add(relation.projectId);
    }
    if ((IMPLICIT_TEAM_PROJECT_MEMBER_ROLES as readonly string[]).includes(auth.role)) {
      if (PROJECT_ROLE_SCOPES['project:admin'].has(scope)) {
        for (const project of await this.repos.projects.listAll(tenantId)) {
          if (project.type === 'team') out.add(project.id);
        }
      }
    }
    return [...out];
  }

  /** the target's row, the projects that reach it and the masks they hold; 404 when it is not there */
  private async resolveTarget(tenantId: string, target: AccessTarget): Promise<ResolvedTarget> {
    const { repos } = this;
    if ('projectId' in target) {
      const project = await repos.projects.get(tenantId, target.projectId);
      if (!project) throw ApiError.notFound('Project');
      return { reach: [{ projectId: project.id, mask: null }], extra: [] };
    }
    if ('workflowId' in target) {
      const workflow = await repos.workflows.get(tenantId, target.workflowId);
      if (!workflow) throw ApiError.notFound('Workflow');
      return { reach: await this.workflowReach(tenantId, workflow.id, workflow.projectId), extra: [] };
    }
    if ('credentialId' in target) {
      const credential = await repos.credentials.get(tenantId, target.credentialId);
      if (!credential) throw ApiError.notFound('Credential');
      const shares = await repos.shares.credentialSharesFor(tenantId, credential.id);
      return {
        reach: [
          { projectId: credential.projectId, mask: RESOURCE_ROLE_SCOPES['credential:owner'] },
          ...shares.map((share) => ({ projectId: share.projectId, mask: resourceMask(share.role) })),
        ],
        // n8n: a global credential is readable by everyone (check-access.ts, global read-only access)
        extra: credential.isGlobal ? ['credential:read'] : [],
      };
    }
    if ('dataTableId' in target) {
      const table = await repos.dataTables.get(tenantId, target.dataTableId);
      if (!table) {
        throw new ApiError(404, 'not_found', DATA_TABLE_ERRORS.tableIdNotFound(target.dataTableId), {
          description: DATA_TABLE_ERRORS.tableIdNotFoundDescription,
        });
      }
      return { reach: [{ projectId: table.projectId, mask: null }], extra: [] };
    }
    if ('folderId' in target) {
      const folder = await repos.folders.get(tenantId, target.folderId);
      if (!folder) throw ApiError.notFound('Folder');
      return { reach: [{ projectId: folder.projectId, mask: null }], extra: [] };
    }
    if ('executionId' in target) {
      const execution = await repos.executions.get(tenantId, target.executionId);
      if (!execution) throw ApiError.notFound('Execution');
      // a run with no workflow row (no parent) is owner and admin only: global scopes
      if (!execution.workflowId) return { reach: [], extra: [] };
      const workflow = await repos.workflows.get(tenantId, execution.workflowId);
      if (!workflow) return { reach: [], extra: [] };
      return { reach: await this.workflowReach(tenantId, workflow.id, workflow.projectId), extra: [] };
    }
    if ('variableId' in target) {
      const variable = await repos.variables.get(tenantId, target.variableId);
      if (!variable) throw ApiError.notFound('Variable');
      // a workspace variable: global scopes only
      if (!variable.projectId) return { reach: [], extra: [] };
      return { reach: [{ projectId: variable.projectId, mask: null }], extra: [] };
    }
    const connection = await repos.secrets.get(tenantId, target.secretConnectionKey);
    if (!connection) throw ApiError.notFound(`Connection with key "${target.secretConnectionKey}"`);
    const reach: Reach[] = [];
    if (connection.projectId) {
      reach.push({
        projectId: connection.projectId,
        mask: RESOURCE_ROLE_SCOPES['secretsProviderConnection:owner'],
      });
    }
    for (const access of await repos.secrets.accessFor(tenantId, connection.id)) {
      reach.push({ projectId: access.projectId, mask: resourceMask(access.role) });
    }
    return { reach, extra: [] };
  }

  private async workflowReach(tenantId: string, workflowId: string, projectId: string): Promise<Reach[]> {
    const shares = await this.repos.shares.workflowSharesFor(tenantId, workflowId);
    return [
      { projectId, mask: RESOURCE_ROLE_SCOPES['workflow:owner'] },
      ...shares.map((share) => ({ projectId: share.projectId, mask: resourceMask(share.role) })),
    ];
  }
}
