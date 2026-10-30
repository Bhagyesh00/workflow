/**
 * Expression previews in the editor: builds the same `ExpressionDataContext` the engine builds,
 * from the run data the editor holds (plus pinned data), and evaluates with the sandboxed
 * interpreter from `@workflow/workflow` under a tight budget.
 */
import {
  type Connections,
  type ExpressionDataContext,
  ExpressionEvaluator,
  type Item,
  type NodeParameters,
  type RunData,
  type SourceData,
  stringifyValue,
  type TaskData,
  type WorkflowNode,
} from '@workflow/workflow';
import { getMainParents } from './workflow-ops';

export interface PreviewWorkflow {
  id?: string;
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Connections;
}

export interface PreviewInput {
  workflow: PreviewWorkflow;
  runData: RunData;
  pinData?: Record<string, Item[]>;
  nodeName: string;
  itemIndex?: number;
  variables?: Record<string, string>;
  timezone?: string;
  executionId?: string;
  /** current (possibly unsaved) parameters of the active node */
  parameters?: NodeParameters;
}

/** Run data with pinned outputs filled in for nodes that have not run. */
export function withPinnedData(runData: RunData, pinData: Record<string, Item[]> | undefined): RunData {
  if (!pinData) return runData;
  const merged: RunData = { ...runData };
  for (const [name, items] of Object.entries(pinData)) {
    if (merged[name]?.length) continue;
    const task: TaskData = {
      startTime: 0,
      executionTime: 0,
      executionStatus: 'success',
      data: { main: [items] },
      source: [],
    };
    merged[name] = [task];
  }
  return merged;
}

/** Output items of `node` (last run unless `runIndex` given). */
export function getNodeOutput(
  runData: RunData,
  node: string,
  outputIndex = 0,
  runIndex?: number,
): Item[] | null {
  const runs = runData[node];
  if (!runs?.length) return null;
  const task = runs[runIndex ?? runs.length - 1];
  return (task?.data?.main?.[outputIndex] as Item[] | null | undefined) ?? null;
}

export interface InputSelection {
  parent: string | null;
  outputIndex: number;
  runIndex: number;
  items: Item[];
}

/** The input the active node would see: its first main parent that has data. */
export function resolveInput(workflow: PreviewWorkflow, runData: RunData, nodeName: string): InputSelection {
  const parents = getMainParents(workflow.connections, nodeName).filter((p) => p.inputIndex === 0);
  const parent = parents.find((p) => runData[p.node]?.length) ?? parents[0];
  if (!parent || !runData[parent.node]?.length) {
    return { parent: parent?.node ?? null, outputIndex: parent?.outputIndex ?? 0, runIndex: 0, items: [] };
  }
  const runIndex = runData[parent.node].length - 1;
  return {
    parent: parent.node,
    outputIndex: parent.outputIndex,
    runIndex,
    items: getNodeOutput(runData, parent.node, parent.outputIndex, runIndex) ?? [],
  };
}

export function buildExpressionContext(input: PreviewInput): ExpressionDataContext {
  const runData = withPinnedData(input.runData, input.pinData);
  const nodesByName = Object.fromEntries(input.workflow.nodes.map((n) => [n.name, n]));
  const selection = resolveInput(input.workflow, runData, input.nodeName);
  const source: SourceData | null = selection.parent
    ? {
        previousNode: selection.parent,
        previousNodeOutput: selection.outputIndex,
        previousNodeRun: selection.runIndex,
      }
    : null;
  return {
    workflow: {
      id: input.workflow.id,
      name: input.workflow.name,
      active: input.workflow.active,
      nodes: nodesByName,
    },
    runData,
    activeNodeName: input.nodeName,
    connectionInputData: selection.items,
    itemIndex: Math.min(input.itemIndex ?? 0, Math.max(0, selection.items.length - 1)),
    runIndex: 0,
    mode: 'manual',
    executionId: input.executionId ?? 'preview',
    timezone: input.timezone ?? 'UTC',
    variables: input.variables ?? {},
    executeData: {
      node: input.nodeName,
      data: { main: [selection.items] },
      source: source ? { main: [source] } : null,
    },
    nodeParameters: input.parameters ?? nodesByName[input.nodeName]?.parameters,
  };
}

export type PreviewResult = { ok: true; value: unknown; text: string } | { ok: false; error: string };

const previewEvaluator = new ExpressionEvaluator({ timeoutMs: 250, maxSteps: 250_000 });

export function formatPreviewValue(value: unknown): string {
  if (value === undefined) return '[undefined]';
  if (value === null) return '[null]';
  if (typeof value === 'string') return value === '' ? '[empty]' : value;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const text = stringifyValue(value);
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return text;
      }
    }
    return text;
  }
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return stringifyValue(value);
    }
  }
  return stringifyValue(value);
}

export function previewExpression(expression: string, ctx: ExpressionDataContext): PreviewResult {
  try {
    const value = previewEvaluator.evaluate(expression, ctx);
    const text = formatPreviewValue(value);
    return { ok: true, value, text: text.length > 5000 ? `${text.slice(0, 5000)}…` : text };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? String(error) };
  }
}
