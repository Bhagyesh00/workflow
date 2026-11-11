/**
 * What the CLI prints (P6-77). `--format table|json|id-only` (json when stdout is not a terminal), `--json`,
 * `--quiet`, `--no-header` and `--pick <path>` (a dotted path such as `data[0].id` or `[].name`, applied before
 * the format). Cell text has control characters replaced, so an API value cannot drive the terminal.
 */
import { type Args, flagOn, flagText, UsageError } from './args';

export type Format = 'table' | 'json' | 'id-only';

export interface OutputOptions {
  format: Format;
  quiet: boolean;
  header: boolean;
  pick?: string;
}

const FORMATS: readonly string[] = ['table', 'json', 'id-only'];

export function outputOptions(args: Args, isTTY: boolean): OutputOptions {
  const named = flagText(args, 'format');
  if (named !== undefined && !FORMATS.includes(named)) {
    throw new UsageError(`--format must be one of: ${FORMATS.join(', ')}`);
  }
  const format: Format = flagOn(args, 'json')
    ? 'json'
    : ((named as Format | undefined) ?? (isTTY ? 'table' : 'json'));
  return {
    format,
    quiet: flagOn(args, 'quiet'),
    header: !flagOn(args, 'no-header'),
    pick: flagText(args, 'pick'),
  };
}

/** `a.b[0].c`, `[].id` (each item of an array), `data[]`; a missing step gives undefined */
export function pickPath(value: unknown, path: string): unknown {
  const steps = path.match(/[^.[\]]+|\[\]|\[\d+\]/g);
  if (!steps) throw new UsageError('--pick needs a path such as data[0].id or [].name');
  const walk = (current: unknown, index: number): unknown => {
    if (index === steps.length) return current;
    const step = steps[index];
    if (step === '[]') {
      return Array.isArray(current) ? current.map((item) => walk(item, index + 1)) : undefined;
    }
    if (/^\[\d+\]$/.test(step)) {
      return Array.isArray(current) ? walk(current[Number(step.slice(1, -1))], index + 1) : undefined;
    }
    if (current && typeof current === 'object' && !Array.isArray(current) && Object.hasOwn(current, step)) {
      return walk((current as Record<string, unknown>)[step], index + 1);
    }
    return undefined;
  };
  return walk(value, 0);
}

const CELL_MAX = 60;

function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'name' in v)) {
    text = value.map((v) => String((v as { name: unknown }).name)).join(',');
  } else text = JSON.stringify(value) ?? '';
  text = text.replace(/\p{Cc}/gu, ' ');
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
}

function table(rows: string[][], header: string[] | undefined): string {
  const all = header ? [header.map((h) => h.toUpperCase()), ...rows] : rows;
  const widths = all[0]?.map((_, col) => Math.max(...all.map((row) => row[col]?.length ?? 0))) ?? [];
  return `${all
    .map((row) =>
      row
        .map((text, col) => text.padEnd(widths[col]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** the text to print for `value` (always ends with a newline) */
export function render(value: unknown, options: OutputOptions, columns?: readonly string[]): string {
  const shown = options.pick ? pickPath(value, options.pick) : value;
  if (options.format === 'json') return `${JSON.stringify(shown ?? null, null, 2)}\n`;
  if (options.format === 'id-only') {
    const items = Array.isArray(shown) ? shown : [shown];
    const ids = items.map((item) => (isRecord(item) ? item.id : typeof item === 'string' ? item : undefined));
    if (ids.every((id) => typeof id === 'string' || typeof id === 'number')) {
      return ids.length ? `${ids.map((id) => cell(id)).join('\n')}\n` : '';
    }
    return `${JSON.stringify(shown ?? null, null, 2)}\n`;
  }
  if (Array.isArray(shown)) {
    if (!shown.length) return 'No results.\n';
    if (shown.every(isRecord)) {
      const keys = columns?.length
        ? [...columns]
        : [...new Set(shown.flatMap((row) => Object.keys(row)))].slice(0, 6);
      return table(
        shown.map((row) => keys.map((key) => cell(row[key]))),
        options.header ? keys : undefined,
      );
    }
    return `${shown.map(cell).join('\n')}\n`;
  }
  if (isRecord(shown)) {
    const keys = Object.keys(shown);
    if (!keys.length) return 'No results.\n';
    return table(
      keys.map((key) => [key, cell(shown[key])]),
      options.header ? ['field', 'value'] : undefined,
    );
  }
  return `${cell(shown)}\n`;
}
