/**
 * API key scopes (P4-18), n8n's public API scopes. `API_KEY_SCOPES` is final: POST /api-keys
 * validates against it and every PUBLIC_ROUTES row names one. `assertApiKeyScope` is a no-op until
 * L7, which makes it fail closed: a key with non-empty scopes gets 403 on a route whose scope it
 * lacks and on a route with no scope; a key with empty scopes keeps full access.
 */
import type { AuthContext } from './auth';

export const API_KEY_SCOPES = [
  'user:read',
  'user:list',
  'user:create',
  'user:changeRole',
  'user:delete',
  'sourceControl:pull',
  'securityAudit:generate',
  'project:create',
  'project:update',
  'project:delete',
  'project:list',
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
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Stub until L7: refuses nothing yet. */
export function assertApiKeyScope(_auth: AuthContext, _scope?: ApiKeyScope): void {
  // L7: fail closed, see the file comment
}
