/**
 * Helpers shared by the in-memory MockBackend and its route modules (mock-folders, mock-annotations,
 * mock-publish, mock-reviews): an HTTP error answered as `{ error: { code, message, details } }`,
 * cursor paging, timestamps and deep copies.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 501 for a demo route a Phase 3 lane has not written yet */
export function notImplemented(lane: string): never {
  throw new HttpError(501, 'not_implemented', `not implemented (${lane})`);
}

export const now = (): string => new Date().toISOString();

export const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** `{ data, nextCursor }` for `?limit` (1..250, default 50) and an opaque offset `?cursor` */
export function page<T>(list: T[], query: Record<string, string>): { data: T[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 250);
  const offset = query.cursor ? Number(atob(query.cursor)) || 0 : 0;
  const slice = list.slice(offset, offset + limit);
  const next = offset + limit < list.length ? btoa(String(offset + limit)) : null;
  return { data: slice, nextCursor: next };
}

/** a handler result answered as a list page (`{ data, nextCursor }` instead of `{ data }`) */
export function listResult<T>(result: { data: T[]; nextCursor: string | null }) {
  return { __list: true as const, ...result };
}
