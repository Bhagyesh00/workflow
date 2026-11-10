/**
 * Node packages served by this instance. `@workflow/nodes-base` is always present; the AI package
 * is optional and loaded when installed.
 */
import { type CredentialTypes, type NodeTypes, registriesFromPackages } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { NodePackage } from '@workflow/workflow';
import type { Config } from './config';

const OPTIONAL_PACKAGES = ['@workflow/nodes-ai'];

function asPackage(name: string, mod: Record<string, unknown>): NodePackage | undefined {
  const candidate = Object.values(mod).find(
    (v): v is NodePackage =>
      Boolean(v) &&
      typeof v === 'object' &&
      Array.isArray((v as NodePackage).nodes) &&
      Array.isArray((v as NodePackage).credentials),
  );
  if (candidate) return candidate;
  if (Array.isArray(mod.nodes) && Array.isArray(mod.credentials)) {
    return {
      name,
      nodes: mod.nodes as NodePackage['nodes'],
      credentials: mod.credentials as NodePackage['credentials'],
    };
  }
  return undefined;
}

export async function loadNodePackages(): Promise<NodePackage[]> {
  const packages: NodePackage[] = [nodesBasePackage];
  for (const name of OPTIONAL_PACKAGES) {
    // a variable specifier keeps bundlers and the type checker from requiring the package
    const specifier: string = name;
    try {
      const mod = (await import(specifier)) as Record<string, unknown>;
      const pkg = asPackage(name, mod);
      if (pkg) packages.push(pkg);
    } catch {
      /* optional package not installed */
    }
  }
  return packages;
}

export interface Registries {
  nodeTypes: NodeTypes;
  credentialTypes: CredentialTypes;
}

/**
 * P6-47 (L3): `lists` is `config.nodes` (NODES_EXCLUDE, NODES_INCLUDE); C0 added the parameter and ignores it
 * until L3 applies it (an empty `include` means every type).
 */
export function buildRegistries(packages: NodePackage[], _lists?: Config['nodes']): Registries {
  return registriesFromPackages(packages);
}
