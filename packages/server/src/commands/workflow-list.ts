/**
 * P6-78 (L11): `list:workflow`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - list:workflow: `--tenant <slug>`, `--active` (`--active=false` lists the unpublished), `--onlyId`
 * One line per workflow: `<id>|<name>`, or only the id.
 */
import type { ServerContext } from '../context';
import { allWorkflows, parseCommandArgs, requireTenant, runCommand } from './command-args';
import type { CommandIo } from './command-io';

export const LIST_WORKFLOW_USAGE = 'Usage: list:workflow --tenant <slug> [--active[=true|false]] [--onlyId]';

export function listWorkflowCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, LIST_WORKFLOW_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['tenant'], flags: ['active', 'onlyId'] });
    const tenant = await requireTenant(ctx, args);
    const active = args.bool('active');
    const rows = await allWorkflows(ctx, tenant.id, active === undefined ? {} : { active });
    const onlyId = args.flag('onlyId');
    out.stdout(rows.map((row) => `${onlyId ? row.id : `${row.id}|${row.name}`}\n`).join(''));
    return 0;
  });
}
