/**
 * Token-based splitting with the cl100k_base encoding (pure JS, no network). The rank table is big, so
 * it loads once, lazily, the first time a token splitter runs.
 *
 * Byte-pair encoding of one unbroken run costs about the square of its length in bytes: roughly 0.1 ms
 * per character for 400 characters of "a", and 0.9 ms per character for 400 CJK characters (real CJK
 * prose has no spaces, so its runs are long). To keep the work bounded, a run is encoded for real only
 * when it is at most RUN_BYTES long, and only while the squares of the encoded run lengths add up to
 * less than WORK_LIMIT (about 1 to 2 seconds of encoding in the worst case; ordinary English stays
 * under it for about 600 KB). Every other run is estimated instead: 4 ASCII characters or one other character
 * count as one token. That is a cheap guess that keeps the cost linear for any input.
 */
import type { Tiktoken } from 'js-tiktoken/lite';

export interface TokenSplitOptions {
  chunkSize: number;
  chunkOverlap: number;
}

/** longest run, in UTF-8 bytes, that is encoded for real */
const RUN_BYTES = 48;
/** sum of the squared lengths (bytes) of the runs that may be encoded for real in one text */
const WORK_LIMIT = 4_000_000;
const ASCII_CHARS_PER_TOKEN = 4;
const RUNS = /\S+|\s+/gu;

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
    let end = start;
    if (run.charCodeAt(start) < 0x80) {
      const limit = Math.min(run.length, start + ASCII_CHARS_PER_TOKEN);
      while (end < limit && run.charCodeAt(end) < 0x80) end += 1;
    } else {
      // one token for a non-ASCII character; never cut a surrogate pair in two
      end = start + (run.codePointAt(start)! > 0xffff ? 2 : 1);
    }
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
  let work = 0;
  for (const match of text.matchAll(RUNS)) {
    const run = match[0];
    const bytes = Buffer.byteLength(run);
    if (bytes <= RUN_BYTES && work + bytes * bytes <= WORK_LIMIT) {
      work += bytes * bytes;
      continue;
    }
    const at = match.index ?? 0;
    encode(text.slice(last, at));
    estimateUnits(run, units);
    last = at + run.length;
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
