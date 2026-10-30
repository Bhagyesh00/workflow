/**
 * Builds the `$`-variables available to expressions ($json, $input, $('Node'), $execution, ...)
 * for one node + item. Pure function of the execution state, so it runs identically on the
 * server and in the editor (expression preview).
 */
import { DateTime } from 'luxon';
import { ExpressionError } from '../errors';
import type {
  DataObject,
  ExecuteData,
  ExecutionMode,
  Item,
  NodeParameters,
  PairedItem,
  RunData,
  SourceData,
  WorkflowNode,
} from '../interfaces';

export interface ExpressionDataContext {
  workflow: { id?: string; name: string; active: boolean; nodes: Record<string, WorkflowNode> };
  runData: RunData;
  /** node whose parameters are being resolved */
  activeNodeName: string;
  /** items on the active node's first main input */
  connectionInputData: Item[];
  itemIndex: number;
  runIndex: number;
  mode: ExecutionMode;
  executionId: string;
  timezone: string;
  /** tenant variables ($vars) */
  variables?: Record<string, string>;
  /** source info for the active node's inputs (paired item resolution) */
  executeData?: ExecuteData;
  resumeUrl?: string;
  customData?: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    getAll(): Record<string, string>;
  };
  /** raw parameters of the active node ($parameter) */
  nodeParameters?: NodeParameters;
  /** additional variables, e.g. $fromAI for tool nodes */
  extra?: Record<string, unknown>;
}

function normalizePaired(paired: Item['pairedItem']): PairedItem[] {
  if (paired === undefined || paired === null) return [];
  if (typeof paired === 'number') return [{ item: paired }];
  return Array.isArray(paired) ? paired : [paired];
}

function lastRunIndex(runData: RunData, node: string): number {
  return (runData[node]?.length ?? 0) - 1;
}

function getOutputItems(runData: RunData, node: string, output = 0, run = -1): Item[] {
  const runs = runData[node];
  if (!runs?.length) throw new ExpressionError(`Node "${node}" has not been executed`);
  const runIndex = run < 0 ? runs.length - 1 : run;
  const task = runs[runIndex];
  if (!task) throw new ExpressionError(`Node "${node}" has no run ${runIndex}`);
  return task.data?.main?.[output] ?? [];
}

/**
 * Follow pairedItem links from `item` (an output item of `source`) back to `target`.
 * Returns the matching item of `target`, or throws if the chain is broken.
 */
