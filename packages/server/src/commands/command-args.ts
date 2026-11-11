/**
 * P6-78 (L11): what the data commands share: the argument reader, the `--tenant` lookup, the workspace
 * owner who stands for the operator, and the wrapper that turns a thrown error into an exit code (a bad
 * call 2, any other failure 1; the text passes `redactSecrets`, so no secret reaches the terminal).
 * `--name value` and `--name=value` both work; a flag is `--name`, `--name=true` or `--name=false`.
 */
import { redactSecrets } from '@workflow/workflow';
import type { ServerContext } from '../context';
import type { TenantRow } from '../db/schema';
import { type CommandIo, processIo } from './command-io';

/** a wrong call: the command prints its usage and exits 2 */
export class CommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandUsageError';
  }
}

export interface ArgSpec {
  /** options that take a value: `--id <value>` */
  values?: readonly string[];
  /** options that are on or off: `--all`, `--all=false` */
  flags?: readonly string[];
}

export class CommandArgs {
  constructor(
    private readonly values: Map<string, string>,
    private readonly flags: Map<string, boolean>,
  ) {}

  /** the value of `--name`, or undefined when it was not given */
  value(name: string): string | undefined {
    return this.values.get(name);
  }

  /** `--name` true, `--name=false` false, undefined when it was not given */
  bool(name: string): boolean | undefined {
    return this.flags.get(name);
  }

  /** true only when `--name` was given and not `=false` */
  flag(name: string): boolean {
    return this.flags.get(name) === true;
  }

  /** the value of `--name` read as a whole number of at least `min`, or `fallback` when it was not given */
  integer(name: string, fallback: number, min: number, max: number): number {
    const text = this.values.get(name);
    if (text === undefined) return fallback;
    const n = Number(text);
    if (!/^\d{1,9}$/.test(text) || n < min || n > max) {
      throw new CommandUsageError(`--${name} must be a whole number from ${min} to ${max}`);
    }
    return n;
  }
}

/** reads `argv` (the words after the command name) by `spec`; an unknown option, a missing value or a repeat is a usage error */
export function parseCommandArgs(argv: string[], spec: ArgSpec): CommandArgs {
  const valueNames = new Set(spec.values ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const values = new Map<string, string>();
  const flags = new Map<string, boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new CommandUsageError(`Unexpected argument "${arg.slice(0, 64)}"`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (valueNames.has(name)) {
      if (values.has(name)) throw new CommandUsageError(`--${name} is given twice`);
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === '') throw new CommandUsageError(`--${name} needs a value`);
      values.set(name, value);
    } else if (flagNames.has(name)) {
      if (flags.has(name)) throw new CommandUsageError(`--${name} is given twice`);
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        throw new CommandUsageError(`--${name} is on or off, not "${inline.slice(0, 32)}"`);
      }
      flags.set(name, inline !== 'false');
    } else {
      throw new CommandUsageError(`Unknown option --${name.slice(0, 64)}`);
    }
  }
  return new CommandArgs(values, flags);
}

/** the workspace of `--tenant <slug>`: a missing option is a usage error, an unknown slug an error */
export async function requireTenant(ctx: ServerContext, args: CommandArgs): Promise<TenantRow> {
  const slug = args.value('tenant');
  if (!slug) throw new CommandUsageError('--tenant <slug> is required');
  const tenant = await ctx.repos.tenants.getBySlug(slug);
  if (!tenant) throw new Error(`No workspace has the slug "${slug}"`);
  return tenant;
}

/** the actor a command acts as: the workspace's first active owner (none: no user, which the services accept) */
export async function commandActor(ctx: ServerContext, tenantId: string): Promise<{ userId?: string }> {
  const userId = await ctx.repos.scim.firstOwner(tenantId);
  return userId ? { userId } : {};
}

/**
 * The project an import writes into: `--projectId` (a project of this workspace, else an error), or the
 * personal project of the workspace's owner.
 */
export async function importProject(
  ctx: ServerContext,
  tenantId: string,
  args: CommandArgs,
  actor: { userId?: string },
): Promise<string> {
  const given = args.value('projectId');
  if (given !== undefined) {
    const project = await ctx.repos.projects.get(tenantId, given);
    if (!project) throw new Error('No such project in the workspace');
    return project.id;
  }
  if (!actor.userId) throw new Error('The workspace has no owner to import into; give --projectId');
  const personal = await ctx.repos.projects.getPersonal(tenantId, actor.userId);
  if (!personal) throw new Error('The workspace owner has no personal project; give --projectId');
  return personal.id;
}

/** the text of a thrown value, secrets removed */
export function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Runs `body` with `io` (default `processIo()`): its number is the exit code; a usage error prints its text
 * and `usage` and exits 2; any other error prints its redacted text and exits 1.
 */
export async function runCommand(
  io: CommandIo | undefined,
  usage: string,
  body: (io: CommandIo) => Promise<number>,
): Promise<number> {
  const out = io ?? processIo();
  try {
    return await body(out);
  } catch (error) {
    if (error instanceof CommandUsageError) {
      out.stderr(`${error.message}\n${usage}\n`);
      return 2;
    }
    out.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

/** JSON text for the terminal or a file: pretty (two spaces) or one line, ending with a newline */
export function toJson(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

/** every workflow of the workspace that is not archived (`active` narrows to published or unpublished ones), as the list rows */
export async function allWorkflows(ctx: ServerContext, tenantId: string, filter: { active?: boolean } = {}) {
  const rows: Awaited<ReturnType<ServerContext['workflows']['list']>>['data'] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.workflows.list(tenantId, {
      limit: 200,
      archived: 'false',
      ...(filter.active === undefined ? {} : { active: filter.active }),
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}
