/**
 * The execution engine.
 *
 * Semantics (documented in docs/ARCHITECTURE.md, "Execution model"):
 * - Depth-first: when a node finishes, its children are put at the FRONT of the stack ordered by
 *   canvas position (top-to-bottom, then left-to-right), so one branch completes before the next.
 * - A node with several main inputs waits until every connected input has data. When nothing else
 *   can run, waiting nodes run with the inputs they have (most-upstream first).
 * - Empty outputs do not trigger children (unless the node has "Always output data").
 * - Run data is deep-frozen once recorded: downstream nodes and expressions cannot mutate it.
 * - The whole state is JSON-serializable so executions can pause (Wait node) and resume in another
 *   process, and queue workers can pick them up.
 */
import {
  type ConnectionType,
  type DataObject,
  deepFreeze,
  type ExecuteData,
  ExecutionCancelledError,
  type ExecutionResult,
  type ExecutionState,
  type ExecutionStatus,
  ExecutionTimeoutError,
  ExpressionEvaluator,
  evaluateSimple,
  type Item,
  type NodeInputConfig,
  NodeOperationError,
  type NodeOutput,
  type NodeOutputConfig,
  type NodeType,
  normalizePairedItems,
  portType,
  QuotaExceededError,
  resolvePorts,
  type SourceData,
  type SupplyDataContext,
  serializeError,
  sleep,
  sortByPosition,
  type TaskData,
  type Workflow,
  type WorkflowNode,
  WorkflowOperationError,
} from '@workflow/workflow';
import {
  assertValidOutput,
  type ContextDeps,
  createBaseContext,
  createCodeRunnerCall,
  createExecuteContext,
  createSubWorkflowCaller,
  getResolvedParameters,
} from './node-context';
import type { ExecutionServices } from './services';

export interface RunOptions {
  /** node to start from (defaults to the first trigger) */
  startNode?: string;
  /** items emitted by the trigger / webhook / manual run */
  triggerItems?: Item[];
  /** manual partial execution: stop after this node */
  destinationNode?: string;
  /** pinned outputs (manual mode) */
  pinData?: Record<string, Item[]>;
  /** overrides workflow settings / tenant default */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResumeOptions {
  /** replaces the output of the node that was waiting (e.g. data received by a resume webhook) */
  output?: Item[][];
  timeoutMs?: number;
  signal?: AbortSignal;
}

type NodeOutcome = 'continue' | 'stop' | 'wait';

/** wait before the next retry: fixed or exponential with ±20% jitter, honouring Retry-After (capped) */
export function retryDelay(node: WorkflowNode, attempt: number, error: unknown): number {
  const base = Math.min(Math.max(node.waitBetweenTries ?? 1000, 0), 5000);
  let delay =
    node.retryBackoff === 'exponential'
      ? Math.min(base * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS) * (0.8 + Math.random() * 0.4)
      : base;
  const retryAfter = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
  if (typeof retryAfter === 'number' && retryAfter > delay) delay = Math.min(retryAfter, MAX_RETRY_WAIT_MS);
  return Math.round(delay);
}

export function createInitialState(): ExecutionState {
  return {
    startData: {},
    resultData: { runData: {} },
    executionData: {
      nodeExecutionStack: [],
      waitingExecution: {},
      waitingExecutionSource: {},
      contextData: {},
    },
  };
}

const MAX_NODE_RUNS = 100_000;
const MAX_ITEMS_PER_OUTPUT = 1_000_000;
const MAX_RETRY_WAIT_MS = 60_000;

export class WorkflowExecute {
  readonly state: ExecutionState;
  private readonly controller = new AbortController();
  private readonly evaluator: ExpressionEvaluator;
  private lastNodeOutput: Item[][] | null = null;
  private waitTill?: Date;
  /** hooks of logged sub-node runs, chained so they land in order and finish before the parent node does */
  private subNodeHooks: Promise<void> = Promise.resolve();
  private startedAt = Date.now();
  private nodeRuns = 0;
  private runFilter?: Set<string>;

