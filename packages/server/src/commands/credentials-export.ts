/**
 * P6-78 (L11): `export:credentials`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - export:credentials: `--tenant <slug>` with `--all` or `--id`, `--output`, `--separate`, `--decrypted`
 * The file is a JSON list of `{ id, name, type, data }`. `data` stays the stored ciphertext (it opens only in
 * this workspace, under this credential id) unless `--decrypted`: then the plain data is written, only to a
 * file (`--output` is required, stdout is refused), with mode 0o600, and each credential written adds one
 * `credentials.exported_decrypted` audit row (id only, never a value).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerContext } from '../context';
import { ApiError } from '../http/errors';
import {
  CommandUsageError,
  commandActor,
  parseCommandArgs,
  requireTenant,
  runCommand,
  toJson,
} from './command-args';
import type { CommandIo } from './command-io';

export const EXPORT_CREDENTIALS_USAGE =
  'Usage: export:credentials --tenant <slug> (--all | --id <id>) [--output <path>] [--separate] [--decrypted]';

/** the mode of a decrypted export file: the operator only */
const PRIVATE_MODE = 0o600;

export function exportCredentialsCommand(
  ctx: ServerContext,
  argv: string[],
  io?: CommandIo,
): Promise<number> {
  return runCommand(io, EXPORT_CREDENTIALS_USAGE, async (out) => {
    const args = parseCommandArgs(argv, {
      values: ['tenant', 'id', 'output'],
      flags: ['all', 'separate', 'decrypted'],
    });
    const tenant = await requireTenant(ctx, args);
    const id = args.value('id');
    const all = args.flag('all');
    if (all === (id !== undefined)) throw new CommandUsageError('Give exactly one of --all and --id');
    const output = args.value('output');
    const decrypted = args.flag('decrypted');
    const separate = args.flag('separate');
    // checked before any credential is read: decrypted data never goes to the terminal
    if (decrypted && output === undefined) {
      throw new CommandUsageError(
        '--decrypted needs --output <path>: decrypted credentials are never printed',
      );
    }
    if (separate && output === undefined) throw new CommandUsageError('--separate needs --output <folder>');

    const ids = id !== undefined ? [id] : (await ctx.repos.credentials.list(tenant.id)).map((row) => row.id);
    const entries: Array<{ id: string; name: string; type: string; data: unknown }> = [];
    for (const credentialId of ids) {
      const row = await ctx.repos.credentials.get(tenant.id, credentialId);
      if (!row) throw ApiError.notFound('Credential');
      entries.push({
        id: row.id,
        name: row.name,
        type: row.type,
        data: decrypted ? ctx.credentials.decrypt(row) : row.dataEnc,
      });
    }

    if (output === undefined) {
      out.stdout(toJson(entries, true));
      return 0;
    }
    const options = decrypted ? { mode: PRIVATE_MODE } : {};
    const actor = await commandActor(ctx, tenant.id);
    const audit = (credentialId: string) =>
      decrypted
        ? ctx.repos.audit.add(tenant.id, {
            userId: actor.userId,
            action: 'credentials.exported_decrypted',
            resourceType: 'credential',
            resourceId: credentialId,
          })
        : Promise.resolve();
    if (separate) {
      await mkdir(output, { recursive: true, ...(decrypted ? { mode: 0o700 } : {}) });
      for (const entry of entries) {
        await out.writeFile(path.join(output, `${entry.id}.json`), toJson(entry, true), options);
        await audit(entry.id);
      }
    } else {
      await out.writeFile(output, toJson(entries, true), options);
      for (const entry of entries) await audit(entry.id);
    }
    out.stdout(`Exported ${entries.length} credential(s) to ${output}\n`);
    return 0;
  });
}
