/**
 * P6-48 (L1): which package each node type and credential type comes from (`NodePackage.name`), for the
 * `package` selector: our node names carry a category prefix (`core.`, `app.`, `ai.`), not the package
 * (Q-D7). context.ts builds it once from the loaded packages and hands it to `PolicySnapshots`. The tool and
 * human review variants (`withToolVariants`, which the registry adds) belong to their base node's package
 * and are listed in `bases`, so a `name` rule on the base reaches them.
 */
import { type NodePackage, withToolVariants } from '@workflow/workflow';
import type { PolicyKind, TypeFacts } from './types';

export interface PackageIndex {
  /** node type name to package name */
  nodes: ReadonlyMap<string, string>;
  /** credential type name to package name */
  credentials: ReadonlyMap<string, string>;
  /** tool and human review variant name to the base node type name */
  bases: ReadonlyMap<string, string>;
}

export function buildPackageIndex(packages: readonly NodePackage[]): PackageIndex {
  const nodes = new Map<string, string>();
  const credentials = new Map<string, string>();
  const bases = new Map<string, string>();
  for (const pkg of packages) {
    const withVariants = withToolVariants([...pkg.nodes]);
    const own = new Set(pkg.nodes.map((node) => node.description.name));
    for (const node of withVariants) {
      const name = node.description.name;
      nodes.set(name, pkg.name);
      if (own.has(name)) continue;
      // a variant is named `<base>Tool` or `<base>HitlTool`
      const base = name.endsWith('HitlTool')
        ? name.slice(0, -'HitlTool'.length)
        : name.slice(0, -'Tool'.length);
      if (own.has(base)) bases.set(name, base);
    }
    for (const credential of pkg.credentials) credentials.set(credential.name, pkg.name);
  }
  return { nodes, credentials, bases };
}

/**
 * the facts of one type from the index: its package, and for a node tool or human review variant the base
 * node (`baseName`), so a `name` rule on the base reaches the variant. `ancestors` (credential kind) come
 * from `CredentialTypes.isA`, which the caller has.
 */
export function typeFactsOf(
  index: PackageIndex,
  kind: PolicyKind,
  type: string,
  ancestors?: string[],
): TypeFacts {
  const facts: TypeFacts = { kind };
  const packageName = (kind === 'node' ? index.nodes : index.credentials).get(type);
  if (packageName !== undefined) facts.packageName = packageName;
  const baseName = kind === 'node' ? index.bases.get(type) : undefined;
  if (baseName !== undefined) facts.baseName = baseName;
  if (ancestors !== undefined) facts.ancestors = ancestors;
  return facts;
}
