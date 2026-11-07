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
  isHitlVariant,
  isToolNode,
  type NodeExecutionHint,
  type NodeInputConfig,
  NodeOperationError,
  type NodeOutput,
  type NodeOutputConfig,
  type NodeType,
  type NodeTypeDescription,
  normalizePairedItems,
  planPartialRun,
  portType,
  QuotaExceededError,
  type RunData,
  resolvePorts,
  type SourceData,
  type SupplyDataContext,
  serializeError,
  sleep,
  sortByPosition,
  type TaskData,
  type ToolResumeData,
  type ToolSuspension,
  type ToolSuspensionState,
  type Workflow,
  type WorkflowNode,
  WorkflowOperationError,
} from '@workflow/workflow';
import { createHitlGate } from './hitl-gate';
import { createNodeAsTool, type ToolRunHost } from './node-as-tool';
import {
  assertValidOutput,
  type ContextDeps,
  createBaseContext,
  createCodeRunnerCall,
  createExecuteContext,
  createSubWorkflowCaller,
  createToolParameterReader,
  getResolvedParameters,
} from './node-context';
import type { ExecutionServices } from './services';
import { runToolExecutor, toolRootOf } from './tool-executor';

export interface RunOptions {
  /** node to start from (defaults to the first trigger) */
  startNode?: string;
  /** items emitted by the trigger / webhook / manual run; without them, a start node reads its parents' run data */
  triggerItems?: Item[];
  /**
   * partial run: the run data of an earlier execution. The start node and the nodes after it run again,
   * so their earlier results are dropped; the nodes before it keep theirs for the start node's input
   * and for expressions such as `$('Trigger').item`.
   */
  runData?: RunData;
  /** manual partial execution: stop after this node */
  destinationNode?: string;
  /** pinned outputs (manual mode) */
  pinData?: Record<string, Item[]>;
  /** partial run (P3-06): nodes the editor marked dirty since `runData` was produced; they and their descendants run again */
  dirtyNodeNames?: string[];
  /** overrides workflow settings / tenant default */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * test a tool (P5-76): `destinationNode` names the tool. Its root node becomes the destination and, instead of
   * running, calls the tool with `query`.
   */
  agentRequest?: { query: DataObject; toolName: string };
}

export interface ResumeOptions {
  /** replaces the output of the node that was waiting (e.g. data received by a resume webhook) */
  output?: Item[][];
  timeoutMs?: number;
  signal?: AbortSignal;
}

type NodeOutcome = 'continue' | 'stop' | 'wait';

