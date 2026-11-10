/**
 * Any node as an agent tool. `ToolRunHost` is what the engine lends the tool code: `createNodeAsTool`,
 * `createHitlGate` and `runToolExecutor` all run against it.
 *
 * Tools run in parallel, so each call has its own context: nothing here touches the engine's per-task wait,
 * hints or metadata. The model's values are data: `$fromAI` hands them to the expression as a return value and
 * they are never read as an expression.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiTool,
  CHAT_TOOL_TYPE,
  type ConnectionType,
  type DataObject,
  type ExecuteContext,
  type ExecuteData,
  type ExecutionState,
  type ExpressionEvaluator,
  extractFromAiArguments,
  type FromAiArgument,
  fromAiSchema,
  fromAiVariables,
  type GetNodeParameterOptions,
  type Item,
  isToolSuspension,
  type NodeExecutionHint,
  NodeOperationError,
  type NodeType,
  QuotaExceededError,
  sleep,
  ToolSuspension,
  toolDescriptionFor,
  toolNameOf,
  type Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import {
  assertValidOutput,
  type ContextDeps,
  createBaseContext,
  createExecuteContext,
  getResolvedParameters,
  mergeSubWorkflowReport,
} from './node-context';
import type { ExecutionServices } from './services';

const MIN_TRIES = 2;
const MAX_TRIES = 5;
const DEFAULT_TRIES = 3;
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 5000;
const BINARY_ONLY = 'Error: The Tool attempted to return binary data, which is not supported in Agents';
const JSON_VALUE_RULE = 'Value must be a non-empty object or a non-empty array';
/** the engine's own default for `limits.maxItemsPerOutput` */
const MAX_ITEMS_PER_OUTPUT = 1_000_000;
/** how many tools can run inside each other: each level multiplies the model calls of the one above */
const MAX_TOOL_DEPTH = 5;

/**
 * The tools a call runs inside. A tool's own sub-nodes get the call's exec back as their parent's, so the chain
 * travels with it through `supplySubNodes`.
 */
const toolChains = new WeakMap<ExecuteData, readonly string[]>();

export interface ToolRunHost {
  readonly workflow: Workflow;
  readonly services: ExecutionServices;
  readonly evaluator: ExpressionEvaluator;
  readonly state: ExecutionState;
  contextDeps(node: WorkflowNode, exec: ExecuteData, runIndex: number, signal: AbortSignal): ContextDeps;
  supplySubNodes(
    parent: WorkflowNode,
    parentType: NodeType,
    type: ConnectionType,
    itemIndex: number,
    exec: ExecuteData,
    signal: AbortSignal,
    closeFunctions: Array<() => Promise<void>>,
  ): Promise<unknown>;
  logSubNodeRun(
    sub: WorkflowNode,
    parent: WorkflowNode,
    type: ConnectionType,
    input: DataObject,
    output: DataObject,
    error?: Error,
    /** P6 S3 (C0): the call's sub-workflow report (`usedCredentialIds`, `subWorkflowRedaction`) for its task */
    metadata?: DataObject,
  ): void;
}

/** the declared arguments only, as own properties, with each scanned default filled in */
function declaredArguments(args: DataObject, declared: FromAiArgument[]): DataObject {
  const entries: Array<[string, unknown]> = [];
  for (const { key, type, defaultValue } of declared) {
    const sent = Object.hasOwn(args, key) ? args[key] : undefined;
    if (sent === undefined) {
      if (defaultValue !== undefined) entries.push([key, defaultValue]);
      continue;
    }
    if (type === 'json' && !isNonEmptyContainer(sent)) throw new Error(JSON_VALUE_RULE);
    entries.push([key, sent]);
  }
  return Object.fromEntries(entries);
}

function isNonEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

/** a tool that `callers` already run, or one level too deep: the calling model gets this as the tool's error */
function chainRefusal(tool: WorkflowNode, callers: readonly string[]): NodeOperationError | undefined {
  if (callers.includes(tool.name)) {
    return new NodeOperationError(
      tool,
      `Couldn't run tool "${tool.name}": it is already running in this chain of tool calls`,
    );
  }
  if (callers.length < MAX_TOOL_DEPTH) return undefined;
  return new NodeOperationError(
    tool,
    `Couldn't run tool "${tool.name}": tools can run inside each other at most ${MAX_TOOL_DEPTH} levels deep`,
  );
}

/** `$input` in a tool call: one item, the model's arguments, whatever the agent's input holds */
function toolInput(args: DataObject, itemIndex: number, params: DataObject) {
  const item: Item = { json: args, pairedItem: { item: itemIndex } };
  return Object.freeze({ item, all: () => [item], first: () => item, last: () => item, params });
}

