/**
 * Node parameter schema helpers shared by the engine and the editor:
 * visibility (displayOptions) and default values.
 */
import type {
  DisplayOptions,
  NodeParameters,
  NodeProperty,
  NodePropertyCollection,
  NodePropertyOption,
  ResourceLocatorValue,
} from './interfaces';

function getPath(params: NodeParameters, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], params);
}

/**
 * Whether a property is visible given the sibling parameter values.
 * `rootParams` is used for `/name` (absolute) references.
 */
export function isParameterDisplayed(
  displayOptions: DisplayOptions | undefined,
  siblingParams: NodeParameters,
  options: { nodeVersion?: number; rootParams?: NodeParameters } = {},
): boolean {
  if (!displayOptions) return true;
  const lookupValue = (key: string): unknown => {
    if (key === '@version') return options.nodeVersion;
    if (key.startsWith('/')) return getPath(options.rootParams ?? siblingParams, key.slice(1));
    return getPath(siblingParams, key);
  };
  const matches = (value: unknown, allowed: unknown[]): boolean => {
    const values = Array.isArray(value) ? value : [value];
    return allowed.some((a) => {
      if (a && typeof a === 'object' && '_cnd' in (a as object)) {
        return values.some((v) => matchCondition(v, (a as { _cnd: Record<string, unknown> })._cnd));
      }
      return values.some((v) => v === a);
    });
  };
  if (displayOptions.show) {
    for (const [key, allowed] of Object.entries(displayOptions.show)) {
      if (!matches(lookupValue(key), allowed)) return false;
    }
  }
  if (displayOptions.hide) {
    for (const [key, denied] of Object.entries(displayOptions.hide)) {
      if (matches(lookupValue(key), denied)) return false;
    }
  }
  return true;
}

function matchCondition(value: unknown, cnd: Record<string, unknown>): boolean {
  const [op, target] = Object.entries(cnd)[0] ?? [];
  switch (op) {
    case 'eq':
      return value === target;
    case 'not':
      return value !== target;
    case 'gte':
      return Number(value) >= Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'gt':
      return Number(value) > Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'startsWith':
      return String(value).startsWith(String(target));
    case 'includes':
      return String(value).includes(String(target));
    case 'exists':
      return value !== undefined && value !== null;
    default:
      return false;
  }
}

function isCollectionOption(o: unknown): o is NodePropertyCollection {
  return Boolean(
    o && typeof o === 'object' && 'values' in o && Array.isArray((o as NodePropertyCollection).values),
  );
}

/**
 * Returns the effective parameters of a node: user values plus defaults for every visible
 * property, dropping values of hidden properties. Collections keep only user-set keys.
 */
export function resolveNodeParameters(
  properties: NodeProperty[],
  values: NodeParameters,
  options: { nodeVersion?: number; rootParams?: NodeParameters } = {},
): NodeParameters {
  const result: NodeParameters = {};
  const rootParams = options.rootParams ?? values;
  // two passes so that a property's visibility can depend on defaults of earlier properties
  const merged: NodeParameters = { ...values };
  for (const prop of properties) {
    if (!(prop.name in merged) && prop.type !== 'notice' && prop.type !== 'button') {
      merged[prop.name] = prop.default;
    }
  }
  for (const prop of properties) {
    if (prop.type === 'notice' || prop.type === 'button') continue;
    if (!isParameterDisplayed(prop.displayOptions, merged, { ...options, rootParams })) continue;
    const value = prop.name in values ? values[prop.name] : structuredCloneSafe(prop.default);
    if (prop.type === 'fixedCollection' && value && typeof value === 'object' && !isExpressionString(value)) {
      const out: NodeParameters = {};
      for (const option of prop.options ?? []) {
        if (!isCollectionOption(option)) continue;
        const entry = (value as NodeParameters)[option.name];
        if (entry === undefined) continue;
        if (Array.isArray(entry)) {
          out[option.name] = entry.map((e) =>
            resolveNodeParameters(option.values, (e ?? {}) as NodeParameters, { ...options, rootParams }),
          );
        } else {
          out[option.name] = resolveNodeParameters(option.values, (entry ?? {}) as NodeParameters, {
            ...options,
            rootParams,
          });
        }
      }
      result[prop.name] = out;
    } else {
      result[prop.name] = value;
    }
  }
  // keep values for which the schema has no property (forward compatibility)
  for (const [k, v] of Object.entries(values)) {
    if (!(k in result) && !properties.some((p) => p.name === k)) result[k] = v;
  }
  return result;
}

function isExpressionString(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('=');
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function isResourceLocatorValue(value: unknown): value is ResourceLocatorValue {
  return Boolean(value && typeof value === 'object' && (value as ResourceLocatorValue).__rl === true);
}

export function isOption(o: unknown): o is NodePropertyOption {
  return Boolean(o && typeof o === 'object' && 'value' in o && !('type' in o));
}

/** Locate a (possibly nested) property definition by dotted path, e.g. `options.timeout`. */
export function findProperty(properties: NodeProperty[], path: string): NodeProperty | undefined {
  const [head, ...rest] = path.split('.');
  const prop = properties.find((p) => p.name === head);
  if (!prop || rest.length === 0) return prop;
  const nested = (prop.options ?? []).flatMap((o) => {
    if (isCollectionOption(o)) return o.name === rest[0] ? o.values : [];
    if (o && typeof o === 'object' && 'type' in o) return [o as NodeProperty];
    return [];
  });
  if (prop.type === 'fixedCollection') return findProperty(nested, rest.slice(1).join('.'));
  return findProperty(nested, rest.join('.'));
}
