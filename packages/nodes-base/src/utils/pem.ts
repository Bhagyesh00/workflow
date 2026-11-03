/**
 * Keys pasted into a credential field often lose their line breaks (one line, spaces, or literal
 * `\n`). Node's and ssh2's PEM parsers need the base64 body on lines of its own, so this rebuilds
 * each `-----BEGIN X-----` ... `-----END X-----` block with 64-character body lines.
 */

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
/** an RFC 1421 header field name such as `Proc-Type` or `DEK-Info` */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*:$/;

function wrap(base64: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return lines;
}

function formatBlock(label: string, inner: string): string {
  const tokens = inner.split(/\s+/).filter(Boolean);
  // encrypted PKCS#1 keys carry `Name: value` header lines before the base64 body
  const headers: string[] = [];
  while (tokens.length >= 2 && HEADER_NAME.test(tokens[0])) {
    headers.push(`${tokens.shift()} ${tokens.shift()}`);
  }
  const body = wrap(tokens.join(''));
  const lines = [`-----BEGIN ${label}-----`];
  if (headers.length) lines.push(...headers, '');
  lines.push(...body, `-----END ${label}-----`);
  return lines.join('\n');
}

/**
 * Re-wrap every PEM block in `text` into a valid PEM (64-character body lines, trailing newline).
 * Text without a PEM block is returned trimmed and otherwise unchanged.
 */
export function formatPemBlock(text: string): string {
  const normalized = text
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
  const blocks: string[] = [];
  for (const match of normalized.matchAll(BLOCK)) blocks.push(formatBlock(match[1], match[2]));
  return blocks.length ? `${blocks.join('\n')}\n` : normalized;
}
