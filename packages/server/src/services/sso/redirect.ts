/**
 * P6-01 (L6): where a sign-in may send the browser afterwards (SAML RelayState, OIDC return path), the one
 * server validator of decisions "Security, final" (S13): a relative path, or an absolute URL with exactly
 * the base origin (scheme, host and port), so plain http passes only when the base itself is http; anything
 * else falls back to the editor's home.
 */

/** the editor's home, where a refused or missing target goes */
export const SSO_REDIRECT_HOME = '/';
const MAX_REDIRECT_LENGTH = 2048;

/** control characters, whitespace and backslashes: browsers read a backslash as `/` and drop tabs */
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

export function safeSsoRedirect(value: unknown, baseUrl: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_REDIRECT_LENGTH) return SSO_REDIRECT_HOME;
  if (hasUnsafeCharacter(value)) return SSO_REDIRECT_HOME;
  // a same-app path; `//host` is another origin to a browser
  if (value.startsWith('/')) return value.startsWith('//') ? SSO_REDIRECT_HOME : value;
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(value);
  } catch {
    return SSO_REDIRECT_HOME;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return SSO_REDIRECT_HOME;
  if (target.username || target.password) return SSO_REDIRECT_HOME;
  // the exact origin: a longer host (`app.example.com.evil.test`) or another scheme or port is refused
  if (target.origin !== base.origin) return SSO_REDIRECT_HOME;
  return target.href;
}
