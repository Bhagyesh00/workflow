/**
 * What each system role may do, as scope sets. System roles live in code; custom roles live in the
 * `roles` table and carry their own scope lists.
 *
 * Three levels, as n8n's: a global role (the workspace membership: owner, admin, member), a project
 * role (a user's relation to a project) and a resource role (how a workflow, credential or vault
 * connection belongs to a project: owned or shared). A project role that reaches a resource is cut
 * down by the resource role with `maskScopes`.
 *
 * This module runs in the editor too: no Node API here.
 */
import type { Scope } from './scopes';

/** Global role slugs held in `memberships.role`. */
export const GLOBAL_ROLE_SLUGS = ['owner', 'admin', 'member'] as const;
export type GlobalRoleSlug = (typeof GLOBAL_ROLE_SLUGS)[number];

/** Project role slugs held in a project relation. `project:personalOwner` is never assigned by hand. */
export const PROJECT_ROLE_SLUGS = [
  'project:admin',
  'project:editor',
  'project:viewer',
  'project:personalOwner',
] as const;
export type ProjectRoleSlug = (typeof PROJECT_ROLE_SLUGS)[number];

/** Project roles a user can be given on a team project (the personal owner role is implicit). */
export const ASSIGNABLE_PROJECT_ROLE_SLUGS = ['project:admin', 'project:editor', 'project:viewer'] as const;
export type AssignableProjectRoleSlug = (typeof ASSIGNABLE_PROJECT_ROLE_SLUGS)[number];

/** Resource role slugs: how a workflow, credential or vault connection belongs to a project. */
export const RESOURCE_ROLE_SLUGS = [
  'workflow:owner',
  'workflow:editor',
  'credential:owner',
  'credential:user',
  'secretsProviderConnection:owner',
  'secretsProviderConnection:user',
] as const;
export type ResourceRoleSlug = (typeof RESOURCE_ROLE_SLUGS)[number];

/** Every role that lives in code. A custom role can never take one of these slugs, nor be edited as one. */
export const SYSTEM_ROLE_SLUGS: readonly (GlobalRoleSlug | ProjectRoleSlug)[] = [
  ...GLOBAL_ROLE_SLUGS,
  ...PROJECT_ROLE_SLUGS,
];

const SYSTEM_SLUG_SET: ReadonlySet<string> = new Set(SYSTEM_ROLE_SLUGS);

/** True when `slug` names a role that lives in code. */
export function isSystemRoleSlug(slug: string): slug is GlobalRoleSlug | ProjectRoleSlug {
  return SYSTEM_SLUG_SET.has(slug);
}

/** Global roles that make a user an implicit admin of every team project in the workspace. */
export const IMPLICIT_TEAM_PROJECT_MEMBER_ROLES: readonly GlobalRoleSlug[] = ['owner', 'admin'];

const set = (scopes: readonly Scope[]): ReadonlySet<Scope> => new Set(scopes);

const OWNER_SCOPES: readonly Scope[] = [
  'aiAssistant:manage',
  'annotationTag:create',
  'annotationTag:read',
  'annotationTag:update',
  'annotationTag:delete',
  'annotationTag:list',
  'apiKey:manage',
  'apiKey:create',
  'apiKey:update',
  'auditLogs:manage',
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'credential:list',
  'credential:share',
  'credential:unshare',
  'credential:shareGlobally',
  'credential:move',
  'credential:connect',
  'credential:createEndUser',
  'credentialTypePolicy:manage',
  'dataTable:create',
  'dataTable:read',
  'dataTable:update',
  'dataTable:delete',
  'dataTable:list',
  'dataTable:listProject',
  'dataTable:readRow',
  'dataTable:writeRow',
  'dataTable:readColumn',
  'dataTable:writeColumn',
  'eventBusDestination:create',
  'eventBusDestination:read',
  'eventBusDestination:update',
  'eventBusDestination:delete',
  'eventBusDestination:list',
  'eventBusDestination:test',
  'execution:read',
  'execution:list',
  'execution:delete',
  'execution:reveal',
  'externalSecret:list',
  'externalSecretsProvider:create',
  'externalSecretsProvider:read',
  'externalSecretsProvider:update',
  'externalSecretsProvider:delete',
  'externalSecretsProvider:list',
  'externalSecretsProvider:sync',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:list',
  'folder:move',
  'insights:list',
  'insights:read',
  'instanceAi:message',
  'instanceAi:manage',
  'ldap:manage',
  'ldap:sync',
  'logStreaming:manage',
  'mcp:manage',
  'mcp:oauth',
  'mcpApiKey:create',
  'mcpApiKey:rotate',
  'nodeTypePolicy:manage',
  'oidc:manage',
  'otel:manage',
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'project:list',
  'project:manageMembers',
  'projectVariable:create',
  'projectVariable:read',
  'projectVariable:update',
  'projectVariable:delete',
  'projectVariable:list',
  'provisioning:manage',
  'role:manage',
  'role:read',
  'role:list',
  'roleMappingRule:create',
  'roleMappingRule:read',
  'roleMappingRule:update',
  'roleMappingRule:delete',
  'roleMappingRule:list',
  'saml:manage',
  'scim:manage',
  'securityAudit:generate',
  'securitySettings:manage',
  'sourceControl:pull',
  'sourceControl:push',
  'sourceControl:manage',
  'sourceControl:read',
  'tag:create',
  'tag:read',
  'tag:update',
  'tag:delete',
  'tag:list',
  'user:create',
  'user:read',
  'user:update',
  'user:delete',
  'user:list',
  'user:resetPassword',
  'user:changeRole',
  'user:enforceMfa',
  'user:generateInviteLink',
  'variable:create',
  'variable:read',
  'variable:update',
  'variable:delete',
  'variable:list',
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:list',
  'workflow:execute',
  'workflow:share',
  'workflow:unshare',
  'workflow:move',
  'workflow:publish',
  'workflow:unpublish',
  'workflow:enableRedaction',
  'workflow:disableRedaction',
];

