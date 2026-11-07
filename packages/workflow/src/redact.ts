/**
 * Secret patterns removed before text is persisted (agent memory, run data) or sent to a model or a client
 * (security rule S4: no credentials in run data, memory, errors or API output). No Node API.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const scheme = /^(Bearer|Basic)\s/.exec(match)?.[1];
      return scheme ? `${scheme} [redacted]` : '[redacted]';
    });
  }
  return out;
}