type AgentRequestState = NonNullable<RunOptions['agentRequest']> & { rootNode: string; toolNode: string };

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
  /** hints the running node added with addExecutionHints */
  private nodeHints: NodeExecutionHint[] = [];
  /** what the running node passed to setMetadata */
  private nodeMetadata: DataObject = {};
  /** hooks of logged sub-node runs, chained so they land in order and finish before the parent node does */
  private subNodeHooks: Promise<void> = Promise.resolve();
  private startedAt = Date.now();
  private nodeRuns = 0;
  private runFilter?: Set<string>;
  /** set by run() for a tool test: reaching `rootNode` calls the tool instead of running the root */
  private agentRequest?: AgentRequestState;
  /** what the running node passed to `suspendForTool`; runNode turns it into the execution's wait */
  private toolWait?: { suspension: ToolSuspension; checkpoint: DataObject };
  /** the answer of a tool's wait, read by the run of the agent that waited for it */
  private toolResume?: { agentNode: string; data: ToolResumeData };

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
    if (options.agentRequest) options = this.startAgentRequest(options.agentRequest, options);
    if (options.destinationNode && options.runData) {
      return this.runPartial({
        ...options,
        destinationNode: options.destinationNode,
        runData: options.runData,
      });
    }
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
    if (options.runData) {
      const rerun = new Set([start.name, ...this.workflow.getChildNodes(start.name)]);
      this.state.resultData.runData = Object.fromEntries(
        Object.entries(options.runData).filter(([name]) => this.workflow.nodes[name] && !rerun.has(name)),
      );
    }
    const triggerItems = options.triggerItems?.length ? options.triggerItems : undefined;
    this.state.executionData.nodeExecutionStack.push(
      (!triggerItems && this.startFromParentRunData(start)) || {
        node: start.name,
        data: { main: [triggerItems ?? [{ json: {} }]] },
        source: null,
      },
    );
    return this.process(options);
  }

  /** a tool test: the caller names the tool as the destination, the run really stops at the tool's root node */
  private startAgentRequest(
    request: NonNullable<RunOptions['agentRequest']>,
    options: RunOptions,
  ): RunOptions {
    const toolNode = options.destinationNode;
    if (!toolNode) throw new WorkflowOperationError('A tool test needs a destination node');
    if (!this.workflow.nodes[toolNode]) {
      throw new WorkflowOperationError(`Destination node "${toolNode}" does not exist`);
    }
    const rootNode = toolRootOf(this.workflow, toolNode).name;
    this.agentRequest = { ...request, rootNode, toolNode };
    return { ...options, destinationNode: rootNode };
  }

  /**
   * P3-06 partial run (as n8n's partial execution): planPartialRun keeps the run data of the nodes that do not
   * change, and names the start nodes. Each start node is queued with the output its parents already produced; a
   * multi-input node (Merge) still missing an input from a branch that runs again waits for it in
   * `waitingExecution`. Only the subgraph root .. destination runs.
   */
  private runPartial(
    options: RunOptions & { destinationNode: string; runData: RunData },
  ): Promise<ExecutionResult> {
    const pinData = options.pinData && Object.keys(options.pinData).length ? options.pinData : undefined;
    const plan = planPartialRun(this.workflow.definition, {
      root: options.startNode ?? this.workflow.getStartNode()?.name,
      destination: options.destinationNode,
      runData: options.runData,
      pinData,
      dirtyNodeNames: options.dirtyNodeNames,
    });
    this.state.startData.destinationNode = plan.destination;
    this.state.startData.runNodeFilter = plan.subgraph;
    this.runFilter = new Set(plan.subgraph);
    if (pinData) this.state.resultData.pinData = pinData;
    this.state.resultData.runData = plan.runData;

    const triggerItems = options.triggerItems?.length ? options.triggerItems : undefined;
    for (const name of plan.startNodes) {
      const node = this.workflow.nodes[name];
      if (name !== plan.root) {
        this.seedStartNode(node, plan.runData, pinData);
        continue;
      }
      // the root reads the parents it may have outside the subgraph from the run data it was given
      this.state.executionData.nodeExecutionStack.push(
        (!triggerItems && this.startFromParentRunData(node, options.runData)) || {
          node: name,
          data: { main: [triggerItems ?? [{ json: {} }]] },
          source: null,
        },
      );
    }
    return this.process(options);
  }

  /** the output a parent already produced on `output`: its pin (first output only), else its last run */
  private parentOutput(
    parent: string,
    output: number,
    runData: RunData,
    pinData: Record<string, Item[]> | undefined,
  ): { items: Item[]; source: SourceData } | undefined {
    const runs = runData[parent] ?? [];
    const previousNodeRun = Math.max(0, runs.length - 1);
    const pinned = pinData?.[parent];
    const items = pinned
      ? output === 0
        ? pinned
        : undefined
      : (runs[runs.length - 1]?.data?.main?.[output] as Item[] | null | undefined);
    if (!items?.length) return undefined;
    return { items, source: { previousNode: parent, previousNodeOutput: output, previousNodeRun } };
  }

  /**
   * Queue a non-root start node of a partial run. A single-input node runs once per parent that has output (as in
   * a full run). A multi-input node runs now when every connected input has data, otherwise its available inputs
   * are seeded into `waitingExecution`, where addToWaiting completes them when the missing branch runs again.
   */
  private seedStartNode(
    node: WorkflowNode,
    runData: RunData,
    pinData: Record<string, Item[]> | undefined,
  ): void {
    const inputs = this.workflow
      .getMainInputs(node.name)
      .map((conns) => (conns ?? []).filter((c) => !this.runFilter || this.runFilter.has(c.node)));
    const inputCount = this.workflow.getMainInputCount(node);
    const ex = this.state.executionData;
    if (inputCount <= 1) {
      for (const conn of inputs[0] ?? []) {
        const found = this.parentOutput(conn.node, conn.index, runData, pinData);
        if (found) {
          ex.nodeExecutionStack.push({
            node: node.name,
            data: { main: [found.items] },
            source: { main: [found.source] },
          });
        }
      }
      return;
    }
    const main: Array<Item[] | null> = Array.from({ length: inputCount }, () => null);
    const sources: Array<SourceData | null> = Array.from({ length: inputCount }, () => null);
    inputs.forEach((conns, inputIndex) => {
      for (const conn of conns) {
        const found = this.parentOutput(conn.node, conn.index, runData, pinData);
        if (!found) continue;
        main[inputIndex] = found.items;
        sources[inputIndex] = found.source;
        break;
      }
    });
    const connected = inputs.map((conns, i) => (conns.length ? i : -1)).filter((i) => i >= 0);
    if (connected.every((i) => main[i] != null)) {
      ex.nodeExecutionStack.push({ node: node.name, data: { main }, source: { main: sources } });
      return;
    }
    if (main.every((items) => items == null)) return;
    const waiting = (ex.waitingExecution[node.name] ??= {});
    const waitingSources = (ex.waitingExecutionSource[node.name] ??= {});
    const slots = Object.keys(waiting).map(Number);
    const slot = slots.length ? Math.max(...slots) + 1 : 0;
    waiting[slot] = { main };
    waitingSources[slot] = { main: sources };
  }

  /**
   * A start node whose parents already ran (partial or resumed runs) takes each input from the last
   * run of the first parent with run data on it, and records that parent as the input's source, so
   * paired items and nodes that read their input source (Loop Over Items) work as in a full run.
   */
  private startFromParentRunData(
    start: WorkflowNode,
    runData: RunData = this.state.resultData.runData,
  ): ExecuteData | undefined {
    const main: Item[][] = [];
    const sources: Array<SourceData | null> = [];
    let found = false;
    this.workflow.getMainInputs(start.name).forEach((connections, inputIndex) => {
      main[inputIndex] = [];
      sources[inputIndex] = null;
      for (const connection of connections ?? []) {
        const run = (runData[connection.node]?.length ?? 0) - 1;
        const items = run < 0 ? undefined : runData[connection.node][run]?.data?.main?.[connection.index];
        if (!items) continue;
        main[inputIndex] = items;
        sources[inputIndex] = {
          previousNode: connection.node,
          previousNodeOutput: connection.index,
          previousNodeRun: run,
        };
        found = true;
        break;
      }
    });
    return found ? { node: start.name, data: { main }, source: { main: sources } } : undefined;
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
    const suspended = this.state.executionData.suspended;
    if (suspended) return this.resumeToolWait(suspended, options);
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

  /**
   * A tool's wait ended: its answer goes on the tool's run and the agent runs again, from its checkpoint. A wait
   * that ended by itself has no answer.
   */
  private resumeToolWait(suspended: ToolSuspensionState, options: ResumeOptions): Promise<ExecutionResult> {
    const { resultData, executionData } = this.state;
    const answer = options.output ?? null;
    const runs = resultData.runData[suspended.toolNode];
    const task: TaskData = {
      ...runs[suspended.toolRunIndex],
      executionStatus: 'success',
      data: { ai_tool: answer ? deepFreeze(this.pairOutput(answer, [])) : [[]] },
      executionTime: Date.now() - runs[suspended.toolRunIndex].startTime,
    };
    runs[suspended.toolRunIndex] = task;
    this.state.waitTill = undefined;
    executionData.suspended = undefined;
    executionData.nodeExecutionStack.unshift(suspended.exec);
    this.toolResume = {
      agentNode: suspended.agentNode,
      data: { checkpoint: suspended.checkpoint, toolCallId: suspended.toolCallId, answer },
    };
    this.logToolAnswer(suspended, task);
    return this.process(options);
  }

  /** the tool's run has changed: the hook lands before the parent node finishes, as for any sub-node */
  private logToolAnswer(suspended: ToolSuspensionState, task: TaskData): void {
    this.subNodeHooks = this.subNodeHooks
      .then(() =>
        this.services.hooks?.nodeExecuteAfter?.(suspended.toolNode, suspended.toolRunIndex, task, this.state),
      )
      .catch((e) =>
        this.services.logger.warn('nodeExecuteAfter failed for sub-node', {
          node: suspended.toolNode,
          error: String(e),
        }),
      );
  }

  /**
   * The agent stopped for a tool: the execution waits at the tool node. The agent has no task, so `lastNodeExecuted`
   * and the last run of that node are what `resume()` and the resume webhook read; its `exec` runs again on resume.
   */
  private async suspendAgent(
    agent: WorkflowNode,
    exec: ExecuteData,
    { suspension, checkpoint }: { suspension: ToolSuspension; checkpoint: DataObject },
  ): Promise<NodeOutcome> {
    const { resultData, executionData } = this.state;
    if (!resultData.runData[agent.name]?.length) delete resultData.runData[agent.name];
    const runs = (resultData.runData[suspension.toolNode] ??= []);
    const toolRunIndex = runs.length;
    const task: TaskData = {
      startTime: Date.now(),
      executionTime: 0,
      executionStatus: 'waiting',
      ...(suspension.gatedTool
        ? { inputOverride: { ai_tool: [[{ json: { ...suspension.gatedTool } }]] } }
        : {}),
      source: [{ previousNode: agent.name }],
    };
    runs.push(task);
    executionData.suspended = {
      agentNode: agent.name,
      exec,
      toolNode: suspension.toolNode,
      toolRunIndex,
      toolCallId: suspension.toolCallId,
      checkpoint,
    };
    resultData.lastNodeExecuted = suspension.toolNode;
    this.state.waitTill = suspension.waitTill.toISOString();
    await this.services.hooks?.nodeExecuteAfter?.(suspension.toolNode, toolRunIndex, task, this.state);
    return 'wait';
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
        if (this.toolResume?.agentNode === next.node) this.toolResume = undefined;
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

  /** a node's ports; an expression sees the parameters with their defaults by version, as in the editor */
  private resolvedPorts(
    ports: NodeTypeDescription['inputs'] | NodeTypeDescription['outputs'],
    node: WorkflowNode,
  ) {
    const parameters = getResolvedParameters(this.workflow, node);
    return resolvePorts(ports, { ...node, parameters }, (expr, values) =>
      evaluateSimple(expr, { $parameter: values }),
    );
  }

  private regularOutputCount(node: WorkflowNode, type: NodeType): number {
    const ports = this.resolvedPorts(type.description.outputs, node);
    return Math.max(1, ports.filter((p) => portType(p) === 'main').length);
  }

  /** the root of a tool test runs the tool and writes no task for itself, so the run data shows the tool only */
  private async runAgentRequest(
    request: AgentRequestState,
    rootExec: ExecuteData,
    signal: AbortSignal,
  ): Promise<NodeOutcome> {
    const closeFunctions: Array<() => Promise<void>> = [];
    try {
      await runToolExecutor(this.toolHost(), request, rootExec, signal, closeFunctions);
    } finally {
      this.state.resultData.lastNodeExecuted = request.toolNode;
      await this.finishSubNodes(closeFunctions);
    }
    return 'continue';
  }

  private async runNode(exec: ExecuteData, signal: AbortSignal): Promise<NodeOutcome> {
    if (this.agentRequest && exec.node === this.agentRequest.rootNode) {
      return this.runAgentRequest(this.agentRequest, exec, signal);
    }
    const node = this.workflow.nodes[exec.node];
    if (!node) throw new WorkflowOperationError(`Node "${exec.node}" does not exist`);
    const runs = (this.state.resultData.runData[node.name] ??= []);
    const runIndex = runs.length;
    const source = exec.source?.main ?? [];
    const inputItems = exec.data.main?.[0] ?? [];

    await this.services.hooks?.nodeExecuteBefore?.(node.name, runIndex);
    const startTime = Date.now();
    this.waitTill = undefined;
    this.toolWait = undefined;
    this.nodeHints = [];
    this.nodeMetadata = {};

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

    if (!error && this.toolWait) return this.suspendAgent(node, exec, this.toolWait);

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
          metadata: this.taskMetadata(attempts),
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
      metadata: this.taskMetadata(attempts),
    };
    const hints = [...this.nodeHints];
    if (errorOutputUsed) {
      hints.push({ message: 'Node failed; items were routed to the error output', level: 'warning' });
    }
    if (hints.length) task.hints = hints;
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
    // a retried attempt starts without the hints and metadata of the attempt that failed
    this.nodeHints = [];
    this.nodeMetadata = {};
    const ctx = createExecuteContext(deps, {
      getInputConnectionData: (type, itemIndex) =>
        this.supplySubNodes(node, nodeType, type, itemIndex, effectiveExec, signal, closeFunctions),
      putExecutionToWait: (waitTill) => {
        this.waitTill = waitTill;
      },
      continueOnFail: () =>
        node.onError === 'continueRegularOutput' || node.onError === 'continueErrorOutput',
      addExecutionHints: (hints) => {
        this.nodeHints.push(...hints);
      },
      setMetadata: (data) => {
        Object.assign(this.nodeMetadata, data);
      },
      suspendForTool: (suspension, checkpoint) => {
        this.toolWait = { suspension, checkpoint };
      },
      getResumeData: () => (this.toolResume?.agentNode === node.name ? this.toolResume.data : undefined),
    });
    try {
      return await nodeType.execute(ctx);
    } finally {
      await this.finishSubNodes(closeFunctions);
    }
  }

  /** wait for the hooks of logged sub-node runs, then close what the sub-nodes opened */
  private async finishSubNodes(closeFunctions: Array<() => Promise<void>>): Promise<void> {
    await this.subNodeHooks;
    for (const close of closeFunctions) {
      await close().catch((e) => this.services.logger.warn('Sub-node close failed', { error: String(e) }));
    }
  }

  /** what a node running as a tool needs from the engine; per-call state stays with the tool */
  private toolHost(): ToolRunHost {
    return {
      workflow: this.workflow,
      services: this.services,
      evaluator: this.evaluator,
      state: this.state,
      contextDeps: (node, exec, runIndex, signal) => this.contextDeps(node, exec, runIndex, signal),
      supplySubNodes: (parent, parentType, type, itemIndex, exec, signal, closeFunctions) =>
        this.supplySubNodes(parent, parentType, type, itemIndex, exec, signal, closeFunctions),
      logSubNodeRun: (sub, parent, type, input, output, error) =>
        this.logSubNodeRun(sub, parent, type, input, output, error),
    };
  }

  /** the metadata of a finished task: what the node set, plus the retry attempt that produced it */
  private taskMetadata(attempts: number): TaskData['metadata'] {
    const metadata: NonNullable<TaskData['metadata']> = { ...this.nodeMetadata };
    if (attempts > 1) metadata.attempt = attempts;
    return Object.keys(metadata).length ? metadata : undefined;
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
    const ports = this.resolvedPorts(parentType.description.inputs, parent).filter(
      (p) => portType(p) === type,
    ) as Array<NodeInputConfig | ConnectionType>;
    const supply = (subNodes: WorkflowNode[], port: NodeInputConfig | ConnectionType | undefined) =>
      this.supplyFrom(subNodes, port, parent, type, itemIndex, parentExec, signal, closeFunctions);

    // several ports of one type (fallback model, Model Selector): one value per port, the parent checks its slots
    if (ports.length > 1) {
      const slots = this.workflow.getSubNodesBySlot(parent.name, type);
      const results: unknown[] = [];
      for (const [slot, port] of ports.entries()) {
        const slotNodes = slots[slot] ?? [];
        results.push(slotNodes.length ? await supply(slotNodes, port) : undefined);
      }
      return results;
    }

    const config = ports[0] as NodeInputConfig | ConnectionType | undefined;
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
    return supply(subNodes, config);
  }

  /** what `subNodes` supply to one port: the first value when the port takes one connection, otherwise all */
  private async supplyFrom(
    subNodes: WorkflowNode[],
    port: NodeInputConfig | ConnectionType | undefined,
    parent: WorkflowNode,
    type: ConnectionType,
    itemIndex: number,
    parentExec: ExecuteData,
    signal: AbortSignal,
    closeFunctions: Array<() => Promise<void>>,
  ): Promise<unknown> {
    const results: unknown[] = [];
    for (const sub of subNodes) {
      const subType = this.workflow.getNodeType(sub);
      if (subType.supplyData) {
        const ctx = this.createSupplyDataContext(sub, parent, parentExec, type, signal);
        const supplied = await subType.supplyData(ctx, itemIndex);
        if (supplied.closeFunction) closeFunctions.push(supplied.closeFunction);
        results.push(supplied.response);
      } else if (isHitlVariant(subType.description)) {
        const host = this.toolHost();
        const tools = await createHitlGate(
          host,
          sub,
          subType,
          parent,
          parentExec,
          itemIndex,
          signal,
          closeFunctions,
        );
        results.push(...tools);
      } else if (subType.execute && isToolNode(subType.description)) {
        results.push(createNodeAsTool(this.toolHost(), sub, subType, parent, parentExec, itemIndex, signal));
      } else {
        throw new NodeOperationError(sub, `Node "${sub.name}" cannot be used as a ${type} sub-node`);
      }
    }
    return typeof port === 'object' && port.maxConnections === 1 ? results[0] : results;
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
      getToolParameter: createToolParameterReader(deps),
      logSubNodeRun: (input: DataObject, output: DataObject, error?: Error) =>
        this.logSubNodeRun(sub, parent, type, input, output, error),
    };
  }

  /** record one call of a sub-node as a task of its own; the parent node waits for the hook */
  private logSubNodeRun(
    sub: WorkflowNode,
    parent: WorkflowNode,
    type: ConnectionType,
    input: DataObject,
    output: DataObject,
    error?: unknown,
  ): void {
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
