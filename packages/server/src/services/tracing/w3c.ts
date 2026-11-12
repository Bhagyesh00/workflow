/**
 * P6-65 (S5 L9): W3C Trace Context (`traceparent`, `tracestate`) and Baggage headers, parsed and written; a
 * malformed header or member is ignored, never an error. Limits as the specs: `tracestate` at most 32 members and
 * 512 characters, `baggage` at most 180 members and 8192 bytes.
 */
import type { SpanContext } from './span';

export const TRACESTATE_MAX_ENTRIES = 32;
export const TRACESTATE_MAX_LENGTH = 512;
/** a `tracestate` member over this size is the first to go when the header is too long */
const TRACESTATE_LARGE_ENTRY = 128;
export const BAGGAGE_MAX_ENTRIES = 180;
export const BAGGAGE_MAX_BYTES = 8192;

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/** undefined for a missing or malformed header (version ff, all-zero ids and uppercase hex refused) */
export function parseTraceparent(header: string | undefined): SpanContext | undefined {
  if (typeof header !== 'string') return undefined;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, flags, rest] = match;
  if (version === 'ff') return undefined;
  // version 00 has exactly four fields; a later version may add fields after a dash
  if (version === '00' ? rest !== '' : rest !== '' && !rest.startsWith('-')) return undefined;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
}

/** version 00 */
export function formatTraceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

const TRACESTATE_KEY =
  /^(?:[a-z][_0-9a-z\-*/]{0,255}|[a-z0-9][_0-9a-z\-*/]{0,240}@[a-z][_0-9a-z\-*/]{0,13})$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/**
 * The valid members of a `tracestate` header, in order, as one header value (undefined when none): a malformed or
 * repeated member is dropped, at most 32 members are kept, and a header over 512 characters loses its members over
 * 128 characters first, then members from the end.
 */
export function parseTracestate(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const members: string[] = [];
  const seen = new Set<string>();
  for (const raw of header.split(',')) {
    const member = raw.trim();
    if (!member) continue;
    const eq = member.indexOf('=');
    if (eq <= 0) continue;
    const key = member.slice(0, eq);
    const value = member.slice(eq + 1);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(value) || seen.has(key)) continue;
    seen.add(key);
    members.push(`${key}=${value}`);
    if (members.length === TRACESTATE_MAX_ENTRIES) break;
  }
  const length = () => members.reduce((sum, m) => sum + m.length, 0) + Math.max(0, members.length - 1);
  while (members.length && length() > TRACESTATE_MAX_LENGTH) {
    let large = -1;
    for (let i = members.length - 1; i >= 0; i--) {
      if (members[i].length > TRACESTATE_LARGE_ENTRY) {
        large = i;
        break;
      }
    }
    members.splice(large === -1 ? members.length - 1 : large, 1);
  }
  return members.length ? members.join(',') : undefined;
}

/** RFC 7230 token: a baggage key */
const BAGGAGE_KEY = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** baggage-octet: printable US-ASCII without space, DQUOTE, comma, semicolon and backslash */
const BAGGAGE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/** key to value (percent-decoded); member properties are dropped, malformed members skipped, a header over 8192 bytes ignored */
export function parseBaggage(header: string | undefined): Record<string, string> {
  // a Map, so a key such as `__proto__` stays a plain entry
  const entries = new Map<string, string>();
  if (typeof header !== 'string' || !header || Buffer.byteLength(header) > BAGGAGE_MAX_BYTES) return {};
  for (const raw of header.split(',')) {
    if (entries.size >= BAGGAGE_MAX_ENTRIES) break;
    const member = raw.split(';', 1)[0].trim();
    const eq = member.indexOf('=');
    if (eq <= 0) continue;
    const key = member.slice(0, eq).trim();
    const encoded = member.slice(eq + 1).trim();
    if (!BAGGAGE_KEY.test(key) || !BAGGAGE_VALUE.test(encoded)) continue;
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    entries.set(key, value);
  }
  return Object.fromEntries(entries);
}

/** `key=value,...` with percent-encoded values; invalid keys are skipped and the 180 member and 8192 byte limits kept */
export function formatBaggage(entries: Record<string, string>): string {
  const members: string[] = [];
  let bytes = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (members.length >= BAGGAGE_MAX_ENTRIES) break;
    if (!BAGGAGE_KEY.test(key) || typeof value !== 'string') continue;
    const member = `${key}=${encodeURIComponent(value)}`;
    const added = Buffer.byteLength(member) + (members.length ? 1 : 0);
    if (bytes + added > BAGGAGE_MAX_BYTES) continue;
    members.push(member);
    bytes += added;
  }
  return members.join(',');
}
