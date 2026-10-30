import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import type { CredentialTypeRegistry, NodeTypeRegistry } from './engine/services';

export class NodeTypes implements NodeTypeRegistry {
  private readonly types = new Map<string, NodeType>();

  constructor(nodes: NodeType[] = []) {
    for (const n of nodes) this.register(n);
  }

  register(node: NodeType): void {
    const name = node.description.name;
    if (this.types.has(name)) throw new Error(`Node type "${name}" is already registered`);
    this.types.set(name, node);
  }

  get(type: string): NodeType | undefined {
    return this.types.get(type);
  }

  list(): NodeType[] {
    return [...this.types.values()];
  }
}

export class CredentialTypes implements CredentialTypeRegistry {
  private readonly types = new Map<string, CredentialType>();
  private readonly resolved = new Map<string, CredentialType>();

  constructor(types: CredentialType[] = []) {
    for (const t of types) this.register(t);
  }

  register(type: CredentialType): void {
    if (this.types.has(type.name)) throw new Error(`Credential type "${type.name}" is already registered`);
    this.types.set(type.name, type);
    this.resolved.clear();
  }

  get(name: string): CredentialType | undefined {
    return this.types.get(name);
  }

  list(): CredentialType[] {
    return [...this.types.values()];
  }

  getResolved(name: string): CredentialType | undefined {
    const cached = this.resolved.get(name);
    if (cached) return cached;
    const type = this.types.get(name);
    if (!type) return undefined;
    const parents = (type.extends ?? [])
      .map((p) => this.getResolved(p))
      .filter((p): p is CredentialType => !!p);
    const properties = [...parents.flatMap((p) => p.properties)];
    for (const prop of type.properties) {
      const i = properties.findIndex((p) => p.name === prop.name);
      if (i >= 0) properties[i] = prop;
      else properties.push(prop);
    }
    const merged: CredentialType = {
      ...Object.assign({}, ...parents),
      ...type,
      properties,
      authenticate: type.authenticate ?? parents.find((p) => p.authenticate)?.authenticate,
      test: type.test ?? parents.find((p) => p.test)?.test,
    };
    this.resolved.set(name, merged);
    return merged;
  }

  isA(name: string, parent: string): boolean {
    if (name === parent) return true;
    const type = this.types.get(name);
    return (type?.extends ?? []).some((p) => this.isA(p, parent));
  }
}

export function registriesFromPackages(packages: NodePackage[]): {
  nodeTypes: NodeTypes;
  credentialTypes: CredentialTypes;
} {
  const nodeTypes = new NodeTypes();
  const credentialTypes = new CredentialTypes();
  for (const pkg of packages) {
    for (const n of pkg.nodes) nodeTypes.register(n);
    for (const c of pkg.credentials) credentialTypes.register(c);
  }
  return { nodeTypes, credentialTypes };
}
