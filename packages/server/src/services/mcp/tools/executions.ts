/**
 * MCP tools: executions of workflows available in MCP (P5-04; research-B section 2, part a).
 * `get_workflow_execution` gives the metadata, and with `includeData` the run data (node filter, items
 * per output capped by `truncateData`). `search_workflow_executions` lists only executions of workflows
 * the gate lets through. Run data is untrusted text for the client's model (server instructions).
 */
import type { DataObject } from '@workflow/workflow';
import { z } from 'zod';
import { parse } from '../../../http/errors';
import { executionListQuery, getExecution, listExecutions } from '../../../routes/executions';
import type { McpToolDefinition } from '../types';
import {
  assertWorkflowForMcp,
  McpToolError,
  mcpListFilter,
  requireMcpScope,
  workflowsAvailableInMcp,
} from '../workflow-gate';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] as const;
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const MCP_EXECUTION_TEXTS = {
  notFound: (id: string) => `Execution '${id}' not found for this workflow`,
} as const;

interface TaskLike {
  startTime?: number;
  executionTime?: number;
  executionStatus?: string;
  error?: unknown;
  data?: Record<string, Array<Array<{ json?: unknown }> | null>>;
}

/** the run data of the named nodes (all when none), each output cut to `limit` items (json only) */
function runDataView(state: unknown, nodeNames: string[] | undefined, limit: number) {
  const resultData = ((state ?? {}) as { resultData?: DataObject }).resultData ?? {};
  const runData = (resultData.runData ?? {}) as Record<string, TaskLike[]>;
  const wanted = nodeNames?.length ? new Set(nodeNames) : undefined;
  const nodes: Record<string, unknown[]> = {};
  let truncated = false;
  for (const [name, tasks] of Object.entries(runData)) {
    if (wanted && !wanted.has(name)) continue;
    nodes[name] = (tasks ?? []).map((task) => {
      const outputs: Record<string, unknown[][]> = {};
      for (const [type, branches] of Object.entries(task?.data ?? {})) {
        outputs[type] = (branches ?? []).map((items) => {
          const list = items ?? [];
          if (list.length > limit) truncated = true;
          return list.slice(0, limit).map((item) => item?.json ?? null);
        });
      }
      return {
        startTime: task?.startTime ?? null,
        executionTime: task?.executionTime ?? null,
        executionStatus: task?.executionStatus ?? null,
        ...(task?.error ? { error: errorText(task.error) } : {}),
        data: outputs,
      };
    });
  }
  const error = resultData.error ? errorText(resultData.error) : null;
  return { lastNodeExecuted: resultData.lastNodeExecuted ?? null, error, truncated, nodes };
}

function errorText(error: unknown) {
  const value = (
    typeof error === 'object' && error !== null ? error : { message: String(error) }
  ) as DataObject;
  return {
    message: typeof value.message === 'string' ? value.message : 'Unknown error',
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.node === 'object' && value.node !== null
      ? { node: (value.node as DataObject).name ?? null }
      : {}),
  };
}

const getWorkflowExecution: McpToolDefinition<{
  workflowId: string;
  executionId: string;
  includeData: boolean;
  nodeNames?: string[];
  truncateData: number;
}> = {
  name: 'get_workflow_execution',
  description:
    'Get an execution of a workflow available in MCP: status, timing and error. With includeData, also the output items of each node (filter with nodeNames; at most truncateData items per output).',
  scopes: ['execution:read'],
  access: 'execution:read',
  input: z.object({
    workflowId: z.uuid(),
    executionId: z.uuid(),
    includeData: z.boolean().default(false),
    nodeNames: z.array(z.string().min(1).max(256)).max(100).optional(),
    truncateData: z.number().int().min(1).max(1000).default(20),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    const row = await ctx.repos.executions.get(caller.tenant.id, input.executionId);
    if (!row || row.workflowId !== input.workflowId) {
      throw new McpToolError(MCP_EXECUTION_TEXTS.notFound(input.executionId));
    }
    // the execution's own scope, on the project of its workflow (P6-35)
    await requireMcpScope(ctx, caller, 'execution:read', { executionId: row.id });
    const execution = await getExecution(ctx, caller.tenant.id, input.executionId, false);
    if (!input.includeData) return { execution };
    const data = await ctx.repos.executions.getData(caller.tenant.id, input.executionId);
    return { execution, data: runDataView(data?.state, input.nodeNames, input.truncateData) };
  },
};

const searchWorkflowExecutions: McpToolDefinition<{
  workflowId?: string;
  status?: Array<(typeof STATUSES)[number]>;
  limit: number;
  cursor?: string;
}> = {
  name: 'search_workflow_executions',
  description:
    'List executions, newest first, of one workflow available in MCP or of all of them; filter by status.',
  scopes: ['execution:read'],
  access: 'execution:list',
  input: z.object({
    workflowId: z.uuid().optional(),
    status: z.array(z.enum(STATUSES)).min(1).max(STATUSES.length).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    if (input.workflowId) await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
    const query = parse(executionListQuery, {
      workflowId: input.workflowId,
      status: input.status?.join(','),
      limit: input.limit,
      cursor: input.cursor,
    });
    const filter = await mcpListFilter(ctx, caller, 'execution:list');
    const page = await listExecutions(ctx, caller.tenant.id, query, { filter });
    const available = await workflowsAvailableInMcp(
      ctx,
      caller.tenant.id,
      page.data.map((e) => e.workflowId).filter((id): id is string => typeof id === 'string'),
    );
    return {
      data: page.data
        .filter((e) => e.workflowId && available.has(e.workflowId))
        .map((e) => ({
          id: e.id,
          workflowId: e.workflowId,
          workflowName: e.workflowName,
          mode: e.mode,
          status: e.status,
          startedAt: e.startedAt,
          stoppedAt: e.stoppedAt,
          durationMs: e.durationMs,
          errorMessage: e.errorMessage,
          errorNode: e.errorNode,
        })),
      nextCursor: page.nextCursor,
    };
  },
};

export const executionsTools: McpToolDefinition<any>[] = [getWorkflowExecution, searchWorkflowExecutions];
