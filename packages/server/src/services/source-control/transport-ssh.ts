/**
 * P6-72 (L1): the SSH adapter behind isomorphic-git's HTTP plugin interface. GET `info/refs?service=X` maps to an
 * ssh2 `exec` of `X '<path>'` (path quoted, no other command); POST writes the body to the same channel. The
 * socket comes from `ctx.http.resolveAllowedHost` with its pinned `lookup` (handed to ssh2 as `sock`);
 * `hostVerifier` keeps the first SHA256 fingerprint through `onFirstSeen` and refuses a changed one with
 * `GitHostKeyChangedError`. Connect timeout 30 s. Keys stay in memory.
 * stub (L1)
 */
import type { HttpClient } from '@workflow/core';
import type { GitHttpPlugin } from './transport-http';
import type { ParsedRemote } from './url';

/** the host key memory of one connection: the stored fingerprint, or null before the first connect */
export interface HostKeyCheck {
  fingerprint: string | null;
  /** called once with the SHA256 fingerprint when none was stored (accept-new) */
  onFirstSeen(fingerprint: string): Promise<void>;
}

/** stub (L1): throws until L1 writes the adapter */
export function gitSshTransport(
  _http: HttpClient,
  _remote: ParsedRemote,
  _key: { privateKey: string },
  _hostKey: HostKeyCheck,
): GitHttpPlugin {
  throw new Error('not implemented (L1)');
}
