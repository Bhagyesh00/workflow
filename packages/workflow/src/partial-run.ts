/**
 * Partial run planner (P3-06), as n8n's partial execution: subgraph from the trigger (root) to the destination,
 * dirty nodes and their descendants cleaned, start nodes found (cycle entry, Loop done-output rule, Merge seed).
 * The core engine runs the plan (multi-start); the editor uses it to keep the reused run data on screen.
 *
 * Steps:
 * 1. The destination must exist and be enabled.
 * 2. Root: the given trigger when it is enabled and upstream of the destination, else an enabled trigger upstream
 *    of it, else the closest parent with run data.
 * 3. Subgraph: nodes on a main path root .. destination, plus the sub-nodes (AI inputs) feeding them.
 * 4. Run data of dirty nodes, their descendants and the sub-nodes of those goes; so does data outside the subgraph.
 * 5. Start nodes: walking from the root, the first node on each branch with no usable data, the destination, or a
 *    Loop whose "done" output is empty. A branch whose output was empty is not followed.
 * 6. A start node inside a cycle is replaced by the node the walk entered that cycle at.
 * 7. Run data of the start nodes and their descendants goes too (they run again).
 * Disabled nodes are never a root; in the walk they behave like any node (the engine passes their input through).
 */
import { WorkflowOperationError } from './errors';
import type { Connections, Item, RunData, TaskData, WorkflowDefinition, WorkflowNode } from './interfaces';
import { sortByPosition } from './workflow';

export interface PartialRunOptions {
  /** trigger node name to run from; absent = closest parent with run data */
  root?: string;
  /** node name the run stops after */
  destination: string;
  /** run data of the earlier execution */
  runData: RunData;
  pinData?: Record<string, Item[]>;
  /** node names marked dirty since runData was produced */
  dirtyNodeNames?: string[];
  /**
   * which nodes count as a trigger when `root` is absent or not upstream of the destination
   * (default: a node without main inputs that is not a sub-node)
   */
  isTrigger?: (node: WorkflowNode) => boolean;
}

export interface PartialRunPlan {
  /** node names in the subgraph root .. destination */
  subgraph: string[];
  /** node names the engine starts from (each reads its parents' run data), in canvas order */
  startNodes: string[];
  /** run data kept for nodes that do not run again */
  runData: RunData;
  pinData: Record<string, Item[]>;
  destination: string;
  /** the node the subgraph starts from (a trigger, or the closest parent with run data) */
  root: string;
}

export const NO_TRIGGER_MESSAGE = "Connect a trigger and make sure it's enabled to run this node";
export const DISABLED_DESTINATION_MESSAGE = 'Cannot execute a disabled node';

/** node types whose first output ("done") must have data before the nodes after it can reuse it */
const LOOP_NODE_TYPES = new Set(['core.splitInBatches']);

/** Graph helpers over a definition's connections (by node name). */
export class ConnectionGraph {
  /** main children per output index */
  private readonly mainOut = new Map<string, string[][]>();
  private readonly mainIn = new Map<string, string[]>();
  /** sources of non-main (AI) inputs */
  private readonly subIn = new Map<string, string[]>();
  /** targets of non-main (AI) outputs */
  private readonly subOut = new Map<string, string[]>();
  /** every outgoing target, any connection type */
  private readonly anyOut = new Map<string, string[]>();
  private readonly nonMainOut = new Set<string>();
  private readonly mainOutSources = new Set<string>();

  constructor(
    connections: Connections,
    readonly names: ReadonlySet<string>,
  ) {
    const push = (map: Map<string, string[]>, key: string, value: string) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const [source, byType] of Object.entries(connections ?? {})) {
      if (!names.has(source)) continue;
      for (const [type, outputs] of Object.entries(byType ?? {})) {
        (outputs ?? []).forEach((targets, output) => {
          for (const target of targets ?? []) {
            if (!names.has(target.node)) continue;
            push(this.anyOut, source, target.node);
            if (type === 'main') {
              this.mainOutSources.add(source);
              const outs = this.mainOut.get(source) ?? [];
              while (outs.length <= output) outs.push([]);
              outs[output].push(target.node);
              this.mainOut.set(source, outs);
              push(this.mainIn, target.node, source);
            } else {
              this.nonMainOut.add(source);
              push(this.subIn, target.node, source);
              push(this.subOut, source, target.node);
            }
          }
        });
      }
    }
  }

  mainChildren(name: string): string[][] {
    return this.mainOut.get(name) ?? [];
  }

  mainParents(name: string): string[] {
    return this.mainIn.get(name) ?? [];
  }

  /** nodes feeding `name` through AI (non-main) inputs */
  subNodesOf(name: string): string[] {
    return this.subIn.get(name) ?? [];
  }

  /** nodes `name` feeds through its AI (non-main) outputs */
  subNodeTargets(name: string): string[] {
    return this.subOut.get(name) ?? [];
  }

  /** direct targets of any connection type */
  children(name: string): string[] {
    return this.anyOut.get(name) ?? [];
  }

  /** a node with AI outputs and no main outputs */
  isSubNode(name: string): boolean {
    return this.nonMainOut.has(name) && !this.mainOutSources.has(name);
  }

  hasNonMainOutputs(name: string): boolean {
    return this.nonMainOut.has(name);
  }

  /** `from` and everything reachable from it through `next` */
  reach(from: Iterable<string>, next: (name: string) => string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...from];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...next(name));
    }
    return seen;
  }

  /** `from`, every descendant (any connection type) and the sub-nodes feeding any of them */
  descendantsWithSubNodes(from: Iterable<string>): Set<string> {
    const down = this.reach(from, (name) => this.children(name));
    return this.reach(down, (name) => this.subNodesOf(name));
  }

  /** strongly connected components of the main graph with a cycle (size > 1 or a self loop), Tarjan */
  cycles(): string[][] {
    let index = 0;
    const indexOf = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const result: string[][] = [];
    const visit = (name: string) => {
      indexOf.set(name, index);
      low.set(name, index);
      index++;
      stack.push(name);
      onStack.add(name);
      for (const child of this.mainChildren(name).flat()) {
        if (!indexOf.has(child)) {
          visit(child);
          low.set(name, Math.min(low.get(name)!, low.get(child)!));
        } else if (onStack.has(child)) {
          low.set(name, Math.min(low.get(name)!, indexOf.get(child)!));
        }
      }
      if (low.get(name) !== indexOf.get(name)) return;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== name);
      if (component.length > 1 || this.mainChildren(name).flat().includes(name)) result.push(component);
    };
    for (const name of this.names) if (!indexOf.has(name)) visit(name);
    return result;
  }
}

