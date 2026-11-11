/**
 * P6-50: what the editor knows about node types a policy blocks. `useRestrictedTypes` reads the working
 * project's `available-types` rows; the node creator, the canvas badge, the NDV panels and the add path
 * read it. The server stays the lock (save, publish and run refuse a blocked type); this only explains.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { projectsApi } from '../api/endpoints';
import { queryKeys, useAvailableTypes } from '../api/queries';
import type { AvailableType, Member, TypePolicyViolation } from '../api/types';
import { useWorkingProjectId } from '../features/editor/open-resources';

export type RestrictedMap = ReadonlyMap<string, AvailableType>;

const NONE: RestrictedMap = new Map();

/** the rows the last mounted `useRestrictedTypes` published, for code that runs outside React (add-node.ts) */
let published: RestrictedMap = NONE;

function sameRows(a: RestrictedMap, b: RestrictedMap): boolean {
  if (a.size !== b.size) return false;
  for (const [type, row] of a) {
    const other = b.get(type);
    if (!other || other.reason !== row.reason || other.scope !== row.scope) return false;
  }
  return true;
}

/** the unavailable row for `type` as last published, if any */
export function restrictedEntry(type: string): AvailableType | undefined {
  return published.get(type);
}

/** only the rows a policy blocks, keyed by node type */
export function restrictedRows(rows: readonly AvailableType[] | undefined): RestrictedMap {
  const map = new Map<string, AvailableType>();
  for (const row of rows ?? []) if (!row.available) map.set(row.type, row);
  return map.size ? map : NONE;
}

/** the blocked node types of the project the user works in (the personal project outside a project) */
export function useRestrictedTypes(): { restricted: RestrictedMap; isLoading: boolean } {
  const working = useWorkingProjectId();
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: !working,
    staleTime: 60_000,
    retry: false,
  });
  const projectId = working ?? personal.data?.id ?? null;
  const rows = useAvailableTypes(projectId);
  const restricted = useMemo(() => restrictedRows(rows.data), [rows.data]);
  useEffect(() => {
    if (!sameRows(published, restricted)) published = restricted;
    return () => {
      // the last hook to go leaves nothing published (a stale project's rows must not block another's adds)
      if (published === restricted) published = NONE;
    };
  }, [restricted]);
  return { restricted, isLoading: rows.isLoading };
}

/** one type's unavailable row, or undefined while it is allowed */
export function useRestrictedEntry(type: string): AvailableType | undefined {
  return useRestrictedTypes().restricted.get(type);
}

/** why a type is blocked, in words for a builder (no policy or project names) */
export function restrictedReason(entry: Pick<AvailableType, 'scope' | 'optInAvailable' | 'reason'>): string {
  const where = entry.scope === 'project' ? 'this project' : 'this workspace';
  const base = `A policy of ${where} blocks this node.`;
  const optIn = entry.optInAvailable ? ' A project admin can allow it for the project.' : '';
  return `${base}${optIn}`;
}

export function violationText(violation: TypePolicyViolation, displayName?: string): string {
  const name = displayName ?? violation.type;
  const where = violation.scope === 'project' ? 'this project' : 'this workspace';
  return `${name} is blocked by a policy of ${where}.`;
}

/** the title and text of the toast that shows when a blocked type is picked */
export function restrictedToast(displayName: string): { title: string; description: string } {
  return {
    title: `${displayName} is restricted`,
    description: 'A policy blocks this node, so it was not added. Ask an admin to allow it.',
  };
}

/** the members to ask: the workspace owners and admins that are active */
export function adminsOf(members: readonly Member[] | undefined): Member[] {
  return (members ?? []).filter(
    (m) => (m.role === 'owner' || m.role === 'admin') && (!m.status || m.status === 'active'),
  );
}