/**
 * A workspace member: tags, annotation tags, the user list, global variables read, the data table
 * list, MCP and API key use, and the Assistant. No project, workflow or credential rights of its
 * own: those come from project relations. Unlike n8n, no `eventBusDestination:list` or `:test`
 * (Q-F9: destinations show where audit data goes).
 */
const MEMBER_SCOPES: readonly Scope[] = [
  'annotationTag:create',
  'annotationTag:read',
  'annotationTag:update',
  'annotationTag:delete',
  'annotationTag:list',
  'apiKey:create',
  'apiKey:update',
  'dataTable:list',
  'instanceAi:message',
  'mcp:oauth',
  'mcpApiKey:create',
  'mcpApiKey:rotate',
  'tag:create',
  'tag:read',
  'tag:update',
  'tag:list',
  'user:list',
  'variable:read',
  'variable:list',
];

/** Global role to scopes. Owner and admin hold the same scopes; only owner rules on the slug differ. */
export const GLOBAL_ROLE_SCOPES: Readonly<Record<GlobalRoleSlug, ReadonlySet<Scope>>> = {
  owner: set(OWNER_SCOPES),
  admin: set(OWNER_SCOPES),
  member: set(MEMBER_SCOPES),
};

const PROJECT_ADMIN_SCOPES: readonly Scope[] = [
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'credential:list',
  'credential:share',
  'credential:unshare',
  'credential:move',
  'credential:connect',
  'credential:createEndUser',
  'credentialTypePolicy:manage',
  'dataTable:create',
  'dataTable:read',
  'dataTable:update',
  'dataTable:delete',
  'dataTable:listProject',
  'dataTable:readRow',
  'dataTable:writeRow',
  'dataTable:readColumn',
  'dataTable:writeColumn',
  'execution:read',
  'execution:list',
  'execution:delete',
  'execution:reveal',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:list',
  'folder:move',
  'nodeTypePolicy:manage',
  'project:read',
  'project:update',
  'project:delete',
  'project:list',
  'project:manageMembers',
  'projectVariable:create',
  'projectVariable:read',
  'projectVariable:update',
  'projectVariable:delete',
  'projectVariable:list',
  'sourceControl:push',
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:list',
  'workflow:execute',
  'workflow:move',
  'workflow:publish',
  'workflow:unpublish',
  'workflow:enableRedaction',
  'workflow:disableRedaction',
];

/**
 * The owner of a personal project. Differs from a team project admin: no rename, delete or
 * members, no project variables, and `workflow:publish`, `workflow:share` and `credential:share`
 * only through `personalOwnerScopes` when the workspace policy allows them.
 */
const PERSONAL_OWNER_SCOPES: readonly Scope[] = [
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'credential:list',
  'credential:unshare',
  'credential:move',
  'credential:connect',
  'credential:createEndUser',
  'dataTable:create',
  'dataTable:read',
  'dataTable:update',
  'dataTable:delete',
  'dataTable:listProject',
  'dataTable:readRow',
  'dataTable:writeRow',
  'dataTable:readColumn',
  'dataTable:writeColumn',
  'execution:read',
  'execution:list',
  'execution:delete',
  'execution:reveal',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:list',
  'folder:move',
  'project:read',
  'project:list',
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:list',
  'workflow:execute',
  'workflow:unshare',
  'workflow:move',
  'workflow:unpublish',
  'workflow:enableRedaction',
  'workflow:disableRedaction',
];

