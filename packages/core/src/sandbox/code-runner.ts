/**
 * Runs user JavaScript (Code node) inside a V8 isolate (isolated-vm).
 *
 * - Separate heap with a hard memory limit; the isolate is disposed after every run.
 * - No host objects are shared: input data is passed in as a JSON string and results come back
 *   as a JSON string. The only host callback is a string-only console sink.
 * - No network, filesystem, process or require inside the isolate.
 * - Wall-clock timeout covers async code; on timeout the isolate is disposed.
 *
 * Requires Node to run with `--no-node-snapshot`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type DataObject, type Item, isPlainObject } from '@workflow/workflow';
import ivm from 'isolated-vm';
import type { CodeRunner, CodeRunnerInput } from '../engine/services';

const require = createRequire(import.meta.url);
const LUXON_SOURCE = readFileSync(
  path.join(path.dirname(require.resolve('luxon/package.json')), 'build/global/luxon.min.js'),
  'utf8',
);

export class CodeExecutionError extends Error {
  constructor(
    message: string,
    readonly lineNumber?: number,
  ) {
    super(message);
    this.name = 'CodeExecutionError';
  }
}

export interface CodeRunnerOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  /** max size of the JSON payload passed into the isolate */
  maxPayloadBytes?: number;
}

const PRELUDE = `
"use strict";
const { DateTime, Duration, Interval } = luxon;
const __data = JSON.parse(__payload);
const __fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
const console = Object.freeze({
  log: (...a) => __console('log', JSON.stringify(a.map(__fmt))),
  info: (...a) => __console('info', JSON.stringify(a.map(__fmt))),
  warn: (...a) => __console('warn', JSON.stringify(a.map(__fmt))),
  error: (...a) => __console('error', JSON.stringify(a.map(__fmt))),
  debug: (...a) => __console('debug', JSON.stringify(a.map(__fmt))),
});
const items = __data.items;
const __node = (name) => {
  const out = __data.nodeOutputs[name];
  if (!out) throw new Error('Node "' + name + '" has not been executed or does not exist');
  return Object.freeze({ all: () => out, first: () => out[0], last: () => out[out.length - 1], isExecuted: true });
};
const $ = __node;
const $vars = Object.freeze(__data.variables);
const $workflow = Object.freeze(__data.workflow);
const $execution = Object.freeze(__data.execution);
const $now = DateTime.now().setZone(__data.timezone);
const $today = $now.startOf('day');
const __sd = __data.staticData;
const $getWorkflowStaticData = (type) => {
  if (type === 'global') return __sd.global;
  if (type === 'node') return __sd.node;
  throw new Error("$getWorkflowStaticData expects 'global' or 'node'");
};
const $env = new Proxy({}, { get() { throw new Error('Access to environment variables is disabled. Use $vars instead.'); } });
`;

/** a language's own texts and n8n's stricter item checks; without it the JavaScript behaviour applies */
export interface ResultWording {
  /** an all-items result, or an entry of one, that is not an item */
  notItems: string;
  /** a per-item result that is not an item */
  notItem: string;
  /** a per-item result that is a list */
  notSingle: string;
  /** an item whose `json` is not an object */
  jsonNotObject: string;
  unknownKey(key: string): string;
}

/** n8n's result checks for Python */
export const PYTHON_RESULT_WORDING: ResultWording = {
  notItems: "Code doesn't return items properly",
  notItem: "Code doesn't return a dictionary",
  notSingle: "Code doesn't return a single dictionary",
  jsonNotObject: "A 'json' property isn't a dictionary",
  unknownKey: (key) => `Unknown top-level item key: ${key}`,
};

const ITEM_KEYS = new Set(['json', 'binary', 'error', 'pairedItem', 'index']);

/** with a wording, a value with `json` or `binary` is an item: its keys are checked and `json` is required to be one */
function checkedItem(value: DataObject, wording: ResultWording): DataObject {
  if ('json' in value && !isPlainObject(value.json)) throw new CodeExecutionError(wording.jsonNotObject);
  for (const key of Object.keys(value)) {
    if (!ITEM_KEYS.has(key)) throw new CodeExecutionError(wording.unknownKey(key));
  }
  return { json: {}, ...value };
}

export function normalizeResult(
  result: unknown,
  mode: CodeRunnerInput['mode'],
  itemIndex?: number,
  wording?: ResultWording,
): Item[] {
  const toItem = (original: unknown, index: number): Item => {
    const value =
      wording && isPlainObject(original) && ('json' in original || 'binary' in original)
        ? checkedItem(original as DataObject, wording)
        : original;
    if (isPlainObject(value) && 'json' in value && isPlainObject((value as DataObject).json)) {
      const v = value as unknown as Item;
      return {
        json: v.json,
        ...(v.binary ? { binary: v.binary } : {}),
        pairedItem:
          v.pairedItem ?? (mode === 'runOnceForEachItem' ? { item: itemIndex ?? index } : undefined),
      };
    }
    if (isPlainObject(value)) {
      return {
        json: value,
        pairedItem: mode === 'runOnceForEachItem' ? { item: itemIndex ?? index } : undefined,
      };
    }
    if (wording) {
      throw new CodeExecutionError(mode === 'runOnceForEachItem' ? wording.notItem : wording.notItems);
    }
    throw new CodeExecutionError(
      `Code must return ${mode === 'runOnceForEachItem' ? 'an object' : 'an array of objects'}, got ${
        value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      }`,
    );
  };
  if (result === undefined || result === null) return [];
  if (mode === 'runOnceForEachItem') {
    if (Array.isArray(result)) {
      throw new CodeExecutionError(
        wording?.notSingle ?? 'In "Run once for each item" mode, return a single object',
      );
    }
    return [toItem(result, itemIndex ?? 0)];
  }
  if (!Array.isArray(result)) return [toItem(result, 0)];
  return result.map((v, i) => toItem(v, i));
}

