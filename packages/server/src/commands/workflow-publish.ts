/**
 * P6-78 (L11): `publish:workflow`, `unpublish:workflow`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - publish:workflow: `--tenant <slug>` with `--id` or `--all`
 * - unpublish:workflow: `--tenant <slug>` with `--id` or `--all`
 * stub (L11): throws.
 */
import type { ServerContext } from '../context';
import type { CommandIo } from './command-io';

/** stub (L11) */
export function publishWorkflowCommand(
  _ctx: ServerContext,
  _argv: string[],
  _io?: CommandIo,
): Promise<number> {
  throw new Error('not implemented (L11)');
}

/** stub (L11) */
export function unpublishWorkflowCommand(
  _ctx: ServerContext,
  _argv: string[],
  _io?: CommandIo,
): Promise<number> {
  throw new Error('not implemented (L11)');
}
