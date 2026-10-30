/** Small helpers shared by the AI nodes. */
import type { AiChatMessage, AiContentPart, DataObject } from '@workflow/workflow';

/** Text of a message; image parts are dropped. */
export function messageText(content: AiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Tool names must match `[a-zA-Z0-9_-]{1,64}` for every provider. */
export function toToolName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'tool').slice(0, 64);
}

/** Stringify a tool result for the model. */
export function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Pull a JSON value out of model output: accepts bare JSON, ```json fenced blocks and
 * JSON surrounded by prose. Throws when nothing parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* try the other shapes */
  }
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error('The model response is not valid JSON');
}

/** Run `fn` over `items` with at most `limit` promises in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fill `{placeholder}` markers in a prompt template. Unknown markers are left as they are. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}

/** Normalise a `fixedCollection` value (`{ values: [...] }`) to its list. */
export function collectionList<T = DataObject>(value: unknown, key: string): T[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as DataObject)[key];
  return Array.isArray(list) ? (list as T[]) : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Abort signal that fires on `signal` or after `ms` milliseconds. */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number | undefined,
): AbortSignal | undefined {
  if (!ms || ms <= 0) return signal;
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Race a promise against an abort signal (for work that cannot be cancelled itself). */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason.name === 'TimeoutError' ? new Error('The operation timed out') : reason;
  }
  return new Error('The operation was aborted');
}

/**
 * Secret patterns removed before conversation text is persisted to agent memory
 * (security rule S4: no credentials in run data or memory).
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const scheme = /^(Bearer|Basic)\s/.exec(match)?.[1];
      return scheme ? `${scheme} [redacted]` : '[redacted]';
    });
  }
  return out;
}
