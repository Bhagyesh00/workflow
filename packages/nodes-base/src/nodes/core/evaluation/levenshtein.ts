/**
 * Edit distance between two texts (insert, delete, replace; each costs 1), counted in whole characters
 * (code points), so an emoji is one edit and not two. Two rows of memory.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, n) => n);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/** 1 for equal texts, 0 for nothing in common: 1 - distance / length of the longer text; two empty texts give 1 */
export function similarity(a: string, b: string): number {
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}
