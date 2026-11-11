/**
 * P6-78 (L11): `execute`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - execute: `--tenant <slug> --id <workflowId>`, `--rawOutput`
 * Runs the workflow's saved draft in this process through the execution service (`executions.start`, mode
 * `cli`), as the MCP production path does, never through `WorkflowService.run`: it is no manual run, so it
 * works on a protected workspace (as n8n's `execute`), and the run's own checks (the `workflowStart` policy,
 * credential use in the workflow's project) still apply. Prints the last node's items, or with `--rawOutput`
 * only those items. A run that does not succeed prints its error on stderr and exits 1.
 */
import { type ExecutionStatus, Workflow, type WorkflowDefinition } from '@workflow/workflow';
import type { ServerContext } from '../context';
import { toDefinition } from '../services/workflow-model';
import { chooseManualStartNode } from '../services/workflows';
import {
  CommandUsageError,
  errorText,
  parseCommandArgs,
  requireTenant,
  runCommand,
  toJson,
} from './command-args';
import type { CommandIo } from './command-io';

export const EXECUTE_USAGE = 'Usage: execute --tenant <slug> --id <workflowId> [--rawOutput]';

export interface CliRun {
  executionId: string;
  status: ExecutionStatus;
  lastNodeExecuted?: string;
  /** the last node's items; absent when the workflow redacts its execution data */
  data?: unknown[];
  redacted: boolean;
  error?: string;
}

/** runs one saved workflow of the workspace to its end in this process; a workflow that cannot start throws */
export async function runWorkflowOnce(
  ctx: ServerContext,
  tenantId: string,
  workflowId: string,
): Promise<CliRun> {
  const row = await ctx.workflows.get(tenantId, workflowId);
  if (row.isArchived) throw new Error(`Workflow "${row.name}" is archived`);
  const definition: WorkflowDefinition = toDefinition(row);
  let workflow: Workflow;
  try {
    workflow = new Workflow(definition, ctx.registries.nodeTypes);
  } catch (error) {
    throw new Error(`Workflow "${row.name}" cannot run: ${errorText(error)}`);
  }
  const start = chooseManualStartNode(workflow);
  if (!start) throw new Error(`Workflow "${row.name}" has no node to start from`);
  const started = await ctx.executions.start({
    tenantId,
    workflow: definition,
    workflowId: row.id,
    mode: 'cli',
    startNode: start.name,
    inline: true,
    wait: true,
  });
  const outcome = await started.finished;
  if (!outcome) throw new Error('The run did not report an outcome');
  // a workflow that redacts its production data never prints it here either
  const redacted = Boolean(
    outcome.redaction?.own.production || outcome.redaction?.fromSubWorkflows.production,
  );
  const branch = (outcome.lastNodeOutput ?? []).find((items) => items?.length) ?? [];
  return {
    executionId: outcome.executionId,
    status: outcome.status,
    lastNodeExecuted: outcome.lastNodeExecuted,
    ...(redacted ? {} : { data: branch.map((item) => item.json) }),
    redacted,
    ...(outcome.error ? { error: errorText(new Error(outcome.error.message)) } : {}),
  };
}

export function executeCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, EXECUTE_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['tenant', 'id'], flags: ['rawOutput'] });
    const tenant = await requireTenant(ctx, args);
    const id = args.value('id');
    if (id === undefined) throw new CommandUsageError('--id <workflowId> is required');
    const run = await runWorkflowOnce(ctx, tenant.id, id);
    if (run.status !== 'success') {
      out.stderr(`Execution ${run.executionId} ${run.status}${run.error ? `: ${run.error}` : ''}\n`);
    }
    if (run.redacted) out.stderr('The output is not printed: the workflow redacts its execution data.\n');
    if (args.flag('rawOutput')) {
      if (run.status === 'success') out.stdout(toJson(run.data ?? [], true));
    } else {
      out.stdout(
        toJson(
          {
            executionId: run.executionId,
            status: run.status,
            lastNodeExecuted: run.lastNodeExecuted ?? null,
            ...(run.data ? { data: run.data } : {}),
          },
          true,
        ),
      );
    }
    return run.status === 'success' ? 0 : 1;
  });
}
