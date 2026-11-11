/**
 * P6-78 (L11): `import:credentials`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - import:credentials: `--tenant <slug> --input <path>`, `--projectId`; through `CredentialService.create`
 * The file is the list `export:credentials` writes. Plain data (from `--decrypted`) is encrypted under this
 * workspace and the new credential's id; ciphertext opens only in the workspace it came from (the same
 * workspace and credential id), so any other is refused with the way out (`--decrypted`). Each credential goes
 * through `CredentialService.create`: the credential type policy and the protected lock run, and a refusal
 * names the credential and sets the exit to 1. The project is `--projectId` (a project of `--tenant`) or the
 * personal project of the workspace owner; with `--projectId`, a credential whose id already belongs to another
 * project of the workspace is refused. No value is ever printed.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServerContext } from '../context';
import { PolicyViolationError } from '../services/type-policies/errors';
import {
  CommandUsageError,
  commandActor,
  errorText,
  importProject,
  parseCommandArgs,
  requireTenant,
  runCommand,
} from './command-args';
import type { CommandIo } from './command-io';

export const IMPORT_CREDENTIALS_USAGE =
  'Usage: import:credentials --tenant <slug> --input <path> [--projectId <id>]';

interface Entry {
  id?: string;
  name: string;
  type: string;
  data: DataObject | string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** a list entry as the export wrote it, or the reason it is not one */
function entryOf(value: unknown): Entry | string {
  if (!isRecord(value)) return 'it is not an object';
  const { id, name, type, data } = value;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 128) return 'it has no name';
  if (typeof type !== 'string' || type === '') return 'it has no type';
  if (typeof data !== 'string' && !isRecord(data)) return 'it has no data';
  return { id: typeof id === 'string' ? id : undefined, name, type, data: data as DataObject | string };
}

export function importCredentialsCommand(
  ctx: ServerContext,
  argv: string[],
  io?: CommandIo,
): Promise<number> {
  return runCommand(io, IMPORT_CREDENTIALS_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['tenant', 'input', 'projectId'] });
    const tenant = await requireTenant(ctx, args);
    const input = args.value('input');
    if (input === undefined) throw new CommandUsageError('--input <path> is required');
    const actor = await commandActor(ctx, tenant.id);
    // the project is checked before the file is read, so a bad --projectId imports nothing
    const projectId = await importProject(ctx, tenant.id, args, actor);
    const projectGiven = args.value('projectId') !== undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await out.readFile(input));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('The input is not valid JSON');
      throw error;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];

    let imported = 0;
    let failed = 0;
    for (const [index, item] of items.entries()) {
      const entry = entryOf(item);
      const label = typeof entry === 'string' ? `credential #${index + 1}` : `"${entry.name.slice(0, 128)}"`;
      try {
        if (typeof entry === 'string') throw new Error(entry);
        // with --projectId, a credential of this workspace that sits in another project is not imported
        if (projectGiven && entry.id) {
          const held = await ctx.repos.credentials.get(tenant.id, entry.id);
          if (held && held.projectId !== projectId) {
            throw new Error('it already exists in another project of the workspace');
          }
        }
        let data: DataObject;
        if (typeof entry.data === 'string') {
          // ciphertext is bound to its workspace and credential id
          try {
            if (!entry.id) throw new Error('no id');
            data = ctx.cipher.decrypt<DataObject>(entry.data, {
              tenantId: tenant.id,
              credentialId: entry.id,
            });
          } catch {
            throw new Error(
              'its data is encrypted for another workspace and cannot be opened here; export it with --decrypted',
            );
          }
        } else {
          data = entry.data;
        }
        const created = await ctx.credentials.create(
          tenant.id,
          { name: entry.name, type: entry.type, data, projectId },
          actor.userId,
        );
        imported++;
        out.stdout(`Imported credential ${label} (${created.id})\n`);
      } catch (error) {
        failed++;
        const types =
          error instanceof PolicyViolationError
            ? ` (blocked: ${[...new Set(error.violations.map((violation) => violation.type))].join(', ')})`
            : '';
        out.stderr(`Could not import ${label}: ${errorText(error)}${types}\n`);
      }
    }
    out.stdout(`Imported ${imported} of ${items.length} credential(s).\n`);
    return failed === 0 ? 0 : 1;
  });
}