  constructor(
    private readonly workflow: Workflow,
    private readonly services: ExecutionServices,
    state?: ExecutionState,
  ) {
    this.state = state ?? createInitialState();
    this.evaluator = new ExpressionEvaluator({
      timeoutMs: services.limits?.expressionTimeoutMs ?? 1000,
      maxSteps: services.limits?.expressionMaxSteps ?? 1_000_000,
    });
    if (this.state.startData.runNodeFilter) this.runFilter = new Set(this.state.startData.runNodeFilter);
  }

  cancel(reason?: string): void {
    this.controller.abort(new ExecutionCancelledError(reason));
  }

  async run(options: RunOptions = {}): Promise<ExecutionResult> {
    const start = this.workflow.getStartNode(options.startNode);
    if (!start) throw new WorkflowOperationError('The workflow has no node to start from');

    if (options.destinationNode) {
      if (!this.workflow.nodes[options.destinationNode]) {
        throw new WorkflowOperationError(`Destination node "${options.destinationNode}" does not exist`);
      }
      this.state.startData.destinationNode = options.destinationNode;
      const filter = [
        options.destinationNode,
        ...this.workflow.getParentNodes(options.destinationNode, 'main'),
      ];
      this.state.startData.runNodeFilter = filter;
      this.runFilter = new Set(filter);
    }
    if (options.pinData && Object.keys(options.pinData).length) {
      this.state.resultData.pinData = options.pinData;
    }
    this.state.executionData.nodeExecutionStack.push({
      node: start.name,
      data: { main: [options.triggerItems?.length ? options.triggerItems : [{ json: {} }]] },
      source: null,
    });
    return this.process(options);
  }

  /**
   * Re-run the node that stopped this execution with the same inputs, reusing every upstream
   * output. Works on a new engine built from the persisted state, optionally with a newer
   * version of the workflow (the node must still exist).
   */
  async retryFromFailure(options: ResumeOptions = {}): Promise<ExecutionResult> {
    const failed = this.state.executionData.failedExecuteData;
    if (!failed) throw new WorkflowOperationError('This execution has no failed node to retry from');
    if (!this.workflow.nodes[failed.node]) {
      throw new WorkflowOperationError(`Node "${failed.node}" no longer exists in the workflow`);
    }
    this.state.executionData.failedExecuteData = undefined;
    this.state.resultData.error = undefined;
    this.state.executionData.nodeExecutionStack.unshift(failed);
    return this.process(options);
  }

  /** Continue from persisted state after a crash (requires `saveExecutionProgress`). */
  async continueExecution(options: ResumeOptions = {}): Promise<ExecutionResult> {
    return this.process(options);
  }

  /** Continue an execution that was waiting (Wait node, resume webhook). */
  async resume(options: ResumeOptions = {}): Promise<ExecutionResult> {
    const nodeName = this.state.resultData.lastNodeExecuted;
    const runs = nodeName ? this.state.resultData.runData[nodeName] : undefined;
    const task = runs?.[runs.length - 1];
    if (!nodeName || !task || task.executionStatus !== 'waiting') {
      throw new WorkflowOperationError('Execution is not waiting');
    }
    const output = options.output
      ? deepFreeze(this.pairOutput(options.output, []))
      : (task.data?.main as Item[][]);
    runs![runs!.length - 1] = {
      ...task,
      executionStatus: 'success',
      data: { ...task.data, main: output },
      executionTime: Date.now() - task.startTime,
    };
    this.state.waitTill = undefined;
    this.lastNodeOutput = output;
    this.scheduleChildren(this.workflow.nodes[nodeName], output, runs!.length - 1);
    return this.process(options);
  }

  // -------------------------------------------------------------------------------------------

