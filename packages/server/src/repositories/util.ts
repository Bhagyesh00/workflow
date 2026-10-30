const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from URLs are validated before they reach a uuid column (avoids 500s on bad input). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** current time truncated to milliseconds (matches the column defaults) */
export function now(): Date {
  return new Date();
}
