/**
 * P6-48 (L1): which package each node type and credential type comes from (`NodePackage.name`), for the
 * `package` selector: our node names carry a category prefix (`core.`, `app.`, `ai.`), not the package
 * (Q-D7). context.ts builds it once from the loaded packages and hands it to `PolicySnapshots`.
 * Stub from C0: PASSES with an empty index (createContext calls it); L1 fills it.
 */
import type { NodePackage } from '@workflow/workflow';

export interface PackageIndex {
  /** node type name to package name */
  nodes: ReadonlyMap<string, string>;
  /** credential type name to package name */
  credentials: ReadonlyMap<string, string>;
}

export function buildPackageIndex(_packages: readonly NodePackage[]): PackageIndex {
  // stub (L1): PASSES, an empty index (no `package` rule matches until L1)
  return { nodes: new Map(), credentials: new Map() };
}
