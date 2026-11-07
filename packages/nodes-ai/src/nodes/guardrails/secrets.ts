/** Guardrails secret-key check: word prefixes plus length, character mix and entropy by level. */
import type { Span } from './pii';

export type SecretLevel = 'strict' | 'balanced' | 'permissive';

const VENDOR_PREFIXES = ['sk-', 'sk_', 'pk_', 'pk-', 'ghp_', 'AKIA', 'xox', 'SG.', 'hf_'];
const GENERIC_PREFIXES = ['key-', 'api-', 'apikey-', 'token-', 'secret-', 'SHA:'];
const FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'sql',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'zip',
  'gz',
  'tar',
  'log',
  'ini',
  'toml',
  'conf',
]);

const LEVELS: Record<
  SecretLevel,
  { minLength: number; minDiversity: number; minEntropy: number; allowList: boolean }
> = {
  strict: { minLength: 10, minDiversity: 2, minEntropy: 3.0, allowList: false },
  balanced: { minLength: 10, minDiversity: 3, minEntropy: 3.8, allowList: true },
  permissive: { minLength: 30, minDiversity: 2, minEntropy: 4.0, allowList: true },
};

function entropy(word: string): number {
  const counts = new Map<string, number>();
  let length = 0;
  for (const ch of word) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    length++;
  }
  let sum = 0;
  for (const count of counts.values()) {
    const p = count / length;
    sum -= p * Math.log2(p);
  }
  return sum;
}

function diversity(word: string): number {
  return (
    Number(/[a-z]/.test(word)) +
    Number(/[A-Z]/.test(word)) +
    Number(/\d/.test(word)) +
    Number(/[^A-Za-z0-9]/.test(word))
  );
}

function isPlainUrl(word: string): boolean {
  return /^[a-z][a-z0-9+.-]{1,15}:\/\/\S+$/i.test(word);
}

function hasFileExtension(word: string): boolean {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(word);
  return match ? FILE_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

function looksSecret(word: string, level: SecretLevel): boolean {
  if (VENDOR_PREFIXES.some((prefix) => word.startsWith(prefix))) return true;
  const rule = LEVELS[level];
  if (rule.allowList && (isPlainUrl(word) || hasFileExtension(word))) return false;
  if (GENERIC_PREFIXES.some((prefix) => word.startsWith(prefix))) return true;
  return (
    [...word].length >= rule.minLength &&
    diversity(word) >= rule.minDiversity &&
    entropy(word) >= rule.minEntropy
  );
}

/** Offsets of the words that look like keys, tokens or secrets (`*` and `#` around a word are skipped). */
export function detectSecrets(text: string, level: SecretLevel): Span[] {
  const words: Array<{ word: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const lead = raw.length - raw.replace(/^[*#]+/, '').length;
    const word = raw.slice(lead).replace(/[*#]+$/, '');
    if (!word) continue;
    words.push({ word, start: match.index + lead, end: match.index + lead + word.length });
  }
  const spans: Span[] = [];
  words.forEach(({ word, start, end }, i) => {
    if (word === 'Bearer') {
      const next = words[i + 1];
      if (next) spans.push({ type: 'SECRET', start: next.start, end: next.end });
      return;
    }
    if (looksSecret(word, level)) spans.push({ type: 'SECRET', start, end });
  });
  return spans;
}
