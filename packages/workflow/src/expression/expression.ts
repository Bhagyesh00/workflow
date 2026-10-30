/**
 * Parameter-level expression resolution.
 *
 * A parameter value is an expression when it is a string starting with `=`. The rest is a template
 * where `{{ code }}` segments are evaluated:
 *   `={{ $json.total }}`              -> raw value (number, object, ...)
 *   `=Hello {{ $json.name }}!`        -> string
 */
import { DateTime } from 'luxon';
import { ExpressionError } from '../errors';
import { createDataProxy, type ExpressionDataContext } from './data-proxy';
import { findExtension } from './extensions';
import { baseGlobals } from './globals';
import { Interpreter, type InterpreterOptions, LIMITS } from './interpreter';

export type TemplateSegment = { type: 'text'; value: string } | { type: 'code'; value: string };

export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

/** Split a template into literal text and `{{ }}` code segments (brace- and string-aware). */
export function splitTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let i = 0;
  let text = '';
  while (i < template.length) {
    if (template[i] === '{' && template[i + 1] === '{') {
      const start = i + 2;
      let depth = 0;
      let j = start;
      let quote: string | null = null;
      let closed = false;
      while (j < template.length) {
        const ch = template[j];
        if (quote) {
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === quote) quote = null;
          j++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          if (depth === 0 && template[j + 1] === '}') {
            closed = true;
            break;
          }
          depth--;
        }
        j++;
      }
      if (!closed) {
        text += template.slice(i);
        break;
      }
      if (text) segments.push({ type: 'text', value: text });
      text = '';
      segments.push({ type: 'code', value: template.slice(start, j) });
      i = j + 2;
      continue;
    }
    text += template[i];
    i++;
  }
  if (text) segments.push({ type: 'text', value: text });
  return segments;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (DateTime.isDateTime(value)) return value.toISO() ?? '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * The text of a mixed template. Each piece is charged to the evaluation's budget, so segments that
 * return the same large value (input data costs the evaluation nothing) cannot build a huge string.
 */
function joinSegments(
  interpreter: Interpreter,
  segments: TemplateSegment[],
  run: (code: string) => unknown,
): string {
  let length = 0;
  const pieces: string[] = [];
  for (const s of segments) {
    const text = s.type === 'text' ? s.value : stringifyValue(run(s.value));
    length += text.length;
    if (length > LIMITS.maxStringLength)
      throw new ExpressionError('String exceeds the maximum allowed length');
    interpreter.chargeOutput(text.length);
    pieces.push(text);
  }
  return pieces.join('');
}

export interface ResolveOptions extends InterpreterOptions {
  /** return a string even when the template is a single `{{ }}` segment */
  forceString?: boolean;
}

export class ExpressionEvaluator {
  constructor(private readonly options: InterpreterOptions = {}) {}

  /** Evaluate one expression string (with or without the leading `=`). */
  evaluate(expression: string, ctx: ExpressionDataContext, options: ResolveOptions = {}): unknown {
    const template = expression.startsWith('=') ? expression.slice(1) : expression;
    const segments = splitTemplate(template);
    if (segments.length === 0) return '';

    const data = createDataProxy(ctx);
    const interpreter = new Interpreter(
      { ...baseGlobals, ...data },
      // item and parameter data belong to this execution: expressions may change them, as in n8n
      { ...this.options, ...options, extensions: findExtension, dataGlobals: Object.keys(data) },
    );

    let started = false;
    const run = (code: string) => {
      if (!code.trim()) return undefined;
      try {
        // the segments of one template share one budget
        const continued = started;
        started = true;
        return interpreter.evaluate(code, continued);
      } catch (error) {
        if (error instanceof ExpressionError) {
          error.context.expression = code.trim();
          error.context.node = ctx.activeNodeName;
          error.context.itemIndex = ctx.itemIndex;
          throw error;
        }
        const e = new ExpressionError((error as Error)?.message ?? String(error), { cause: error });
        e.context = { expression: code.trim(), node: ctx.activeNodeName, itemIndex: ctx.itemIndex };
        throw e;
      }
    };

    if (segments.length === 1 && segments[0].type === 'code' && !options.forceString) {
      return run(segments[0].value);
    }
    return joinSegments(interpreter, segments, run);
  }

  /** Resolve a parameter value recursively (objects/arrays may contain expressions). */
  resolve(value: unknown, ctx: ExpressionDataContext, options: ResolveOptions = {}): unknown {
    if (isExpression(value)) return this.evaluate(value, ctx, options);
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, ctx, options));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.resolve(v, ctx, options);
      return out;
    }
    return value;
  }
}

/** Evaluate a stand-alone expression against a plain variable map (descriptions, credentials). */
export function evaluateSimple(
  expression: string,
  variables: Record<string, unknown>,
  options: InterpreterOptions = {},
): unknown {
  const template = expression.startsWith('=') ? expression.slice(1) : expression;
  const segments = splitTemplate(template);
  const interpreter = new Interpreter(
    { ...baseGlobals, ...variables },
    { ...options, extensions: findExtension },
  );
  if (segments.length === 1 && segments[0].type === 'code') return interpreter.evaluate(segments[0].value);
  let started = false;
  return joinSegments(interpreter, segments, (code) => {
    const continued = started;
    started = true;
    return interpreter.evaluate(code, continued);
  });
}
