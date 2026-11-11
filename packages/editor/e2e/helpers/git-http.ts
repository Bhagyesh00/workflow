/**
 * P6-76 (L6): a local Git remote for e2e/p6-source-control.spec.ts. A bare repository in its own temp folder
 * behind `node:http` on 127.0.0.1 (an ephemeral port) and `git http-backend` (Smart HTTP, pushes allowed). It
 * holds one empty commit on `main` so the branch exists. Nothing here reaches the internet.
 *
 * This file and the server's test/fakes/git-server.ts are the only places that run the `git` binary, always as
 * a spawn with an argument list (never a shell). The spec's server must be started with SSRF_ALLOW=127.0.0.1,
 * or the platform's own guard refuses this host.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'E2E Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'E2E Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** runs `git <args>` and resolves with its output; rejects on a non-zero exit */
function git(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, ...GIT_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
      else
        reject(
          new Error(`git ${args[0]} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim()}`),
        );
    });
    child.stdin.end(input ?? '');
  });
}

export interface GitHttpRemote {
  /** the repository URL to give the Environments page: http://127.0.0.1:<port>/repo.git */
  url: string;
  /** the branch names in the bare repository */
  branches(): Promise<string[]>;
  /** the files of the newest commit on `branch` (path to text) */
  files(branch?: string): Promise<Map<string, string>>;
  /** the commit message of the newest commit on `branch` */
  message(branch?: string): Promise<string>;
  /** stops the server and removes the temp folder */
  close(): Promise<void>;
}

export async function startGitHttpRemote(): Promise<GitHttpRemote> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wf-e2e-git-'));
  const dir = path.join(root, 'repo.git');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', dir]);
  const emptyTree = await git(['--git-dir', dir, 'hash-object', '-t', 'tree', '-w', '--stdin']);
  const first = await git(['--git-dir', dir, 'commit-tree', emptyTree, '-m', 'Initial commit']);
  await git(['--git-dir', dir, 'update-ref', 'refs/heads/main', first]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const child = spawn('git', ['-c', 'http.receivepack=true', 'http-backend'], {
      env: {
        ...process.env,
        ...GIT_ENV,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    req.pipe(child.stdin);
    child.stderr.resume();
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      if (!res.headersSent) res.writeHead(500).end();
    });
    child.on('close', () => {
      // the CGI answer: header lines, an empty line, the body
      const out = Buffer.concat(chunks);
      let split = out.indexOf('\r\n\r\n');
      let gap = 4;
      if (split < 0) {
        split = out.indexOf('\n\n');
        gap = 2;
      }
      if (split < 0) {
        res.writeHead(500).end();
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, split).toString('latin1').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers).end(out.subarray(split + gap));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const inRepo = (args: string[], input?: string) => git(['--git-dir', dir, ...args], input);
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    async branches() {
      const out = await inRepo(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      return out ? out.split('\n') : [];
    },
    async files(branch = 'main') {
      const names = await inRepo(['ls-tree', '-r', '--name-only', branch]);
      const files = new Map<string, string>();
      for (const name of names ? names.split('\n') : [])
        files.set(name, await inRepo(['show', `${branch}:${name}`]));
      return files;
    },
    message: (branch = 'main') => inRepo(['log', '-1', '--format=%s', branch]),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