  private async process(options: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExecutionResult> {
    const timeoutSeconds = this.workflow.settings.executionTimeout;
    const timeoutMs = options.timeoutMs ?? (timeoutSeconds ? timeoutSeconds * 1000 : undefined);
    const signals = [this.controller.signal];
    if (options.signal) signals.push(options.signal);
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      const timeoutController = new AbortController();
      timer = setTimeout(
        () => timeoutController.abort(new ExecutionTimeoutError(timeoutMs / 1000)),
        timeoutMs,
      );
      signals.push(timeoutController.signal);
    }
    const signal = AbortSignal.any(signals);

    let status: ExecutionStatus = 'success';
    await this.services.hooks?.workflowExecuteBefore?.(this.state);
    try {
      const stack = this.state.executionData.nodeExecutionStack;
      for (;;) {
        if (signal.aborted) throw signal.reason;
        let next = stack.shift();
        if (!next) next = this.takeWaitingNode();
        if (!next) break;
        const maxNodeRuns = this.services.limits?.maxNodeRuns ?? MAX_NODE_RUNS;
        if (++this.nodeRuns > maxNodeRuns) {
          throw new QuotaExceededError(`Execution exceeded ${maxNodeRuns} node runs (infinite loop?)`);
        }
        const outcome = await this.runNode(next, signal);
        if (outcome === 'stop') {
          status = 'error';
          break;
        }
        if (outcome === 'wait') {
          status = 'waiting';
          break;
        }
      }
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      status = reason instanceof ExecutionCancelledError ? 'canceled' : 'error';
      this.state.resultData.error = serializeError(reason);
    } finally {
      clearTimeout(timer);
    }

    const result: ExecutionResult = {
      status,
      state: this.state,
      startedAt: this.startedAt,
      stoppedAt: Date.now(),
      lastNodeOutput: this.lastNodeOutput,
    };
    await this.services.hooks?.workflowExecuteAfter?.(result);
    return result;
  }

  /** pick a waiting multi-input node none of whose ancestors are also waiting */
  private takeWaitingNode(): ExecuteData | undefined {
    const waiting = this.state.executionData.waitingExecution;
    const names = Object.keys(waiting).filter((n) => Object.keys(waiting[n]).length > 0);
    if (!names.length) return undefined;
    const pick =
      names.find((name) => {
        const parents = new Set(this.workflow.getParentNodes(name, 'main'));
        return !names.some((other) => other !== name && parents.has(other));
      }) ?? names[0];
    const slots = Object.keys(waiting[pick])
      .map(Number)
      .sort((a, b) => a - b);
    const slot = slots[0];
    const data = waiting[pick][slot];
    const source = this.state.executionData.waitingExecutionSource[pick]?.[slot] ?? { main: [] };
    delete waiting[pick][slot];
    delete this.state.executionData.waitingExecutionSource[pick]?.[slot];
    if (!Object.keys(waiting[pick]).length) {
      delete waiting[pick];
      delete this.state.executionData.waitingExecutionSource[pick];
    }
    return { node: pick, data, source };
  }

  private regularOutputCount(node: WorkflowNode, type: NodeType): number {
    const ports = resolvePorts(type.description.outputs, node, (expr, parameters) =>
      evaluateSimple(expr, { $parameter: parameters }),
    );
    return Math.max(1, ports.filter((p) => portType(p) === 'main').length);
  }

