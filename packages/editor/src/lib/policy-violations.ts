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
import { toast } from '../stores/ui-store';

export type RestrictedMap = ReadonlyMap<string, AvailableType>;

const NONE: RestrictedMap = new Map();

/**
 * The rows each mounted `useRestrictedTypes` holds, for code that runs outside React (add-node.ts, paste).
 * One entry per mounted hook: the registry reads the newest, and only the last hook to go leaves it empty.
 */
const mounted = new Set<{ rows: RestrictedMap }>();

function publishedRows(): RestrictedMap {
  let latest: RestrictedMap = NONE;
  for (const entry of mounted) latest = entry.rows;
  return latest;
}

/** the unavailable row for `type` as last published, if any */
export function restrictedEntry(type: string): AvailableType | undefined {
  return publishedRows().get(type);
}

/** the names of the nodes in `nodes` whose type a policy blocks (a paste or an import adds none of them) */
export function restrictedNodeNames(nodes: readonly { name: string; type: string }[]): string[] {
  const rows = publishedRows();
  return nodes.filter((n) => rows.has(n.type)).map((n) => n.name);
}

/**
 * True, with the toast shown, when `nodes` hold a type a policy blocks: a paste or an import then adds
 * nothing, as the node creator does for one picked node.
 */
export function refuseRestrictedNodes(nodes: readonly { name: string; type: string }[]): boolean {
  const names = restrictedNodeNames(nodes);
  if (!names.length) return false;
  toast.error(
    names.length === 1 ? `${names[0]} is restricted` : `${names.length} nodes are restricted`,
    `A policy blocks ${names.length === 1 ? 'this node' : `these nodes: ${names.join(', ')}`}, so nothing was added. Ask an admin to allow ${names.length === 1 ? 'it' : 'them'}.`,
  );
  return true;
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
    const entry = { rows: restricted };
    mounted.add(entry);
    return () => {
      // the last hook to go leaves nothing published (a stale project's rows must not block another's adds)
      mounted.delete(entry);
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
