/**
 * Assistant tools: executions (P5-69, lane L4; n8n IA/docs/tools.md, `workflow_builder_executions` as
 * separate tools). Reads (`list_executions`, `get_execution`, `debug_execution`, `get_node_output`,
 * `get_resolved_node_parameters`) are viewer tools, as GET /executions; what they return is untrusted
 * run data, strings through `redactSecrets` and cut, binary data as name, type and size only, and no item
 * values when `sendValues` is false. Writes (`run_workflow`, `run_node`, `stop_execution`) are editor
 * tools behind a `runWorkflow` card, as POST /workflows/:id/run and /executions/:id/stop.
 *
 * `run_workflow` always shows a card (no thread grant), runs through `runAndCollect` with the trigger's
 * items from `triggerPinData` (data, never evaluated), waits 5 minutes by default and 10 at most, stops
 * the run on timeout and reports a parked run as `waiting`. `run_node` maps n8n's three input modes onto
 * `workflows.run` (`destinationNode`, `runData`, `dirtyNodeNames`, `pinData`; a tool sub-node through
 * `agentRequest`) and says which nodes really ran in this run. Its card names the earlier nodes that run
 * for real; its grant names the mode (none for a chain run), so one mode's grant never covers another.
 */
import {
  ASSISTANT_PREVIEW,
  type AssistantPreviewTable,
  type DataObject,
  type ExecutionMode,
  type ExecutionState,
  type Item,
  type RunData,
  type TaskData,
  Workflow,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import type { ExecutionRow, WorkflowRow } from '../../../db/schema';
import { ApiError, parse } from '../../../http/errors';
import { executionListQuery, executionSummary, listExecutions } from '../../../routes/executions';
import { toDefinition } from '../../workflow-model';
import { chooseManualStartNode, type WorkflowService } from '../../workflows';
import { previewOutput, RUN_PREVIEW, runAndCollect, triggerPinData } from '../run-helper';
import type { ApprovalCopy, AssistantCaller, AssistantRunScope, AssistantToolDefinition } from '../types';
import { resolveNodeParameters, safeValue } from './resolve-parameters';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;
const OPEN = new Set(['new', 'running']);

/** run timeouts in ms: n8n's default and maximum */
export const RUN_TIMEOUT = { default: 300_000, max: 600_000, min: 1_000 } as const;

const workflowId = z.uuid().describe('The id of the workflow');
const executionId = z.uuid().describe('The id of the execution');
const nodeName = z.string().min(1).max(256).describe('The name of the node, as in the workflow');
const timeout = z
  .number()
  .int()
  .min(RUN_TIMEOUT.min)
  .max(RUN_TIMEOUT.max)
  .default(RUN_TIMEOUT.default)
  .describe('How long to wait in milliseconds (default 5 minutes, at most 10); the run is stopped after it');
const approvalSummary = z
  .string()
  .max(500)
  .optional()
  .describe('One sentence for the person: what this run does and why');

const VALUES_HIDDEN = 'Item values are hidden by a workspace setting';

// ---------------------------------------------------------------------------------------------
// shared reads

async function executionRow(ctx: ServerContext, caller: AssistantCaller, id: string): Promise<ExecutionRow> {
  const row = await ctx.repos.executions.get(caller.tenant.id, id);
  if (!row) throw ApiError.notFound('Execution');
  return row;
}

interface LoadedExecution {
  row: ExecutionRow;
  definition: WorkflowDefinition | null;
  state: ExecutionState | null;
  runData: RunData;
}

async function loadExecution(
  ctx: ServerContext,
  caller: AssistantCaller,
  id: string,
): Promise<LoadedExecution> {
  const row = await executionRow(ctx, caller, id);
  const data = await ctx.repos.executions.getData(caller.tenant.id, row.id);
  const state = (data?.state ?? null) as ExecutionState | null;
  return {
    row,
    definition: (data?.workflowData ?? null) as WorkflowDefinition | null,
    state,
    runData: state?.resultData?.runData ?? {},
  };
}

/** a string of run data as the model may read it */
const text = (value: unknown): string => safeValue(String(value ?? '')) as string;

/** one item: its JSON bounded and redacted, binary as file facts, never the bytes */
function previewItem(item: Item | null | undefined): DataObject {
  const out: DataObject = { json: safeValue(item?.json ?? {}) as DataObject };
  if (item?.binary && typeof item.binary === 'object') {
    const files: DataObject = {};
    for (const [key, file] of Object.entries(item.binary)) {
      files[text(key)] = {
        fileName: typeof file?.fileName === 'string' ? text(file.fileName) : null,
        mimeType: typeof file?.mimeType === 'string' ? text(file.mimeType) : null,
        fileSize: typeof file?.fileSize === 'number' ? file.fileSize : null,
      };
    }
    out.binary = files;
  }
  if (item?.error?.message) out.error = text(item.error.message);
  return out;
}

/** each output of a task (every connection type): item counts and, with values, a window of items */
function taskOutputs(
  data: TaskData['data'] | undefined,
  sendValues: boolean,
  start: number,
  max: number,
): DataObject[] {
  const outputs: DataObject[] = [];
  for (const [type, branches] of Object.entries(data ?? {})) {
    (branches ?? []).forEach((items, index) => {
      const list = Array.isArray(items) ? items : [];
      outputs.push({
        type,
        index,
        itemCount: list.length,
        ...(sendValues ? { items: list.slice(start, start + max).map(previewItem) } : {}),
      });
    });
  }
  return outputs;
}

function itemsOut(task: TaskData | undefined): number {
  return (task?.data?.main ?? []).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

/** each node of a run: last run's status, run count, items out and error; no values */
function nodeSummaries(runData: RunData): DataObject[] {
  return Object.entries(runData)
    .map(([name, runs]) => ({ name, runs: Array.isArray(runs) ? runs : [] }))
    .sort((a, b) => {
      const byTime = (a.runs[0]?.startTime ?? 0) - (b.runs[0]?.startTime ?? 0);
      if (byTime !== 0) return byTime;
      // same millisecond (stored run data does not keep key order): a node follows the node it read from
      const reads = (x: typeof a, from: string) =>
        x.runs.some((r) => (r.source ?? []).some((src) => src?.previousNode === from));
      if (reads(a, b.name)) return 1;
      if (reads(b, a.name)) return -1;
      return 0;
    })
    .map(({ name, runs }) => {
      const last = runs[runs.length - 1];
      return {
        node: text(name),
        status: last?.executionStatus ?? null,
        runs: runs.length,
        itemsOut: itemsOut(last),
        ...(last?.error?.message ? { error: text(last.error.message) } : {}),
      };
    });
}

/** a node that sends into an AI input (a model, a tool, a memory): it is called by its root, not run on its own */
function isSubNodeIn(definition: WorkflowDefinition | null, name: string): boolean {
  const byType = definition?.connections?.[name] as Record<string, unknown> | undefined;
  return Object.keys(byType ?? {}).some((type) => type !== 'main');
}

// ---------------------------------------------------------------------------------------------
// reads

const listExecutionsTool: AssistantToolDefinition<{
  workflowId?: string;
  status?: Array<(typeof STATUSES)[number]>;
  limit: number;
  cursor?: string;
}> = {
  name: 'list_executions',
  description: 'List recent executions, newest first, optionally of one workflow or with given statuses.',
  input: z.object({
    workflowId: workflowId.optional(),
    status: z.array(z.enum(STATUSES)).max(STATUSES.length).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional().describe('The nextCursor of an earlier page'),
  }),
  minRole: 'viewer',
  untrusted: 'execution-list',
  async handler(ctx, run, input) {
    if (input.workflowId) await ctx.workflows.get(run.tenant.id, input.workflowId);
    const query = parse(executionListQuery, {
      workflowId: input.workflowId,
      status: input.status?.length ? input.status.join(',') : undefined,
      limit: input.limit,
      cursor: input.cursor,
    });
    const page = await listExecutions(ctx, run.tenant.id, query);
    return {
      executions: page.data.map((e) => ({
        id: e.id,
        workflowId: e.workflowId,
        workflowName: e.workflowName,
        mode: e.mode,
        status: e.status,
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt,
        durationMs: e.durationMs,
        ...(e.errorMessage ? { errorMessage: text(e.errorMessage) } : {}),
        ...(e.errorNode ? { errorNode: e.errorNode } : {}),
      })),
      nextCursor: page.nextCursor,
    };
  },
};

const getExecutionTool: AssistantToolDefinition<{ executionId: string }> = {
  name: 'get_execution',
  description:
    "An execution's status, timing, error and what each node did (status, runs, item counts). It does not wait for a running execution.",
  input: z.object({ executionId }),
  minRole: 'viewer',
  untrusted: 'execution-output',
  async handler(ctx, run, input) {
    const { row, runData, state } = await loadExecution(ctx, run, input.executionId);
    const summary = executionSummary(row);
    return {
      id: summary.id,
      workflowId: summary.workflowId,
      workflowName: summary.workflowName,
      mode: summary.mode,
      status: summary.status,
      startedAt: summary.startedAt,
      stoppedAt: summary.stoppedAt,
      durationMs: summary.durationMs,
      waitTill: summary.waitTill,
      ...(row.errorMessage ? { error: { message: text(row.errorMessage), node: row.errorNode } } : {}),
      lastNodeExecuted: state?.resultData?.lastNodeExecuted ?? null,
      nodes: nodeSummaries(runData),
    };
  },
};

const debugExecution: AssistantToolDefinition<{ executionId: string }> = {
  name: 'debug_execution',
  description:
    'Why an execution failed: the failed node, its error, and the trace of the nodes that ran before it. Use get_resolved_node_parameters and get_node_output for more.',
  input: z.object({ executionId }),
  minRole: 'viewer',
  untrusted: 'execution-output',
  async handler(ctx, run, input) {
    const { row, runData, state, definition } = await loadExecution(ctx, run, input.executionId);
    const trace = nodeSummaries(runData);
    const stateError = state?.resultData?.error;
    if (!['error', 'crashed'].includes(row.status) && !stateError && !row.errorMessage) {
      return {
        executionId: row.id,
        status: row.status,
        note: `This execution did not fail (status ${row.status})`,
        trace,
      };
    }
    const failedName =
      row.errorNode ??
      stateError?.node ??
      Object.entries(runData).find(([, runs]) => runs?.some((t) => t.error))?.[0] ??
      state?.resultData?.lastNodeExecuted ??
      null;
    const failedRuns = failedName ? (runData[failedName] ?? []) : [];
    const failedTask = [...failedRuns].reverse().find((t) => t.error) ?? failedRuns[failedRuns.length - 1];
    const error = failedTask?.error ?? stateError;
    const node = failedName ? definition?.nodes?.find((n) => n.name === failedName) : undefined;
    const source = failedTask?.source?.[0];
    const inputItems =
      source?.previousNode !== undefined
        ? (runData[source.previousNode]?.[source.previousNodeRun ?? 0]?.data?.main?.[
            source.previousNodeOutput ?? 0
          ] ?? [])
        : [];
    return {
      executionId: row.id,
      status: row.status,
      failedNode: failedName
        ? {
            name: text(failedName),
            ...(node ? { type: node.type, typeVersion: node.typeVersion } : {}),
            runIndex: failedRuns.length ? failedRuns.indexOf(failedTask as TaskData) : null,
            inputItemCount: Array.isArray(inputItems) ? inputItems.length : 0,
            ...(source?.previousNode ? { inputFrom: text(source.previousNode) } : {}),
          }
        : null,
      error: error
        ? {
            message: text(error.message),
            ...(error.description ? { description: text(error.description) } : {}),
            ...(error.code ? { code: text(error.code) } : {}),
            ...(error.hint ? { hint: text(error.hint) } : {}),
            ...(error.httpCode ? { httpCode: text(error.httpCode) } : {}),
            ...(error.parameter ? { parameter: text(error.parameter) } : {}),
            ...(typeof error.itemIndex === 'number' ? { itemIndex: error.itemIndex } : {}),
          }
        : { message: text(row.errorMessage ?? 'Unknown error') },
      trace,
    };
  },
};

const getNodeOutput: AssistantToolDefinition<{
  executionId: string;
  nodeName: string;
  startIndex: number;
  maxItems: number;
}> = {
  name: 'get_node_output',
  description:
    "A node's output in an execution: the last run of a main node, every call of a sub-node (model, tool, memory). Read a window of items with startIndex and maxItems.",
  input: z.object({
    executionId,
    nodeName,
    startIndex: z.number().int().min(0).default(0),
    maxItems: z.number().int().min(1).max(50).default(10),
  }),
  minRole: 'viewer',
  untrusted: 'execution-output',
  async handler(ctx, run, input) {
    const { row, runData, definition } = await loadExecution(ctx, run, input.executionId);
    const runs = runData[input.nodeName];
    if (!runs?.length) throw new Error(`Node '${input.nodeName}' did not run in this execution`);
    const subNode = isSubNodeIn(definition, input.nodeName);
    const chosen = subNode
      ? runs.map((task, runIndex) => ({ task, runIndex }))
      : [{ task: runs[runs.length - 1], runIndex: runs.length - 1 }];
    return {
      executionId: row.id,
      node: text(input.nodeName),
      kind: subNode ? 'sub-node (every call)' : 'main node (last run)',
      totalRuns: runs.length,
      ...(run.sendValues ? {} : { note: VALUES_HIDDEN }),
      runs: chosen.map(({ task, runIndex }) => ({
        runIndex,
        status: task?.executionStatus ?? null,
        ...(task?.error?.message ? { error: text(task.error.message) } : {}),
        ...(subNode && task?.inputOverride
          ? { input: taskOutputs(task.inputOverride, run.sendValues, input.startIndex, input.maxItems) }
          : {}),
        outputs: taskOutputs(task?.data, run.sendValues, input.startIndex, input.maxItems),
      })),
    };
  },
};

const getResolvedNodeParameters: AssistantToolDefinition<{
  executionId: string;
  nodeName: string;
  itemIndex: number;
  runIndex?: number;
}> = {
  name: 'get_resolved_node_parameters',
  description:
    "A node's parameters as they resolved in an execution for one item of one run (default the first item of the last run): each expression with its value, the ones that failed and the ones that came out empty. Nothing runs again.",
  input: z.object({
    executionId,
    nodeName,
    itemIndex: z.number().int().min(0).default(0),
    runIndex: z.number().int().min(0).optional(),
  }),
  minRole: 'viewer',
  untrusted: 'resolved-parameters',
  async handler(ctx, run, input) {
    const { row, runData, definition } = await loadExecution(ctx, run, input.executionId);
    if (!definition) throw new Error('This execution kept no workflow data');
    return {
      executionId: row.id,
      ...resolveNodeParameters({
        definition,
        runData,
        nodeName: input.nodeName,
        itemIndex: input.itemIndex,
        runIndex: input.runIndex,
        executionId: row.id,
        mode: row.mode as ExecutionMode,
        sendValues: run.sendValues,
      }),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// runs (a card each)

async function runnableWorkflow(
  ctx: ServerContext,
  caller: AssistantCaller,
  id: string,
): Promise<{ row: WorkflowRow; definition: WorkflowDefinition; workflow: Workflow }> {
  const row = await ctx.workflows.get(caller.tenant.id, id);
  if (row.isArchived) throw new Error('The workflow is archived; unarchive it before running it');
  const definition = toDefinition(row);
  return { row, definition, workflow: new Workflow(definition, ctx.registries.nodeTypes) };
}

/** the trigger a run starts from: the named one, else the one the editor's run button picks */
function startTrigger(workflow: Workflow, name: string | undefined) {
  if (name) {
    const node = workflow.nodes[name];
    if (!node) throw new Error(`Node '${name}' is not in the workflow`);
    return node;
  }
  const node = chooseManualStartNode(workflow);
  if (!node) throw new Error('The workflow has no trigger to start from');
  return node;
}

const minutes = (ms: number) => `${Math.round((ms / 60_000) * 10) / 10} min`;

/** rows of the model's input data for the card's preview (objects only; anything else as one value) */
function inputRows(inputData: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(inputData) ? inputData : inputData === undefined ? [] : [inputData];
  return list.map((v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v },
  );
}

/** the card's preview of the input rows (the gate bounds and redacts it again) */
function inputPreview(rows: Array<Record<string, unknown>>): AssistantPreviewTable {
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const shown = columns.slice(0, ASSISTANT_PREVIEW.columns);
  const cell = (value: unknown) => {
    const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    return raw.length > ASSISTANT_PREVIEW.valueChars ? `${raw.slice(0, ASSISTANT_PREVIEW.valueChars)}…` : raw;
  };
  return {
    columns: shown,
    rows: rows.slice(0, ASSISTANT_PREVIEW.rows).map((row) => shown.map((column) => cell(row[column]))),
    omittedRows: Math.max(0, rows.length - ASSISTANT_PREVIEW.rows),
    omittedColumns: Math.max(0, columns.length - shown.length),
  };
}

type RunWorkflowInput = {
  workflowId: string;
  inputData?: unknown;
  triggerNodeName?: string;
  timeout: number;
  approvalSummary?: string;
};

const runWorkflowTool: AssistantToolDefinition<RunWorkflowInput> = {
  name: 'run_workflow',
  description:
    "Run a saved workflow (its draft) and wait for the result. inputData becomes the trigger's output: a Form's fields, a Webhook's body (or headers, query, body), a Chat message, or plain items. Always needs the person's approval; it runs the nodes for real.",
  input: z.object({
    workflowId,
    inputData: z.unknown().optional().describe("The trigger's data (JSON), never evaluated"),
    triggerNodeName: nodeName.optional().describe('The trigger to start from when there are several'),
    timeout,
    approvalSummary,
  }),
  minRole: 'editor',
  permission: 'runWorkflow',
  // n8n: a run always waits for the person; no "always allow this session"
  grantKey: () => null,
  async approval(ctx, caller, input): Promise<ApprovalCopy> {
    const { row, definition, workflow } = await runnableWorkflow(ctx, caller, input.workflowId);
    const trigger = startTrigger(workflow, input.triggerNodeName);
    // data the trigger cannot take (Form fields inside `formFields`) is refused before any card
    triggerPinData(definition, trigger.name, input.inputData);
    const rows = inputRows(input.inputData);
    return {
      title: 'Run workflow',
      resourceName: row.name,
      ...(input.approvalSummary ? { approvalSummary: input.approvalSummary } : {}),
      details: {
        facts: [
          { label: 'Workflow', value: row.name },
          { label: 'Trigger', value: trigger.name },
          { label: 'Input data', value: rows.length ? `${rows.length} item(s)` : 'None' },
          { label: 'Stops after', value: minutes(input.timeout) },
        ],
        ...(rows.length ? { preview: inputPreview(rows) } : {}),
      },
    };
  },
  async handler(ctx, run, input) {
    const { row, definition, workflow } = await runnableWorkflow(ctx, run, input.workflowId);
    const trigger = startTrigger(workflow, input.triggerNodeName);
    const pinData = {
      ...((definition.pinData ?? {}) as Record<string, Item[]>),
      ...triggerPinData(definition, trigger.name, input.inputData),
    };
    const outcome = await runAndCollect(
      ctx,
      run,
      { workflow: definition, workflowId: row.id, startNode: trigger.name, pinData },
      input.timeout,
    );
    const head =
      outcome.status === 'timedOut'
        ? outcome.aborted
          ? 'The run was stopped because this turn was stopped.'
          : `The run did not finish within ${minutes(input.timeout)} and was stopped.`
        : outcome.status === 'waiting'
          ? 'The run is waiting (a Wait, Form or approval step); it was not stopped.'
          : `The run ended with status ${outcome.status}.`;
    return `${head}\n${previewOutput(outcome, run.sendValues)}`;
  },
};

type RunNodeMode = 'chain' | 'reused-execution' | 'mocked' | 'tool';

type RunNodeInput = {
  workflowId: string;
  nodeName: string;
  reuseExecutionId?: string;
  mockInput?: unknown;
  toolArguments?: Record<string, unknown>;
  timeout: number;
  approvalSummary?: string;
};

function runNodeMode(input: RunNodeInput): RunNodeMode {
  if (input.toolArguments !== undefined) return 'tool';
  if (input.reuseExecutionId) return 'reused-execution';
  if (input.mockInput !== undefined) return 'mocked';
  return 'chain';
}

const MODE_NOTES: Record<RunNodeMode, string> = {
  chain: 'The nodes before the target ran for real in this run.',
  'reused-execution':
    'The nodes before the target replayed their output from the reused execution; only the nodes in executedNodeNames ran.',
  mocked:
    'The target got invented input and the nodes before it got placeholder data, so this result does not show that the workflow works.',
  tool: 'The tool ran with the given arguments; the agent it belongs to did not run.',
};

/**
 * The thread grant a run_node card covers: the mode is in it, so a grant from a mocked or tool run never
 * covers a run whose earlier nodes really run. A chain run gets none (as `run_workflow`: it runs the
 * unpinned nodes before the target, and that set changes with the workflow); a reused run names its
 * execution, since what replays and what runs again depends on it.
 */
export function runNodeGrantKey(input: RunNodeInput): string | null {
  const mode = runNodeMode(input);
  if (mode === 'chain') return null;
  const scope = mode === 'reused-execution' ? `${mode}:${input.reuseExecutionId}` : mode;
  return `run_node:${input.workflowId}:${scope}:${input.nodeName}`;
}

/** names on a card, as many as fit in 400 characters, then a count of the rest */
function nameList(names: string[]): string {
  const shown: string[] = [];
  let length = 0;
  for (const name of names) {
    if (length + name.length > 400) break;
    shown.push(name);
    length += name.length + 2;
  }
  const rest = names.length - shown.length;
  if (!rest) return shown.join(', ');
  return shown.length ? `${shown.join(', ')} and ${rest} more` : `${rest} nodes`;
}

/** what a run_node card says about the nodes before the target, read from the saved workflow */
async function runNodeFacts(
  ctx: ServerContext,
  caller: AssistantCaller,
  input: RunNodeInput,
  definition: WorkflowDefinition,
  workflow: Workflow,
): Promise<Array<{ label: string; value: string }>> {
  const mode = runNodeMode(input);
  if (mode === 'tool') {
    return [
      { label: 'Before the target', value: 'Nothing else runs: the agent the tool belongs to does not run' },
    ];
  }
  if (mode === 'mocked') {
    return [
      { label: 'Before the target', value: 'The nodes before it do not run: they get placeholder data' },
    ];
  }
  const pinned = new Set(Object.keys(definition.pinData ?? {}));
  let earlier = workflow
    .getParentNodes(input.nodeName, 'main')
    .filter((name) => !pinned.has(name) && !workflow.nodes[name]?.disabled)
    .reverse();
  if (mode === 'reused-execution') {
    const replayed = (await loadExecution(ctx, caller, input.reuseExecutionId as string)).runData;
    earlier = earlier.filter((name) => !replayed[name]?.length);
    if (!earlier.length) {
      return [
        {
          label: 'Before the target',
          value: 'The nodes before it replay their output from that execution and do not run',
        },
      ];
    }
  }
  if (!earlier.length) return [{ label: 'Before the target', value: 'No other node runs' }];
  return [
    { label: 'Also runs for real', value: nameList(earlier) },
    {
      label: 'Note',
      value: `The ${earlier.length === 1 ? 'node' : `${earlier.length} nodes`} before the target really run: what they send or change happens again`,
    },
  ];
}

/** polls the row until the run ends or parks, the timeout passes or the turn stops; stops it then */
async function waitForRun(
  ctx: ServerContext,
  run: AssistantRunScope,
  id: string,
  timeoutMs: number,
): Promise<'finished' | 'timeout' | 'aborted'> {
  const deadline = Date.now() + timeoutMs;
  let ending: 'finished' | 'timeout' | 'aborted' = 'finished';
  for (;;) {
    const row = await ctx.repos.executions.get(run.tenant.id, id);
    if (!row || !OPEN.has(row.status)) break;
    if (run.signal.aborted) {
      ending = 'aborted';
      break;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      ending = 'timeout';
      break;
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        run.signal.removeEventListener('abort', done);
        resolve();
      };
      timer = setTimeout(done, Math.min(100, left));
      timer.unref?.();
      run.signal.addEventListener('abort', done, { once: true });
    });
  }
  if (ending !== 'finished') {
    await ctx.executions.stop(run.tenant.id, id).catch((error) => {
      ctx.logger.warn(
        { err: error, tenantId: run.tenant.id, executionId: id },
        'Assistant run could not be stopped',
      );
    });
  }
  return ending;
}

const runNodeTool: AssistantToolDefinition<RunNodeInput> = {
  name: 'run_node',
  description:
    "Run one node of a saved workflow and wait. Modes: neither option runs the nodes before it for real (chain); reuseExecutionId replays their output from that earlier execution; mockInput gives the node invented input (weakest evidence); toolArguments runs a tool sub-node with those arguments. Writing nodes do their work again. Needs the person's approval.",
  input: z.object({
    workflowId,
    nodeName,
    reuseExecutionId: executionId.optional().describe('An earlier execution of this workflow to replay'),
    mockInput: z.unknown().optional().describe('Invented input items for the node (JSON), never evaluated'),
    toolArguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for a tool sub-node'),
    timeout,
    approvalSummary,
  }),
  minRole: 'editor',
  permission: 'runWorkflow',
  grantKey: runNodeGrantKey,
  async approval(ctx, caller, input): Promise<ApprovalCopy> {
    const { row, definition, workflow } = await runnableWorkflow(ctx, caller, input.workflowId);
    if (!workflow.nodes[input.nodeName]) throw new Error(`Node '${input.nodeName}' is not in the workflow`);
    if (input.reuseExecutionId) await executionRow(ctx, caller, input.reuseExecutionId);
    const mode = runNodeMode(input);
    const given =
      mode === 'mocked' ? inputRows(input.mockInput) : mode === 'tool' ? [input.toolArguments ?? {}] : [];
    return {
      title: 'Run a node',
      resourceName: `${row.name}: ${input.nodeName}`,
      ...(input.approvalSummary ? { approvalSummary: input.approvalSummary } : {}),
      details: {
        facts: [
          { label: 'Workflow', value: row.name },
          { label: 'Node', value: input.nodeName },
          { label: 'Input', value: mode },
          ...(input.reuseExecutionId ? [{ label: 'Replays execution', value: input.reuseExecutionId }] : []),
          ...(await runNodeFacts(ctx, caller, input, definition, workflow)),
          { label: 'Stops after', value: minutes(input.timeout) },
        ],
        // the invented input or the tool's arguments the target runs with
        ...(given.length ? { preview: inputPreview(given) } : {}),
      },
    };
  },
  untrusted: 'execution-output',
  async handler(ctx, run, input) {
    const { row, definition, workflow } = await runnableWorkflow(ctx, run, input.workflowId);
    const target = workflow.nodes[input.nodeName];
    if (!target) throw new Error(`Node '${input.nodeName}' is not in the workflow`);
    const given = [input.reuseExecutionId, input.mockInput, input.toolArguments].filter(
      (v) => v !== undefined,
    );
    if (given.length > 1)
      throw new Error('Give at most one of reuseExecutionId, mockInput and toolArguments');
    const mode = runNodeMode(input);
    const subNode = workflow.isSubNode(target) || isSubNodeIn(definition, target.name);
    const isTool = Object.keys(definition.connections?.[target.name] ?? {}).includes('ai_tool');

    const body: Parameters<WorkflowService['run']>[2] = { destinationNode: target.name };
    let mocked: string[] = [];
    let replayFrom: RunData | undefined;
    if (subNode && !isTool) {
      throw new Error(`'${target.name}' is a sub-node; run the node it is connected to instead`);
    }
    if (subNode && mode !== 'tool') {
      throw new Error(`'${target.name}' is a tool: run it with toolArguments`);
    }
    if (mode === 'tool') {
      if (!isTool) throw new Error('toolArguments is only for a tool sub-node');
      body.agentRequest = { query: input.toolArguments ?? {}, toolName: target.name };
    } else if (mode === 'reused-execution') {
      const earlier = await loadExecution(ctx, run, input.reuseExecutionId as string);
      if (earlier.row.workflowId !== row.id) throw new Error('That execution belongs to another workflow');
      if (!Object.keys(earlier.runData).length) throw new Error('That execution kept no run data to replay');
      replayFrom = earlier.runData;
      body.runData = earlier.runData as unknown as NonNullable<typeof body.runData>;
      body.dirtyNodeNames = [target.name];
    } else if (mode === 'mocked') {
      const parents = workflow.getParentNodes(target.name, 'main', 1);
      if (!parents.length) {
        throw new Error(`'${target.name}' has no input to mock; use run_workflow with inputData`);
      }
      const items = inputRows(input.mockInput).map((json) => ({ json: json as DataObject }));
      const pinData: Record<string, Item[]> = {};
      for (const name of workflow.getParentNodes(target.name, 'main')) {
        pinData[name] = parents.includes(name) ? (items.length ? items : [{ json: {} }]) : [{ json: {} }];
      }
      mocked = Object.keys(pinData);
      body.pinData = pinData as unknown as NonNullable<typeof body.pinData>;
    }

    run.signal.throwIfAborted();
    const startedAt = Date.now();
    const { executionId: id } = await ctx.workflows.run(run.tenant, row.id, body, run.actor);
    const ending = await waitForRun(ctx, run, id, input.timeout);

    const done = await loadExecution(ctx, run, id);
    const pinned = new Set([...mocked, ...Object.keys(definition.pinData ?? {})]);
    const executed = Object.entries(done.runData)
      .filter(
        ([name, runs]) => !pinned.has(name) && runs?.some((t) => (t.startTime ?? 0) >= startedAt - 1000),
      )
      .map(([name]) => name);
    const replayed = replayFrom ? Object.keys(replayFrom).filter((name) => !executed.includes(name)) : [];
    const targetRuns = done.runData[target.name] ?? [];
    const last = targetRuns[targetRuns.length - 1];
    const ran = executed.includes(target.name);
    const status = ending === 'finished' ? done.row.status : 'timedOut';
    const notes = [MODE_NOTES[mode]];
    if (!ran) notes.push('The target node did not run in this execution.');
    if (status === 'waiting')
      notes.push('The run is waiting (a Wait, Form or approval step); it was not stopped.');
    if (ending === 'timeout')
      notes.push(`The run did not finish within ${minutes(input.timeout)} and was stopped.`);
    if (ending === 'aborted') notes.push('The run was stopped because this turn was stopped.');
    if (!run.sendValues) notes.push(VALUES_HIDDEN);
    return {
      executionId: id,
      mode,
      status,
      ...(done.row.errorMessage
        ? { error: { message: text(done.row.errorMessage), node: done.row.errorNode } }
        : {}),
      target: {
        node: text(target.name),
        ran,
        ...(last
          ? {
              status: last.executionStatus,
              ...(last.error?.message ? { error: text(last.error.message) } : {}),
              outputs: taskOutputs(last.data, run.sendValues, 0, RUN_PREVIEW.items),
            }
          : {}),
      },
      executedNodeNames: executed,
      ...(replayFrom ? { replayedNodeNames: replayed } : {}),
      ...(mocked.length ? { mockedNodeNames: mocked } : {}),
      notes,
    };
  },
};

const stopExecution: AssistantToolDefinition<{ executionId: string; approvalSummary?: string }> = {
  name: 'stop_execution',
  description: "Stop a running or waiting execution. Needs the person's approval.",
  input: z.object({ executionId, approvalSummary }),
  minRole: 'editor',
  permission: 'runWorkflow',
  grantKey: (input) => `stop_execution:${input.executionId}`,
  async approval(ctx, caller, input): Promise<ApprovalCopy> {
    const row = await executionRow(ctx, caller, input.executionId);
    return {
      title: 'Stop execution',
      resourceName: row.workflowName || row.id,
      ...(input.approvalSummary ? { approvalSummary: input.approvalSummary } : {}),
      details: {
        facts: [
          { label: 'Workflow', value: row.workflowName || '(unsaved)' },
          { label: 'Execution', value: row.id },
          { label: 'Status', value: row.status },
        ],
      },
    };
  },
  async handler(ctx, run, input) {
    const row = await executionRow(ctx, run, input.executionId);
    if (!OPEN.has(row.status) && row.status !== 'waiting') {
      return { executionId: row.id, status: row.status, note: 'The execution had already ended' };
    }
    const status = await ctx.executions.stop(run.tenant.id, row.id);
    return { executionId: row.id, status };
  },
};

export const executionsTools: AssistantToolDefinition[] = [
  listExecutionsTool,
  getExecutionTool,
  debugExecution,
  getNodeOutput,
  getResolvedNodeParameters,
  runWorkflowTool,
  runNodeTool,
  stopExecution,
];
