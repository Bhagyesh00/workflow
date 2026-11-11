/**
 * P6-72 (S4 L1): local Git remotes for the source control tests. Nothing here reaches the internet.
 * - `createBareRepo()`: a bare repository `repo.git` in its own temp folder, with helpers that write commits
 *   straight into the object store (any tree, including a symlink, a submodule or a `..` entry) and read
 *   back what a push left there.
 * - `startGitHttpServer(repo)`: `node:http` on 127.0.0.1 in front of `git -c http.receivepack=true http-backend`
 *   (Smart HTTP), with an optional Basic token and an optional redirect for every request.
 * - `startGitSshServer(repo)`: an ssh2 `Server` on 127.0.0.1 with a generated host key that runs
 *   `git upload-pack` or `git receive-pack` for an `exec` of `git-upload-pack '<path>'` or
 *   `git-receive-pack '<path>'`; `swapHostKey()` answers later connections with a new key.
 * This file and e2e/helpers/git-http.ts are the only places that run the `git` binary, always as a spawn with an
 * argument list (never a shell). A test that finds no `git` fails: `requireGit()` throws.
 */
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type ParsedKey, Server as SshServer, utils as sshUtils } from 'ssh2';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fake Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fake Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export interface GitRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** runs `git <args>` (an argument list, no shell) and resolves with its output; rejects on a non-zero exit */
export function runGit(
  args: string[],
  options: { cwd?: string; input?: Buffer | string; env?: Record<string, string> } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...GIT_ENV, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(`git ${args[0]} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim()}`),
        );
    });
    child.stdin.end(options.input ?? '');
  });
}

/** the installed git version; throws (so the test fails, never skips) when no `git` binary answers */
export async function requireGit(): Promise<string> {
  try {
    return (await runGit(['--version'])).toString('utf8').trim();
  } catch (error) {
    throw new Error(`The Git tests need the git binary on PATH: ${(error as Error).message}`);
  }
}

/** one entry of a commit written by `BareRepo.commit` */
export interface TreeFile {
  /** a slash path; a segment may be `..` (written as a raw tree entry) */
  path: string;
  /** the file data (a blob); for mode 160000 a commit id instead */
  data?: string | Uint8Array;
  /** default 100644; 120000 = symlink (data = target), 160000 = submodule (data = commit id) */
  mode?: '100644' | '100755' | '120000' | '160000';
}

export interface BareRepo {
  /** the folder holding `repo.git` (http-backend's project root) */
  root: string;
  /** the bare repository itself */
  dir: string;
  /** the path a remote URL names: `/repo.git` */
  urlPath: string;
  /** writes a commit holding exactly `files` on `branch` (default main) and moves the branch to it */
  commit(
    files: TreeFile[],
    options?: { branch?: string; message?: string; parent?: string | null },
  ): Promise<string>;
  /** the commit `refs/heads/<branch>` names, or null */
  head(branch?: string): Promise<string | null>;
  /** every branch name */
  branches(): Promise<string[]>;
  /** the files of `ref` (path to text) */
  files(ref: string): Promise<Map<string, string>>;
  /** the parent ids of a commit */
  parents(commit: string): Promise<string[]>;
  /** the message of a commit */
  message(commit: string): Promise<string>;
  /** `git fsck --strict` of the whole repository (rejects when git finds a broken object) */
  fsck(): Promise<void>;
  cleanup(): Promise<void>;
}