const PROJECT_EDITOR_SCOPES: readonly Scope[] = [
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'credential:list',
  'credential:connect',
  'dataTable:create',
  'dataTable:read',
  'dataTable:update',
  'dataTable:delete',
  'dataTable:listProject',
  'dataTable:readRow',
  'dataTable:writeRow',
  'dataTable:readColumn',
  'dataTable:writeColumn',
  'execution:read',
  'execution:list',
  'execution:delete',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:list',
  'project:read',
  'project:list',
  'projectVariable:create',
  'projectVariable:read',
  'projectVariable:update',
  'projectVariable:delete',
  'projectVariable:list',
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:list',
  'workflow:execute',
  'workflow:publish',
  'workflow:unpublish',
];

const PROJECT_VIEWER_SCOPES: readonly Scope[] = [
  'credential:read',
  'credential:list',
  'dataTable:read',
  'dataTable:listProject',
  'dataTable:readRow',
  'dataTable:readColumn',
  'execution:read',
  'execution:list',
  'folder:read',
  'folder:list',
  'project:read',
  'project:list',
  'projectVariable:read',
  'projectVariable:list',
  'workflow:read',
  'workflow:list',
];

/** Project role to scopes. `project:personalOwner` here is the base, before the workspace policy. */
export const PROJECT_ROLE_SCOPES: Readonly<Record<ProjectRoleSlug, ReadonlySet<Scope>>> = {
  'project:admin': set(PROJECT_ADMIN_SCOPES),
  'project:editor': set(PROJECT_EDITOR_SCOPES),
  'project:viewer': set(PROJECT_VIEWER_SCOPES),
  'project:personalOwner': set(PERSONAL_OWNER_SCOPES),
};

/** Resource role to the mask it puts on a project role that reaches the resource. */
export const RESOURCE_ROLE_SCOPES: Readonly<Record<ResourceRoleSlug, ReadonlySet<Scope>>> = {
  'workflow:owner': set([
    'workflow:read',
    'workflow:update',
    'workflow:delete',
    'workflow:execute',
    'workflow:share',
    'workflow:unshare',
    'workflow:move',
    'workflow:publish',
    'workflow:unpublish',
    'workflow:enableRedaction',
    'workflow:disableRedaction',
    'execution:read',
    'execution:list',
    'execution:delete',
    'execution:reveal',
  ]),
  'workflow:editor': set([
    'workflow:read',
    'workflow:update',
    'workflow:execute',
    'workflow:publish',
    'workflow:unpublish',
    'execution:read',
    'execution:list',
    'execution:delete',
  ]),
  'credential:owner': set([
    'credential:read',
    'credential:update',
    'credential:delete',
    'credential:share',
    'credential:unshare',
    'credential:move',
    'credential:connect',
    'credential:createEndUser',
  ]),
  'credential:user': set(['credential:read', 'credential:connect']),
  'secretsProviderConnection:owner': set([
    'externalSecretsProvider:read',
    'externalSecretsProvider:update',
    'externalSecretsProvider:delete',
    'externalSecretsProvider:list',
    'externalSecretsProvider:sync',
    'externalSecret:list',
  ]),
  'secretsProviderConnection:user': set([
    'externalSecretsProvider:read',
    'externalSecretsProvider:list',
    'externalSecret:list',
  ]),
};

/** The workspace security policy flags that widen what a personal project owner may do. */
export interface PersonalSpacePolicy {
  /** a personal project owner may publish workflows */
  personalSpacePublishing: boolean;
  /** a personal project owner may share workflows and credentials */
  personalSpaceSharing: boolean;
}

/** The scopes `personalSpacePublishing` adds to a personal project owner. */
export const PERSONAL_SPACE_PUBLISHING_SCOPES: readonly Scope[] = ['workflow:publish'];
/** The scopes `personalSpaceSharing` adds to a personal project owner. */
export const PERSONAL_SPACE_SHARING_SCOPES: readonly Scope[] = ['workflow:share', 'credential:share'];

/** A personal project owner's scopes under the workspace policy, as a new set. */
export function personalOwnerScopes(policy: PersonalSpacePolicy): ReadonlySet<Scope> {
  const out = new Set(PERSONAL_OWNER_SCOPES);
  if (policy.personalSpacePublishing) for (const scope of PERSONAL_SPACE_PUBLISHING_SCOPES) out.add(scope);
  if (policy.personalSpaceSharing) for (const scope of PERSONAL_SPACE_SHARING_SCOPES) out.add(scope);
  return out;
}

/**
 * What the `externalSecrets.systemRolesEnabled` switch adds to the system project roles: a project
 * admin manages the project's vault connections, a project editor reads them.
 */
export const EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES: Readonly<
  Record<'project:admin' | 'project:editor', ReadonlySet<Scope>>
> = {
  'project:admin': set([
    'externalSecretsProvider:create',
    'externalSecretsProvider:read',
    'externalSecretsProvider:update',
    'externalSecretsProvider:delete',
    'externalSecretsProvider:list',
    'externalSecretsProvider:sync',
    'externalSecret:list',
  ]),
  'project:editor': set([
    'externalSecretsProvider:read',
    'externalSecretsProvider:list',
    'externalSecret:list',
  ]),
};
