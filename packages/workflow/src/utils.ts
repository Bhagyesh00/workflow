import type { DataObject, Item, PairedItem } from './interfaces';

/** Deep-freeze plain data. Run data is immutable once recorded by the engine. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}

/** Deep copy of JSON-like data (Dates and typed arrays preserved). */
export function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (ArrayBuffer.isView(value)) return (value as unknown as Uint8Array).slice() as T;
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as object)) out[k] = deepCopy(v);
  return out as T;
}

export function isPlainObject(value: unknown): value is DataObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toItems(data: DataObject | DataObject[], pairedItem?: PairedItem): Item[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((json, i) => ({ json, pairedItem: pairedItem ?? { item: i } }));
}

export function normalizePairedItems(paired: Item['pairedItem']): PairedItem[] {
  if (paired === undefined || paired === null) return [];
  if (typeof paired === 'number') return [{ item: paired }];
  return Array.isArray(paired) ? paired : [paired];
}

/** Get a value by dotted path (`a.b[0].c`). */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Set a value by dotted path, creating intermediate objects. Refuses prototype keys. */
export function setByPath(obj: DataObject, path: string, value: unknown): void {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new Error(`Invalid key "${p}"`);
    if (i === parts.length - 1) {
      cur[p] = value;
      return;
    }
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[p] as Record<string, unknown>;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * The name/value pairs of a form-urlencoded body: one rule for the HTTP client that sends it and the
 * OAuth1 signer that signs it. A string is parsed as a query string; for an object, undefined values
 * are left out, null is an empty value, arrays repeat the name, and objects are sent as JSON.
 */
export function formEntries(body: unknown): Array<[string, string]> {
  if (body === undefined || body === null) return [];
  if (typeof body === 'string' || body instanceof URLSearchParams) return [...new URLSearchParams(body)];
  if (typeof body !== 'object') return [];
  const out: Array<[string, string]> = [];
  const text = (value: unknown) =>
    value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) out.push([name, text(entry)]);
    }
  }
  return out;
}
