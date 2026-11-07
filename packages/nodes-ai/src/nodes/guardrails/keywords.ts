/**
 * Guardrails keyword and custom-regex checks. Every user pattern goes through `createSafeRegExp`.
 * A custom regex then runs in a worker thread with a time budget: the scan only refuses catastrophic
 * shapes, and an ordinary pattern can still take minutes on a long text.
 */
import { Worker } from 'node:worker_threads';
import { createSafeRegExp } from '@workflow/workflow';
import type { Span } from './pii';

const TRAILING_PUNCTUATION = /[\s.,;:!?'")\]}]+$/u;

/** how long one custom regex may run on one text; the worker's start does not count */
const REGEX_TIME_BUDGET_MS = 250;
/** a worker that has not started by now counts as a failed check */
const WORKER_START_LIMIT_MS = 10_000;

/** fixed source, run with the eval option so it needs no bundling; the pattern and the text are data */
const REGEX_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { source, flags, text } = workerData;
parentPort.postMessage({ started: true });
const pattern = new RegExp(source, flags);
const offsets = [];
for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
  if (match[0].length === 0) {
    pattern.lastIndex++;
    continue;
  }
  offsets.push(match.index, match.index + match[0].length);
}
parentPort.postMessage({ offsets });
`;

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

/**
 * `/text/flags` or a bare pattern. Anything after the last slash that is not made of valid flags makes
 * the whole value a bare pattern (`/api/users`). Flags other than i m s u are dropped; g is always on.
 */
export function parseRegexSpec(spec: string): { source: string; flags: string } {
  const trimmed = spec.trim();
  const written = /^\/(.+)\/([dgimsuvy]*)$/su.exec(trimmed);
  const source = written ? written[1] : trimmed;
  const flags = new Set(['g']);
  for (const flag of written?.[2] ?? '') if ('imsu'.includes(flag)) flags.add(flag);
  return { source, flags: [...flags].join('') };
}

/** Flat start and end offsets of every non-empty match. Rejects when the budget runs out; never blocks this thread. */
async function execInWorker(source: string, flags: string, text: string): Promise<number[]> {
  const worker = new Worker(REGEX_WORKER, {
    eval: true,
    env: {},
    execArgv: [],
    workerData: { source, flags, text },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<number[]>((resolve, reject) => {
      const tooSlow = () => reject(new Error(`Couldn't run the custom regex: it took too long`));
      const stopped = () => reject(new Error(`Couldn't run the custom regex: the check stopped`));
      timer = setTimeout(tooSlow, WORKER_START_LIMIT_MS);
      worker.on('message', (message: { offsets?: number[] }) => {
        if (message.offsets) {
          resolve(message.offsets);
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(tooSlow, REGEX_TIME_BUDGET_MS);
      });
      worker.on('error', stopped);
      worker.on('exit', stopped);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

/** Offsets of every match of a user regex. Rejects when the pattern is invalid, could backtrack badly or runs too long. */
export async function findRegexMatches(text: string, spec: string, type: string): Promise<Span[]> {
  const { source, flags } = parseRegexSpec(spec);
  if (!source || !text) return [];
  const pattern = createSafeRegExp(source, flags);
  const offsets = await execInWorker(pattern.source, pattern.flags, text);
  const spans: Span[] = [];
  for (let i = 0; i < offsets.length; i += 2) {
    spans.push({ type, start: offsets[i], end: offsets[i + 1] });
  }
  return spans;
}
