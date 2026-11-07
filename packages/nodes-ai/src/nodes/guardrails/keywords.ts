/** Guardrails keyword and custom-regex checks. Every user pattern goes through `createSafeRegExp`. */
import { createSafeRegExp } from '@workflow/workflow';
import type { Span } from './pii';

const TRAILING_PUNCTUATION = /[\s.,;:!?'")\]}]+$/u;
const MAX_MATCHES = 10_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

/** Keywords from a comma list: trimmed, trailing punctuation dropped, empty entries removed. */
export function parseKeywords(list: string): string[] {
  return [
    ...new Set(
      list
        .split(',')
        .map((word) => word.trim().replace(TRAILING_PUNCTUATION, ''))
        .filter(Boolean),
    ),
  ];
}

/** The keywords found in the text (as configured, each once): case-insensitive, whole words, literal. */
export function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const found: string[] = [];
  for (const keyword of keywords) {
    const pattern = createSafeRegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}_])`, 'iu');
    if (pattern.test(text)) found.push(keyword);
  }
  return found;
}

/** `/text/flags` or a bare pattern. Flags other than i m s u are dropped; g is always on. */
export function parseRegexSpec(spec: string): { source: string; flags: string } {
  const trimmed = spec.trim();
  const written = /^\/(.+)\/([a-z]*)$/su.exec(trimmed);
  const source = written ? written[1] : trimmed;
  const flags = new Set(['g']);
  for (const flag of written?.[2] ?? '') if ('imsu'.includes(flag)) flags.add(flag);
  return { source, flags: [...flags].join('') };
}

/** Offsets of every match of a user regex. Throws when the pattern is invalid or could backtrack badly. */
export function findRegexMatches(text: string, spec: string, type: string): Span[] {
  const { source, flags } = parseRegexSpec(spec);
  if (!source) return [];
  const pattern = createSafeRegExp(source, flags);
  const spans: Span[] = [];
  for (let match = pattern.exec(text); match && spans.length < MAX_MATCHES; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    spans.push({ type, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}
