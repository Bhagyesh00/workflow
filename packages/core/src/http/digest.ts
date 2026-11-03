/**
 * HTTP Digest authentication (RFC 2617): builds the Authorization header that answers a
 * `WWW-Authenticate: Digest ...` challenge. MD5 and MD5-sess with qop=auth, or the RFC 2069 form
 * when the server names no usable qop (as n8n does). SHA-256 and auth-int are not supported.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface DigestRequest {
  method: string;
  /** path and query of the request, as sent on the request line */
  uri: string;
  username: string;
  password: string;
  /** client nonce; random when omitted (set only by tests) */
  cnonce?: string;
}

interface Challenge {
  scheme: string;
  params: Map<string, string>;
}

const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex');

/** Split a WWW-Authenticate value into challenges: a bare word starts one, name=value pairs fill it. */
function parseChallenges(header: string): Challenge[] {
  const out: Challenge[] = [];
  let current: Challenge | undefined;
  const re = /\s*,?\s*([^\s=,"]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*)))?/gy;
  let match: RegExpExecArray | null;
  while (re.lastIndex < header.length && (match = re.exec(header)) !== null) {
    const [, name, quoted, bare] = match;
    if (quoted === undefined && bare === undefined) {
      current = { scheme: name.toLowerCase(), params: new Map() };
      out.push(current);
    } else if (current) {
      current.params.set(name.toLowerCase(), quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare);
    }
  }
  return out;
}

const quote = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** the Authorization header value for `challenge`, or undefined when it cannot be answered */
export function digestAuthorization(challenge: string, request: DigestRequest): string | undefined {
  const chosen = parseChallenges(challenge)
    .filter((c) => c.scheme === 'digest')
    .find((c) => {
      const algorithm = (c.params.get('algorithm') ?? 'MD5').toUpperCase();
      return (algorithm === 'MD5' || algorithm === 'MD5-SESS') && c.params.has('nonce');
    });
  if (!chosen) return undefined;
  const { params } = chosen;
  const realm = params.get('realm') ?? '';
  const nonce = params.get('nonce') as string;
  const opaque = params.get('opaque');
  const algorithmText = params.get('algorithm');
  const sess = algorithmText?.toUpperCase() === 'MD5-SESS';
  const useQop = (params.get('qop') ?? '')
    .split(',')
    .map((q) => q.trim().toLowerCase())
    .includes('auth');
  const cnonce = request.cnonce ?? randomBytes(8).toString('hex');
  const nc = '00000001';

  let ha1 = md5(`${request.username}:${realm}:${request.password}`);
  if (sess) ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${request.method.toUpperCase()}:${request.uri}`);
  const response = useQop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username=${quote(request.username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(request.uri)}`,
  ];
  if (algorithmText) parts.push(`algorithm=${algorithmText}`);
  parts.push(`response="${response}"`);
  if (opaque !== undefined) parts.push(`opaque=${quote(opaque)}`);
  if (useQop) parts.push('qop=auth', `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  return `Digest ${parts.join(', ')}`;
}
