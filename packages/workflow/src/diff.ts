/**
 * Semantic workflow diff: what changed in logic, ignoring canvas positions and key order.
 * Nodes are matched by id, so renames are reported as renames rather than remove + add.
 */
import type { Connection, ConnectionType, WorkflowDefinition, WorkflowNode } from './interfaces';

export interface ValueChange {
  /** dotted path, e.g. `parameters.options.timeout` */
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeChange {
  id: string;
  name: string;
  type: string;
  changes: ValueChange[];
}

export interface ConnectionRef {
  from: string;
  output: number;
  to: string;
  input: number;
  type: ConnectionType;
}

export interface WorkflowDiff {
  nodes: {
    added: Array<{ id: string; name: string; type: string }>;
    removed: Array<{ id: string; name: string; type: string }>;
    renamed: Array<{ id: string; from: string; to: string }>;
    changed: NodeChange[];
  };
  connections: { added: ConnectionRef[]; removed: ConnectionRef[] };
  settings: ValueChange[];
  /** name / pinned-data level changes */
  other: ValueChange[];
  /** true when nothing but layout changed */
  isEmpty: boolean;
}

/** node fields that do not affect behaviour */
const IGNORED_NODE_KEYS = new Set(['position', 'id', 'name']);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

export function diffValues(before: unknown, after: unknown, path = ''): ValueChange[] {
  if (stable(before) === stable(after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffValues(before[k], after[k], path ? `${path}.${k}` : k));
  }
  return [{ path, before, after }];
}

function connectionList(def: WorkflowDefinition, idByName: Map<string, string>): ConnectionRef[] {
  const out: ConnectionRef[] = [];
  for (const [from, byType] of Object.entries(def.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      outputs?.forEach((dests, output) => {
        for (const d of dests ?? []) {
          // compare by node id so renames do not show up as rewiring
          out.push({
            from: idByName.get(from) ?? from,
            output,
            to: idByName.get(d.node) ?? d.node,
            input: d.index,
            type,
          });
        }
      });
    }
  }
  return out;
}

export function diffWorkflows(before: WorkflowDefinition, after: WorkflowDefinition): WorkflowDiff {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => afterById.get(id)?.name ?? beforeById.get(id)?.name ?? id;
  const summary = (n: WorkflowNode) => ({ id: n.id, name: n.name, type: n.type });

  const added = after.nodes.filter((n) => !beforeById.has(n.id)).map(summary);
  const removed = before.nodes.filter((n) => !afterById.has(n.id)).map(summary);
  const renamed: WorkflowDiff['nodes']['renamed'] = [];
  const changed: NodeChange[] = [];
  for (const node of after.nodes) {
    const prev = beforeById.get(node.id);
    if (!prev) continue;
    if (prev.name !== node.name) renamed.push({ id: node.id, from: prev.name, to: node.name });
    const strip = (n: WorkflowNode) =>
      Object.fromEntries(Object.entries(n).filter(([k]) => !IGNORED_NODE_KEYS.has(k)));
    const changes = diffValues(strip(prev), strip(node));
    if (changes.length) changed.push({ ...summary(node), changes });
  }

  const idsBefore = new Map(before.nodes.map((n) => [n.name, n.id]));
  const idsAfter = new Map(after.nodes.map((n) => [n.name, n.id]));
  const key = (c: ConnectionRef) => `${c.type}|${c.from}|${c.output}|${c.to}|${c.input}`;
  const cBefore = connectionList(before, idsBefore);
  const cAfter = connectionList(after, idsAfter);
  const beforeKeys = new Set(cBefore.map(key));
  const afterKeys = new Set(cAfter.map(key));
  const named = (c: ConnectionRef): ConnectionRef => ({ ...c, from: nameOf(c.from), to: nameOf(c.to) });
  const connections = {
    added: cAfter.filter((c) => !beforeKeys.has(key(c))).map(named),
    removed: cBefore.filter((c) => !afterKeys.has(key(c))).map(named),
  };

  const settings = diffValues(before.settings ?? {}, after.settings ?? {}, 'settings');
  const other = [
    ...diffValues(before.name, after.name, 'name'),
    ...diffValues(before.pinData ?? {}, after.pinData ?? {}, 'pinData'),
  ];
  const isEmpty =
    !added.length &&
    !removed.length &&
    !renamed.length &&
    !changed.length &&
    !connections.added.length &&
    !connections.removed.length &&
    !settings.length &&
    !other.length;
  return { nodes: { added, removed, renamed, changed }, connections, settings, other, isEmpty };
}
