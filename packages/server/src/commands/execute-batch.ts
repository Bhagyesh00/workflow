/**
 * P6-78 (L11): `execute-batch`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - execute-batch: `--tenant <slug> --ids <a,b>`, `--concurrency`, `--retries`, `--skipList`, `--output`; summary only
 * Runs each workflow like `execute` (mode `cli`, in this process) up to `--concurrency` at a time (1 to 20,
 * default 1). A run that does not succeed is tried again up to `--retries` more times (0 to 10, default 0).
 * `--ids all` takes every workflow that is not archived; `--skipList` names ids (a file with one per line, or
 * a JSON list) that are not run. The summary holds counts and one row per id (status, attempts, execution id,
 * error text), never a node's items. It goes to stdout, or to `--output` with one line on stdout. The exit is
 * 1 when any run failed.
 */
import type { ServerContext } from '../context';
import {
  allWorkflows,
  CommandUsageError,
  errorText,
  parseCommandArgs,
  requireTenant,
  runCommand,
  toJson,
} from './command-args';
import type { CommandIo } from './command-io';
import { runWorkflowOnce } from './execute';

export const EXECUTE_BATCH_USAGE =
  'Usage: execute-batch --tenant <slug> --ids <id,id,...|all> [--concurrency <n>] [--retries <n>] [--skipList <path>] [--output <path>]';

interface BatchRow {
  id: string;
  status: 'success' | 'error' | 'skipped';
  attempts: number;
  executionId?: string;
  error?: string;
}

/** the ids of a skip list: a JSON list of ids, or ids split by new lines and commas */
function skipIds(text: string): Set<string> {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    } catch {
      // not JSON: read it as lines
    }
  }
  return new Set(
    trimmed
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function executeBatchCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, EXECUTE_BATCH_USAGE, async (out) => {
    const args = parseCommandArgs(argv, {
      values: ['tenant', 'ids', 'concurrency', 'retries', 'skipList', 'output'],
    });
    const tenant = await requireTenant(ctx, args);
    const wanted = args.value('ids');
    if (wanted === undefined) throw new CommandUsageError('--ids <id,id,...|all> is required');
    const concurrency = args.integer('concurrency', 1, 1, 20);
    const retries = args.integer('retries', 0, 0, 10);
    const skipPath = args.value('skipList');
    const skip = skipPath === undefined ? new Set<string>() : skipIds(await out.readFile(skipPath));
    const ids =
      wanted === 'all'
        ? (await allWorkflows(ctx, tenant.id)).map((row) => row.id)
        : [
            ...new Set(
              wanted
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean),
            ),
          ];
    if (ids.length === 0) throw new CommandUsageError('--ids names no workflow');

    const rows: BatchRow[] = new Array(ids.length);
    const runOne = async (id: string): Promise<BatchRow> => {
      if (skip.has(id)) return { id, status: 'skipped', attempts: 0 };
      let last: BatchRow = { id, status: 'error', attempts: 0 };
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          const run = await runWorkflowOnce(ctx, tenant.id, id);
          last = {
            id,
            status: run.status === 'success' ? 'success' : 'error',
            attempts: attempt,
            executionId: run.executionId,
            ...(run.error ? { error: run.error } : {}),
          };
          if (run.status === 'success') return last;
        } catch (error) {
          // a workflow that cannot start (unknown, archived, a broken graph) is not tried again
          return { id, status: 'error', attempts: attempt, error: errorText(error) };
        }
      }
      return last;
    };
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next++;
        rows[index] = await runOne(ids[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    const succeeded = rows.filter((row) => row.status === 'success').length;
    const failed = rows.filter((row) => row.status === 'error').length;
    const skipped = rows.filter((row) => row.status === 'skipped').length;
    for (const row of rows) {
      if (row.status === 'error')
        out.stderr(`Workflow ${row.id} failed${row.error ? `: ${row.error}` : ''}\n`);
    }
    const summary = { total: rows.length, succeeded, failed, skipped, results: rows };
    const output = args.value('output');
    if (output === undefined) {
      out.stdout(toJson(summary, true));
    } else {
      await out.writeFile(output, toJson(summary, true), {});
      out.stdout(`Batch finished: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped.\n`);
    }
    return failed === 0 ? 0 : 1;
  });
}