function lastTask(runData: RunData, name: string): TaskData | undefined {
  const runs = runData[name];
  return runs?.length ? runs[runs.length - 1] : undefined;
}

/** a task whose output later nodes can read */
function usable(task: TaskData | undefined): boolean {
  return (
    Boolean(task) && !task!.error && task!.executionStatus !== 'error' && task!.executionStatus !== 'waiting'
  );
}

export function planPartialRun(definition: WorkflowDefinition, options: PartialRunOptions): PartialRunPlan {
  const nodes = new Map(definition.nodes.map((node) => [node.name, node]));
  const graph = new ConnectionGraph(definition.connections, new Set(nodes.keys()));
  const { destination } = options;
  const target = nodes.get(destination);
  if (!target) throw new WorkflowOperationError(`Destination node "${destination}" does not exist`);
  if (target.disabled) throw new WorkflowOperationError(DISABLED_DESTINATION_MESSAGE);

  const pinData = options.pinData ?? {};
  const given = options.runData ?? {};
  const hasData = (name: string, runData: RunData) =>
    Boolean(pinData[name]) || usable(lastTask(runData, name));

  // 2. root
  const upstream = graph.reach([destination], (name) => graph.mainParents(name));
  const isTrigger =
    options.isTrigger ??
    ((node: WorkflowNode) => graph.mainParents(node.name).length === 0 && !graph.isSubNode(node.name));
  const enabled = (name: string) => {
    const node = nodes.get(name);
    return Boolean(node && !node.disabled);
  };
  let root: string | undefined =
    options.root && enabled(options.root) && upstream.has(options.root) ? options.root : undefined;
  if (!root) {
    const triggers = [...upstream]
      .map((name) => nodes.get(name)!)
      .filter((node) => !node.disabled && !graph.isSubNode(node.name) && isTrigger(node));
    const withData = triggers.filter((node) => hasData(node.name, given));
    root = sortByPosition(withData.length ? withData : triggers)[0]?.name;
  }
  if (!root) {
    // closest parent with run data (breadth first, nearest first)
    let frontier = graph.mainParents(destination);
    const seen = new Set([destination]);
    while (!root && frontier.length) {
      const next: string[] = [];
      for (const name of frontier) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (enabled(name) && usable(lastTask(given, name))) {
          root = name;
          break;
        }
        next.push(...graph.mainParents(name));
      }
      frontier = next;
    }
  }
  if (!root) throw new WorkflowOperationError(NO_TRIGGER_MESSAGE);

  // 3. subgraph
  const mainSubgraph = graph.reach([root], (name) =>
    graph
      .mainChildren(name)
      .flat()
      .filter((child) => upstream.has(child)),
  );
  const subgraph = graph.reach(mainSubgraph, (name) => graph.subNodesOf(name));

  // 4. clean
  const runData: RunData = {};
  for (const [name, runs] of Object.entries(given)) {
    if (subgraph.has(name) && Array.isArray(runs)) runData[name] = [...runs];
  }
  const dirty = (options.dirtyNodeNames ?? []).filter((name) => nodes.has(name));
  for (const name of graph.descendantsWithSubNodes(dirty)) delete runData[name];

  // 5. start nodes
  const outputItems = (name: string, output: number): Item[] => {
    if (pinData[name]) return output === 0 ? pinData[name] : [];
    return (lastTask(runData, name)?.data?.main?.[output] as Item[] | null | undefined) ?? [];
  };
  const starts = new Set<string>();
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (!order.includes(name)) order.push(name);
    if (!hasData(name, runData) || name === destination) {
      starts.add(name);
      return;
    }
    if (LOOP_NODE_TYPES.has(nodes.get(name)!.type) && outputItems(name, 0).length === 0) {
      starts.add(name);
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    graph.mainChildren(name).forEach((children, output) => {
      if (!outputItems(name, output).length) return;
      for (const child of children) if (mainSubgraph.has(child)) walk(child);
    });
  };
  walk(root);

  // 6. cycle entry
  const entries = new Set<string>();
  const cycles = graph.cycles();
  for (const start of starts) {
    const cycle = cycles.find((members) => members.includes(start));
    entries.add(cycle ? (order.find((name) => cycle.includes(name)) ?? start) : start);
  }

  // 7. the start nodes and everything after them run again
  for (const name of graph.descendantsWithSubNodes(entries)) delete runData[name];

  return {
    subgraph: [...subgraph],
    startNodes: sortByPosition([...entries].map((name) => nodes.get(name)!)).map((node) => node.name),
    runData,
    pinData: Object.fromEntries(Object.entries(pinData).filter(([name]) => subgraph.has(name))),
    destination,
    root,
  };
}
