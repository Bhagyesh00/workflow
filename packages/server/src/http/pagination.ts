/** Opaque keyset cursors: base64url(JSON [sortValue, id]). */
import { z } from 'zod';
import { ApiError } from './errors';

export interface Cursor {
  /** ISO timestamp or number of the sort column */
  value: string;
  id: string;
}

export function encodeCursor(value: Date | string | number, id: string): string {
  const v = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(JSON.stringify([v, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Cursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string') {
      return { value: String(parsed[0]), id: parsed[1] };
    }
  } catch {
    /* fall through */
  }
  throw ApiError.badRequest('Invalid cursor');
}

export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
};

/** Slice one extra row to know whether a next page exists. */
export function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): { data: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  return { data, nextCursor: cursorOf(data[data.length - 1]) };
}
