/**
 * P6-78 (C0, final): what a CLI command (src/commands/*.ts, dispatched by cli.ts) reads and writes, so tests capture
 * the output and assert the mode a file is written with on the call itself (never `stat`, which Windows ignores).
 * `processIo()` is the real one: stdout and stderr of this process, files as UTF-8. A write with a `mode` (the
 * `--decrypted` export writes 0o600) applies it to a new file and tightens an existing one with `chmod`.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, options: { mode?: number }): Promise<void>;
}

export function processIo(): CommandIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, data, options) => {
      const { mode } = options;
      await writeFile(path, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
      // writeFile's mode applies only to a new file: an existing one keeps its old mode unless changed here
      if (mode !== undefined) await chmod(path, mode);
    },
  };
}
