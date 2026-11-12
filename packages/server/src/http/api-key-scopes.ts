/**
 * API key scopes (P4-18), n8n's public API scopes. `API_KEY_SCOPES` is final: POST /api-keys
 * validates against it and every PUBLIC_ROUTES row names one. `assertApiKeyScope` fails closed: a key
 * with non-empty scopes gets 403 on a route whose scope it lacks and on a route with no scope; a key
 * with empty scopes keeps full access.
 */
import { PROJECT_ROLE_SCOPES, type Scope } from '@workflow/workflow';
import type { AuthContext } from './auth';
import { ApiError } from './errors';

export const API_KEY_SCOPES = [
  'user:read',
  'user:list',
  'user:create',
  'user:changeRole',
  'user:delete',
  'sourceControl:pull',
  // P6 S4 (L5): the public push and status
  'sourceControl:push',
  'sourceControl:read',
  'securityAudit:generate',
  'project:create',
  'project:update',
  'project:delete',
  'project:list',
  // P6-03, P6-32, P6-33
  'project:manageMembers',
  'role:list',
  'role:read',
  'role:manage',
  'role:manageProject',
  'securitySettings:manage',
  'variable:create',
  'variable:update',
  'variable:delete',
  'variable:list',
  'tag:create',
  'tag:read',
  'tag:update',
  'tag:delete',
  'tag:list',
  'workflowTags:update',
  'workflowTags:list',
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:list',
  'workflow:move',
  'workflow:activate',
  'workflow:deactivate',
  'execution:delete',
  'execution:read',
  'execution:retry',
  'execution:stop',
  'execution:list',
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:move',
  'credential:delete',
  'credential:list',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:list',
  'dataTable:list',
  'dataTable:create',
  'dataTable:read',
  'dataTable:update',
  'dataTable:delete',
  'dataTableColumn:create',
  'dataTableColumn:read',
  'dataTableColumn:update',
  'dataTableColumn:delete',
  'dataTableRow:create',
  'dataTableRow:read',
  'dataTableRow:update',
  'dataTableRow:upsert',
  'dataTableRow:delete',
  // P5-12: the evaluation test runs of the public API
  'testRun:list',
  'testRun:create',
  'testRun:read',
  'testRun:cancel',
  // P6-01, P6-09 to P6-14: SSO, LDAP and role mapping on the public API
  'saml:manage',
  'oidc:manage',
  'ldap:manage',
  'ldap:sync',
  'roleMappingRule:create',
  'roleMappingRule:delete',
  'roleMappingRule:list',
  'roleMappingRule:update',
  // P6-49, P6-05: node and credential type policies and insights on the public API (appended last)
  'nodeTypePolicy:manage',
  'credentialTypePolicy:manage',
  'insights:read',
  // P6-06, P6-67 (S5 C0): log streaming destinations and OpenTelemetry settings on the public API (appended last)
  'eventBusDestination:list',
  'eventBusDestination:read',
  'eventBusDestination:create',
  'eventBusDestination:update',
  'eventBusDestination:test',
  'eventBusDestination:delete',
  'otel:manage',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * P6-21: the key scopes a user may give a key (and the key list offers), as n8n's `getApiKeyScopesForRole`:
 * the role's global scopes that are key scopes, plus the key scopes a personal project owner holds, because
 * every member works in their own personal project. In `API_KEY_SCOPES` order.
 */
export function apiKeyScopesForRole(scopes: ReadonlySet<Scope>): ApiKeyScope[] {
  const personal = PROJECT_ROLE_SCOPES['project:personalOwner'];
  return API_KEY_SCOPES.filter((scope) => scopes.has(scope as Scope) || personal.has(scope as Scope));
}

/**
 * Fails closed. A key with scopes gets 403 on a route whose scope it lacks and on a route with no
 * scope; a key with no scopes, and a signed-in user (no key), keep full access. With an array of
 * scopes, any one the key holds passes.
 */
export function assertApiKeyScope(auth: AuthContext, scope?: ApiKeyScope | readonly ApiKeyScope[]): void {
  const granted = auth.apiKeyScopes;
  if (!granted || granted.length === 0) return;
  if (scope === undefined) throw ApiError.forbidden();
  // P6-32: an array passes when the key holds any one (n8n's `anyOf` on role writes); an empty array never
  const wanted: readonly ApiKeyScope[] = typeof scope === 'string' ? [scope] : scope;
  if (!wanted.some((s) => granted.includes(s))) throw ApiError.forbidden();
}
