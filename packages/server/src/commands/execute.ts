/**
 * P6-78 (L11): `execute`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - execute: `--tenant <slug> --id <workflowId>`, `--rawOutput`; mode `cli` through `executions.start`
 * stub (L11): throws.
 */
import type { ServerContext } from '../context';
import type { CommandIo } from './command-io';

/** stub (L11) */
export function executeCommand(_ctx: ServerContext, _argv: string[], _io?: CommandIo): Promise<number> {
  throw new Error('not implemented (L11)');
}
