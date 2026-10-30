/**
 * Helpers over item data: schema inference for the schema view and `$json` autocomplete,
 * table flattening, expression paths, and the structural diff behind "Compare with previous run".
 */
import type { Item } from '@workflow/workflow';

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'undefined';

export function kindOf(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t;
  return 'object';
}

export interface SchemaField {
  key: string;
  /** path segments from the item json root */
  path: Array<string | number>;
  kind: ValueKind;
  example?: string;
  children: SchemaField[];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `$json` access path: `.name`, `["first name"]`, `[0]` */
export function accessPath(path: Array<string | number>): string {
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : IDENT.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`))
    .join('');
}

/** Expression that reads `path` from the input of the active node (or another node's output). */
export function fieldExpression(path: Array<string | number>, fromNode?: string): string {
  const base = fromNode ? `$('${fromNode.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}').item.json` : '$json';
  return `{{ ${base}${accessPath(path)} }}`;
}

function example(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return undefined;
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function inferValue(
  key: string,
  path: Array<string | number>,
  values: unknown[],
  depth: number,
): SchemaField {
  const present = values.filter((v) => v !== undefined);
  const first = present.find((v) => v !== null) ?? present[0];
  const kind = kindOf(first);
  const field: SchemaField = { key, path, kind, example: example(first), children: [] };
  if (depth > 6) return field;
  if (kind === 'object') {
    field.children = inferObject(
      present.filter((v) => kindOf(v) === 'object') as Array<Record<string, unknown>>,
      path,
      depth + 1,
    );
  } else if (kind === 'array') {
    const arrays = present.filter(Array.isArray) as unknown[][];
    const elements = arrays.flatMap((a) => a.slice(0, 20));
    if (elements.length) field.children = [inferValue('[0]', [...path, 0], elements, depth + 1)];
  }
  return field;
}

function inferObject(
  objects: Array<Record<string, unknown>>,
  path: Array<string | number>,
  depth: number,
): SchemaField[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys.map((k) =>
    inferValue(
      k,
      [...path, k],
      objects.map((o) => o[k]),
      depth,
    ),
  );
}

/** Union schema of the first `sample` items' json. */
export function inferSchema(items: Item[], sample = 50): SchemaField[] {
  return inferObject(
    items.slice(0, sample).map((i) => i.json ?? {}),
    [],
    0,
  );
}

/** Flatten schema to dotted paths (for autocomplete). */
export function flattenSchema(
  fields: SchemaField[],
): Array<{ path: Array<string | number>; kind: ValueKind }> {
  const out: Array<{ path: Array<string | number>; kind: ValueKind }> = [];
  const walk = (list: SchemaField[]) => {
    for (const f of list) {
      out.push({ path: f.path, kind: f.kind });
      walk(f.children);
    }
  };
  walk(fields);
  return out;
}

/** Top-level columns for the table view (union of keys, in first-seen order). */
export function tableColumns(items: Item[], max = 40): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const item of items.slice(0, 200)) {
    for (const key of Object.keys(item.json ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length >= max) return columns;
    }
  }
  return columns;
}

export function cellText(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// ---------------------------------------------------------------------------------------------
// Diff (run comparison)
// ---------------------------------------------------------------------------------------------

export interface DiffEntry {
  /** printable path, e.g. `[0].customer.email` */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural diff of two JSON values; stops after `limit` entries. */
export function diffJson(before: unknown, after: unknown, limit = 500): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (a: unknown, b: unknown, path: Array<string | number>) => {
    if (out.length >= limit) return;
    if (Object.is(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (i >= a.length) out.push({ path: accessPath([...path, i]), kind: 'added', after: b[i] });
        else if (i >= b.length) out.push({ path: accessPath([...path, i]), kind: 'removed', before: a[i] });
        else walk(a[i], b[i], [...path, i]);
        if (out.length >= limit) return;
      }
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) {
        if (!(k in b)) out.push({ path: accessPath([...path, k]), kind: 'removed', before: a[k] });
        else walk(a[k], b[k], [...path, k]);
        if (out.length >= limit) return;
      }
      for (const k of Object.keys(b)) {
        if (!(k in a)) out.push({ path: accessPath([...path, k]), kind: 'added', after: b[k] });
        if (out.length >= limit) return;
      }
      return;
    }
    out.push({ path: accessPath(path) || '(root)', kind: 'changed', before: a, after: b });
  };
  walk(before, after, []);
  return out;
}

export interface RunComparison {
  beforeCount: number;
  afterCount: number;
  entries: DiffEntry[];
  identical: boolean;
}

/** Compare two item lists by position (item json only). */
export function compareItems(before: Item[], after: Item[]): RunComparison {
  const entries = diffJson(
    before.map((i) => i.json),
    after.map((i) => i.json),
  );
  return { beforeCount: before.length, afterCount: after.length, entries, identical: entries.length === 0 };
}
