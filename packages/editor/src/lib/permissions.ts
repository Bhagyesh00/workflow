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

export interface Permissions {
  can(scope: Scope, resource?: ScopedResource | null): boolean;
}

/** `can` over the signed-in user's `me` (false until it loads) */
export function usePermissions(): Permissions {
  const me = useMe().data;
  const can = useCallback(
    (scope: Scope, resource?: ScopedResource | null) => canWith(me, scope, resource),
    [me],
  );
  return useMemo(() => ({ can }), [can]);
}
