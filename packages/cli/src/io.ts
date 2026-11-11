/** The real `CliIo` on Node: process streams, the user's home folder, global fetch and node:fs/promises. */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CliIo } from './index';

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export function nodeIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    home: homedir(),
    fetch: (input, init) => globalThis.fetch(input, init),
    stdin: readStdin,
    isTTY: process.stdout.isTTY === true,
    /** The file's text, or undefined when it does not exist. */
    async readFile(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    /**
     * Makes the folder, then writes the file with `mode` (0o600 for the config file). A file written with a
     * mode gets a private folder (0o700) when the folder is new and is written to a new temp file in the same
     * folder with that mode (flag `wx`), then renamed over the target: the text never sits in a file with an
     * older, wider mode. On Windows the mode is not enforced.
     */
    async writeFile(path, data, options) {
      const mode = options.mode;
      await mkdir(dirname(path), mode === undefined ? { recursive: true } : { recursive: true, mode: 0o700 });
      if (mode === undefined) {
        await writeFile(path, data, { encoding: 'utf8' });
        return;
      }
      const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, data, { encoding: 'utf8', mode, flag: 'wx' });
        await chmod(temp, mode);
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    /** Removes the file; a missing file is not an error. */
    async removeFile(path) {
      await rm(path, { force: true });
    },
  };
}
