/**
 * Rules and text of a parameter the model defines through `$fromAI` (P5-75). The value is a data
 * placeholder for the tool call, written with `FROM_AI_MARKER` so it reads back. Nothing here
 * evaluates the expression: the text is built and read as plain strings.
 */
import {
  FROM_AI_MARKER,
  type FromAiArgument,
  isToolNode,
  type NodeParameters,
  type NodeProperty,
  type NodeTypeDescription,
} from '@workflow/workflow';
import type { ParameterPath } from './workflow-ops';

export interface FromAiOverrideValue {
  key: string;
  description: string;
  type: FromAiArgument['type'];
}

/** nodes whose parameters the model never defines */
const DENIED_NODE_TYPES = new Set(['ai.toolCode', 'ai.toolHttpRequest', 'ai.mcpClientTool']);
/** top-level parameters that name or describe the tool itself */
const DENIED_PATHS = new Set(['toolName', 'description', 'toolDescription']);
/** parameter types an expression can hold and the model may fill (never `options` or `credentialsSelect`) */
const ALLOWED_TYPES = new Set<NodeProperty['type']>([
  'string',
  'number',
  'boolean',
  'multiOptions',
  'json',
  'color',
  'dateTime',
  'resourceLocator',
]);
const KEY_LENGTH = 63;
const TYPES: ReadonlyArray<FromAiArgument['type']> = ['string', 'number', 'boolean', 'json'];

/** whether the override button shows for this parameter of this node type */
export function canUseFromAiOverride(
  description: NodeTypeDescription | undefined,
  prop: NodeProperty,
  path: ParameterPath,
): boolean {
  if (!description || !isToolNode(description)) return false;
  const categories = description.categories ?? [];
  if (!categories.includes('AI') || !categories.includes('Tools')) return false;
  if (DENIED_NODE_TYPES.has(description.name) || description.name.startsWith('ai.vectorStore')) return false;
  if (path.length === 1 && DENIED_PATHS.has(String(path[0]))) return false;
  if (prop.noDataExpression || prop.type === 'credentialsSelect' || prop.type === 'options') return false;
  return ALLOWED_TYPES.has(prop.type);
}

/** the `$fromAI` key of a parameter path: `[^a-zA-Z0-9-]` becomes `_`, at most 63 characters */
export function fromAiKeyFromPath(path: ParameterPath): string {
  return path
    .join('_')
    .replace(/[^a-zA-Z0-9-]/g, '_')
    .slice(0, KEY_LENGTH);
}

/** the `$fromAI` type of a parameter: number, boolean, json, else string */
export function fromAiTypeOf(prop: NodeProperty): FromAiArgument['type'] {
  if (prop.type === 'number') return 'number';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'json') return 'json';
  return 'string';
}

type Quote = "'" | '"' | '`';
const QUOTES: Quote[] = ["'", '"', '`'];

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** the quote that needs the fewest escapes in all the texts (a backtick also counts `${`) */
function bestQuote(texts: string[]): Quote {
  const joined = texts.join('\n');
  let best: Quote = "'";
  let fewest = Number.POSITIVE_INFINITY;
  for (const quote of QUOTES) {
    const cost = countOf(joined, quote) + (quote === '`' ? countOf(joined, '${') : 0);
    if (cost < fewest) {
      best = quote;
      fewest = cost;
    }
  }
  return best;
}

function quoted(text: string, quote: Quote): string {
  let out = text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r');
  if (quote !== '`') out = out.replace(/\n/g, '\\n');
  out = out.split(quote).join(`\\${quote}`);
  if (quote === '`') out = out.replace(/\$\{/g, '\\${');
  return `${quote}${out}${quote}`;
}

/** the expression: `FROM_AI_MARKER`, then `$fromAI('Key', 'description', 'type')`, best quote and escaping */
export function buildFromAiOverride(override: FromAiOverrideValue): string {
  const { key, description, type } = override;
  const quote = bestQuote([key, description, type]);
  const args = [key, description, type].map((text) => quoted(text, quote)).join(', ');
  return `={{ ${FROM_AI_MARKER} $fromAI(${args}) }}`;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** one string literal at `from`: the text and the index after it, or null */
function readLiteral(source: string, from: number): { text: string; end: number } | null {
  const quote = source[from];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let text = '';
  for (let i = from + 1; i < source.length; i++) {
    const char = source[i];
    if (char === quote) return { text, end: i + 1 };
    if (quote === '`' && char === '$' && source[i + 1] === '{') return null;
    if (char !== '\\') {
      text += char;
      continue;
    }
    i++;
    if (i >= source.length) return null;
    const next = source[i];
    text += ESCAPES[next] ?? next;
  }
  return null;
}

function skipSpace(source: string, from: number): number {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/** reads a value written by `buildFromAiOverride`; null for anything else */
export function parseFromAiOverride(value: unknown): FromAiOverrideValue | null {
  let source: unknown = value;
  if (source && typeof source === 'object' && (source as { __rl?: unknown }).__rl) {
    source = (source as { value?: unknown }).value;
  }
  if (typeof source !== 'string') return null;
  const head = /^=\{\{\s*/.exec(source);
  if (!head) return null;
  let i = head[0].length;
  if (!source.startsWith(FROM_AI_MARKER, i)) return null;
  i = skipSpace(source, i + FROM_AI_MARKER.length);
  if (!source.startsWith('$fromAI(', i)) return null;
  i += '$fromAI('.length;
  const args: string[] = [];
  while (args.length < 3) {
    i = skipSpace(source, i);
    const literal = readLiteral(source, i);
    if (!literal) return null;
    args.push(literal.text);
    i = skipSpace(source, literal.end);
    if (source[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  if (source[i] !== ')') return null;
  i = skipSpace(source, i + 1);
  if (source.slice(i).trim() !== '}}') return null;
  const [key, description = '', type = 'string'] = args;
  if (!key || !TYPES.includes(type as FromAiArgument['type'])) return null;
  return { key, description, type: type as FromAiArgument['type'] };
}

function reconcile(value: unknown, path: ParameterPath): unknown {
  if (typeof value === 'string' || (value && typeof value === 'object' && '__rl' in value)) {
    const parsed = parseFromAiOverride(value);
    if (!parsed) return value;
    const key = fromAiKeyFromPath(path);
    if (parsed.key === key) return value;
    const text = buildFromAiOverride({ ...parsed, key });
    return typeof value === 'string' ? text : { ...(value as object), value: text };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const after = reconcile(item, [...path, index]);
      if (after !== item) changed = true;
      return after;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      const after = reconcile(item, [...path, name]);
      if (after !== item) changed = true;
      next[name] = after;
    }
    return changed ? next : value;
  }
  return value;
}

/** after list rows move: every override's key follows its new path (the same object when nothing changed) */
export function reconcileFromAiKeys(parameters: NodeParameters): NodeParameters {
  return reconcile(parameters, []) as NodeParameters;
}
