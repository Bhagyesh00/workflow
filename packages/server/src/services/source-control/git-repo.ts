/**
 * P6-72 (L1): one Git operation on a remote. `withRepo` makes one temp folder per operation (removed in `finally`),
 * object store only (no checkout, no working tree), and hands `fn` a `GitSession`. `readFiles` walks the tree and
 * refuses mode 120000 and 160000, `..`, absolute paths and any path outside `SOURCE_CONTROL_PATHS`, and enforces
 * `SOURCE_CONTROL_LIMITS` (`GitLimitError`). Keys stay in memory; no error text holds a key, a token or a password.
 * Each session method turns a library or network failure into one of the four errors below with a fixed text (the
 * cause goes to `reason`, for the log only); errors thrown by `fn` itself pass through untouched.
 */
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type HttpClient, SsrfBlockedError } from '@workflow/core';
import { CredentialDomainError, isManagedPath, type SOURCE_CONTROL_LIMITS } from '@workflow/workflow';
import git from 'isomorphic-git';
import { ApiError } from '../../http/errors';
import { type GitHttpPlugin, gitHttpTransport, remoteBaseUrl } from './transport-http';
import { gitSshTransport, type HostKeyCheck } from './transport-ssh';
import { parseRemoteUrl } from './url';

export interface GitDeps {
  http: HttpClient;
  limits: typeof SOURCE_CONTROL_LIMITS;
}

/** the remote of one operation, its secrets decrypted only for it (`SourceControlSettingsService.withRemote`) */
export interface GitRemote {
  url: string;
  auth:
    | { kind: 'ssh'; privateKey: string; hostKey: HostKeyCheck }
    | { kind: 'https'; username: string; token: string };
}

export interface GitSession {
  listBranches(): Promise<string[]>;
  /** the head commit of `branch` after a shallow fetch, or null when the branch does not exist yet */
  fetchBranch(branch: string): Promise<string | null>;
  /** the managed files of `commit`, by path */
  readFiles(commit: string): Promise<Map<string, Uint8Array>>;
  /** a commit on `parent` (null: the first commit) holding exactly `files`; returns its id */
  writeCommit(input: {
    parent: string | null;
    files: Map<string, Uint8Array>;
    message: string;
    author: { name: string; email: string };
  }): Promise<string>;
  push(branch: string, commit: string, options: { force: boolean }): Promise<void>;
}

/** the remote's host key differs from the stored one (n8n: disconnect and connect again to reset it) */
export class GitHostKeyChangedError extends ApiError {
  constructor() {
    super(
      400,
      'source_control_host_key_changed',
      'The host key of the Git server changed. Disconnect and connect again to accept the new key.',
    );
    this.name = 'GitHostKeyChangedError';
  }
}

/** a tree or a file over `SOURCE_CONTROL_LIMITS`, or a path the rules refuse */
export class GitLimitError extends ApiError {
  constructor(message: string) {
    super(400, 'source_control_limit', message);
    this.name = 'GitLimitError';
  }
}

/** the remote refused or failed (fetch, push, a missing repository); the message holds no secret */
export class GitRemoteError extends ApiError {
  constructor(
    message: string,
    /** the cause, for the log only (never sent) */
    readonly reason?: unknown,
  ) {
    super(400, 'source_control_remote', message);
    this.name = 'GitRemoteError';
  }
}

/** the remote refused the key or the token */
export class GitAuthError extends ApiError {
  constructor(message = 'The Git server refused the credentials. Check the key or the token.') {
    super(400, 'source_control_auth', message);
    this.name = 'GitAuthError';
  }
}

const OID_RE = /^[0-9a-f]{40}$/;
/** the URL isomorphic-git is given for an SSH remote; the SSH adapter ignores its host and uses the parsed remote */
const SSH_PLACEHOLDER_URL = 'https://ssh.invalid/repository';

