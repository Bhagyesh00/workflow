/**
 * P6-74, P6-78 (C0, final): replace known UUIDs anywhere in a value, in one pass. Used by the source control id map
 * (`SyncIdMap.rewriteDefinition`, L3) and the workflow import command (L11), so credential refs, sub-workflow ids,
 * data table ids, the error workflow and ids inside expressions all map with no per-node list.
 *
 * Every string value in `value` (nested in arrays and plain objects, keys left as they are) is scanned once; each
 * UUID that `lookup` maps (asked with the lower-case form) is replaced by the mapped id, any other text passes
 * unchanged. A replaced id is never scanned again. The input is never changed: arrays and plain objects are copied,
 * other objects (a Date, a Buffer) are kept by reference. No I/O.
 */

const UUID =
  /(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])/g;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function rewriteUuids<T>(value: T, lookup: (id: string) => string | undefined): T {
  const seen = new Map<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return current.replace(UUID, (match) => lookup(match.toLowerCase()) ?? match);
    }
    if (current === null || typeof current !== 'object') return current;
    const done = seen.get(current);
    if (done !== undefined) return done;
    if (Array.isArray(current)) {
      const out: unknown[] = [];
      seen.set(current, out);
      for (const item of current) out.push(visit(item));
      return out;
    }
    if (!isPlainObject(current)) return current;
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(current));
    seen.set(current, out);
    for (const [key, item] of Object.entries(current)) {
      // defineProperty, so an own `__proto__` key (from JSON.parse) stays a key and never sets the prototype
      Object.defineProperty(out, key, {
        value: visit(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return visit(value) as T;
}