/** the most static data (global and node scope together, as JSON) one Code run may leave behind */
export const MAX_STATIC_DATA_BYTES = 1024 * 1024;

export class IsolatedVmCodeRunner implements CodeRunner {
  private readonly memoryLimitMb: number;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private luxonCache?: ivm.ExternalCopy<ArrayBuffer>;

  constructor(options: CodeRunnerOptions = {}) {
    this.memoryLimitMb = options.memoryLimitMb ?? 128;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024;
  }

  /** hand changed static data to the host after a finished run; the host copy is never touched otherwise */
  private saveStaticData(input: CodeRunnerInput, after: { global: DataObject; node: DataObject }): void {
    if (!input.onStaticData) return;
    const next = JSON.stringify({ global: after.global ?? {}, node: after.node ?? {} });
    const previous = JSON.stringify({
      global: input.staticData?.global ?? {},
      node: input.staticData?.node ?? {},
    });
    if (next === previous) return;
    if (Buffer.byteLength(next) > MAX_STATIC_DATA_BYTES) {
      throw new CodeExecutionError('Workflow static data is larger than the 1 MB limit');
    }
    input.onStaticData({ global: after.global ?? {}, node: after.node ?? {} });
  }

  async run(input: CodeRunnerInput): Promise<Item[]> {
    const payload = JSON.stringify({
      items: input.items,
      nodeOutputs: input.nodeOutputs,
      variables: input.variables,
      workflow: input.workflow,
      execution: input.execution,
      timezone: input.timezone,
      staticData: { global: input.staticData?.global ?? {}, node: input.staticData?.node ?? {} },
    });
    if (payload.length > this.maxPayloadBytes) {
      throw new CodeExecutionError('Input data is too large for the Code node sandbox');
    }

    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
    let timedOut = false;
    const dispose = () => {
      if (!isolate.isDisposed) isolate.dispose();
    };
    const onAbort = () => dispose();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set('globalThis', jail.derefInto());
      await jail.set('__payload', payload);
      await jail.set(
        '__console',
        new ivm.Callback((level: string, argsJson: string) => {
          try {
            input.onConsole?.(String(level), JSON.parse(String(argsJson)));
          } catch {
            /* ignore malformed console payloads */
          }
        }),
      );

      const luxonScript = (await isolate.compileScript(LUXON_SOURCE, {
        cachedData: this.luxonCache,
        produceCachedData: !this.luxonCache,
      })) as ivm.Script & { cachedData?: ivm.ExternalCopy<ArrayBuffer> };
      if (!this.luxonCache && luxonScript.cachedData) this.luxonCache = luxonScript.cachedData;
      await luxonScript.run(context, { timeout: 5000 });

      const userFn =
        input.mode === 'runOnceForEachItem'
          ? `
const __results = [];
for (let __i = 0; __i < items.length; __i++) {
  const $input = Object.freeze({ item: items[__i], all: () => items, first: () => items[0], last: () => items[items.length - 1] });
  const $json = items[__i].json;
  const $binary = items[__i].binary;
  const $itemIndex = __i;
  const __r = await (async () => {
${input.code}
  })();
  __results.push(__r === undefined ? null : __r);
}
return __results;`
          : `
const $input = Object.freeze({ all: () => items, first: () => items[0], last: () => items[items.length - 1] });
return await (async () => {
${input.code}
})();`;

      const source = `${PRELUDE}\n(async () => {\n${userFn}\n})().then((r) => JSON.stringify({ r: r === undefined ? null : r, s: __sd }))`;
      const run = context.eval(source, { promise: true, timeout: this.timeoutMs, filename: 'code-node.js' });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          dispose();
          reject(new CodeExecutionError(`Code execution timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });
      let json: string;
      try {
        json = (await Promise.race([run, timeout])) as string;
      } finally {
        clearTimeout(timer);
      }
      const parsed = JSON.parse(json) as { r: unknown; s: { global: DataObject; node: DataObject } };
      const result = parsed.r;
      // the result is checked first: a run that fails on its result shape leaves static data as it was
      const items =
        input.mode === 'runOnceForEachItem'
          ? (result as unknown[]).flatMap((r, i) => (r === null ? [] : normalizeResult(r, input.mode, i)))
          : normalizeResult(result, input.mode);
      this.saveStaticData(input, parsed.s);
      return items;
    } catch (error) {
      if (error instanceof CodeExecutionError) throw error;
      if (input.signal?.aborted) throw new CodeExecutionError('Code execution was cancelled');
      if (timedOut || /timed out/i.test((error as Error)?.message ?? '')) {
        throw new CodeExecutionError(`Code execution timed out after ${this.timeoutMs}ms`);
      }
      const message = (error as Error)?.message ?? String(error);
      if (/memory limit/i.test(message) || isolate.isDisposed) {
        throw new CodeExecutionError(`Code exceeded the memory limit of ${this.memoryLimitMb}MB`);
      }
      const line = /code-node\.js:(\d+)/.exec((error as Error)?.stack ?? '')?.[1];
      throw new CodeExecutionError(message, line ? Number(line) : undefined);
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      dispose();
    }
  }
}
