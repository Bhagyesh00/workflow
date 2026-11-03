/**
 * A small in-browser stand-in for the execution engine, used by the demo build and the tests.
 * It walks the graph like the real engine (depth first, multi-input nodes wait for all inputs),
 * evaluates expressions with the real sandboxed interpreter, and emits the same push events.
 * Only the demo node types have behaviour; anything else passes its input through.
 */
import {
  deepCopy,
  type ExecutionErrorShape,
  ExpressionEvaluator,
  type FilterCondition,
  type FilterValue,
  type Item,
  isExpression,
  type RunData,
  setByPath,
  type TaskData,
  type WorkflowNode,
} from '@workflow/workflow';
import type { PushEvent } from '../api/types';
import { buildExpressionContext, type PreviewWorkflow } from '../lib/expression-context';
import { getAncestors, getMainParents, listConnections } from '../lib/workflow-ops';
import { demoContacts } from './fixtures';

export interface SimulationInput {
  executionId: string;
  workflow: PreviewWorkflow & { pinData?: Record<string, Item[]> };
  mode: 'manual' | 'webhook' | 'trigger' | 'retry';
  destinationNode?: string;
  startNode?: string;
  triggerItems?: Item[];
  /** P3-06 partial run: the last run data the editor sent (L6 plans the run from it) */
  runData?: RunData;
  /** P3-06: nodes changed since that run data was produced */
  dirtyNodeNames?: string[];
  variables: Record<string, string>;
  emit: (event: PushEvent) => void;
  /** pause between nodes, so the canvas can show progress */
  stepDelayMs: number;
  signal?: { canceled: boolean };
}

export interface SimulationResult {
  status: 'success' | 'error' | 'canceled';
  runData: RunData;
  error?: ExecutionErrorShape;
  lastNodeExecuted?: string;
}

const evaluator = new ExpressionEvaluator({ timeoutMs: 500, maxSteps: 500_000 });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class NodeFailure extends Error {
  constructor(
    message: string,
    readonly description?: string,
  ) {
    super(message);
  }
}

function compare(condition: FilterCondition, left: unknown, right: unknown, caseSensitive: boolean): boolean {
  const str = (v: unknown) => (caseSensitive ? String(v ?? '') : String(v ?? '').toLowerCase());
  const num = (v: unknown) => Number(v);
  const date = (v: unknown) => new Date(String(v)).getTime();
  const empty = (v: unknown) =>
    v === undefined ||
    v === null ||
    v === '' ||
    (Array.isArray(v) && !v.length) ||
    (typeof v === 'object' && v !== null && !Object.keys(v).length);
  const { type, operation } = condition.operator;
  switch (operation) {
    case 'exists':
      return left !== undefined && left !== null;
    case 'notExists':
      return left === undefined || left === null;
    case 'empty':
      return empty(left);
    case 'notEmpty':
      return !empty(left);
    case 'true':
      return left === true || left === 'true';
    case 'false':
      return left === false || left === 'false';
    case 'equals':
      return type === 'number'
        ? num(left) === num(right)
        : type === 'dateTime'
          ? date(left) === date(right)
          : str(left) === str(right);
    case 'notEquals':
      return type === 'number' ? num(left) !== num(right) : str(left) !== str(right);
    case 'contains':
      return Array.isArray(left) ? left.includes(right) : str(left).includes(str(right));
    case 'notContains':
      return Array.isArray(left) ? !left.includes(right) : !str(left).includes(str(right));
    case 'startsWith':
      return str(left).startsWith(str(right));
    case 'notStartsWith':
      return !str(left).startsWith(str(right));
    case 'endsWith':
      return str(left).endsWith(str(right));
    case 'notEndsWith':
      return !str(left).endsWith(str(right));
    case 'regex':
    case 'notRegex': {
      let matches = false;
      try {
        matches = new RegExp(String(right ?? ''), caseSensitive ? '' : 'i').test(String(left ?? ''));
      } catch {
        matches = false;
      }
      return operation === 'regex' ? matches : !matches;
    }
    case 'gt':
      return num(left) > num(right);
    case 'gte':
      return num(left) >= num(right);
    case 'lt':
      return num(left) < num(right);
    case 'lte':
      return num(left) <= num(right);
    case 'after':
      return date(left) > date(right);
    case 'afterOrEquals':
      return date(left) >= date(right);
    case 'before':
      return date(left) < date(right);
    case 'beforeOrEquals':
      return date(left) <= date(right);
    case 'lengthEquals':
      return Array.isArray(left) && left.length === num(right);
    case 'lengthNotEquals':
      return Array.isArray(left) && left.length !== num(right);
    case 'lengthGt':
      return Array.isArray(left) && left.length > num(right);
    case 'lengthGte':
      return Array.isArray(left) && left.length >= num(right);
    case 'lengthLt':
      return Array.isArray(left) && left.length < num(right);
    case 'lengthLte':
      return Array.isArray(left) && left.length <= num(right);
    default:
      return false;
  }
}

