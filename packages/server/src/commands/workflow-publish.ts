/**
 * P6-78 (L11): `publish:workflow`, `unpublish:workflow`. Dispatched by cli.ts inside `createContext`, the
 * context closed after it; the result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output
 * goes through `io` (default `processIo()`), so tests capture it.
 * - publish:workflow: `--tenant <slug>` with `--id` or `--all`
 * - unpublish:workflow: `--tenant <slug>` with `--id` or `--all`
 * Publishing is allowed on a protected workspace (the service does not lock it). `--all` publishes the
 * workflows that are not published yet and unpublishes the published ones; `--id` always acts on that one
 * (publish takes its current draft). A workflow that cannot be changed is named on stderr and the exit is 1.
 */
import type { ServerContext } from '../context';
import {
  allWorkflows,
  CommandUsageError,
  commandActor,
  errorText,
  parseCommandArgs,
  requireTenant,
  runCommand,
} from './command-args';
import type { CommandIo } from './command-io';

export const PUBLISH_WORKFLOW_USAGE = 'Usage: publish:workflow --tenant <slug> (--id <id> | --all)';
export const UNPUBLISH_WORKFLOW_USAGE = 'Usage: unpublish:workflow --tenant <slug> (--id <id> | --all)';

function setPublished(ctx: ServerContext, argv: string[], io: CommandIo | undefined, active: boolean) {
  return runCommand(io, active ? PUBLISH_WORKFLOW_USAGE : UNPUBLISH_WORKFLOW_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['tenant', 'id'], flags: ['all'] });
    const tenant = await requireTenant(ctx, args);
    const id = args.value('id');
    const all = args.flag('all');
    if (all === (id !== undefined)) throw new CommandUsageError('Give exactly one of --all and --id');
    const actor = await commandActor(ctx, tenant.id);
    const targets =
      id !== undefined
        ? [await ctx.workflows.get(tenant.id, id)]
        : await Promise.all(
            (await allWorkflows(ctx, tenant.id, { active: !active })).map((row) =>
              ctx.workflows.get(tenant.id, row.id),
            ),
          );
    let failed = 0;
    for (const workflow of targets) {
      try {
        await ctx.workflows.setActive(tenant.id, workflow.id, active, actor);
        out.stdout(`${active ? 'Published' : 'Unpublished'} "${workflow.name}"\n`);
      } catch (error) {
        failed++;
        out.stderr(`Could not ${active ? 'publish' : 'unpublish'} "${workflow.name}": ${errorText(error)}\n`);
      }
    }
    return failed === 0 ? 0 : 1;
  });
}

export function publishWorkflowCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return setPublished(ctx, argv, io, true);
}

export function unpublishWorkflowCommand(
  ctx: ServerContext,
  argv: string[],
  io?: CommandIo,
): Promise<number> {
  return setPublished(ctx, argv, io, false);
}
