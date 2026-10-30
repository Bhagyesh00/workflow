/**
 * Text splitting: a separator-based splitter and the recursive splitter that tries separators
 * from coarse (paragraphs) to fine (characters) until every chunk fits `chunkSize`.
 */

export interface SplitOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

function checkOptions({ chunkSize, chunkOverlap }: SplitOptions): void {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) throw new Error('Chunk size must be at least 1');
  if (chunkOverlap < 0) throw new Error('Chunk overlap cannot be negative');
  if (chunkOverlap >= chunkSize) throw new Error('Chunk overlap must be smaller than the chunk size');
}

/** Join small pieces into chunks up to `chunkSize`, carrying `chunkOverlap` characters forward. */
export function mergeSplits(splits: string[], separator: string, options: SplitOptions): string[] {
  const { chunkSize, chunkOverlap } = options;
  const chunks: string[] = [];
  const current: string[] = [];
  let total = 0;
  const join = (parts: string[]) => parts.join(separator).trim();
  for (const piece of splits) {
    const extra = current.length ? separator.length : 0;
    if (total + piece.length + extra > chunkSize && current.length) {
      const chunk = join(current);
      if (chunk) chunks.push(chunk);
      // drop pieces from the front until what remains fits the overlap
      while (
        current.length &&
        (total > chunkOverlap ||
          (total + piece.length + (current.length ? separator.length : 0) > chunkSize && total > 0))
      ) {
        total -= current[0].length + (current.length > 1 ? separator.length : 0);
        current.shift();
      }
    }
    current.push(piece);
    total += piece.length + (current.length > 1 ? separator.length : 0);
  }
  const last = join(current);
  if (last) chunks.push(last);
  return chunks;
}

export function splitByCharacter(text: string, separator: string, options: SplitOptions): string[] {
  checkOptions(options);
  const pieces = separator ? text.split(separator) : [...text];
  return mergeSplits(
    pieces.filter((p) => p !== ''),
    separator,
    options,
  );
}

export function splitRecursively(
  text: string,
  options: SplitOptions,
  separators: string[] = DEFAULT_SEPARATORS,
): string[] {
  checkOptions(options);
  return recurse(text, separators, options);
}

function recurse(text: string, separators: string[], options: SplitOptions): string[] {
  let separator = separators[separators.length - 1] ?? '';
  let rest: string[] = [];
  for (let i = 0; i < separators.length; i++) {
    const candidate = separators[i];
    if (candidate === '' || text.includes(candidate)) {
      separator = candidate;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const pieces = (separator ? text.split(separator) : [...text]).filter((p) => p !== '');
  const chunks: string[] = [];
  let small: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= options.chunkSize) {
      small.push(piece);
      continue;
    }
    if (small.length) {
      chunks.push(...mergeSplits(small, separator, options));
      small = [];
    }
    if (rest.length) chunks.push(...recurse(piece, rest, options));
    else chunks.push(...hardSplit(piece, options));
  }
  if (small.length) chunks.push(...mergeSplits(small, separator, options));
  return chunks;
}

function hardSplit(text: string, { chunkSize, chunkOverlap }: SplitOptions): string[] {
  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - chunkOverlap);
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + chunkSize));
    if (start + chunkSize >= text.length) break;
  }
  return chunks;
}
