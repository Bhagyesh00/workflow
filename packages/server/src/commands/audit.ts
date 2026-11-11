/**
 * P6-78 (L11): `audit`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - audit: `--tenant <slug>`, `--categories <a,b>`, `--days-abandoned-workflow <n>`
 * Prints the workspace's security audit report as JSON (the report holds no secret).
 */
import type { ServerContext } from '../context';
import { generateSecurityAudit } from '../services/security-audit';
import type { AuditCategory } from '../services/security-audit/types';
import { parseCommandArgs, requireTenant, runCommand, toJson } from './command-args';
import type { CommandIo } from './command-io';

export const AUDIT_USAGE =
  'Usage: audit --tenant <slug> [--categories credentials,database,nodes,filesystem,instance] [--days-abandoned-workflow <n>]';

export function auditCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, AUDIT_USAGE, async (out) => {
    const args = parseCommandArgs(argv, {
      values: ['tenant', 'categories', 'days-abandoned-workflow', 'daysAbandonedWorkflow'],
    });
    const tenant = await requireTenant(ctx, args);
    const days =
      args.value('days-abandoned-workflow') !== undefined
        ? 'days-abandoned-workflow'
        : 'daysAbandonedWorkflow';
    const categories = args
      .value('categories')
      ?.split(',')
      .map((category) => category.trim())
      .filter(Boolean) as AuditCategory[] | undefined;
    const daysAbandonedWorkflow =
      args.value(days) === undefined ? undefined : args.integer(days, 0, 1, 36500);
    // an unknown category is the service's 400 with the valid list
    const report = await generateSecurityAudit(ctx.serviceDeps, tenant.id, {
      ...(categories ? { categories } : {}),
      ...(daysAbandonedWorkflow === undefined ? {} : { daysAbandonedWorkflow }),
    });
    out.stdout(toJson(report, true));
    return 0;
  });
}