  private async runNode(exec: ExecuteData, signal: AbortSignal): Promise<NodeOutcome> {
    const node = this.workflow.nodes[exec.node];
    if (!node) throw new WorkflowOperationError(`Node "${exec.node}" does not exist`);
    const runs = (this.state.resultData.runData[node.name] ??= []);
    const runIndex = runs.length;
    const source = exec.source?.main ?? [];
    const inputItems = exec.data.main?.[0] ?? [];

    await this.services.hooks?.nodeExecuteBefore?.(node.name, runIndex);
    const startTime = Date.now();
    this.waitTill = undefined;

    let output: NodeOutput = null;
    let error: unknown;
    /** attempts actually made (for metadata) */
    let attempts = 1;
    let nodeType: NodeType | undefined;

    try {
      nodeType = this.workflow.getNodeType(node);
      const pinned = this.state.resultData.pinData?.[node.name];
      if (pinned) {
        output = [
          pinned.map((item, i) => ({
            ...item,
            pairedItem: item.pairedItem ?? { item: inputItems.length === pinned.length ? i : 0 },
          })),
        ];
      } else if (node.disabled) {
        output = exec.data.main?.[0]
          ? [exec.data.main[0].map((item, i) => ({ ...item, pairedItem: { item: i } }))]
          : null;
      } else {
        const maxTries = node.retryOnFail
          ? Math.min(Math.max(node.maxTries ?? 3, 2), this.services.limits?.maxTries ?? 5)
          : 1;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
          attempts = attempt;
          try {
            output = await this.executeNode(node, nodeType, exec, runIndex, signal);
            error = undefined;
            break;
          } catch (e) {
            error = e;
            if (signal.aborted) throw signal.reason;
            if (attempt < maxTries) await sleep(retryDelay(node, attempt, e), signal);
          }
        }
        if (error) throw error;
      }
      assertValidOutput(node, output);
      const maxItems = this.services.limits?.maxItemsPerOutput ?? MAX_ITEMS_PER_OUTPUT;
      if (output?.some((items) => (items?.length ?? 0) > maxItems)) {
        throw new QuotaExceededError(
          `Node "${node.name}" returned more than ${maxItems} items in one output`,
        );
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      error = e;
    }

    let errorOutputUsed = false;
    if (error) {
      const serialized = serializeError(error, node.name);
      const onError = node.onError ?? 'stopWorkflow';
      if (onError === 'stopWorkflow' || !nodeType) {
        const task: TaskData = {
          startTime,
          executionTime: Date.now() - startTime,
          executionStatus: 'error',
          error: serialized,
          source,
          metadata: attempts > 1 ? { attempt: attempts } : undefined,
        };
        runs.push(task);
        this.state.resultData.lastNodeExecuted = node.name;
        this.state.resultData.error = serialized;
        this.state.executionData.failedExecuteData = exec;
        await this.services.hooks?.nodeExecuteAfter?.(node.name, runIndex, task, this.state);
        return 'stop';
      }
      if (onError === 'continueRegularOutput') {
        output = [
          [
            {
              json: { error: serialized.message },
              error: { ...serialized, stack: undefined },
              pairedItem: { item: 0 },
            },
          ],
        ];
      } else {
        const outputs: Item[][] = Array.from(
          { length: this.regularOutputCount(node, nodeType) + 1 },
          () => [],
        );
        outputs[outputs.length - 1] = inputItems.map((item, i) => ({
          json: { ...item.json },
          error: { ...serialized, stack: undefined },
          pairedItem: { item: i },
        }));
        output = outputs;
        errorOutputUsed = true;
      }
    } else if (node.onError === 'continueErrorOutput' && output && nodeType) {
      output = this.routeErrorItems(output, this.regularOutputCount(node, nodeType));
    }

    if (node.alwaysOutputData && (!output || output.every((o) => !o || o.length === 0))) {
      output = [[{ json: {}, pairedItem: { item: 0 } }]];
    }

    const finalOutput = output ? deepFreeze(this.pairOutput(output, inputItems)) : null;
    const task: TaskData = {
      startTime,
      executionTime: Date.now() - startTime,
      executionStatus: this.waitTill ? 'waiting' : 'success',
      data: finalOutput ? { main: finalOutput } : undefined,
      source,
      metadata: attempts > 1 ? { attempt: attempts } : undefined,
    };
    if (errorOutputUsed)
      task.hints = [{ message: 'Node failed; items were routed to the error output', level: 'warning' }];
    runs.push(task);
    this.state.resultData.lastNodeExecuted = node.name;
    this.lastNodeOutput = finalOutput;
    await this.services.hooks?.nodeExecuteAfter?.(node.name, runIndex, task, this.state);

    const waitTill = this.waitTill as Date | undefined;
    if (waitTill) {
      this.state.waitTill = waitTill.toISOString();
      return 'wait';
    }
    if (this.state.startData.destinationNode === node.name) return 'continue';
    if (finalOutput) this.scheduleChildren(node, finalOutput, runIndex);
    return 'continue';
  }

  private routeErrorItems(output: Item[][], regularCount: number): Item[][] {
    const regular = output.slice(0, regularCount).map((items) => items ?? []);
    while (regular.length < regularCount) regular.push([]);
    const errors: Item[] = [];
    const cleaned = regular.map((items) =>
      items.filter((item) => {
        if (item.error) {
          errors.push(item);
          return false;
        }
        return true;
      }),
    );
    return [...cleaned, errors];
  }

  /** fill missing pairedItem information */
  private pairOutput(output: Item[][], inputItems: Item[]): Item[][] {
    return output.map((items) =>
      (items ?? []).map((item, i) => {
        if (normalizePairedItems(item.pairedItem).length) return item;
        if (inputItems.length === 1) return { ...item, pairedItem: { item: 0 } };
        if (items.length === inputItems.length) return { ...item, pairedItem: { item: i } };
        return item;
      }),
    );
  }