/** what the model reads: the JSON of the first output; binary data cannot reach it */
function modelResult(host: ToolRunHost, tool: WorkflowNode, items: Item[]): string {
  const hasKeys = (value: object | undefined) => Object.keys(value ?? {}).length > 0;
  const hasBinary = items.some((item) => hasKeys(item.binary));
  if (hasBinary && !items.some((item) => hasKeys(item.json))) return BINARY_ONLY;
  if (hasBinary) {
    host.services.logger.warn(
      'A tool returned binary data, which is not supported in Agents. It was left out.',
      {
        node: tool.name,
      },
    );
  }
  return JSON.stringify(items.map((item) => item.json));
}

/** an expression is read at the agent's item; one that names no operation yet, such as `$fromAI`, may still wait */
function operationCanWait(
  host: ToolRunHost,
  tool: WorkflowNode,
  parentExec: ExecuteData,
  itemIndex: number,
  signal: AbortSignal,
): boolean {
  const { operation } = getResolvedParameters(host.workflow, tool);
  if (typeof operation !== 'string' || !operation.startsWith('=')) return operation === 'sendAndWait';
  const runIndex = host.state.resultData.runData[tool.name]?.length ?? 0;
  const exec: ExecuteData = { node: tool.name, data: parentExec.data, source: parentExec.source };
  try {
    const value = createBaseContext(host.contextDeps(tool, exec, runIndex, signal)).getNodeParameter(
      'operation',
      itemIndex,
      '',
    );
    return typeof value !== 'string' || value === '' || value === 'sendAndWait';
  } catch {
    return true;
  }
}

/**
 * Whether a node run as a tool may wait for a person: it has webhooks, and when it offers a choice of operations
 * with `sendAndWait`, the operation at the agent's item is that one or not known yet.
 */
export function toolCanWait(
  host: ToolRunHost,
  tool: WorkflowNode,
  toolType: NodeType,
  parentExec: ExecuteData,
  itemIndex: number,
  signal: AbortSignal,
): boolean {
  const { webhooks, properties } = toolType.description;
  if (!webhooks?.length) return false;
  // a node with a choice of operations waits only at this one
  const offered = properties.some(
    ({ name, options }) =>
      name === 'operation' && options?.some((option) => 'value' in option && option.value === 'sendAndWait'),
  );
  return !offered || operationCanWait(host, tool, parentExec, itemIndex, signal);
}

