/**
 * `$fromAI(key, description?, type?, defaultValue?)`: a parameter value the agent's model supplies when a
 * node runs as a tool. The values are data: nothing here evaluates them, and they are never re-read as
 * expressions. The scanner and the schema are L2's.
 */
import type { JsonSchema } from './ai-types';
import { ExpressionError } from './errors';
import type { DataObject } from './interfaces';

/** starts a parameter value that "Let the model define this parameter" wrote */
export const FROM_AI_MARKER = '/*auto-generated-fromAI-override*/';

export interface FromAiArgument {
  key: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  defaultValue?: unknown;
}

export class FromAiError extends ExpressionError {}

/** Every `$fromAI` call in the strings of `parameters`, one entry per key. Nothing is evaluated. */
export function extractFromAiArguments(_parameters: unknown): FromAiArgument[] {
  throw new Error('not implemented (L2)');
}

/** JSON Schema of the tool's arguments, built from `extractFromAiArguments` */
export function fromAiSchema(_parameters: unknown): JsonSchema {
  throw new Error('not implemented (L2)');
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** names that would reach inherited members instead of a value; refused at run time only */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',
  'mainModule',
  'binding',
  '_linkedBinding',
  '_load',
  'prepareStackTrace',
  '__lookupGetter__',
  '__lookupSetter__',
  '__defineGetter__',
  '__defineSetter__',
  'caller',
  'callee',
  'arguments',
  'getBuiltinModule',
  'dlopen',
  'execve',
  'loadEnvFile',
]);

function ownValue(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads `source.query[key]`, then `source[key]`, then the default; own keys only. `description` and `type`
 * matter to the scanner, not here.
 */
export function fromAiValue(
  source: DataObject | undefined,
  key: unknown,
  _description?: unknown,
  _type?: unknown,
  defaultValue?: unknown,
): unknown {
  if (!key) throw new FromAiError("Add a key, e.g. $fromAI('placeholder_name')");
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new FromAiError(
      'Invalid parameter key, must be between 1 and 64 characters long and only contain lowercase letters, uppercase letters, numbers, underscores, and hyphens',
    );
  }
  if (RESERVED_KEYS.has(key)) throw new FromAiError('Invalid parameter key');
  if (!source) throw new FromAiError('No execution data available');
  return ownValue(ownValue(source, 'query'), key) ?? ownValue(source, key) ?? defaultValue;
}

/** the three spellings of `$fromAI`, bound to the arguments of one tool call */
export function fromAiVariables(args: DataObject): Record<string, unknown> {
  const read = (key: unknown, description?: unknown, type?: unknown, defaultValue?: unknown) =>
    fromAiValue(args, key, description, type, defaultValue);
  return { $fromAI: read, $fromAi: read, $fromai: read };
}
