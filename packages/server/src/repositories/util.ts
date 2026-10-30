const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from URLs are validated before they reach a uuid column (avoids 500s on bad input). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** current time truncated to milliseconds (matches the column defaults) */
export function now(): Date {
  return new Date();
}

/** Postgres error code (drizzle wraps driver errors in `cause`) */
export function pgErrorCode(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === '23505';
