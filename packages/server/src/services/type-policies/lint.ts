/**
 * P6-48 (L1): write-time checks of a document's rules. Warnings (the write goes through): `shadowed` (an
 * earlier rule already matches everything this one does), `notLoaded` (no loaded type or package matches).
 * Refused (400, not a warning): `extends` in a node policy, `delegate` where the scope cannot hold it.
 * Stub from C0; L1 fills it.
 */
import type { PolicyKind, PolicyRule, PolicyWarning } from './types';

/** the loaded type names and package names of one kind */
export interface KnownTypes {
  types: ReadonlySet<string>;
  packages: ReadonlySet<string>;
}

export function lintRules(
  _kind: PolicyKind,
  _rules: readonly PolicyRule[],
  _known: KnownTypes,
): PolicyWarning[] {
  // stub (L1)
  throw new Error('not implemented (L1)');
}