  private contextDeps(
    node: WorkflowNode,
    exec: ExecuteData,
    runIndex: number,
    signal: AbortSignal,
  ): ContextDeps {
    return {
      workflow: this.workflow,
      node,
      services: this.services,
      evaluator: this.evaluator,
      signal,
      state: this.state,
      runIndex,
      executeData: exec,
    };
  }

  private async executeNode(
    node: WorkflowNode,
    nodeType: NodeType,
    exec: ExecuteData,
    runIndex: number,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    let data = exec.data;
    if (node.executeOnce) {
      data = { ...data, main: data.main?.map((items) => (items ? items.slice(0, 1) : items)) };
    }
    const effectiveExec: ExecuteData = { ...exec, data };

    if (!nodeType.execute) {
      // triggers/webhooks/pollers "execute" by passing through the data they emitted
      if (nodeType.trigger || nodeType.webhook || nodeType.poll)
        return data.main?.[0] ? [data.main[0]] : [[]];
      throw new NodeOperationError(node, `Node type "${node.type}" cannot be executed directly`);
    }

    const deps = this.contextDeps(node, effectiveExec, runIndex, signal);
    const closeFunctions: Array<() => Promise<void>> = [];
    const ctx = createExecuteContext(deps, {
      getInputConnectionData: (type, itemIndex) =>
        this.supplySubNodes(node, nodeType, type, itemIndex, effectiveExec, signal, closeFunctions),
      putExecutionToWait: (waitTill) => {
        this.waitTill = waitTill;
      },
      continueOnFail: () =>
        node.onError === 'continueRegularOutput' || node.onError === 'continueErrorOutput',
    });
    try {
      return await nodeType.execute(ctx);
    } finally {
      await this.subNodeHooks;
      for (const close of closeFunctions) {
        await close().catch((e) => this.services.logger.warn('Sub-node close failed', { error: String(e) }));
      }
    }
  }

  /** resolve AI sub-nodes attached to `parent` via `type` */
  private async supplySubNodes(
    parent: WorkflowNode,
    parentType: NodeType,
    type: ConnectionType,
    itemIndex: number,
    parentExec: ExecuteData,
    signal: AbortSignal,
    closeFunctions: Array<() => Promise<void>>,
  ): Promise<unknown> {
    const inputs = resolvePorts(parentType.description.inputs, parent, (expr, parameters) =>
      evaluateSimple(expr, { $parameter: parameters }),
    );
    const config = inputs.find((p) => portType(p) === type) as NodeInputConfig | ConnectionType | undefined;
    const maxConnections = typeof config === 'object' ? config.maxConnections : undefined;
    const required = typeof config === 'object' ? config.required : false;
    const subNodes = this.workflow.getSubNodes(parent.name, type);

    if (!subNodes.length) {
      if (required) {
        throw new NodeOperationError(
          parent,
          `A sub-node must be connected to the "${type.replace('ai_', '')}" input`,
        );
      }
      return maxConnections === 1 ? undefined : [];
    }

    const results: unknown[] = [];
    for (const sub of subNodes) {
      const subType = this.workflow.getNodeType(sub);
      if (!subType.supplyData) {
        throw new NodeOperationError(sub, `Node "${sub.name}" cannot be used as a ${type} sub-node`);
      }
      const ctx = this.createSupplyDataContext(sub, parent, parentExec, type, signal);
      const supplied = await subType.supplyData(ctx, itemIndex);
      if (supplied.closeFunction) closeFunctions.push(supplied.closeFunction);
      results.push(supplied.response);
    }
    return maxConnections === 1 ? results[0] : results;
  }

