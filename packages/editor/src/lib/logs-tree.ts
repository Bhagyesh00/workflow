/**
 * The run as a tree of node runs for the Logs tab (P5-60). Main runs come in start order; the runs
 * of sub-nodes (models, tools, memory, parsers) sit under the run of the node they feed, matched by
 * time: a sub-node run belongs to the latest run of its parent that started before it (a sub-node
 * parent is logged after its children, so there it is the earliest run that starts at or after it).
 * Tokens come from `data[type][0][0].json.tokenUsage` (what the chat model nodes log) and are summed
 * up the tree.
 */
import type { Connections, ConnectionType, ExecutionStatus, RunData, TaskData } from '@workflow/workflow';

export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
}

export interface LogNode {
  /** `Node#runIndex`, unique within one run */
  id: string;
  node: string;
  runIndex: number;
  /** `main` for a regular node, the connection type for a sub-node */
  type: ConnectionType;
  status: ExecutionStatus;
  start: number;
  duration: number;
  /** this run's tokens plus those of every run under it; absent when none reported any */
  tokens?: TokenCount;
  children: LogNode[];
  task: TaskData;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** tokens the run itself reported, read from the first item of its first output */
export function ownTokens(task: TaskData): TokenCount | undefined {
  for (const outputs of Object.values(task.data ?? {})) {
    const json = outputs?.[0]?.[0]?.json as Record<string, unknown> | undefined;
    const usage = json?.tokenUsage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      const inputTokens = count(u.inputTokens);
      const outputTokens = count(u.outputTokens);
      if (inputTokens || outputTokens) return { inputTokens, outputTokens };
    }
  }
  return undefined;
}

/** "12 + 30 tokens" */
export function formatTokens(tokens: TokenCount | undefined): string {
  return tokens ? `${tokens.inputTokens} + ${tokens.outputTokens} tokens` : '';
}

/** for each node that feeds another through a non-main connection: its connection type and parents */
function subNodeLinks(connections: Connections): Map<string, { type: ConnectionType; parents: string[] }> {
  const links = new Map<string, { type: ConnectionType; parents: string[] }>();
  for (const [source, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType)) {
      if (type === 'main') continue;
      const parents: string[] = [];
      for (const list of outputs ?? []) for (const conn of list ?? []) parents.push(conn.node);
      if (parents.length) links.set(source, { type: type as ConnectionType, parents });
    }
  }
  return links;
}

function byStart(a: LogNode, b: LogNode): number {
  return a.start - b.start || a.runIndex - b.runIndex;
}

export function buildLogsTree(runData: RunData, connections: Connections): LogNode[] {
  const links = subNodeLinks(connections);
  const nodes = new Map<string, LogNode[]>();
  const all: LogNode[] = [];
  for (const [name, runs] of Object.entries(runData)) {
    const link = links.get(name);
    const list: LogNode[] = [];
    runs.forEach((task, runIndex) => {
      const node: LogNode = {
        id: `${name}#${runIndex}`,
        node: name,
        runIndex,
        type: link?.type ?? 'main',
        status: task.error ? 'error' : task.executionStatus,
        start: task.startTime,
        duration: task.executionTime ?? 0,
        children: [],
        task,
      };
      list.push(node);
      all.push(node);
    });
    nodes.set(name, list);
  }

  const roots: LogNode[] = [];
  for (const node of all.sort(byStart)) {
    const link = links.get(node.node);
    if (!link) {
      roots.push(node);
      continue;
    }
    // the node named by the run's source wins when several parents share this sub-node
    const previous = node.task.source?.[0]?.previousNode;
    const parentName = previous && link.parents.includes(previous) ? previous : link.parents[0];
    const candidates = (parentName ? nodes.get(parentName) : undefined) ?? [];
    let parent: LogNode | undefined;
    if (links.has(parentName ?? '')) {
      // a sub-node parent is logged after its children (stamped when its call ends): the earliest one
      // that starts at or after this run is the call it belongs to
      for (const run of candidates) {
        if (run === node) continue;
        if (run.start >= node.start && (!parent || run.start < parent.start)) parent = run;
      }
    }
    if (!parent) {
      for (const run of candidates) {
        if (run === node) continue;
        if (run.start <= node.start && (!parent || run.start >= parent.start)) parent = run;
      }
    }
    parent ??= candidates.find((run) => run !== node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sum = (node: LogNode): TokenCount | undefined => {
    node.children.sort(byStart);
    let total = ownTokens(node.task);
    for (const child of node.children) {
      const part = sum(child);
      if (part) {
        total = {
          inputTokens: (total?.inputTokens ?? 0) + part.inputTokens,
          outputTokens: (total?.outputTokens ?? 0) + part.outputTokens,
        };
      }
    }
    if (total) node.tokens = total;
    return total;
  };
  for (const root of roots) sum(root);
  return roots;
}

export interface LogRow {
  node: LogNode;
  depth: number;
  parent: LogNode | null;
}

/** the rows a tree shows: a node's children only while it is expanded */
export function visibleRows(roots: LogNode[], collapsed: ReadonlySet<string>): LogRow[] {
  const rows: LogRow[] = [];
  const walk = (list: LogNode[], depth: number, parent: LogNode | null) => {
    for (const node of list) {
      rows.push({ node, depth, parent });
      if (node.children.length && !collapsed.has(node.id)) walk(node.children, depth + 1, node);
    }
  };
  walk(roots, 0, null);
  return rows;
}

export function findLogNode(roots: LogNode[], id: string | null): LogNode | undefined {
  if (!id) return undefined;
  for (const node of roots) {
    if (node.id === id) return node;
    const inside = findLogNode(node.children, id);
    if (inside) return inside;
  }
  return undefined;
}

/** tokens of the whole run: the roots summed */
export function totalTokens(roots: LogNode[]): TokenCount | undefined {
  let total: TokenCount | undefined;
  for (const root of roots) {
    if (!root.tokens) continue;
    total = {
      inputTokens: (total?.inputTokens ?? 0) + root.tokens.inputTokens,
      outputTokens: (total?.outputTokens ?? 0) + root.tokens.outputTokens,
    };
  }
  return total;
}
