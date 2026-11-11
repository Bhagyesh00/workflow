/**
 * P6-72 (L1): one Git operation on a remote. `withRepo` makes one temp folder per operation (removed in `finally`),
 * object store only (no checkout, no working tree), and hands `fn` a `GitSession`. `readFiles` walks the tree and
 * refuses mode 120000 and 160000, `..`, absolute paths and any path outside `SOURCE_CONTROL_PATHS`, and enforces
 * `SOURCE_CONTROL_LIMITS` (`GitLimitError`). Keys stay in memory; no error text holds a key, a token or a password.
 * stub (L1): `withRepo` throws; the error classes are final.
 */
import type { HttpClient } from '@workflow/core';
import type { SOURCE_CONTROL_LIMITS } from '@workflow/workflow';
import { ApiError } from '../../http/errors';
import type { HostKeyCheck } from './transport-ssh';

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

/** stub (L1): throws until L1 writes the session */
export function withRepo<T>(
  _deps: GitDeps,
  _remote: GitRemote,
  _fn: (repo: GitSession) => Promise<T>,
): Promise<T> {
  throw new Error('not implemented (L1)');
}