  private createSupplyDataContext(
    sub: WorkflowNode,
    parent: WorkflowNode,
    parentExec: ExecuteData,
    type: ConnectionType,
    signal: AbortSignal,
  ): SupplyDataContext {
    const runIndex = this.state.resultData.runData[sub.name]?.length ?? 0;
    const exec: ExecuteData = { node: sub.name, data: parentExec.data, source: parentExec.source };
    const deps = this.contextDeps(sub, exec, runIndex, signal);
    const base = createBaseContext(deps);
    const subType = this.workflow.getNodeType(sub);
    const closeFunctions: Array<() => Promise<void>> = [];
    return {
      ...base,
      runCode: createCodeRunnerCall(deps, base),
      executeWorkflow: createSubWorkflowCaller(deps),
      getInputData: (inputIndex = 0) => (parentExec.data.main?.[inputIndex] ?? []) as Item[],
      getInputConnectionData: (subType2, itemIndex) =>
        this.supplySubNodes(sub, subType, subType2, itemIndex, exec, signal, closeFunctions),
      logSubNodeRun: (input: DataObject, output: DataObject, error?: Error) => {
        const runs = (this.state.resultData.runData[sub.name] ??= []);
        const task: TaskData = {
          startTime: Date.now(),
          executionTime: 0,
          executionStatus: error ? 'error' : 'success',
          inputOverride: { [type]: [[{ json: input }]] },
          data: { [type]: [[{ json: output }]] },
          error: error ? serializeError(error, sub.name) : undefined,
          source: [{ previousNode: parent.name }],
        };
        runs.push(deepFreeze(task));
        const subRunIndex = runs.length - 1;
        this.subNodeHooks = this.subNodeHooks
          .then(() => this.services.hooks?.nodeExecuteAfter?.(sub.name, subRunIndex, task, this.state))
          .catch((e) =>
            this.services.logger.warn('nodeExecuteAfter failed for sub-node', {
              node: sub.name,
              error: String(e),
            }),
          );
      },
    };
  }

  private scheduleChildren(node: WorkflowNode, output: Item[][], runIndex: number): void {
    const outputs = this.workflow.connectionsBySource[node.name]?.main ?? [];
    const ready: ExecuteData[] = [];
    output.forEach((items, outputIndex) => {
      if (!items || items.length === 0) return;
      for (const conn of outputs[outputIndex] ?? []) {
        if (this.runFilter && !this.runFilter.has(conn.node)) continue;
        const dest = this.workflow.nodes[conn.node];
        if (!dest) continue;
        const src: SourceData = {
          previousNode: node.name,
          previousNodeOutput: outputIndex,
          previousNodeRun: runIndex,
        };
        const inputCount = this.workflow.getMainInputCount(dest);
        if (inputCount <= 1 && conn.index === 0) {
          ready.push({ node: conn.node, data: { main: [items] }, source: { main: [src] } });
        } else {
          const entry = this.addToWaiting(dest, conn.index, items, src, inputCount);
          if (entry) ready.push(entry);
        }
      }
    });
    if (!ready.length) return;
    const order = sortByPosition(ready.map((e) => this.workflow.nodes[e.node])).map((n) => n.name);
    ready.sort((a, b) => order.indexOf(a.node) - order.indexOf(b.node));
    this.state.executionData.nodeExecutionStack.unshift(...ready);
  }

  private addToWaiting(
    dest: WorkflowNode,
    inputIndex: number,
    items: Item[],
    src: SourceData,
    inputCount: number,
  ): ExecuteData | undefined {
    const ex = this.state.executionData;
    const waiting = (ex.waitingExecution[dest.name] ??= {});
    const sources = (ex.waitingExecutionSource[dest.name] ??= {});
    const slots = Object.keys(waiting)
      .map(Number)
      .sort((a, b) => a - b);
    let slot = slots.find((s) => waiting[s].main?.[inputIndex] == null);
    if (slot === undefined) {
      slot = slots.length ? slots[slots.length - 1] + 1 : 0;
      waiting[slot] = { main: Array.from({ length: inputCount }, () => null) };
      sources[slot] = { main: Array.from({ length: inputCount }, () => null) };
    }
    waiting[slot].main![inputIndex] = items;
    sources[slot].main[inputIndex] = src;

    const connected = this.workflow
      .getMainInputs(dest.name)
      .map((conns, i) => (conns.some((c) => !this.runFilter || this.runFilter.has(c.node)) ? i : -1))
      .filter((i) => i >= 0);
    if (!connected.every((i) => waiting[slot!].main?.[i] != null)) return undefined;

    const entry: ExecuteData = { node: dest.name, data: waiting[slot], source: sources[slot] };
    delete waiting[slot];
    delete sources[slot];
    if (!Object.keys(waiting).length) {
      delete ex.waitingExecution[dest.name];
      delete ex.waitingExecutionSource[dest.name];
    }
    return entry;
  }
}

export type { NodeOutputConfig };
export { getResolvedParameters };
