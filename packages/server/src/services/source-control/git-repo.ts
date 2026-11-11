/**
 * P6-72 (L1): one Git operation on a remote. `withRepo` makes one temp folder per operation (removed in `finally`),
 * object store only (no checkout, no working tree), and hands `fn` a `GitSession`. Every upload-pack answer passes
 * a pack guard before isomorphic-git inflates it: the object count and each object's size (a blob, a commit or
 * tree, a delta's result) and the totals are checked from the pack headers as the bytes stream in. `readFiles`
 * walks only the root and the managed folders (as n8n: a README.md, a .gitignore or any other entry outside them
 * is skipped, never read), refuses mode 120000 and 160000, `..` and absolute paths there, and enforces
 * `SOURCE_CONTROL_LIMITS` (`GitLimitError`); `writeCommit` keeps every entry of the parent tree that is not a
 * managed path, byte for byte with its mode. Keys stay in memory; no error text holds a key, a token or a password.
 * Each session method turns a library or network failure into one of the four errors below with a fixed text (the
 * cause goes to `reason`, for the log only); errors thrown by `fn` itself pass through untouched.
 */
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type HttpClient, SsrfBlockedError } from '@workflow/core';
import { CredentialDomainError, isManagedPath, type SOURCE_CONTROL_LIMITS } from '@workflow/workflow';
import git, { type TreeEntry } from 'isomorphic-git';
import { ApiError } from '../../http/errors';
import { type GitHttpPlugin, gitHttpTransport, remoteBaseUrl } from './transport-http';
import { gitSshTransport, type HostKeyCheck } from './transport-ssh';
import { parseRemoteUrl } from './url';

export interface GitDeps {
  http: HttpClient;
  /** `files`, `fileBytes` and `totalBytes` bound both the pack guard (before inflating) and `readFiles` */
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
  /** the managed files of `commit`, by path; any other entry is skipped */
  readFiles(commit: string): Promise<Map<string, Uint8Array>>;
  /**
   * a commit on `parent` (null: the first commit) whose managed paths are exactly `files`; every other entry of the
   * parent's tree stays as it was; returns its id
   */
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

type Limits = GitDeps['limits'];

/** the largest commit, tree or tag a pack may hold (a tree of 5000 entries is about 400 KB) */
const TREE_OBJECT_BYTES = 1024 * 1024;
/** commits, trees and tags, plus every delta's own instructions, in one pack */
const OTHER_TOTAL_BYTES = 64 * 1024 * 1024;
/** bytes the pack guard inflates before it lets the event loop run */
const PACK_STEP_BYTES = 4 * 1024 * 1024;
/** tree entries `readFiles` may walk beyond `limits.files`: the managed folders and files, a README and the like */
const ENTRY_SLACK = 100;
/** the root and the four managed folders: `readFiles` reads no other tree */
const MAX_TREE_VISITS = 5;

const PACK_TYPES: Record<number, 'commit' | 'tree' | 'blob' | 'tag'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;
/** a delta on a base whose type the guard cannot see (a ref delta) */
type PackObjectType = 'commit' | 'tree' | 'blob' | 'tag' | 'unknown';

const badPack = () => new GitRemoteError('The Git server sent a bad pack.');
const TOO_LARGE_TEXT = 'The Git server sent more than the size limit allows.';

/** the most objects one pack may hold */
const packObjectCap = (limits: Limits) => 4 * limits.files + 1000;

/** the type, size and data offset of the object header at `p`, or null when `buf` does not hold all of it yet */
function packObjectHeader(
  buf: Buffer,
  p: number,
): { type: number; size: number; baseDistance: number; dataStart: number } | null {
  let i = p;
  if (i >= buf.length) return null;
  let c = buf[i++] as number;
  const type = (c >> 4) & 7;
  let size = c & 15;
  let mult = 16;
  while (c & 0x80) {
    if (i >= buf.length) return null;
    if (mult > 2 ** 46) throw badPack();
    c = buf[i++] as number;
    size += (c & 0x7f) * mult;
    mult *= 128;
  }
  let baseDistance = 0;
  if (type === OFS_DELTA) {
    if (i >= buf.length) return null;
    c = buf[i++] as number;
    baseDistance = c & 0x7f;
    while (c & 0x80) {
      if (i >= buf.length) return null;
      if (baseDistance > 2 ** 40) throw badPack();
      c = buf[i++] as number;
      baseDistance = (baseDistance + 1) * 128 + (c & 0x7f);
    }
  } else if (type === REF_DELTA) {
    if (i + 20 > buf.length) return null;
    i += 20;
  } else if (!PACK_TYPES[type]) {
    throw badPack();
  }
  return { type, size, baseDistance, dataStart: i };
}

/** the result size a delta's instructions announce (after the base size), or null when they are cut short */
function deltaResultSize(delta: Buffer): number | null {
  let i = 0;
  for (let n = 0; n < 2; n++) {
    let value = 0;
    let mult = 1;
    for (;;) {
      if (i >= delta.length || mult > 2 ** 49) return null;
      const c = delta[i++] as number;
      value += (c & 0x7f) * mult;
      mult *= 128;
      if (!(c & 0x80)) break;
    }
    if (n === 1) return value;
  }
  return null;
}

/**
 * Reads a pack as it streams in and refuses it (`GitLimitError`) before isomorphic-git inflates anything over the
 * limits: more objects than `packObjectCap`, a blob over `limits.fileBytes`, a commit, tree or tag over
 * `TREE_OBJECT_BYTES`, a delta whose result is over the cap of its base's type, blobs over `limits.totalBytes` in
 * all, and the rest over `OTHER_TOTAL_BYTES`. Each object is inflated with `maxOutputLength` at its announced size,
 * so an object larger than its header says fails as a bad pack.
 */
class PackGuard {
  private parts: Buffer[] = [];
  private length = 0;
  /** the pack offset of the first byte in `parts` */
  private offset = 0;
  /** the buffered length the next scan waits for (a cut object is tried again once twice as many bytes are in) */
  private waitFor = 0;
  /** objects still to read; -1 before the pack header */
  private left = -1;
  private done = false;
  private readonly types = new Map<number, PackObjectType>();
  private blobBytes = 0;
  private otherBytes = 0;