export async function simulateExecution(input: SimulationInput): Promise<SimulationResult> {
  const { workflow, emit, executionId } = input;
  const nodes = new Map(workflow.nodes.map((n) => [n.name, n]));
  const runData: RunData = {};
  const connections = listConnections(workflow.connections);
  const allowed = input.destinationNode
    ? new Set([input.destinationNode, ...getAncestors(workflow.connections, input.destinationNode)])
    : null;

  const resolve = (node: WorkflowNode, value: unknown, itemIndex: number): unknown => {
    if (!isExpression(value)) return value;
    const ctx = buildExpressionContext({
      workflow,
      runData,
      pinData: workflow.pinData,
      nodeName: node.name,
      itemIndex,
      variables: input.variables,
      executionId,
    });
    return evaluator.evaluate(value, ctx);
  };

  const execute = (node: WorkflowNode, inputs: Item[][]): Item[][] => {
    const items = inputs[0] ?? [];
    const p = node.parameters ?? {};
    switch (node.type) {
      case 'core.manualTrigger':
        return [input.triggerItems ?? [{ json: {} }]];
      case 'core.webhook':
        return [
          input.triggerItems ?? [
            {
              json: {
                headers: { 'content-type': 'application/json', 'user-agent': 'demo-client/1.0' },
                query: {},
                body: {
                  orderId: 1042,
                  total: 249.5,
                  currency: 'EUR',
                  customer: { name: 'Mara Quinn', email: 'mara@example.com' },
                },
              },
            },
          ],
        ];
      case 'core.scheduleTrigger':
        return [[{ json: { timestamp: new Date().toISOString(), timezone: 'UTC' } }]];
      case 'core.set':
        return [
          items.map((item, i) => {
            const include = resolve(node, p.includeOtherFields ?? true, i) !== false;
            const json: Record<string, unknown> = include ? deepCopy(item.json) : {};
            if ((p.mode ?? 'manual') === 'raw') {
              const raw = resolve(node, p.jsonOutput ?? '{}', i);
              let parsed: unknown = raw;
              if (typeof raw === 'string') {
                try {
                  parsed = JSON.parse(raw);
                } catch (e) {
                  throw new NodeFailure(`JSON Output is not valid JSON: ${(e as Error).message}`);
                }
              }
              return { json: { ...json, ...(parsed as object) }, pairedItem: { item: i } };
            }
            const assignments =
              (p.assignments as { assignments?: Array<{ name: string; value: unknown; type: string }> })
                ?.assignments ?? [];
            for (const a of assignments) {
              if (!a.name) continue;
              let value = resolve(node, a.value, i);
              if (a.type === 'number') value = Number(value);
              else if (a.type === 'boolean') value = value === true || value === 'true';
              else if (a.type === 'string' && typeof value !== 'string')
                value = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
              setByPath(json, a.name, value);
            }
            return { json, pairedItem: { item: i } };
          }),
        ];
      case 'core.if':
      case 'core.switch': {
        const test = (filterValue: unknown, i: number) => {
          const filter = (filterValue ?? {}) as Partial<FilterValue>;
          const conditions = filter.conditions ?? [];
          const caseSensitive = filter.options?.caseSensitive !== false;
          const results = conditions.map((c) =>
            compare(c, resolve(node, c.leftValue, i), resolve(node, c.rightValue, i), caseSensitive),
          );
          if (!results.length) return true;
          return filter.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
        };
        if (node.type === 'core.if') {
          const yes: Item[] = [];
          const no: Item[] = [];
          for (const [i, item] of items.entries()) {
            (test(p.conditions, i) ? yes : no).push({ json: item.json, pairedItem: { item: i } });
          }
          return [yes, no];
        }
        const rules = (p.rules as { values?: Array<{ conditions?: unknown }> })?.values ?? [];
        const outputs: Item[][] = rules.map(() => []);
        items.forEach((item, i) => {
          const index = rules.findIndex((r) => test(r.conditions, i));
          if (index >= 0) outputs[index].push({ json: item.json, pairedItem: { item: i } });
        });
        return outputs;
      }
      case 'core.merge':
        return [inputs.flat().map((item, i) => ({ json: item.json, pairedItem: { item: i } }))];
      case 'core.code':
        emit({
          type: 'consoleMessage',
          data: { executionId, nodeName: node.name, args: ['items in:', items.length] },
        });
        emit({
          type: 'consoleMessage',
          data: {
            executionId,
            nodeName: node.name,
            args: ['Demo mode: Code runs in a server-side sandbox, so items pass through here.'],
          },
        });
        return [items.map((item, i) => ({ json: item.json, pairedItem: { item: i } }))];
      case 'core.httpRequest':
        return [
          items.map((_, i) => {
            const url = String(resolve(node, p.url ?? '', i) ?? '');
            if (!url)
              throw new NodeFailure('The URL parameter is empty', 'Enter the address of the API to call.');
            return {
              json: { statusCode: 200, url, body: { ok: true, receivedAt: new Date().toISOString() } },
              pairedItem: { item: i },
            };
          }),
        ];
      case 'app.crm':
        return [
          items.map((_, i) => {
            const contact = demoContacts[i % demoContacts.length];
            return {
              json: {
                id: contact.value,
                name: contact.name,
                email: `${contact.value}@example.com`,
                stage: 'qualified',
              },
              pairedItem: { item: i },
            };
          }),
        ];
      case 'ai.agent': {
        const out = items.map((_, i) => {
          const prompt = String(resolve(node, p.text ?? '', i) ?? '');
          return {
            json: { output: `Here is a demo answer to: ${prompt || 'your question'}` },
            pairedItem: { item: i },
          };
        });
        // record what each attached sub-node "did", like logSubNodeRun on the server
        for (const c of connections.filter((c) => c.target === node.name && c.targetType !== 'main')) {
          const runs = (runData[c.source] ??= []);
          const task: TaskData = {
            startTime: Date.now(),
            executionTime: 120,
            executionStatus: 'success',
            inputOverride: {
              [c.sourceType]: [[{ json: { messages: [{ role: 'user', content: 'demo prompt' }] } }]],
            },
            data: { [c.sourceType]: [[{ json: { response: 'demo response' } }]] },
            source: [{ previousNode: node.name }],
          };
          runs.push(task);
          emit({
            type: 'nodeExecuteAfter',
            data: { executionId, nodeName: c.source, runIndex: runs.length - 1, taskData: task },
          });
        }
        return [out];
      }
      default:
        return [items.map((item, i) => ({ json: item.json, binary: item.binary, pairedItem: { item: i } }))];
    }
  };

  emit({ type: 'executionStarted', data: { executionId, workflowId: workflow.id ?? '', mode: input.mode } });

  // start node: requested, first trigger, or first node without inputs
  const roots = workflow.nodes.filter(
    (n) =>
      !n.disabled &&
      getMainParents(workflow.connections, n.name).length === 0 &&
      !connections.some((c) => c.source === n.name && c.sourceType !== 'main'),
  );
  const start =
    (input.startNode && nodes.get(input.startNode)) ||
    roots.find((n) => /trigger|webhook/i.test(n.type)) ||
    roots[0];
  if (!start || (allowed && !allowed.has(start.name))) {
    const error = {
      name: 'WorkflowOperationError',
      message: 'There is no node to start from. Add a trigger.',
    };
    emit({
      type: 'executionFinished',
      data: { executionId, workflowId: workflow.id ?? '', status: 'error', error },
    });
    return { status: 'error', runData, error };
  }

  const waiting = new Map<string, Item[][]>();
  const stack: Array<{ node: WorkflowNode; inputs: Item[][]; source: string | null }> = [
    { node: start, inputs: [[]], source: null },
  ];
  let lastNode: string | undefined;

  while (stack.length) {
    if (input.signal?.canceled) {
      emit({
        type: 'executionFinished',
        data: { executionId, workflowId: workflow.id ?? '', status: 'canceled' },
      });
      return { status: 'canceled', runData, lastNodeExecuted: lastNode };
    }
    const { node, inputs, source } = stack.shift()!;
    emit({ type: 'nodeExecuteBefore', data: { executionId, nodeName: node.name } });
    if (input.stepDelayMs) await wait(input.stepDelayMs);
    const startTime = Date.now();
    let output: Item[][];
    let failure: ExecutionErrorShape | undefined;
    try {
      const pinned = workflow.pinData?.[node.name];
      if (pinned) output = [pinned];
      else if (node.disabled) output = [inputs[0] ?? []];
      else output = execute(node, inputs);
    } catch (error) {
      const e = error as NodeFailure;
      failure = {
        name: 'NodeOperationError',
        message: e.message,
        description: e.description,
        node: node.name,
      };
      output = node.onError === 'continueRegularOutput' ? [[{ json: { error: e.message } }]] : [];
    }
    if (failure && node.onError === 'continueErrorOutput') {
      output = [...Array.from({ length: Math.max(1, output.length) }, () => [] as Item[]), inputs[0] ?? []];
    }
    const task: TaskData = {
      startTime,
      executionTime: Date.now() - startTime + (input.stepDelayMs ? 40 + Math.round(Math.random() * 160) : 0),
      executionStatus: failure && !node.onError ? 'error' : 'success',
      data: { main: output },
      error: failure && !node.onError ? failure : undefined,
      source: source ? [{ previousNode: source }] : [],
    };
    const runs = (runData[node.name] ??= []);
    runs.push(task);
    lastNode = node.name;
    emit({
      type: 'nodeExecuteAfter',
      data: { executionId, nodeName: node.name, runIndex: runs.length - 1, taskData: task },
    });
    if (failure && !node.onError) {
      emit({
        type: 'executionFinished',
        data: { executionId, workflowId: workflow.id ?? '', status: 'error', error: failure },
      });
      return { status: 'error', runData, error: failure, lastNodeExecuted: lastNode };
    }
    if (input.destinationNode === node.name) break;

    const children: Array<{ node: WorkflowNode; inputs: Item[][]; source: string }> = [];
    for (const c of connections) {
      if (c.source !== node.name || c.sourceType !== 'main') continue;
      const items = output[c.sourceIndex];
      const child = nodes.get(c.target);
      if (!child || !items?.length || (allowed && !allowed.has(child.name))) continue;
      const inputCount = Math.max(
        1,
        ...getMainParents(workflow.connections, child.name).map((pa) => pa.inputIndex + 1),
      );
      if (inputCount > 1) {
        const collected = waiting.get(child.name) ?? Array.from({ length: inputCount }, () => [] as Item[]);
        collected[c.targetIndex] = items;
        if (collected.every((list) => list.length)) {
          waiting.delete(child.name);
          children.push({ node: child, inputs: collected, source: node.name });
        } else {
          waiting.set(child.name, collected);
        }
      } else {
        children.push({ node: child, inputs: [items], source: node.name });
      }
    }
    children.sort(
      (a, b) => a.node.position[1] - b.node.position[1] || a.node.position[0] - b.node.position[0],
    );
    stack.unshift(...children);
    if (!stack.length && waiting.size) {
      // run multi-input nodes with whatever arrived
      for (const [name, collected] of waiting)
        stack.push({ node: nodes.get(name)!, inputs: collected, source: node.name });
      waiting.clear();
    }
  }

  emit({
    type: 'executionFinished',
    data: { executionId, workflowId: workflow.id ?? '', status: 'success' },
  });
  return { status: 'success', runData, lastNodeExecuted: lastNode };
}