/** git check-ref-format's rules for a branch name, plus no leading `-` */
function assertBranch(branch: string): void {
  const bad =
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch === '@' ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
    /[\u0000- \u007f~^:?*[\\]/.test(branch) ||
    branch.split('/').some((part) => part.startsWith('.'));
  if (bad) throw new GitRemoteError('The branch name is not valid.');
}

function assertOid(oid: string): void {
  if (typeof oid !== 'string' || !OID_RE.test(oid)) throw new GitRemoteError('The commit id is not valid.');
}

/** a path from the remote, shortened for an error text */
function shown(p: string): string {
  return JSON.stringify(p.length > 120 ? `${p.slice(0, 120)}...` : p);
}

/** the error a caller sees for a failure of the library or the network; fixed texts only */
function toGitError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof SsrfBlockedError) {
    return new GitRemoteError('The Git server address is not allowed by the network policy.', error);
  }
  if (error instanceof CredentialDomainError) {
    return new GitRemoteError(
      'The Git server redirected to another host. The token is not sent there.',
      error,
    );
  }
  const e = error as { code?: string; name?: string; message?: string; data?: { statusCode?: number } };
  const message = typeof e?.message === 'string' ? e.message : '';
  if (/exceeds the maximum size/.test(message)) {
    return new GitLimitError('The Git server sent more than the size limit allows.');
  }
  // isomorphic-git refuses `..`, `.git`, a slash or a backslash in a tree entry while it parses the tree
  if (e?.code === 'UnsafeFilepathError') {
    return new GitLimitError('The repository holds a path that leaves the work folder.');
  }
  if (e?.code === 'HttpError') {
    const status = e.data?.statusCode;
    if (status === 401 || status === 403) return new GitAuthError();
    if (status === 404) return new GitRemoteError('The Git server has no repository at this URL.', error);
    return new GitRemoteError(`The Git server answered with status ${Number(status) || 'unknown'}.`, error);
  }
  if (e?.code === 'SmartHttpError') {
    return new GitRemoteError('The URL does not point to a Git repository over Smart HTTP.', error);
  }
  if (e?.code === 'PushRejectedError') {
    return new GitRemoteError('The branch changed on the Git server. Pull first, or push with force.', error);
  }
  if (e?.code === 'GitPushError') return new GitRemoteError('The Git server refused the push.', error);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new GitRemoteError('The Git server did not answer in time.', error);
  }
  return new GitRemoteError('The Git operation failed.', error);
}

async function guarded<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    throw toGitError(error);
  }
}

interface TreeNode {
  files: Map<string, string>;
  folders: Map<string, TreeNode>;
}

