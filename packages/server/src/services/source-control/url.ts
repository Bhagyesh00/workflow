/**
 * P6-72 (L1): the remote URL rules. Accepts `https://`, `http://`, `ssh://` and the scp form `user@host:path`;
 * refuses every other scheme, `ext::`, `file://`, control characters, a leading `-`, `::`, any password in a URL,
 * and a path holding a quote, a backslash, a backtick, `$`, `;` or whitespace (the SSH `exec` quotes the path).
 * stub (L1)
 */

/** a remote URL that passed the rules; `path` is the repository path on the host */
export interface ParsedRemote {
  kind: 'https' | 'http' | 'ssh';
  host: string;
  port: number;
  path: string;
  user?: string;
}

/** stub (L1): throws until L1 writes the rules */
export function parseRemoteUrl(_url: string): ParsedRemote {
  throw new Error('not implemented (L1)');
}