/** a bare repository `repo.git` (default branch main) in a new temp folder */
export async function createBareRepo(): Promise<BareRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wf-fake-git-'));
  const dir = path.join(root, 'repo.git');
  await runGit(['init', '--bare', '--quiet', '--initial-branch=main', dir]);
  const git = (args: string[], input?: Buffer | string) => runGit(['--git-dir', dir, ...args], { input });

  const writeBlob = async (data: string | Uint8Array) =>
    (await git(['hash-object', '-w', '--stdin'], Buffer.from(data))).toString('utf8').trim();

  /** a raw tree object (--literally: names such as `..` are written as given) */
  const writeTree = async (entries: Array<{ mode: string; name: string; oid: string }>): Promise<string> => {
    const sorted = [...entries].sort((a, b) => {
      const ka = a.mode === '40000' ? `${a.name}/` : a.name;
      const kb = b.mode === '40000' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const body = Buffer.concat(
      sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')])),
    );
    return (await git(['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], body))
      .toString('utf8')
      .trim();
  };

  const buildTree = async (files: Array<TreeFile & { rest: string[] }>): Promise<string> => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const folders = new Map<string, Array<TreeFile & { rest: string[] }>>();
    for (const file of files) {
      const [name, ...rest] = file.rest;
      if (name === undefined) continue;
      if (rest.length > 0) {
        const list = folders.get(name) ?? [];
        list.push({ ...file, rest });
        folders.set(name, list);
        continue;
      }
      const mode = file.mode ?? '100644';
      const oid = mode === '160000' ? String(file.data) : await writeBlob(file.data ?? '');
      entries.push({ mode, name, oid });
    }
    for (const [name, list] of folders) entries.push({ mode: '40000', name, oid: await buildTree(list) });
    return writeTree(entries);
  };

  const head = async (branch = 'main'): Promise<string | null> => {
    try {
      return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
        .toString('utf8')
        .trim();
    } catch {
      return null;
    }
  };

  return {
    root,
    dir,
    urlPath: '/repo.git',
    async commit(files, options = {}) {
      const branch = options.branch ?? 'main';
      const tree = await buildTree(files.map((f) => ({ ...f, rest: f.path.split('/') })));
      const parent = options.parent === undefined ? await head(branch) : options.parent;
      const args = ['commit-tree', tree, '-m', options.message ?? 'seed'];
      if (parent) args.push('-p', parent);
      const commit = (await git(args)).toString('utf8').trim();
      await git(['update-ref', `refs/heads/${branch}`, commit]);
      return commit;
    },
    head,
    async branches() {
      const out = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).toString('utf8');
      return out.split('\n').filter(Boolean).sort();
    },
    async files(ref) {
      const list = (await git(['ls-tree', '-r', '-z', '--full-tree', ref])).toString('utf8');
      const result = new Map<string, string>();
      for (const line of list.split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const [, , oid] = line.slice(0, tab).split(' ');
        result.set(line.slice(tab + 1), (await git(['cat-file', 'blob', String(oid)])).toString('utf8'));
      }
      return result;
    },
    async parents(commit) {
      const out = (await git(['rev-list', '--parents', '-n', '1', commit])).toString('utf8').trim();
      return out.split(' ').slice(1);
    },
    async message(commit) {
      return (await git(['log', '-1', '--format=%B', commit])).toString('utf8').trim();
    },
    async fsck() {
      await git(['fsck', '--strict', '--no-progress']);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** one request the HTTP fake saw */
export interface SeenRequest {
  method: string;
  url: string;
  authorization?: string;
  gitProtocol?: string;
}

export interface GitHttpServer {
  port: number;
  /** `http://127.0.0.1:<port>/repo.git` */
  url: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

/**
 * Smart HTTP in front of the bare repo. `auth`: every request must carry this Basic user and token (401
 * otherwise). `redirectTo`: answers every request with a 302 to `redirectTo + path and query` instead.
 */
export async function startGitHttpServer(
  repo: BareRepo,
  options: { auth?: { username: string; token: string }; redirectTo?: string } = {},
): Promise<GitHttpServer> {
  const requests: SeenRequest[] = [];
  const expected = options.auth
    ? `Basic ${Buffer.from(`${options.auth.username}:${options.auth.token}`).toString('base64')}`
    : undefined;
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      authorization: req.headers.authorization,
      gitProtocol: req.headers['git-protocol'] as string | undefined,
    });
    if (options.redirectTo) {
      req.resume();
      res.writeHead(302, { location: `${options.redirectTo}${req.url ?? '/'}` }).end();
      return;
    }
    if (expected && req.headers.authorization !== expected) {
      req.resume();
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('Unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const child = spawn('git', ['-c', 'http.receivepack=true', 'http-backend'], {
      env: {
        ...process.env,
        ...GIT_ENV,
        GIT_PROJECT_ROOT: repo.root,
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
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      if (!res.headersSent) res.writeHead(500).end();
    });
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      let split = out.indexOf('\r\n\r\n');
      let sep = 4;
      if (split < 0) {
        split = out.indexOf('\n\n');
        sep = 2;
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
      res.writeHead(status, headers).end(out.subarray(split + sep));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}${repo.urlPath}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** an OpenSSH key pair made in memory for one test */
export interface SshKeyPair {
  privateKey: string;
  publicKey: string;
}

export function generateSshKey(type: 'ed25519' | 'rsa' = 'ed25519'): SshKeyPair {
  const pair =
    type === 'rsa'
      ? sshUtils.generateKeyPairSync('rsa', { bits: 2048 })
      : sshUtils.generateKeyPairSync('ed25519');
  return { privateKey: pair.private, publicKey: pair.public };
}

/** OpenSSH's `SHA256:<base64>` fingerprint of a public key */
export function sshFingerprint(publicKey: string): string {
  const parsed = sshUtils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  return `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
}

export interface GitSshServer {
  port: number;
  /** `ssh://git@127.0.0.1:<port>/repo.git` */
  url: string;
  /** the key pair the server accepts for user `git` */
  clientKey: SshKeyPair;
  /** the fingerprint of the host key in use */
  fingerprint: string;
  /** every `exec` command the server got */
  commands: string[];
  /** TCP connections the server accepted */
  connections: number;
  /** answers later connections with a newly generated host key; returns its fingerprint */
  swapHostKey(): string;
  close(): Promise<void>;
}

const EXEC_RE = /^(git-upload-pack|git-receive-pack) '([^']*)'$/;

/**
 * An ssh2 server for the bare repo: public key auth for user `git` with `clientKey`, `exec` of the two Git
 * services with the quoted repository path (`/repo.git` or `repo.git`); anything else is refused.
 */
export async function startGitSshServer(repo: BareRepo): Promise<GitSshServer> {
  const clientKey = generateSshKey();
  const allowed = sshUtils.parseKey(clientKey.publicKey) as ParsedKey;
  const commands: string[] = [];
  const makeServer = (hostKey: string) =>
    new SshServer({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || ctx.username !== 'git') return ctx.reject(['publickey']);
        const sameKey =
          ctx.key.algo === allowed.type &&
          ctx.key.data.length === allowed.getPublicSSH().length &&
          timingSafeEqual(ctx.key.data, allowed.getPublicSSH());
        if (!sameKey) return ctx.reject(['publickey']);
        if (ctx.signature && ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          return ctx.reject(['publickey']);
        }
        ctx.accept();
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('exec', (accept, reject, info) => {
            commands.push(info.command);
            const match = EXEC_RE.exec(info.command);
            if (!match || (match[2] !== repo.urlPath && match[2] !== repo.urlPath.slice(1))) {
              reject();
              return;
            }
            const stream = accept();
            const child = spawn('git', [String(match[1]).slice(4), repo.dir], {
              env: { ...process.env, ...GIT_ENV },
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
            child.stdout.pipe(stream, { end: false });
            child.stderr.on('data', (c: Buffer) => stream.stderr.write(c));
            stream.on('data', (c: Buffer) => child.stdin.write(c));
            stream.on('end', () => child.stdin.end());
            stream.on('close', () => {
              if (child.exitCode === null) child.kill();
            });
            child.stdin.on('error', () => undefined);
            child.on('close', (code) => {
              stream.exit(code ?? 1);
              stream.end();
            });
          });
        });
      });
    });

  let hostKey = generateSshKey();
  let ssh = makeServer(hostKey.privateKey);
  const servers = [ssh];
  const sockets = new Set<net.Socket>();
  const state = { connections: 0 };
  const front = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    ssh.injectSocket(socket);
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const { port } = front.address() as AddressInfo;
  const result: GitSshServer = {
    port,
    url: `ssh://git@127.0.0.1:${port}${repo.urlPath}`,
    clientKey,
    fingerprint: sshFingerprint(hostKey.publicKey),
    commands,
    get connections() {
      return state.connections;
    },
    swapHostKey() {
      hostKey = generateSshKey();
      ssh = makeServer(hostKey.privateKey);
      servers.push(ssh);
      result.fingerprint = sshFingerprint(hostKey.publicKey);
      return result.fingerprint;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const s of servers) s.close();
      await new Promise<void>((resolve) => front.close(() => resolve()));
    },
  };
  return result;
}
