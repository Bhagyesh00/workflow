/**
 * P6-72 (L1): the remote URL rules. Accepts `https://`, `http://`, `ssh://` and the scp form `user@host:path`;
 * refuses every other scheme, `ext::`, `file://`, control characters, a leading `-`, `::`, any password in a URL,
 * a user name in an `https://` or `http://` URL (the token and its user name have their own fields), and a path
 * holding a quote, a backslash, a backtick, `$`, `;`, whitespace (the SSH `exec` quotes the path), `?` or `#` (a
 * decoded `%3F` or `%23` would move the rest of the path into a query string or a fragment).
 * No error text echoes the URL: it can hold a password.
 */
import { ApiError } from '../../http/errors';

/** a remote URL that passed the rules; `path` is the repository path on the host */
export interface ParsedRemote {
  kind: 'https' | 'http' | 'ssh';
  host: string;
  port: number;
  path: string;
  user?: string;
}

/** the repository URL breaks a rule; the message names the rule, never the URL */
export class GitUrlError extends ApiError {
  constructor(reason: string) {
    super(400, 'source_control_url', `The repository URL is not valid: ${reason}.`);
    this.name = 'GitUrlError';
  }
}

const DEFAULT_PORTS = { https: 443, http: 80, ssh: 22 } as const;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** characters a path may not hold: the SSH exec puts the path inside '...' */
const PATH_FORBIDDEN = /['"\\`$;\s]/;
/** `?` and `#` in a decoded path: the base URL would end its path there */
const PATH_QUERY = /[?#]/;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
/** `user@host:path`; the user and host hold no `@`, `/`, `:` or whitespace (an IPv6 host is bracketed) */
const SCP = /^([^@/:\s[\]]+)@([^@/:\s[\]]+|\[[0-9a-fA-F:.]+\]):(.+)$/;
const HOST_OK = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|[0-9a-fA-F:.]+)$/;
const USER_OK = /^[a-zA-Z0-9._~+-]+$/;

function checkPath(path: string): string {
  if (!path || path === '/') throw new GitUrlError('the repository path is missing');
  if (CONTROL.test(path) || PATH_FORBIDDEN.test(path)) {
    throw new GitUrlError('the repository path holds a quote, a backslash, a backtick, $, ; or whitespace');
  }
  if (PATH_QUERY.test(path)) throw new GitUrlError('the repository path holds ? or #');
  if (path.startsWith('-')) throw new GitUrlError('the repository path starts with -');
  return path;
}

function checkHost(raw: string): string {
  const host = raw.replace(/^\[|\]$/g, '');
  if (!host) throw new GitUrlError('the host is missing');
  if (host.startsWith('-') || !HOST_OK.test(host)) throw new GitUrlError('the host is not valid');
  return host.toLowerCase();
}

function checkUser(user: string): string {
  if (user.startsWith('-') || !USER_OK.test(user)) throw new GitUrlError('the user name is not valid');
  return user;
}

/** checks `url` against the remote rules; throws `GitUrlError` (400) naming the rule it breaks */
export function parseRemoteUrl(url: string): ParsedRemote {
  if (typeof url !== 'string' || url.length === 0) throw new GitUrlError('a URL is required');
  if (url.length > 2048) throw new GitUrlError('the URL is too long');
  if (CONTROL.test(url)) throw new GitUrlError('it holds a control character');
  if (url.startsWith('-')) throw new GitUrlError('it starts with -');
  // `transport::address` (ext::, fd::); a bracketed IPv6 host is the one place `::` may appear
  if (url.replace(/\[[0-9a-fA-F:.]+\]/g, '[]').includes('::'))
    throw new GitUrlError('the transport::address form is not allowed');

  const scheme = SCHEME.exec(url);
  if (scheme) {
    const kind = String(scheme[1]).toLowerCase();
    if (kind !== 'https' && kind !== 'http' && kind !== 'ssh') {
      throw new GitUrlError('only https://, http://, ssh:// and user@host:path are allowed');
    }
    // the authority must not hold a password: checked on the raw text, since URL drops an empty one
    const authority = url.slice(String(scheme[0]).length).split('/')[0] ?? '';
    const at = authority.lastIndexOf('@');
    if (at >= 0 && authority.slice(0, at).includes(':')) {
      throw new GitUrlError('a password in the URL is not allowed; use the token field');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GitUrlError('it cannot be parsed');
    }
    if (parsed.password) throw new GitUrlError('a password in the URL is not allowed; use the token field');
    if (parsed.search || parsed.hash || url.includes('?') || url.includes('#')) {
      throw new GitUrlError('a query string or fragment is not allowed');
    }
    const host = checkHost(parsed.hostname);
    let path: string;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      throw new GitUrlError('the repository path cannot be decoded');
    }
    checkPath(path);
    // the path is checked decoded and as written, so an encoded quote is refused too
    checkPath(parsed.pathname);
    const result: ParsedRemote = {
      kind,
      host,
      port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[kind],
      path,
    };
    if (parsed.username) {
      // a token typed as the user name would be stored in the URL and shown with it
      if (kind !== 'ssh') {
        throw new GitUrlError(
          'a user name in an https:// or http:// URL is not allowed; use the user name field',
        );
      }
      let user: string;
      try {
        user = decodeURIComponent(parsed.username);
      } catch {
        throw new GitUrlError('the user name is not valid');
      }
      result.user = checkUser(user);
    }
    return result;
  }

  if (url.includes('://'))
    throw new GitUrlError('only https://, http://, ssh:// and user@host:path are allowed');
  const scp = SCP.exec(url);
  if (!scp) throw new GitUrlError('only https://, http://, ssh:// and user@host:path are allowed');
  return {
    kind: 'ssh',
    host: checkHost(String(scp[2])),
    port: DEFAULT_PORTS.ssh,
    path: checkPath(String(scp[3])),
    user: checkUser(String(scp[1])),
  };
}
