/**
 * Test one tool on its own: the node the tool hangs from does not run, and the tool is called once in its place
 * with the values a person typed. The values are data, as a model's are: nothing here evaluates them.
 */
import {
  type AiTool,
  type DataObject,
  type ExecuteData,
  type Item,
  isHitlVariant,
  isToolNode,
  isToolSuspension,
  type JsonSchema,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
  type Workflow,
  type WorkflowNode,
  WorkflowOperationError,
} from '@workflow/workflow';
import { createNodeAsTool, type ToolRunHost } from './node-as-tool';
import {
  connectedNodes,
  createBaseContext,
  createCodeRunnerCall,
  createSubWorkflowCaller,
  createToolParameterReader,
} from './node-context';

const NO_TOOL = 'No tool inputs found';
const EXECUTE_FAILED = 'Error executing tool: ';
// `agentRequest` lives on the engine of this run only: after a wait the root would run as a normal node
const CANNOT_WAIT = 'A tool test cannot wait for a reply';
const HITL_REFUSED = 'A Human review node waits for a person. Test the tool it guards instead';

/** `RunOptions.agentRequest` plus the two nodes the engine found for it */
export interface ToolExecutorRequest {
  query: DataObject;
  toolName: string;
  rootNode: string;
  toolNode: string;
}

function consumersOf(workflow: Workflow, name: string): string[] {
  return Object.entries(workflow.connectionsBySource[name] ?? {})
    .filter(([type]) => type !== 'main')
    .flatMap(([, outputs]) => outputs ?? [])
    .flatMap((slot) => slot ?? [])
    .map((connection) => connection.node)
    .filter((consumer) => workflow.nodes[consumer]);
}

/**
 * The first node that is not a sub-node, along the non-main connections from the tool. A tool or a sub-node that
 * nothing calls is the end of its own walk.
 */
export function toolRootOf(workflow: Workflow, toolNode: string): WorkflowNode {
  const tool = workflow.nodes[toolNode];
  if (!tool) throw new WorkflowOperationError(`Destination node "${toolNode}" does not exist`);
  const seen = new Set([toolNode]);
  const queue = [tool];
  let last = tool;
  for (const current of queue) {
    if (!workflow.isSubNode(current)) return current;
    last = current;
    for (const consumer of consumersOf(workflow, current.name)) {
      if (seen.has(consumer)) continue;
      seen.add(consumer);
      queue.push(workflow.nodes[consumer]);
    }
  }
  return last;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** every `type` a schema allows, through `anyOf` and `oneOf` */
function schemaTypes(schema: JsonSchema): Set<string> {
  const types = new Set<string>(
    [schema.type].flat().filter((type): type is string => typeof type === 'string'),
  );
  for (const branch of [schema.anyOf, schema.oneOf].flat()) {
    if (isRecord(branch)) for (const type of schemaTypes(branch)) types.add(type);
  }
  return types;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** a typed-in string as the type its schema asks for; a value that cannot be one is refused */
function convertString(key: string, text: string, schema: JsonSchema, types: Set<string>): unknown {
  const trimmed = text.trim();
  const number = trimmed === '' ? Number.NaN : Number(trimmed);
  if (types.has('number') && Number.isFinite(number)) return number;
  if (types.has('integer') && Number.isInteger(number)) return number;
  const lower = trimmed.toLowerCase();
  if (types.has('boolean') && (lower === 'true' || lower === 'false')) return lower === 'true';
  const parsed = parseJson(text);
  if (types.has('object') && isRecord(parsed)) return convertValue(key, parsed, schema);
  if (types.has('array') && Array.isArray(parsed)) return convertValue(key, parsed, schema);

  if (types.has('number')) throw new Error(`"${key}" must be a number`);
  if (types.has('integer')) throw new Error(`"${key}" must be a whole number`);
  if (types.has('boolean')) throw new Error(`"${key}" must be true or false`);
  if (types.has('object') && types.has('array')) throw new Error(`"${key}" must be JSON`);
  throw new Error(`"${key}" must be a JSON ${types.has('array') ? 'array' : 'object'}`);
}

function convertValue(key: string, value: unknown, schema: JsonSchema): unknown {
  if (typeof value === 'string') {
    const types = schemaTypes(schema);
    return types.size === 0 || types.has('string') ? value : convertString(key, value, schema, types);
  }
  if (Array.isArray(value)) {
    const { items } = schema;
    return isRecord(items) ? value.map((entry) => convertValue(key, entry, items)) : value;
  }
  return isRecord(value) && isRecord(schema.properties) ? convertArguments(value, schema) : value;
}

/** the arguments as the tool's schema types them; fromEntries keeps a `__proto__` key an own property */
function convertArguments(query: DataObject, schema: JsonSchema): DataObject {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const args: DataObject = Object.fromEntries(
    Object.entries(query).map(([key, value]) => {
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
      return [key, isRecord(property) ? convertValue(key, value, property) : value];
    }),
  );
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key === 'string' && !Object.hasOwn(args, key)) {
      throw new Error(`Missing a value for "${key}"`);
    }
  }
  return args;
}

/**
 * The value of a tool that takes one string: the editor sends it bare, under the tool's name, as n8n does. A key the
 * tool itself declares is an ordinary argument.
 */