export function resolvePairedItem(
  runData: RunData,
  target: string,
  source: SourceData,
  itemIndex: number,
  depth = 0,
): Item {
  if (depth > 500) throw new ExpressionError('Paired item chain is too deep');
  const node = source.previousNode;
  const run = source.previousNodeRun ?? lastRunIndex(runData, node);
  const task = runData[node]?.[run];
  if (!task) throw new ExpressionError(`Node "${node}" has not been executed`);
  const items = task.data?.main?.[source.previousNodeOutput ?? 0] ?? [];
  const item = items[itemIndex];
  if (!item) throw new ExpressionError(`Item ${itemIndex} of node "${node}" does not exist`);
  if (node === target) return item;

  let paired = normalizePaired(item.pairedItem);
  if (!paired.length) {
    const firstSource = task.source?.[0];
    const parentItems = firstSource
      ? (runData[firstSource.previousNode]?.[firstSource.previousNodeRun ?? 0]?.data?.main?.[
          firstSource.previousNodeOutput ?? 0
        ] ?? [])
      : [];
    if (parentItems.length === 1) paired = [{ item: 0 }];
    else if (parentItems.length === items.length) paired = [{ item: itemIndex }];
  }
  if (!paired.length) {
    throw new ExpressionError(`Can't get data for expression: paired item information is missing`, {
      description: `Node "${node}" did not return information about which input item produced output item ${itemIndex}.`,
    });
  }

  let lastError: unknown;
  for (const p of paired) {
    const parentSource = task.source?.[p.input ?? 0];
    if (!parentSource) continue;
    try {
      return resolvePairedItem(runData, target, parentSource, p.item, depth + 1);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new ExpressionError(`Node "${target}" is not an ancestor of the current item`);
}

function nodeAccessor(ctx: ExpressionDataContext, name: string) {
  const node = ctx.workflow.nodes[name];
  if (!node) throw new ExpressionError(`Referenced node "${name}" does not exist`);
  const source = ctx.executeData?.source?.main?.[0] ?? undefined;
  const pairedFor = (itemIndex: number): Item => {
    if (!source) {
      return getOutputItems(ctx.runData, name)[itemIndex] ?? getOutputItems(ctx.runData, name)[0];
    }
    return resolvePairedItem(ctx.runData, name, source, itemIndex);
  };
  return Object.freeze({
    get item() {
      return pairedFor(ctx.itemIndex);
    },
    itemMatching: (itemIndex: number) => pairedFor(itemIndex),
    first: (branch = 0, run = -1) => getOutputItems(ctx.runData, name, branch, run)[0],
    last: (branch = 0, run = -1) => {
      const items = getOutputItems(ctx.runData, name, branch, run);
      return items[items.length - 1];
    },
    all: (branch = 0, run = -1) => getOutputItems(ctx.runData, name, branch, run),
    get isExecuted() {
      return Boolean(ctx.runData[name]?.length);
    },
    get params() {
      return node.parameters;
    },
  });
}

export function createDataProxy(ctx: ExpressionDataContext): Record<string, unknown> {
  const item = ctx.connectionInputData[ctx.itemIndex];
  const zone = ctx.timezone || 'UTC';
  const prevSource = ctx.executeData?.source?.main?.[0] ?? undefined;
  const node = ctx.workflow.nodes[ctx.activeNodeName];

  const $input = Object.freeze({
    get item() {
      return item;
    },
    all: () => ctx.connectionInputData,
    first: () => ctx.connectionInputData[0],
    last: () => ctx.connectionInputData[ctx.connectionInputData.length - 1],
    get params() {
      return ctx.nodeParameters ?? node?.parameters ?? {};
    },
  });

  const $ = (name: string) => nodeAccessor(ctx, String(name));

  // legacy accessor: $node["Name"].json / .parameter
  const $node = new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== 'string') return undefined;
        const n = ctx.workflow.nodes[name];
        if (!n) throw new ExpressionError(`Referenced node "${name}" does not exist`);
        const items = ctx.runData[name]?.length ? getOutputItems(ctx.runData, name) : [];
        const chosen = items[ctx.itemIndex] ?? items[0];
        return Object.freeze({
          json: chosen?.json,
          binary: chosen?.binary,
          parameter: n.parameters,
          runIndex: lastRunIndex(ctx.runData, name),
        });
      },
      set() {
        return false;
      },
    },
  );

  const $env = new Proxy(
    {},
    {
      get() {
        throw new ExpressionError('Access to environment variables is disabled. Use $vars instead.');
      },
    },
  );

  const vars: Record<string, string> = Object.freeze({ ...(ctx.variables ?? {}) });

  const $execution = Object.freeze({
    id: ctx.executionId,
    mode: ctx.mode === 'manual' ? 'test' : 'production',
    resumeUrl: ctx.resumeUrl,
    customData: Object.freeze({
      set: (key: string, value: unknown) => ctx.customData?.set(String(key), String(value)),
      get: (key: string) => ctx.customData?.get(String(key)),
      getAll: () => ctx.customData?.getAll() ?? {},
      setAll: (values: DataObject) => {
        for (const [k, v] of Object.entries(values)) ctx.customData?.set(k, String(v));
      },
    }),
  });

  return {
    $json: item?.json,
    $binary: item?.binary,
    $input,
    $: $,
    $node,
    $items: (name?: string, output = 0, run = -1) =>
      name ? getOutputItems(ctx.runData, name, output, run) : ctx.connectionInputData,
    $prevNode: Object.freeze({
      name: prevSource?.previousNode,
      outputIndex: prevSource?.previousNodeOutput ?? 0,
      runIndex: prevSource?.previousNodeRun ?? 0,
    }),
    $parameter: ctx.nodeParameters ?? node?.parameters ?? {},
    $runIndex: ctx.runIndex,
    $itemIndex: ctx.itemIndex,
    $now: DateTime.now().setZone(zone),
    $today: DateTime.now().setZone(zone).startOf('day'),
    $env,
    $vars: vars,
    $execution,
    $workflow: Object.freeze({ id: ctx.workflow.id, name: ctx.workflow.name, active: ctx.workflow.active }),
    ...(ctx.extra ?? {}),
  };
}
