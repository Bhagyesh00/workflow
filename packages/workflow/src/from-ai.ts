/**
 * `$fromAI(key, description?, type?, defaultValue?)`: a parameter value the agent's model supplies when a
 * node runs as a tool. The values are data: nothing here evaluates them, and they are never re-read as
 * expressions.
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

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const FROM_AI_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'json']);
const FROM_AI_CALL = /\$fromAI\s*\(\s*/gi;
const QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);
const OPENING: ReadonlySet<string> = new Set(['(', '[', '{']);
const CLOSING: ReadonlySet<string> = new Set([')', ']', '}']);
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };

/** the index of the quote that closes the one at `start`, or -1 */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start]) return i;
  }
  return -1;
}

/** the text between the parentheses of a call whose arguments start at `start` */
function callArguments(text: string, start: number): string {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (QUOTES.has(char)) {
      i = closingQuote(text, i);
      if (i < 0) break;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return text.slice(start, i);
  }
  throw new FromAiError(`Unbalanced parentheses while parsing $fromAI call: ${text.slice(start)}`);
}

/** splits at the commas outside quotes and brackets; each part is trimmed */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (QUOTES.has(char)) {
      i = closingQuote(args, i);
      if (i < 0) break;
    } else if (OPENING.has(char)) depth++;
    else if (CLOSING.has(char)) depth--;
    else if (char === ',' && depth === 0) {
      parts.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(args.slice(from).trim());
  return parts;
}

/** a quoted literal as its text; anything else stays as written. Nothing is evaluated. */
function literalText(part: string | undefined): { text: string; quoted: boolean } {
  const raw = part ?? '';
  if (!QUOTES.has(raw[0]) || closingQuote(raw, 0) !== raw.length - 1) return { text: raw, quoted: false };
  const text = raw.slice(1, -1).replace(/\\([\s\S])/g, (_match, char: string) => ESCAPES[char] ?? char);
  return { text, quoted: true };
}

function fromJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** a number or boolean that does not parse is tried as JSON, then kept as text */
function parseDefault(part: string | undefined, type: FromAiArgument['type']): unknown {
  const { text, quoted } = literalText(part);
  if (text === '' || (text === 'undefined' && !quoted)) return undefined;
  if (type === 'string') return text;
  if (type === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  if (type === 'boolean' && /^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  return fromJson(text);
}

function parseCall(args: string): FromAiArgument {
  const [rawKey, rawDescription, rawType, rawDefault] = splitArguments(args);
  const key = literalText(rawKey).text;
  if (!key) throw new FromAiError('You must specify a key when using $fromAI()');
  if (!KEY_PATTERN.test(key)) {
    throw new FromAiError(`Parameter key \`${key}\` is invalid`, {
      description:
        'Invalid parameter key, must be between 1 and 64 characters long and only contain letters, numbers, underscores, and hyphens',
    });
  }
  const description = literalText(rawDescription).text;
  const type = (literalText(rawType).text || 'string').toLowerCase();
  if (!FROM_AI_TYPES.has(type)) {
    throw new FromAiError(`Failed to parse $fromAI arguments: ${args}: Invalid type: ${type}`);
  }
  const defaultValue = parseDefault(rawDefault, type as FromAiArgument['type']);
  return {
    key,
    ...(description ? { description } : {}),
    type: type as FromAiArgument['type'],
    ...(defaultValue === undefined ? {} : { defaultValue }),
  };
}

/** the calls in `text`; inside a call only its arguments that are not quoted text can hold another call */
function scanText(text: string, found: Map<string, FromAiArgument>): void {
  let end = 0;
  for (const match of text.matchAll(FROM_AI_CALL)) {
    if (match.index < end) continue;
    const start = match.index + match[0].length;
    const args = callArguments(text, start);
    end = start + args.length + 1;
    const call = parseCall(args);
    const earlier = found.get(call.key);
    if (earlier && (earlier.description !== call.description || earlier.type !== call.type)) {
      throw new FromAiError(`Duplicate key '${call.key}' found with different description or type`, {
        description: 'Ensure all $fromAI() calls with the same key have consistent descriptions and types',
      });
    }
    found.set(call.key, call);
    for (const part of splitArguments(args)) {
      if (!literalText(part).quoted) scanText(part, found);
    }
  }
}

function scanValue(value: unknown, found: Map<string, FromAiArgument>): void {
  if (typeof value === 'string') {
    scanText(value, found);
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) scanValue(child, found);
  }
}

/** Every `$fromAI` call in the strings of `parameters`, one entry per key. Nothing is evaluated. */
export function extractFromAiArguments(parameters: unknown): FromAiArgument[] {
  const found = new Map<string, FromAiArgument>();
  scanValue(parameters, found);
  return [...found.values()];
}

function propertySchema({ description, type, defaultValue }: FromAiArgument): JsonSchema {
  return {
    ...(type === 'json'
      ? {
          anyOf: [
            { type: 'object', minProperties: 1 },
            { type: 'array', items: {}, minItems: 1 },
          ],
        }
      : { type }),
    ...(description ? { description } : {}),
    ...(defaultValue === undefined ? {} : { default: defaultValue as JsonSchema[string] }),
  };
}

/** JSON Schema of the tool's arguments, built from `extractFromAiArguments` */
export function fromAiSchema(parameters: unknown): JsonSchema {
  const args = extractFromAiArguments(parameters);
  const required = args.filter((arg) => arg.defaultValue === undefined).map((arg) => arg.key);
  return {
    type: 'object',
    // fromEntries makes own properties, so a scanned key `__proto__` sets no prototype
    properties: Object.fromEntries(args.map((arg) => [arg.key, propertySchema(arg)])),
    ...(required.length ? { required } : {}),
  };
}

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
