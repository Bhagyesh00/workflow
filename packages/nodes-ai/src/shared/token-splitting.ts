/**
 * Token-based splitting with the cl100k_base encoding (pure JS, no network). The rank table is big, so
 * it loads once, lazily, the first time a token splitter runs.
 *
 * Byte-pair encoding of one very long unbroken run (a megabyte of "a", a long base64 blob, a wall of
 * spaces) is quadratic in the run length. Runs longer than RUN_LIMIT characters are therefore not
 * encoded: they count as one token per CHARS_PER_TOKEN characters, a cheap estimate that keeps the CPU
 * cost linear. Everything else is encoded for real.
 */
import type { Tiktoken } from 'js-tiktoken/lite';

export interface TokenSplitOptions {
  chunkSize: number;
  chunkOverlap: number;
}

const RUN_LIMIT = 400;
const CHARS_PER_TOKEN = 4;
const LONG_RUN = new RegExp(`\\S{${RUN_LIMIT + 1},}|\\s{${RUN_LIMIT + 1},}`, 'gu');

let encoder: Promise<Tiktoken> | undefined;

function loadEncoder(): Promise<Tiktoken> {
  encoder ??= (async () => {
    const [{ Tiktoken: Encoding }, ranks] = await Promise.all([
      import('js-tiktoken/lite'),
      import('js-tiktoken/ranks/cl100k_base'),
    ]);
    return new Encoding(ranks.default);
  })().catch((error) => {
    encoder = undefined;
    throw error;
  });
  return encoder;
}

/** A real token id, or a run of text standing for one estimated token. */
type Unit = number | string;

function checkOptions({ chunkSize, chunkOverlap }: TokenSplitOptions): void {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) throw new Error('Chunk size must be at least 1');
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0) throw new Error('Chunk overlap cannot be negative');
  if (chunkOverlap >= chunkSize) throw new Error('Chunk overlap must be smaller than the chunk size');
}

function estimateUnits(run: string, units: Unit[]): void {
  let start = 0;
  while (start < run.length) {
    let end = Math.min(run.length, start + CHARS_PER_TOKEN);
    const last = run.charCodeAt(end - 1);
    // never cut a surrogate pair in two
    if (end < run.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    units.push(run.slice(start, end));
    start = end;
  }
}

function toUnits(text: string, enc: Tiktoken): Unit[] {
  const units: Unit[] = [];
  const encode = (part: string) => {
    if (!part) return;
    for (const id of enc.encode(part, 'all')) units.push(id);
  };
  let last = 0;
  for (const match of text.matchAll(LONG_RUN)) {
    const at = match.index ?? 0;
    encode(text.slice(last, at));
    estimateUnits(match[0], units);
    last = at + match[0].length;
  }
  encode(text.slice(last));
  return units;
}

function render(units: Unit[], from: number, to: number, enc: Tiktoken): string {
  let out = '';
  let ids: number[] = [];
  for (let i = from; i < to; i++) {
    const unit = units[i];
    if (typeof unit === 'number') {
      ids.push(unit);
    } else {
      if (ids.length) out += enc.decode(ids);
      ids = [];
      out += unit;
    }
  }
  if (ids.length) out += enc.decode(ids);
  return out;
}

/** Token count of `text` (estimated for very long unbroken runs). */
export async function countTokens(text: string): Promise<number> {
  const enc = await loadEncoder();
  return toUnits(text, enc).length;
}

/** Split into chunks of at most `chunkSize` tokens, each starting `chunkSize - chunkOverlap` tokens after the last. */
export async function splitByTokens(text: string, options: TokenSplitOptions): Promise<string[]> {
  checkOptions(options);
  const enc = await loadEncoder();
  const units = toUnits(text, enc);
  const chunks: string[] = [];
  const step = options.chunkSize - options.chunkOverlap;
  for (let start = 0; start < units.length; start += step) {
    const end = Math.min(units.length, start + options.chunkSize);
    chunks.push(render(units, start, end, enc));
    if (end >= units.length) break;
  }
  return chunks;
}
