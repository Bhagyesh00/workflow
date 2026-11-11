/**
 * The `workflow` CLI (P6-77). Every outside effect goes through `CliIo`, so tests inject all of it.
 * bin/workflow.mjs calls `run(process.argv.slice(2), nodeIo())` and sets the exit code it returns.
 */

import { execute } from './main';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  home: string;
  fetch: typeof fetch;
  stdin(): Promise<string>;
  isTTY: boolean;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string, options: { mode?: number }): Promise<void>;
  removeFile(path: string): Promise<void>;
}

/** Runs one command line and returns the process exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  return execute(argv, io);
}
