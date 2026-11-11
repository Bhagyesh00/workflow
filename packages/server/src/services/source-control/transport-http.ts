/**
 * P6-72 (L1): isomorphic-git's HTTP plugin on `ctx.http` (the SSRF-guarded client): every request goes through it
 * (`bodyType: 'raw'`, `responseType: 'stream'`, `ignoreHttpStatusErrors`), redirects are checked again by the client
 * and `allowedDomains` is the remote host, so a redirect never carries the token to another host. Smart HTTP
 * protocol v1 only; a token is never sent over plain `http://`. No import of `isomorphic-git/http/node`.
 * stub (L1)
 */
import type { HttpClient } from '@workflow/core';
import type { HttpClient as IsomorphicGitHttpClient } from 'isomorphic-git';
import type { ParsedRemote } from './url';

/** what isomorphic-git takes as `http` (its `HttpClient` type: `{ request }`) */
export type GitHttpPlugin = IsomorphicGitHttpClient;

/** stub (L1): throws until L1 writes the transport */
export function gitHttpTransport(
  _http: HttpClient,
  _remote: ParsedRemote,
  _auth?: { username: string; token: string },
): GitHttpPlugin {
  throw new Error('not implemented (L1)');
}
