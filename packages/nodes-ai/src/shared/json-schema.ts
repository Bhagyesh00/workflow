/**
 * Minimal JSON Schema support for structured output: validation of model output, schema
 * inference from an example and per-provider schema dialects. No dynamic code, no `$ref`
 * resolution beyond local definitions.
 */
import type { DataObject, JsonSchema } from '@workflow/workflow';

export interface SchemaError {
  path: string;
  message: string;
}

const MAX_DEPTH = 64;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  const match = /^#\/(definitions|\$defs)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  return ((root[match[1]] as DataObject | undefined)?.[match[2]] as JsonSchema | undefined) ?? undefined;
}

/** Validate `value` against `schema`; returns an empty list when valid. */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(value, schema, root, '$', errors, 0);
  return errors;
}

function walk(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  errors: SchemaError[],
  depth: number,
) {
  if (depth > MAX_DEPTH) {
    errors.push({ path, message: 'schema is nested too deeply' });
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(root, schema.$ref);
    if (target) walk(value, target, root, path, errors, depth + 1);
    return;
  }
  const s = schema as Record<string, any>;

  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) {
    errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
  }
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({
      path,
      message: `must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`,
    });
  }
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const nullable = s.nullable === true && value === null;
    if (!nullable && !types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `must be ${types.join(' or ')}, got ${typeOf(value)}` });
      return;
    }
  }
  for (const sub of (s.allOf as JsonSchema[] | undefined) ?? [])
    walk(value, sub, root, path, errors, depth + 1);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = s[key] as JsonSchema[] | undefined;
    if (Array.isArray(options) && options.length) {
      const passing = options.filter((o) => validateJsonSchema(value, o, root).length === 0).length;
      if (key === 'anyOf' ? passing === 0 : passing !== 1) {
        errors.push({
          path,
          message: `must match ${key === 'anyOf' ? 'at least one' : 'exactly one'} allowed schema`,
        });
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      errors.push({ path, message: `must have at least ${s.minLength} characters` });
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      errors.push({ path, message: `must have at most ${s.maxLength} characters` });
    }
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern, 'u').test(value))
          errors.push({ path, message: `must match ${s.pattern}` });
      } catch {
        /* invalid pattern in the schema: ignore */
      }
    }
  } else if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      errors.push({ path, message: `must be >= ${s.minimum}` });
    if (typeof s.maximum === 'number' && value > s.maximum)
      errors.push({ path, message: `must be <= ${s.maximum}` });
  } else if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      errors.push({ path, message: `must have at least ${s.minItems} items` });
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      errors.push({ path, message: `must have at most ${s.maxItems} items` });
    }
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
      for (const [i, v] of value.entries()) walk(v, s.items, root, `${path}[${i}]`, errors, depth + 1);
    }
  } else if (value && typeof value === 'object') {
    const obj = value as DataObject;
    const properties = (s.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in obj) || obj[key] === undefined)
        errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (properties[key]) walk(v, properties[key], root, `${path}.${key}`, errors, depth + 1);
      else if (s.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'is not an allowed property' });
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        walk(v, s.additionalProperties, root, `${path}.${key}`, errors, depth + 1);
      }
    }
  }
}

export function formatSchemaErrors(errors: SchemaError[]): string {
  return errors
    .slice(0, 10)
    .map((e) => `${e.path} ${e.message}`)
    .join('; ');
}

/** Infer a schema from an example value: every key of an example object is required. */
export function schemaFromExample(example: unknown, depth = 0): JsonSchema {
  if (depth > MAX_DEPTH) return {};
  if (example === null) return { type: 'null' };
  if (Array.isArray(example)) {
    return { type: 'array', items: example.length ? schemaFromExample(example[0], depth + 1) : {} };
  }
  switch (typeof example) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const entries = Object.entries(example as DataObject);
      return {
        type: 'object',
        properties: Object.fromEntries(entries.map(([k, v]) => [k, schemaFromExample(v, depth + 1)])),
        required: entries.map(([k]) => k),
      };
    }
    default:
      return {};
  }
}

/** Parse a JSON value given as a parameter (string or already an object). */
export function parseJsonParameter(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Example JSON or explicit JSON schema parameters -> schema. */
export function schemaFromParameters(
  schemaType: string,
  example: unknown,
  manualSchema: unknown,
): JsonSchema {
  if (schemaType === 'manual') {
    const schema = parseJsonParameter(manualSchema, 'Input Schema');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('Input Schema must be a JSON schema object');
    }
    return schema as JsonSchema;
  }
  return schemaFromExample(parseJsonParameter(example, 'JSON Example'));
}

const UNSUPPORTED_BY_ANTHROPIC = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'dependencies',
  'if',
  'then',
  'else',
  'not',
  '$schema',
  '$id',
]);

/**
 * Schema for Anthropic structured outputs (`output_config.format`): every object needs
 * `additionalProperties: false` and numeric/string constraints are not accepted. Returns
 * undefined when the schema cannot be expressed (free-form objects), so callers fall back to
 * format instructions in the prompt.
 */
export function toAnthropicSchema(schema: JsonSchema): JsonSchema | undefined {
  let expressible = true;
  const convert = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      expressible = false;
      return {};
    }
    if (Array.isArray(node)) return node.map((n) => convert(n, depth + 1));
    if (!node || typeof node !== 'object') return node;
    const out: DataObject = {};
    for (const [key, value] of Object.entries(node as DataObject)) {
      if (UNSUPPORTED_BY_ANTHROPIC.has(key)) continue;
      if (key === 'properties' || key === '$defs' || key === 'definitions') {
        out[key] = Object.fromEntries(
          Object.entries((value ?? {}) as DataObject).map(([k, v]) => [k, convert(v, depth + 1)]),
        );
      } else out[key] = convert(value, depth + 1);
    }
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (types.includes('object')) {
      if (!out.properties || out.additionalProperties) expressible = false;
      out.additionalProperties = false;
    }
    return out;
  };
  const result = convert(schema, 0) as JsonSchema;
  return expressible ? result : undefined;
}

const GEMINI_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'propertyOrdering',
  'title',
]);

/** Gemini function declarations / response schemas accept an OpenAPI 3 subset. */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const convert = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object' || Array.isArray(node)) return node;
    const out: DataObject = {};
    for (const [key, value] of Object.entries(node as DataObject)) {
      if (!GEMINI_KEYS.has(key)) continue;
      if (key === 'properties') {
        out.properties = Object.fromEntries(
          Object.entries((value ?? {}) as DataObject).map(([k, v]) => [k, convert(v, depth + 1)]),
        );
      } else if (key === 'items') out.items = convert(value, depth + 1);
      else if (key === 'anyOf' && Array.isArray(value)) out.anyOf = value.map((v) => convert(v, depth + 1));
      else if (key === 'type' && Array.isArray(value)) {
        const types = value.filter((t) => t !== 'null');
        out.type = types[0] ?? 'string';
        if (types.length !== value.length) out.nullable = true;
      } else out[key] = value;
    }
    if (out.type === 'object' && out.properties && !Object.keys(out.properties as DataObject).length) {
      delete out.properties;
    }
    return out;
  };
  return convert(schema, 0) as JsonSchema;
}

/** True for schemas whose top level is an object (needed by providers' tool parameter slots). */
export function isObjectSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  const type = schema.type;
  return type === 'object' || (Array.isArray(type) && type.includes('object'));
}
