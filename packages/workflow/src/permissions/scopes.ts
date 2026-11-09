/**
 * The permission scope catalog: every `resource:operation` name any Phase 6 stage gates on.
 *
 * Names follow n8n's permission catalog (pinned sha 3895cb31) so roles, API key scopes and route
 * gates read the same as n8n's, less the names this product leaves out (decisions.md:103): agents,
 * chat hub, skills, AI preferences, apps, promotions, community packages, orchestration and worker
 * views, licence, encryption key, banners, breaking changes, credential resolvers, trusted sources,
 * `credential:manageInstance`, `credential:use`, `instanceAi:gateway`, `project:export`,
 * `workflow:export`, `workflow:import` and `workflow:execute-chat`.
 *
 * This module runs in the editor too: no Node API here.
 */
export const SCOPES = [
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
  'execution:get',
  'execution:list',
  'execution:delete',
  'execution:retry',
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
  'role:manageProject',
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

  'testRun:read',
  'testRun:list',

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
  'workflow:activate',
  'workflow:deactivate',
  'workflow:publish',
  'workflow:unpublish',
  'workflow:enableRedaction',
  'workflow:disableRedaction',

  'workflowTags:update',
  'workflowTags:list',
] as const;

/** One permission scope, `resource:operation`. */
export type Scope = (typeof SCOPES)[number];

type ResourceOf<S> = S extends `${infer R}:${string}` ? R : never;

/** The resource part of a scope, such as `workflow` or `dataTable`. */
export type ScopeResource = ResourceOf<Scope>;

type OperationOf<S, R extends string> = S extends `${R}:${infer O}` ? O : never;

/** The operations the catalog holds for one resource, such as `'read' | 'update'` for `tag`. */
export type ScopeOperation<R extends ScopeResource> = OperationOf<Scope, R>;

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

/** True when `value` names a scope in the catalog. */
export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}
