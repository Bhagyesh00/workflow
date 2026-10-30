/** Small helpers shared by many nodes: per-item error handling, JSON parameters, field access. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  isPlainObject,
  NodeOperationError,
  type PairedItem,
  setByPath,
} from '@workflow/workflow';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The item a node emits for a failed input item when "continue on fail" is on. */
export function errorItem(error: unknown, itemIndex: number, json: DataObject = {}): Item {
  const message = errorMessage(error);
  const description = (error as { description?: string } | null)?.description;
  return {
    json: { ...json, error: message },
    error: description ? { message, description } : { message },
    pairedItem: { item: itemIndex },
  };
}

/** Wraps full items (with binary data) returned by a `mapItems` handler. */
export class ItemList {
  constructor(readonly items: Item[]) {}
}

export type HandlerResult = DataObject | DataObject[] | ItemList | undefined | null;

/**
 * Run `fn` for every input item with per-item error isolation: when the node continues on
 * fail, a failing item becomes an error item and the others carry on; otherwise the error is
 * re-thrown with its item index. `fn` returns plain objects (or an `ItemList`) for that item.
 */
export async function mapItems(
  ctx: ExecuteContext,
  fn: (itemIndex: number, item: Item) => Promise<HandlerResult>,
): Promise<Item[]> {
  const items = ctx.getInputData();
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(i, items[i]);
      out.push(...toOutputItems(result, i));
    } catch (error) {
      if (ctx.continueOnFail()) {
        out.push(errorItem(error, i));
        continue;
      }
      throw withItemIndex(ctx, error, i);
    }
  }
  return out;
}

/** Normalise a handler result into output items paired with input `itemIndex`. */
export function toOutputItems(result: HandlerResult, itemIndex: number): Item[] {
  if (result === undefined || result === null) return [];
  if (result instanceof ItemList) {
    return result.items.map((item) => ({ ...item, pairedItem: item.pairedItem ?? { item: itemIndex } }));
  }
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) => ({
    json: isPlainObject(entry) ? entry : { data: entry as unknown },
    pairedItem: { item: itemIndex },
  }));
}

/** Attach the item index to an error so the editor can point at the failing item. */
export function withItemIndex(ctx: ExecuteContext, error: unknown, itemIndex: number): Error {
  if (error instanceof NodeOperationError) {
    if (error.itemIndex === undefined) {
      error.itemIndex = itemIndex;
      error.context.itemIndex = itemIndex;
    }
    return error;
  }
  return new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex, cause: error });
}

/** Parse a `json` parameter that may already be an object (expression result) or a JSON string. */
export function parseJsonParameter(
  ctx: { getNode: ExecuteContext['getNode'] },
  value: unknown,
  name: string,
  itemIndex: number,
): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new NodeOperationError(ctx.getNode(), `${name} is not valid JSON`, {
      itemIndex,
      description: errorMessage(error),
      parameter: name,
    });
  }
}

/** A JSON object parameter (headers, query, body): string or object in, plain object out. */
export function parseJsonObject(
  ctx: { getNode: ExecuteContext['getNode'] },
  value: unknown,
  name: string,
  itemIndex: number,
): DataObject {
  const parsed = parseJsonParameter(ctx, value, name, itemIndex);
  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) {
    throw new NodeOperationError(ctx.getNode(), `${name} must be a JSON object`, {
      itemIndex,
      parameter: name,
    });
  }
  return parsed;
}

/** Split "a, b, c" or an array into a clean list of field names. */
export function fieldList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Read a field either by dotted path or literally (when dot notation is disabled). Own keys only. */
export function getField(json: DataObject, field: string, dotNotation = true): unknown {
  if (!dotNotation || Object.hasOwn(json, field)) return Object.hasOwn(json, field) ? json[field] : undefined;
  const parts = field
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = json;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as DataObject)[part];
  }
  return cur;
}

export function setField(json: DataObject, field: string, value: unknown, dotNotation = true): void {
  if (!dotNotation) {
    if (field === '__proto__' || field === 'constructor' || field === 'prototype') {
      throw new Error(`Invalid key "${field}"`);
    }
    json[field] = value;
    return;
  }
  setByPath(json, field, value);
}

/** Remove a field by dotted path (or literally); returns whether something was deleted. */
export function unsetField(json: DataObject, field: string, dotNotation = true): boolean {
  if (!dotNotation || Object.hasOwn(json, field)) return Object.hasOwn(json, field) && delete json[field];
  const parts = field.split('.');
  const last = parts.pop()!;
  const parent = getField(json, parts.join('.'));
  if (parent && typeof parent === 'object' && Object.hasOwn(parent, last)) {
    return delete (parent as DataObject)[last];
  }
  return false;
}

/** JSON serialisation with sorted keys, so equal objects produce equal strings. */
export function stableStringify(value: unknown, replacer?: (key: string, value: unknown) => unknown): string {
  return JSON.stringify(sortKeys(replacer ? replacer('', value) : value, replacer)) ?? 'undefined';
}

function sortKeys(value: unknown, replacer?: (key: string, value: unknown) => unknown): unknown {
  if (Array.isArray(value))
    return value.map((v, i) => sortKeys(replacer ? replacer(String(i), v) : v, replacer));
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => {
          const v = (value as DataObject)[k];
          return [k, sortKeys(replacer ? replacer(k, v) : v, replacer)];
        }),
    );
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

/** Loose equality used by "fuzzy compare" options: 1 == '1', true == 'true', null == ''. */
export function looseEqual(a: unknown, b: unknown): boolean {
  if (deepEqual(a, b)) return true;
  const norm = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'object') return stableStringify(v);
    return String(v).trim().toLowerCase();
  };
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const x = Number(na);
  const y = Number(nb);
  return na !== '' && nb !== '' && !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}

/** pairedItem list that links an output item to several inputs (merge-style nodes). */
export function pairedFrom(...pairs: Array<[item: number, input: number] | null | undefined>): PairedItem[] {
  return pairs.filter((p): p is [number, number] => !!p).map(([item, input]) => ({ item, input }));
}

/** Parse a `key=value` fixed collection list into an object. */
export function keyValuePairs(list: unknown, keyName = 'name', valueName = 'value'): DataObject {
  const out: DataObject = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list as DataObject[]) {
    const key = entry?.[keyName];
    if (typeof key !== 'string' || !key) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = entry[valueName];
  }
  return out;
}

/** Base64url without padding (Gmail raw messages, JWT-like payloads). */
export function base64Url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

/** Fetch every page of a cursor-paginated API until there is no cursor or `limit` is reached. */
export async function paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next?: string | null }>,
  limit = Number.POSITIVE_INFINITY,
  maxPages = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(cursor);
    out.push(...items);
    if (out.length >= limit) return out.slice(0, limit);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

/** "Return all" + "Limit" parameters as a numeric limit. */
export function readLimit(ctx: ExecuteContext, itemIndex: number, defaultLimit = 50): number {
  const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;
  if (returnAll) return Number.POSITIVE_INFINITY;
  const limit = Number(ctx.getNodeParameter('limit', itemIndex, defaultLimit));
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : defaultLimit;
}

/** Strip prototype-polluting keys from data parsed out of untrusted sources. */
export function safeKey(key: string): string {
  return key === '__proto__' || key === 'constructor' || key === 'prototype' ? `_${key}` : key;
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
