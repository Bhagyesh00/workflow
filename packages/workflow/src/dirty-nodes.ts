/**
 * Dirty node detection (P3-06), as n8n's node dirtiness: compares the definition that produced the run data with
 * the current one (diffWorkflows). Only nodes with run data can be dirty. Moves, renames, notes and colour do not
 * count. Undoing a change clears the mark, since nothing differs any more.
 *
 * Rules (first reason wins, in this order):
 * (a) parameters: any node field changed except position, name, notes, notesInFlow and color
 *     (parameters, credentials, disabled, settings such as retry);
 * (b) connections: a connection was added into the node (also when (c) a node was inserted in front of it);
 * (d) connections: an incoming connection was removed together with its source node (a removed connection alone
 *     does not count);
 * (e) connections: an incoming node was toggled and is now enabled, or it has AI (non-main) outputs;
 * (f) pinned: a parent's pin data changed, or the node's own pin was removed after the run;
 * (g) upstream: a sub-node that changed feeds this node;
 * (h) upstream: a dirty node sits in a loop this node is the entry of.
 */
import { diffValues, diffWorkflows } from './diff';
import type { Connections, RunData, WorkflowDefinition } from './interfaces';
import { ConnectionGraph } from './partial-run';

/** parameters: own fields changed; connections: inputs changed; pinned: pin data changed; upstream: a sub-node or loop member is dirty */
export type DirtyReason = 'parameters' | 'connections' | 'pinned' | 'upstream';

/** node fields whose change does not make the output stale (diffWorkflows already skips position, id, name) */
const COSMETIC_FIELDS = new Set(['notes', 'notesInFlow', 'color']);

interface ConnectionKey {
  key: string;
  from: string;
  to: string;
}

/** connections keyed by node id, so renames do not look like rewiring */
function connectionKeys(connections: Connections, idByName: Map<string, string>): ConnectionKey[] {
  const keys: ConnectionKey[] = [];
  for (const [source, byType] of Object.entries(connections ?? {})) {
    const from = idByName.get(source);
    if (!from) continue;
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((targets, output) => {
        for (const target of targets ?? []) {
          const to = idByName.get(target.node);
          if (to) keys.push({ key: `${type}|${from}|${output}|${to}|${target.index}`, from, to });
        }
      });
    }
  }
  return keys;
}

/** dirty nodes of `current`, keyed by node name (current names) */
export function dirtyNodesFromDiff(
  ran: WorkflowDefinition,
  current: WorkflowDefinition,
  runData: RunData,
): Record<string, DirtyReason> {
  const ranById = new Map(ran.nodes.map((node) => [node.id, node]));
  const nameById = new Map(current.nodes.map((node) => [node.id, node.name]));
  const graph = new ConnectionGraph(current.connections, new Set(current.nodes.map((node) => node.name)));
  const hasRun = new Set(
    current.nodes
      .filter((node) => {
        const before = ranById.get(node.id);
        return Boolean(before && runData[before.name]?.length);
      })
      .map((node) => node.name),
  );
  const result: Record<string, DirtyReason> = {};
  const mark = (name: string | undefined, reason: DirtyReason): boolean => {
    if (!name || result[name] || !hasRun.has(name)) return false;
    result[name] = reason;
    return true;
  };

  // (a)
  const changed = new Set<string>();
  for (const node of diffWorkflows(ran, current).nodes.changed) {
    if (node.changes.some((change) => !COSMETIC_FIELDS.has(change.path.split('.')[0]))) {
      changed.add(node.name);
      mark(node.name, 'parameters');
    }
  }

  // (b), (c), (d)
  const before = connectionKeys(ran.connections, new Map(ran.nodes.map((node) => [node.name, node.id])));
  const after = connectionKeys(
    current.connections,
    new Map(current.nodes.map((node) => [node.name, node.id])),
  );
  const beforeKeys = new Set(before.map((c) => c.key));
  const afterKeys = new Set(after.map((c) => c.key));
  for (const c of after) if (!beforeKeys.has(c.key)) mark(nameById.get(c.to), 'connections');
  for (const c of before) {
    if (!afterKeys.has(c.key) && !nameById.has(c.from)) mark(nameById.get(c.to), 'connections');
  }

  // (e) and (f)
  for (const node of current.nodes) {
    const previous = ranById.get(node.id);
    if (!previous) continue;
    if (Boolean(previous.disabled) !== Boolean(node.disabled)) {
      if (!node.disabled || graph.hasNonMainOutputs(node.name)) {
        for (const child of graph.children(node.name)) mark(child, 'connections');
      }
    }
  }
  for (const node of current.nodes) {
    const previous = ranById.get(node.id);
    if (!previous) continue;
    const pinBefore = ran.pinData?.[previous.name];
    const pinAfter = current.pinData?.[node.name];
    if (!diffValues(pinBefore ?? null, pinAfter ?? null).length) continue;
    for (const child of graph.mainChildren(node.name).flat()) mark(child, 'pinned');
    if (pinBefore && !pinAfter) mark(node.name, 'pinned');
  }

  // (g) and (h), until nothing new is marked
  const cycles = graph.cycles().map((members) => {
    const inside = new Set(members);
    const entries = members.filter((name) => graph.mainParents(name).some((parent) => !inside.has(parent)));
    return { inside, entries };
  });
  let grew = true;
  while (grew) {
    grew = false;
    const sources = new Set([...Object.keys(result), ...changed]);
    for (const name of sources) {
      for (const target of graph.subNodeTargets(name)) grew = mark(target, 'upstream') || grew;
      if (!result[name]) continue;
      for (const cycle of cycles) {
        if (!cycle.inside.has(name)) continue;
        for (const entry of cycle.entries) grew = mark(entry, 'upstream') || grew;
      }
    }
  }
  return result;
}