  constructor(private readonly limits: Limits) {}

  add(data: Buffer): void {
    if (this.done || data.length === 0) return;
    this.parts.push(data);
    this.length += data.length;
  }

  /** checks what is buffered; true when it stopped to let the event loop run and more is ready */
  scan(final: boolean): boolean {
    if (this.done || this.length === 0 || (!final && this.length < this.waitFor)) return false;
    const buf = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
    let p = 0;
    let step = 0;
    let waitFor = 0;
    let paused = false;
    while (!this.done) {
      if (this.left < 0) {
        if (buf.length - p < 12) {
          waitFor = 12;
          break;
        }
        const version = buf.readUInt32BE(p + 4);
        if (buf.toString('latin1', p, p + 4) !== 'PACK' || (version !== 2 && version !== 3)) throw badPack();
        const count = buf.readUInt32BE(p + 8);
        const cap = packObjectCap(this.limits);
        if (count > cap) throw new GitLimitError(`The Git server sent more than ${cap} objects.`);
        this.left = count;
        this.done = count === 0;
        p += 12;
        continue;
      }
      if (step >= PACK_STEP_BYTES) {
        paused = true;
        break;
      }
      const start = this.offset + p;
      const head = packObjectHeader(buf, p);
      if (!head || head.dataStart >= buf.length) {
        waitFor = buf.length - p + 1;
        break;
      }
      const base = PACK_TYPES[head.type];
      // checked from the header, before a byte is inflated
      if (base) this.check(base, head.size);
      else if (head.size > 2 * this.capOf('unknown')) {
        throw new GitLimitError(
          `The Git server sent an object larger than ${2 * this.capOf('unknown')} bytes.`,
        );
      }
      let out: Buffer;
      let used: number;
      try {
        const result = zlib.inflateSync(buf.subarray(head.dataStart), {
          info: true,
          maxOutputLength: Math.max(1, head.size),
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        out = result.buffer;
        used = result.engine.bytesWritten;
      } catch (error) {
        if ((error as { code?: string }).code === 'Z_BUF_ERROR' && !final) {
          // the object's data is not all here yet
          waitFor = 2 * (buf.length - p);
          break;
        }
        throw badPack();
      }
      if (out.length !== head.size) throw badPack();
      let type: PackObjectType;
      if (base) {
        type = base;
        this.count(type, head.size);
      } else {
        const result = deltaResultSize(out);
        if (result === null) throw badPack();
        if (head.type === OFS_DELTA) {
          const known = this.types.get(start - head.baseDistance);
          if (head.baseDistance === 0 || known === undefined) throw badPack();
          type = known;
        } else {
          type = 'unknown';
        }
        this.check(type, result);
        this.count(type, result);
        this.otherBytes += head.size;
        if (this.otherBytes > OTHER_TOTAL_BYTES) throw new GitLimitError(TOO_LARGE_TEXT);
      }
      this.types.set(start, type);
      step += head.size;
      p = head.dataStart + used;
      this.left -= 1;
      if (this.left === 0) this.done = true;
    }
    if (this.done) {
      this.parts = [];
      this.length = 0;
      return false;
    }
    const rest = buf.subarray(p);
    this.offset += p;
    this.parts = rest.length ? [rest] : [];
    this.length = rest.length;
    this.waitFor = waitFor;
    return paused;
  }

  /** at the end of the answer: a pack that started must be complete */
  finish(): void {
    if (this.left < 0 && this.length === 0) return;
    if (!this.done) throw badPack();
  }

  private capOf(type: PackObjectType): number {
    if (type === 'blob') return this.limits.fileBytes;
    if (type === 'unknown') return Math.max(this.limits.fileBytes, TREE_OBJECT_BYTES);
    return TREE_OBJECT_BYTES;
  }

  private check(type: PackObjectType, size: number): void {
    if (size <= this.capOf(type)) return;
    if (type === 'blob') {
      throw new GitLimitError(`The repository holds a file larger than ${this.limits.fileBytes} bytes.`);
    }
    if (type === 'unknown') {
      throw new GitLimitError(`The Git server sent an object larger than ${this.capOf(type)} bytes.`);
    }
    throw new GitLimitError(
      `The repository holds a folder or a commit larger than ${TREE_OBJECT_BYTES} bytes.`,
    );
  }

  private count(type: PackObjectType, size: number): void {
    if (type === 'blob' || type === 'unknown') {
      this.blobBytes += size;
      if (this.blobBytes > this.limits.totalBytes) {
        throw new GitLimitError(
          `The repository files are larger than ${this.limits.totalBytes} bytes in all.`,
        );
      }
      return;
    }
    this.otherBytes += size;
    if (this.otherBytes > OTHER_TOTAL_BYTES) throw new GitLimitError(TOO_LARGE_TEXT);
  }
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The upload-pack answer, unchanged, with the pack guard on its side-band channel 1 (where isomorphic-git reads
 * the pack). A chunk is passed on only after the guard checked every object it completes.
 */
async function* guardPackAnswer(body: AsyncIterable<Uint8Array>, limits: Limits): AsyncGenerator<Uint8Array> {
  const guard = new PackGuard(limits);
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of body) {
    const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    let p = 0;
    while (pending.length - p >= 4) {
      const hex = pending.toString('latin1', p, p + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GitRemoteError('The Git server sent a bad answer.');
      const size = Number.parseInt(hex, 16);
      // a flush or a delimiter packet
      if (size < 4) {
        p += 4;
        continue;
      }
      if (pending.length - p < size) break;
      if (size > 4 && pending[p + 4] === 1) guard.add(Buffer.from(pending.subarray(p + 5, p + size)));
      p += size;
    }
    pending = Buffer.from(pending.subarray(p));
    while (guard.scan(false)) await yieldToLoop();
    yield chunk;
  }
  while (guard.scan(true)) await yieldToLoop();
  guard.finish();
}

/** the plugin with the pack guard on every upload-pack answer */
function withPackGuard(http: GitHttpPlugin, limits: Limits): GitHttpPlugin {
  return {
    async request(request) {
      const response = await http.request(request);
      const post = (request.method ?? 'GET').toUpperCase() === 'POST';
      if (post && request.url.endsWith('/git-upload-pack') && response.statusCode === 200 && response.body) {
        return { ...response, body: guardPackAnswer(response.body, limits) };
      }
      return response;
    },
  };
}

/** a root folder that holds managed files (workflows, credential_stubs, datatables, projects) */
const isManagedFolder = (name: string) => isManagedPath(`${name}/00000000-0000-4000-8000-000000000000.json`);

/** a symbolic link or a submodule, refused anywhere in the managed folders and at a managed path (as n8n) */
function refuseLink(entry: TreeEntry, full: string): void {
  if (entry.mode === '120000') {
    throw new GitLimitError(`The repository holds a symbolic link, which is not allowed: ${shown(full)}.`);
  }
  if (entry.mode === '160000') {
    throw new GitLimitError(`The repository holds a submodule, which is not allowed: ${shown(full)}.`);
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
    http = withPackGuard(ssh, limits);
    close = () => ssh.close();
    url = SSH_PLACEHOLDER_URL;
  } else {
    if (parsed.kind === 'ssh') throw new GitRemoteError('A token needs an https:// URL.');
    const auth = remote.auth.token ? { username: remote.auth.username, token: remote.auth.token } : undefined;
    http = withPackGuard(gitHttpTransport(deps.http, parsed, auth), limits);
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
          let entries = 0;
          let visits = 0;
          const maxEntries = limits.files + ENTRY_SLACK;
          const { commit: head } = await git.readCommit({ fs, gitdir, oid: commit });
          /** the entries of one tree, each name checked; every visit and every entry counts */
          const list = async (treeOid: string, prefix: string) => {
            visits += 1;
            if (visits > MAX_TREE_VISITS) throw new GitLimitError('The repository tree is not valid.');
            const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
            entries += tree.length;
            if (entries > maxEntries) {
              throw new GitLimitError(`The repository tree holds more than ${maxEntries} entries.`);
            }
            const names = new Set<string>();
            return tree.map((entry) => {
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
              if (names.has(name)) throw new GitLimitError(`The repository holds ${shown(full)} twice.`);
              names.add(name);
              return { entry, full };
            });
          };
          const read = async (entry: TreeEntry, full: string) => {
            refuseLink(entry, full);
            if (entry.type !== 'blob') {
              throw new GitLimitError(
                `The repository holds a folder where a work folder file belongs: ${shown(full)}.`,
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
          };
          for (const { entry, full } of await list(head.tree, '')) {
            if (isManagedFolder(full)) {
              refuseLink(entry, full);
              if (entry.type !== 'tree') {
                throw new GitLimitError(
                  `The repository holds a file where a work folder belongs: ${shown(full)}.`,
                );
              }
              for (const inner of await list(entry.oid, full)) {
                refuseLink(inner.entry, inner.full);
                // a nested folder or a file of another name: skipped, never read (a push keeps it)
                if (inner.entry.type !== 'blob' || !isManagedPath(inner.full)) continue;
                await read(inner.entry, inner.full);
              }
            } else if (isManagedPath(full)) {
              await read(entry, full);
            }
            // any other root entry (README.md, .gitignore, a link, a folder): skipped, never read (a push keeps it)
          }
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
          // every entry of the parent's tree that is not a managed path stays, byte for byte with its mode
          const keptRoot: TreeEntry[] = [];
          const keptIn = new Map<string, TreeEntry[]>();
          if (parent !== null) {
            const { commit: base } = await git.readCommit({ fs, gitdir, oid: parent });
            const { tree } = await git.readTree({ fs, gitdir, oid: base.tree });
            for (const entry of tree) {
              if (isManagedFolder(entry.path)) {
                if (entry.type !== 'tree') continue;
                const { tree: inner } = await git.readTree({ fs, gitdir, oid: entry.oid });
                const kept = inner.filter((e) => !isManagedPath(`${entry.path}/${e.path}`));
                if (kept.length) {
                  keptIn.set(entry.path, kept);
                  if (!root.folders.has(entry.path)) {
                    root.folders.set(entry.path, { files: new Map(), folders: new Map() });
                  }
                }
                continue;
              }
              if (!isManagedPath(entry.path)) keptRoot.push(entry);
            }
          }
          const writeNode = async (node: TreeNode, kept: TreeEntry[]): Promise<string> => {
            const entries: TreeEntry[] = kept.map(({ mode, path: name, oid, type }) => ({
              mode,
              path: name,
              oid,
              type,
            }));
            for (const [name, oid] of node.files)
              entries.push({ mode: '100644', path: name, oid, type: 'blob' });
            for (const [name, child] of node.folders) {
              const inner = node === root ? (keptIn.get(name) ?? []) : [];
              entries.push({ mode: '040000', path: name, oid: await writeNode(child, inner), type: 'tree' });
            }
            entries.sort(treeOrder);
            return git.writeTree({ fs, gitdir, tree: entries });
          };
          const tree = await writeNode(root, keptRoot);
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
    await rm(gitdir, { recursive: true, force: true, maxRetries: 3 });
  }
}