/** git's order of tree entries: a folder sorts as its name plus `/` */
function treeOrder(a: { path: string; mode: string }, b: { path: string; mode: string }): number {
  const ka = a.mode === '040000' ? `${a.path}/` : a.path;
  const kb = b.mode === '040000' ? `${b.path}/` : b.path;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Runs `fn` with a session on `remote` in a new temp folder (a bare object store, no working tree), removed in
 * `finally`, error or not. The remote URL is checked again (`parseRemoteUrl`); an SSH key needs an SSH URL and a
 * token an https URL.
 */
export async function withRepo<T>(
  deps: GitDeps,
  remote: GitRemote,
  fn: (repo: GitSession) => Promise<T>,
): Promise<T> {
  const parsed = parseRemoteUrl(remote.url);
  const { limits } = deps;
  let http: GitHttpPlugin;
  let url: string;
  let close: () => Promise<void> = async () => undefined;
  if (remote.auth.kind === 'ssh') {
    if (parsed.kind !== 'ssh') throw new GitRemoteError('An SSH key needs an ssh:// or user@host:path URL.');
    const ssh = gitSshTransport(
      deps.http,
      parsed,
      { privateKey: remote.auth.privateKey },
      remote.auth.hostKey,
    );
    http = ssh;
    close = () => ssh.close();
    url = SSH_PLACEHOLDER_URL;
  } else {
    if (parsed.kind === 'ssh') throw new GitRemoteError('A token needs an https:// URL.');
    const auth = remote.auth.token ? { username: remote.auth.username, token: remote.auth.token } : undefined;
    http = gitHttpTransport(deps.http, parsed, auth);
    url = remoteBaseUrl(parsed);
  }

  const gitdir = await mkdtemp(path.join(os.tmpdir(), 'wf-git-'));
  try {
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    await git.addRemote({ fs, gitdir, remote: 'origin', url });

    const session: GitSession = {
      listBranches: () =>
        guarded(async () => {
          const refs = await git.listServerRefs({ http, url, prefix: 'refs/heads/', protocolVersion: 1 });
          return refs
            .map((r) => r.ref.slice('refs/heads/'.length))
            .filter((name) => name.length > 0)
            .sort();
        }),

      fetchBranch: (branch) =>
        guarded(async () => {
          assertBranch(branch);
          try {
            const result = await git.fetch({
              fs,
              http,
              gitdir,
              url,
              remote: 'origin',
              ref: branch,
              remoteRef: branch,
              singleBranch: true,
              depth: 1,
              tags: false,
            });
            return result.fetchHead ?? null;
          } catch (error) {
            if ((error as { code?: string }).code === 'NotFoundError') return null;
            throw error;
          }
        }),

      readFiles: (commit) =>
        guarded(async () => {
          assertOid(commit);
          const files = new Map<string, Uint8Array>();
          let total = 0;
          const { commit: head } = await git.readCommit({ fs, gitdir, oid: commit });
          const walk = async (treeOid: string, prefix: string): Promise<void> => {
            const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
            for (const entry of tree) {
              const name = entry.path;
              if (
                !name ||
                name === '.' ||
                name === '..' ||
                name.includes('/') ||
                name.includes('\\') ||
                name.includes('\0')
              ) {
                throw new GitLimitError(
                  `The repository holds a path that leaves the work folder: ${shown(name)}.`,
                );
              }
              const full = prefix ? `${prefix}/${name}` : name;
              if (path.posix.isAbsolute(full) || path.win32.isAbsolute(full)) {
                throw new GitLimitError(`The repository holds an absolute path: ${shown(full)}.`);
              }
              if (entry.mode === '120000') {
                throw new GitLimitError(
                  `The repository holds a symbolic link, which is not allowed: ${shown(full)}.`,
                );
              }
              if (entry.mode === '160000') {
                throw new GitLimitError(
                  `The repository holds a submodule, which is not allowed: ${shown(full)}.`,
                );
              }
              if (entry.type === 'tree') {
                await walk(entry.oid, full);
                continue;
              }
              if (entry.type !== 'blob' || !isManagedPath(full)) {
                throw new GitLimitError(
                  `The repository holds a file the work folder does not use: ${shown(full)}.`,
                );
              }
              if (files.size + 1 > limits.files) {
                throw new GitLimitError(`The repository holds more than ${limits.files} files.`);
              }
              const { blob } = await git.readBlob({ fs, gitdir, oid: entry.oid });
              if (blob.byteLength > limits.fileBytes) {
                throw new GitLimitError(`The file ${shown(full)} is larger than ${limits.fileBytes} bytes.`);
              }
              total += blob.byteLength;
              if (total > limits.totalBytes) {
                throw new GitLimitError(
                  `The repository files are larger than ${limits.totalBytes} bytes in all.`,
                );
              }
              files.set(full, blob);
            }
          };
          await walk(head.tree, '');
          return files;
        }),

      writeCommit: ({ parent, files, message, author }) =>
        guarded(async () => {
          if (parent !== null) assertOid(parent);
          if (files.size > limits.files)
            throw new GitLimitError(`A commit holds at most ${limits.files} files.`);
          const root: TreeNode = { files: new Map(), folders: new Map() };
          let total = 0;
          for (const [filePath, data] of files) {
            if (!isManagedPath(filePath)) {
              throw new GitLimitError(`The path ${shown(filePath)} is not a work folder path.`);
            }
            if (data.byteLength > limits.fileBytes) {
              throw new GitLimitError(
                `The file ${shown(filePath)} is larger than ${limits.fileBytes} bytes.`,
              );
            }
            total += data.byteLength;
            if (total > limits.totalBytes) {
              throw new GitLimitError(
                `The work folder files are larger than ${limits.totalBytes} bytes in all.`,
              );
            }
            const parts = filePath.split('/');
            const fileName = String(parts.pop());
            let node = root;
            for (const part of parts) {
              let next = node.folders.get(part);
              if (!next) {
                next = { files: new Map(), folders: new Map() };
                node.folders.set(part, next);
              }
              node = next;
            }
            node.files.set(fileName, await git.writeBlob({ fs, gitdir, blob: data }));
          }
          const writeNode = async (node: TreeNode): Promise<string> => {
            const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' }> = [];
            for (const [name, oid] of node.files)
              entries.push({ mode: '100644', path: name, oid, type: 'blob' });
            for (const [name, child] of node.folders) {
              entries.push({ mode: '040000', path: name, oid: await writeNode(child), type: 'tree' });
            }
            entries.sort(treeOrder);
            return git.writeTree({ fs, gitdir, tree: entries });
          };
          const tree = await writeNode(root);
          const signature = {
            name: author.name,
            email: author.email,
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: 0,
          };
          return git.writeCommit({
            fs,
            gitdir,
            commit: {
              message: message.endsWith('\n') ? message : `${message}\n`,
              tree,
              parent: parent ? [parent] : [],
              author: signature,
              committer: signature,
            },
          });
        }),

      push: (branch, commit, options) =>
        guarded(async () => {
          assertBranch(branch);
          assertOid(commit);
          await git.writeRef({ fs, gitdir, ref: `refs/heads/${branch}`, value: commit, force: true });
          const result = await git.push({
            fs,
            http,
            gitdir,
            url,
            remote: 'origin',
            ref: branch,
            remoteRef: branch,
            force: options.force,
          });
          const ref = result.refs?.[`refs/heads/${branch}`];
          if (!result.ok || (ref && !ref.ok)) {
            throw new GitRemoteError('The Git server refused the push.', result.error ?? ref?.error);
          }
        }),
    };
    return await fn(session);
  } finally {
    await close().catch(() => undefined);
    await rm(gitdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
