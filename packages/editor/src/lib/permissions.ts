/**
 * P6-43: what the signed-in user may do, by scope (n8n's rbac store `hasScope`). A scope passes when the
 * workspace role holds it (`me.globalScopes`) or the row the server sent holds it (`resource.scopes`: a
 * workflow's, credential's, folder's or data table's `scopes`, an execution detail's, or a project's from
 * `useProject`). Nothing loaded yet, or no scopes at all, denies. The server stays the lock; this only
 * decides what the UI offers.
 */
import { hasScope, type Scope } from '@workflow/workflow';
import { useCallback, useMemo } from 'react';
import { useMe } from '../api/queries';
import type { Me } from '../api/types';
import { useProtectedWorkspace } from './protected';

/** the scopes a row carries (lists with `includeScopes`, GET one, a project detail) */
export interface ScopedResource {
  scopes?: Scope[];
}

export function canWith(
  me: Pick<Me, 'globalScopes'> | null | undefined,
  scope: Scope,
  resource?: ScopedResource | null,
): boolean {
  return hasScope(me?.globalScopes, scope) || hasScope(resource?.scopes, scope);
}

/**
 * P6-80: what a protected workspace (n8n's branchReadOnly) refuses on the server, so the editor offers none of it:
 * the create, update and delete scopes of workflows, credentials, projects, variables, folders and the data
 * table structure. Publish, execute and the row scopes stay.
 */
const PROTECTED_MASKED: ReadonlySet<Scope> = new Set<Scope>([
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'credential:create',
  'project:create',
  'variable:create',
  'variable:delete',
  'projectVariable:create',
  'projectVariable:delete',
  'folder:create',
  'folder:update',
  'folder:delete',
  'dataTable:create',
  'dataTable:update',
  'dataTable:delete',
]);

/** true when `scope` is hidden on a protected workspace */
export function maskedWhenProtected(scope: Scope): boolean {
  return PROTECTED_MASKED.has(scope);
}

export interface Permissions {
  can(scope: Scope, resource?: ScopedResource | null): boolean;
}

/** `can` over the signed-in user's `me` (false until it loads) */
export function usePermissions(): Permissions {
  const me = useMe().data;
  const protectedWorkspace = useProtectedWorkspace();
  const can = useCallback(
    (scope: Scope, resource?: ScopedResource | null) =>
      !(protectedWorkspace && maskedWhenProtected(scope)) && canWith(me, scope, resource),
    [me, protectedWorkspace],
  );
  return useMemo(() => ({ can }), [can]);
}
