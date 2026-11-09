/**
 * Set arithmetic on scopes. A user's rights on a resource are the union of what each of their
 * roles grants, where a project role reaching a resource through a share is first cut down to
 * what the share's resource role allows.
 */
import type { Scope } from './scopes';

/** The union of every given scope set, as a new set. */
export function combineScopes(sets: Iterable<ReadonlySet<Scope>>): Set<Scope> {
  const out = new Set<Scope>();
  for (const set of sets) {
    for (const scope of set) out.add(scope);
  }
  return out;
}

/**
 * The scopes of `role` that `mask` also holds, as a new set. A project role that reaches a
 * workflow or credential through a share keeps only what the share's resource role allows.
 */
export function maskScopes(role: ReadonlySet<Scope>, mask: ReadonlySet<Scope>): Set<Scope> {
  const out = new Set<Scope>();
  for (const scope of role) {
    if (mask.has(scope)) out.add(scope);
  }
  return out;
}

/** True when `set` holds `scope`. A missing set holds nothing (deny by default). */
export function hasScope(
  set: ReadonlySet<Scope> | readonly Scope[] | null | undefined,
  scope: Scope,
): boolean {
  if (!set) return false;
  return 'has' in set ? set.has(scope) : set.includes(scope);
}