function bareInput({ query, toolName }: ToolExecutorRequest, schema: JsonSchema): DataObject | undefined {
  const value = Object.hasOwn(query, toolName) ? query[toolName] : undefined;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (typeof value !== 'string' || Object.hasOwn(properties, toolName)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const key = [...required, ...Object.keys(properties)].find((name) => typeof name === 'string');
  return typeof key === 'string' ? { [key]: value } : {};
}

/** an empty query is what a tool gets when nothing asked for values: it runs with none and reports what it misses */
function requestArguments(request: ToolExecutorRequest, schema: JsonSchema): DataObject {
  if (Object.keys(request.query).length === 0) return {};
  return convertArguments(bareInput(request, schema) ?? request.query, schema);
}

/** what the engine gives a sub-node, for the one tool under test: its siblings are not supplied */
function supplyContext(
  host: ToolRunHost,
  tool: WorkflowNode,
  toolType: NodeType,
  root: WorkflowNode,
  rootExec: ExecuteData,
  signal: AbortSignal,
  closeFunctions: Array<() => Promise<void>>,
): SupplyDataContext {
  const runIndex = host.state.resultData.runData[tool.name]?.length ?? 0;
  const exec: ExecuteData = { node: tool.name, data: rootExec.data, source: rootExec.source };
  const deps = host.contextDeps(tool, exec, runIndex, signal);
  const base = createBaseContext(deps);
  return {
    ...base,
    runCode: createCodeRunnerCall(deps, base),
    executeWorkflow: createSubWorkflowCaller(deps),
    getInputData: (inputIndex = 0) => (rootExec.data.main?.[inputIndex] ?? []) as Item[],
    getInputConnectionData: (type, itemIndex) =>
      host.supplySubNodes(tool, toolType, type, itemIndex, exec, signal, closeFunctions),
    getToolParameter: createToolParameterReader(deps),
    logSubNodeRun: (input, output, error) => host.logSubNodeRun(tool, root, 'ai_tool', input, output, error),
    getParentNodes: () => connectedNodes(host.workflow, host.workflow.getParentNodes(root.name)),
  };
}

function isAiTool(value: unknown): value is AiTool {
  return isRecord(value) && value.kind === 'tool' && typeof value.invoke === 'function';
}

/** the tools the node offers, in the order the engine tries a sub-node */
async function toolsOf(
  host: ToolRunHost,
  tool: WorkflowNode,
  root: WorkflowNode,
  rootExec: ExecuteData,
  signal: AbortSignal,
  closeFunctions: Array<() => Promise<void>>,
): Promise<AiTool[]> {
  const toolType = host.workflow.getNodeType(tool);
  if (tool.disabled) return [];
  if (toolType.supplyData) {
    const context = supplyContext(host, tool, toolType, root, rootExec, signal, closeFunctions);
    const supplied = await toolType.supplyData(context, 0);
    if (supplied.closeFunction) closeFunctions.push(supplied.closeFunction);
    return [supplied.response].flat().filter(isAiTool);
  }
  if (isHitlVariant(toolType.description)) throw new Error(HITL_REFUSED);
  if (toolType.execute && isToolNode(toolType.description)) {
    return [createNodeAsTool(host, tool, toolType, root, rootExec, 0, signal)];
  }
  return [];
}

/** requests whose tool was called: a root with two parents that both run is reached twice */
const called = new WeakSet<ToolExecutorRequest>();

export async function runToolExecutor(
  host: ToolRunHost,
  request: ToolExecutorRequest,
  rootExec: ExecuteData,
  signal: AbortSignal,
  closeFunctions: Array<() => Promise<void>>,
): Promise<void> {
  if (called.has(request)) return;
  called.add(request);

  const { workflow, state } = host;
  const tool = workflow.nodes[request.toolNode];
  const root = workflow.nodes[request.rootNode];
  const taskCount = () => state.resultData.runData[tool.name]?.length ?? 0;
  const before = taskCount();
  await host.services.hooks?.nodeExecuteBefore?.(tool.name, before);

  let args = request.query;
  try {
    const tools = await toolsOf(host, tool, root, rootExec, signal, closeFunctions);
    const chosen =
      tools.length === 1
        ? tools[0]
        : tools.find(({ name }) => !request.toolName || name === request.toolName);
    if (!chosen) throw new NodeOperationError(tool, NO_TOOL);
    args = requestArguments(request, chosen.parameters);
    const result = await chosen.invoke(args, { signal });
    if (taskCount() === before) {
      host.logSubNodeRun(tool, root, 'ai_tool', args, { response: result as DataObject[string] });
    }
  } catch (error) {
    const failure = toolFailure(tool, error);
    if (taskCount() === before) host.logSubNodeRun(tool, root, 'ai_tool', args, {}, failure);
    throw failure;
  }
}

function toolFailure(tool: WorkflowNode, error: unknown): Error {
  if (error instanceof NodeOperationError && error.message === NO_TOOL) return error;
  const message = isToolSuspension(error)
    ? CANNOT_WAIT
    : error instanceof Error
      ? error.message
      : String(error);
  return new NodeOperationError(tool, `${EXECUTE_FAILED}${message}`);
}
