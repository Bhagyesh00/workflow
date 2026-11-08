/**
 * What an outside MCP server may tell the Assistant's model (P5-72, lane L9). A tool description, a field
 * description, a schema and a result are text the server controls, so each is cleaned before the model
 * reads it: invisible Unicode and control characters removed, padding made of blank lines collapsed,
 * lengths capped, and a schema that is too deep, too wide or too large dropped with a reason. Names a
 * server picks are turned into `mcp_<connection>_<tool>` and checked.
 *
 * Pure functions, no I/O. Own code to the limits the plan names (n8n's rules, not its source).
 */
import type { JsonSchema } from '@workflow/workflow';

/** limits on what a server sends */
export const MCP_LIMITS = {
  toolDescriptionChars: 16384,
  fieldDescriptionChars: 4096,
  schemaDepth: 32,
  schemaNodes: 1000,
  schemaProperties: 250,
  schemaUnionOptions: 100,
  schemaSerializedChars: 65536,
  toolNameChars: 64,
} as const;

/**
 * Invisible and format characters that can hide text from a person while the model still reads it:
 * soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer vowel inherents,
 * Mongolian free variation selectors, zero width and bidirectional controls, word joiner and the
 * invisible math operators, Hangul filler, variation selectors, byte order mark, interlinear
 * annotation, musical invisible controls, the tag block and the variation selector supplement.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

const codePoint = (value: number) => String.raw`\u{${value.toString(16)}}`;
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => (from === to ? codePoint(from) : `${codePoint(from)}-${codePoint(to)}`)).join('')}]`,
  'gu',
);

/** C0 and C1 control characters except tab and line feed (carriage returns are folded first) */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the list of control characters to remove
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** `text` without invisible Unicode and control characters (tab and line feed stay) */
export function stripInvisible(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '');
}

/**
 * A description for the model: invisible and control characters out, trailing space on every line out,
 * three or more line breaks in a row cut to one blank line (padding that pushes text out of view),
 * trimmed, and cut at `max` characters.
 */
export function sanitizeDescription(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  const cleaned = stripInvisible(text)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function sanitizeToolDescription(text: unknown): string {
  return sanitizeDescription(text, MCP_LIMITS.toolDescriptionChars);
}

export function sanitizeFieldDescription(text: unknown): string {
  return sanitizeDescription(text, MCP_LIMITS.fieldDescriptionChars);
}

/** a server's result text: invisible Unicode and control characters out (redaction is the caller's) */
export function sanitizeResultText(text: string): string {
  return stripInvisible(text);
}

export type SchemaVerdict = { ok: true; schema: JsonSchema } | { ok: false; reason: string };

const UNION_KEYS = ['anyOf', 'oneOf', 'allOf'];
const DESCRIPTION_KEYS = ['description', 'title'];

class SchemaTooBig extends Error {}

/**
 * A tool's input schema with every description cleaned, or the reason it is refused. Refused: not an
 * object schema, nesting deeper than 32, more than 1000 schema nodes, more than 250 properties in one
 * object, more than 100 options in one union, or more than 65536 characters serialized. The check on the
 * serialized size runs on the server's own text first, so a huge schema is never walked.
 */
export function sanitizeSchema(schema: unknown): SchemaVerdict {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'the input schema is not an object' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return { ok: false, reason: 'the input schema cannot be read' };
  }
  if (serialized.length > MCP_LIMITS.schemaSerializedChars) {
    return {
      ok: false,
      reason: `the input schema is larger than ${MCP_LIMITS.schemaSerializedChars} characters`,
    };
  }
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return stripInvisible(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > MCP_LIMITS.schemaDepth)
      throw new SchemaTooBig('the input schema is nested deeper than 32 levels');
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    nodes += 1;
    if (nodes > MCP_LIMITS.schemaNodes) {
      throw new SchemaTooBig(`the input schema has more than ${MCP_LIMITS.schemaNodes} nodes`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
        if (Object.keys(child).length > MCP_LIMITS.schemaProperties) {
          throw new SchemaTooBig(`the input schema has more than ${MCP_LIMITS.schemaProperties} properties`);
        }
      }
      if (UNION_KEYS.includes(key) && Array.isArray(child) && child.length > MCP_LIMITS.schemaUnionOptions) {
        throw new SchemaTooBig(
          `the input schema has more than ${MCP_LIMITS.schemaUnionOptions} union options`,
        );
      }
      if (DESCRIPTION_KEYS.includes(key) && typeof child === 'string') {
        out[key] = sanitizeFieldDescription(child);
      } else {
        out[key] = walk(child, depth + 1);
      }
    }
    return out;
  };
  try {
    const cleaned = walk(schema, 1) as JsonSchema;
    if (JSON.stringify(cleaned).length > MCP_LIMITS.schemaSerializedChars) {
      return {
        ok: false,
        reason: `the input schema is larger than ${MCP_LIMITS.schemaSerializedChars} characters`,
      };
    }
    return { ok: true, schema: cleaned };
  } catch (error) {
    if (error instanceof SchemaTooBig) return { ok: false, reason: error.message };
    throw error;
  }
}

/** the characters a provider accepts in a tool name */
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** a connection or tool name as one name part: other characters become `_`, repeats collapse, ends trimmed */
export function nameToken(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** the prefix of every tool of a connection, `mcp_<connection>_`; null when the name leaves nothing */
export function mcpToolPrefix(connectionName: string): string | null {
  const token = nameToken(connectionName);
  return token ? `mcp_${token}_` : null;
}

/**
 * `mcp_<connection>_<tool>`, validated: null when either part is empty, when the connection part leaves
 * no room, or when the result is not a valid tool name. A long tool part is cut to fit 64 characters.
 */
export function mcpToolName(connectionName: string, toolName: string): string | null {
  const prefix = mcpToolPrefix(connectionName);
  const tool = nameToken(toolName);
  if (!prefix || !tool) return null;
  const room = MCP_LIMITS.toolNameChars - prefix.length;
  if (room < 1) return null;
  const name = `${prefix}${tool.slice(0, room)}`;
  return MCP_TOOL_NAME_PATTERN.test(name) ? name : null;
}