export function createNodeAsTool(
  host: ToolRunHost,
  tool: WorkflowNode,
  toolType: NodeType,
  parent: WorkflowNode,
  parentExec: ExecuteData,
  itemIndex: number,
  signal: AbortSignal,
): AiTool {
  const { execute } = toolType;
  if (!execute) throw new NodeOperationError(tool, `Node "${tool.name}" cannot run as a tool`);

  const parentItems = parentExec.data.main?.[0] ?? [];
  const name = toolNameOf(tool.name);
  // the editor stores only what a person changed, so a `$fromAI` can sit in a default
  const resolved = getResolvedParameters(host.workflow, tool);
  const declared = extractFromAiArguments(resolved);
  const parameters = fromAiSchema(resolved);
  const callers = toolChains.get(parentExec) ?? [];

  // the name and description are read once, against the agent's item
  const descriptionContext = createBaseContext(
    host.contextDeps(tool, { ...parentExec, node: tool.name }, 0, signal),
  );
  const description = toolDescriptionFor(tool, toolType.description, (parameter) =>
    descriptionContext.getNodeParameter(parameter, itemIndex, ''),
  );

  const call = async (
    args: DataObject,
    toolCallId: string,
    callSignal: AbortSignal,
    runIndex: number,
    /** P6 S3 (C0): the call's sub-workflow reports, a union over its attempts; the tool's task metadata */
    report: DataObject,
  ): Promise<{ result: string; response: DataObject }> => {
    const merged: Item = {
      json: { ...parentItems[itemIndex]?.json, ...args, toolCallId },
      pairedItem: { item: itemIndex },
    };
    const extraVariables = {
      ...fromAiVariables(args),
      $input: toolInput(args, itemIndex, resolved),
    };
    const exec: ExecuteData = {
      node: tool.name,
      data: { main: [[merged]] },
      source: parentExec.source,
    };
    // `$('Node').item` walks back from the item's index in the agent's input, and the node reads its one input
    // item at index 0, so a parameter is read at the agent's index with the merged item in that slot
    const slotted = parentItems.slice();
    slotted[itemIndex] = merged;
    const slottedExec: ExecuteData = { ...exec, data: { main: [slotted] } };
    toolChains.set(slottedExec, [...callers, tool.name]);
    const withVariables = (execData: ExecuteData): ContextDeps => ({
      ...host.contextDeps(tool, execData, runIndex, callSignal),
      extraVariables,
    });
    const reader = createBaseContext(withVariables(slottedExec));

    const hints: NodeExecutionHint[] = [];
    const metadata: DataObject = {};
    let waitTill: Date | undefined;
    const closeFunctions: Array<() => Promise<void>> = [];
    const base = createExecuteContext(withVariables(exec), {
      getInputConnectionData: (type) =>
        host.supplySubNodes(tool, toolType, type, itemIndex, slottedExec, callSignal, closeFunctions),
      putExecutionToWait: (time) => {
        waitTill = time;
      },
      continueOnFail: () =>
        tool.onError === 'continueRegularOutput' || tool.onError === 'continueErrorOutput',
      addExecutionHints: (added) => {
        hints.push(...added);
      },
      setMetadata: (data) => {
        Object.assign(metadata, data);
      },
      reportSubWorkflow: (reported) => {
        mergeSubWorkflowReport(report, reported);
      },
    });
    const ctx: ExecuteContext = {
      ...base,
      getNodeParameter: (
        parameter: string,
        _index: number,
        fallback?: unknown,
        options?: GetNodeParameterOptions,
      ) => reader.getNodeParameter(parameter, itemIndex, fallback, options),
      evaluateExpression: (expression: string) => reader.evaluateExpression(expression, itemIndex),
      // a credential id can be a per-item expression: it resolves at the agent's index, as a parameter does
      getCredentials: <T extends DataObject = DataObject>(type: string) =>
        reader.getCredentials<T>(type, itemIndex),
      helpers: {
        ...base.helpers,
        httpRequestWithAuthentication: (type, options) =>
          reader.helpers.httpRequestWithAuthentication(type, options, itemIndex),
      },
      // the run's response belongs to the agent the user talks to; only the Chat tool posts its own message,
      // with its own node in the chunk's meta
      sendChunk: tool.type === CHAT_TOOL_TYPE ? base.sendChunk : () => {},
    };

    try {
      const output = await execute.call(toolType, ctx);
      assertValidOutput(tool, output);
      const maxItems = host.services.limits?.maxItemsPerOutput ?? MAX_ITEMS_PER_OUTPUT;
      if (output?.some((items) => (items?.length ?? 0) > maxItems)) {
        throw new QuotaExceededError(
          `Node "${tool.name}" returned more than ${maxItems} items in one output`,
        );
      }
      if (waitTill) throw new ToolSuspension({ toolNode: tool.name, waitTill, toolName: name, toolCallId });
      const items = output?.[0] ?? [];
      return {
        result: modelResult(host, tool, items),
        response: {
          response: items.map((item) => item.json),
          ...(hints.length ? { hints } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
        },
      };
    } finally {
      for (const close of closeFunctions) {
        await close().catch((error: unknown) =>
          host.services.logger.warn('Tool sub-node close failed', { node: tool.name, error: String(error) }),
        );
      }
    }
  };

  const logFailure = (args: DataObject, error: unknown, report?: DataObject) =>
    host.logSubNodeRun(tool, parent, 'ai_tool', args, {}, error as Error, report);

  let running = 0;
  return {
    kind: 'tool',
    name,
    description,
    parameters,
    canWait: toolCanWait(host, tool, toolType, parentExec, itemIndex, signal),
    async invoke(rawArgs, options) {
      const args = declaredArguments(rawArgs, declared);
      const refusal = chainRefusal(tool, callers);
      if (refusal) {
        logFailure(args, refusal);
        throw refusal;
      }
      const toolCallId = options?.toolCallId ?? randomUUID();
      const callSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
      // parallel calls log when they finish, so a running call holds a place too
      const runIndex = (host.state.resultData.runData[tool.name]?.length ?? 0) + running;
      running++;

      const maxTries = tool.retryOnFail
        ? Math.min(Math.max(tool.maxTries ?? DEFAULT_TRIES, MIN_TRIES), MAX_TRIES)
        : 1;
      const wait = Math.min(Math.max(tool.waitBetweenTries ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
      // P6 S3 (C0): what the sub-workflows of every attempt report; a failed call keeps it too
      const report: DataObject = {};
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const { result, response } = await call(args, toolCallId, callSignal, runIndex, report);
            host.logSubNodeRun(tool, parent, 'ai_tool', args, response, undefined, report);
            return result;
          } catch (error) {
            if (isToolSuspension(error)) throw error;
            if (attempt >= maxTries || error instanceof QuotaExceededError) {
              logFailure(args, error, report);
              throw error;
            }
            // an abort during the wait ends the call with the error it was retrying
            await sleep(wait, callSignal).catch(() => {
              logFailure(args, error, report);
              throw error;
            });
          }
        }
      } finally {
        running--;
      }
    },
  };
}
