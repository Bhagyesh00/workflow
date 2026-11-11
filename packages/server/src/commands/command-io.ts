/**
 * P6-78 (C0, final): what a CLI command (src/commands/*.ts, dispatched by cli.ts) reads and writes, so tests capture
 * the output and assert the mode a file is written with on the call itself (never `stat`, which Windows ignores).
 * `processIo()` is the real one: stdout and stderr of this process, files as UTF-8. A write with a `mode` (the
 * `--decrypted` export writes 0o600) never puts data into an older file under its old mode: it creates a new file
 * in the same folder with that mode (flag `wx`), writes it and renames it over the target.
 */
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    readFile: (file) => readFile(file, 'utf8'),
    writeFile: async (target, data, options) => {
      const { mode } = options;
      if (mode === undefined) {
        await writeFile(target, data, { encoding: 'utf8' });
        return;
      }
      // the mode of writeFile applies only to a new file, so the data goes into a new one and replaces the target
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, data, { encoding: 'utf8', mode, flag: 'wx' });
        // the process umask may have narrowed the mode, never widened it; the call says what is meant
        await chmod(temp, mode);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
