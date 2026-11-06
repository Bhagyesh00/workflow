/**
 * Runs user Python (Code node) with Pyodide inside a V8 isolate (isolated-vm).
 *
 * - A new isolate and interpreter per run, disposed after it; runs share no state.
 * - globalThis holds only our shims. Host callbacks are random bytes and a fixed-name file loader.
 * - Files are Emscripten's in-memory file system with the stdlib zip, plus the wheels a run imports.
 *   No socket, fetch or child exists: wasm cannot open one, and the shims offer none.
 * - Memory: the isolate's memoryLimit does not count wasm memory, so the wasm's own maximum is
 *   lowered (python-assets.ts). Time: the isolate is disposed at the timeout, which stops any loop.
 * - Starting an interpreter takes seconds, so the first run builds a memory snapshot of a started one
 *   in its own isolate, before any user code exists. Every run restores that in about a second.
 *
 * Requires Node to run with `--no-node-snapshot`.
 */
import { randomBytes } from 'node:crypto';
import type { DataObject, Item } from '@workflow/workflow';
import ivm from 'isolated-vm';
import type { CodeRunner, CodeRunnerInput } from '../engine/services';
import { CodeExecutionError, normalizeResult, PYTHON_RESULT_WORDING } from './code-runner';
import { type PythonWheels, pyodideSources, pythonAssetLoader, readWheelFolder } from './python-assets';
import {
  ISOLATE_MAKE_SNAPSHOT,
  ISOLATE_RUN,
  ISOLATE_SHIMS,
  ISOLATE_START,
  PYTHON_BOOTSTRAP,
} from './python-bootstrap';

export interface PyodideRunnerOptions {
  memoryLimitMb: number;
  timeoutMs: number;
  /** runs at once (RUNNERS_MAX_CONCURRENCY) */
  maxConcurrency: number;
  /** standard library modules code may import (RUNNERS_STDLIB_ALLOW) */
  stdlibAllow: string[];
  /** extra packages code may import (RUNNERS_EXTERNAL_ALLOW) */
  externalAllow: string[];
  /** builtins removed before the code runs (RUNNERS_BUILTINS_DENY) */
  builtinsDeny: string[];
  /** whether an allowed module may import modules that are not allowed (RUNNERS_ALLOW_TRANSITIVE_IMPORTS) */
  allowTransitiveImports: boolean;
  /** folder of Pyodide or pure-Python wheels for `externalAllow` (RUNNERS_PYTHON_WHEELS_DIR) */
  wheelsDir?: string;
}

/** the same cap as the JavaScript sandbox */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_RANDOM_BYTES = 65536;
/** the isolate holds the wasm, the stdlib and the snapshot while it starts, outside the wasm's memory */
const MIN_ISOLATE_MEMORY_MB = 128;
/** the snapshot's isolate runs no user code; this memory limit is only for building it */
const SNAPSHOT_MEMORY_MB = 256;
/** starting is our code, not the user's: it has its own time, far above what it needs */
const START_TIMEOUT_MS = 120_000;

async function prepareContext(isolate: ivm.Isolate, memoryMb: number, wheels?: PythonWheels): Promise<ivm.Context> {
  const context = await isolate.createContext();
  const jail = context.global;
  const loadAsset = pythonAssetLoader(memoryMb, wheels);
  await jail.set('globalThis', jail.derefInto());
  await jail.set('__asset', new ivm.Callback((name: string) => loadAsset(String(name))));
  await jail.set(
    '__random',
    new ivm.Callback((size: number) => {
      const bytes = randomBytes(Math.min(Math.max(Math.trunc(Number(size)) || 0, 0), MAX_RANDOM_BYTES));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new ivm.ExternalCopy(buffer as ArrayBuffer).copyInto({ release: true });
    }),
  );
  await context.eval(ISOLATE_SHIMS);

  const { runtime, loader, lockJson } = pyodideSources();
  const missing = () => {
    throw new Error('Pyodide imports nothing in the isolate');
  };
  const runtimeModule = await isolate.compileModule(runtime, { filename: 'pyodide.asm.mjs' });
  await runtimeModule.instantiate(context, missing);
  await runtimeModule.evaluate();
  const loaderModule = await isolate.compileModule(loader, { filename: 'pyodide.mjs' });
  await loaderModule.instantiate(context, missing);
  await loaderModule.evaluate();
  const create = await runtimeModule.namespace.get('default', { reference: true });
  const load = await loaderModule.namespace.get('loadPyodide', { reference: true });
  await jail.set('__createPyodideModule', create.derefInto());
  await jail.set('__loadPyodide', load.derefInto());
  await jail.set('__lockJson', lockJson);
  return context;
}

/** settles with `work`, or disposes the isolate and rejects with `onLate()` after `ms` */
async function within<T>(work: Promise<T>, ms: number, isolate: ivm.Isolate, onLate: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = onLate();
      if (!isolate.isDisposed) isolate.dispose();
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function buildSnapshot(): Promise<ivm.ExternalCopy<ArrayBuffer>> {
  const isolate = new ivm.Isolate({ memoryLimit: SNAPSHOT_MEMORY_MB });
  try {
    const context = await prepareContext(isolate, SNAPSHOT_MEMORY_MB);
    await context.global.set('__bootstrap', PYTHON_BOOTSTRAP);
    const work = (async () => {
      await context.eval(ISOLATE_START, { promise: true });
      return (await context.eval(ISOLATE_MAKE_SNAPSHOT, { promise: true, copy: true })) as ArrayBuffer;
    })();
    const bytes = await within(
      work,
      START_TIMEOUT_MS,
      isolate,
      () => new CodeExecutionError('Python could not start in time'),
    );
    return new ivm.ExternalCopy(bytes);
  } finally {
    if (!isolate.isDisposed) isolate.dispose();
  }
}

/** one per server: it holds a started interpreter with no user code or data, so runners can share it */
let snapshot: Promise<ivm.ExternalCopy<ArrayBuffer>> | undefined;
function pythonSnapshot(): Promise<ivm.ExternalCopy<ArrayBuffer>> {
  if (!snapshot) {
    snapshot = buildSnapshot();
    snapshot.catch(() => {
      snapshot = undefined;
    });
  }
  return snapshot;
}

interface PythonAnswer {
  result?: unknown;
  error?: { type: string; message: string; line: number | null };
  prints: unknown[][];
}

export class PyodideCodeRunner implements CodeRunner {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private wheels: PythonWheels | undefined;

  constructor(readonly options: PyodideRunnerOptions) {}

  private memoryText(): CodeExecutionError {
    return new CodeExecutionError(`Code exceeded the memory limit of ${this.options.memoryLimitMb}MB`);
  }

  /** read once, like the allow list; with no package allowed no wheel file is ever opened */
  private wheelIndex(): PythonWheels {
    const { externalAllow, wheelsDir } = this.options;
    this.wheels ??=
      externalAllow.length > 0 && wheelsDir
        ? readWheelFolder(wheelsDir)
        : { roots: new Map(), unusable: new Map(), files: new Map() };
    return this.wheels;
  }

  /** resolves with a slot held; a signal that fires while waiting gives the place up */
  private async acquire(signal?: AbortSignal): Promise<void> {
    const cancelled = () => new CodeExecutionError('Code execution was cancelled');
    if (signal?.aborted) throw cancelled();
    if (this.running < this.options.maxConcurrency) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(turn), 1);
        reject(cancelled());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(turn);
    });
  }

  /** a waiting run takes the slot over, so `running` stays right */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  async run(input: CodeRunnerInput): Promise<Item[]> {
    const { stdlibAllow, externalAllow, builtinsDeny, allowTransitiveImports } = this.options;
    const wheels = this.wheelIndex();
    const payload = JSON.stringify({
      code: input.code,
      mode: input.mode,
      items: input.items,
      query: input.query,
      stdlibAllow,
      externalAllow,
      builtinsDeny,
      allowTransitiveImports,
      wheels: { roots: Object.fromEntries(wheels.roots), unusable: Object.fromEntries(wheels.unusable) },
    });
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new CodeExecutionError('Input data is too large for the Code node sandbox');
    }
    await this.acquire(input.signal);
    try {
      return await this.runIsolated(input, payload, wheels);
    } finally {
      this.release();
    }
  }

  private async runIsolated(input: CodeRunnerInput, payload: string, wheels: PythonWheels): Promise<Item[]> {
    const started = await pythonSnapshot();
    if (input.signal?.aborted) throw new CodeExecutionError('Code execution was cancelled');

    const { memoryLimitMb, timeoutMs } = this.options;
    const isolate = new ivm.Isolate({ memoryLimit: Math.max(memoryLimitMb, MIN_ISOLATE_MEMORY_MB) });
    const dispose = () => {
      if (!isolate.isDisposed) isolate.dispose();
    };
    input.signal?.addEventListener('abort', dispose, { once: true });

    try {
      const context = await prepareContext(isolate, memoryLimitMb, wheels);
      await context.global.set('__snapshot', started.copyInto({ release: false }));
      await within(
        context.eval(ISOLATE_START, { promise: true }),
        START_TIMEOUT_MS,
        isolate,
        () => new CodeExecutionError('Python could not start in time'),
      );
      await context.global.set('__payload', payload);
      const json: string = await within(
        context.eval(ISOLATE_RUN, { promise: true }),
        timeoutMs,
        isolate,
        () => new CodeExecutionError(`Code execution timed out after ${timeoutMs}ms`),
      );
      return this.readAnswer(JSON.parse(json) as PythonAnswer, input);
    } catch (error) {
      if (error instanceof CodeExecutionError) throw error;
      if (input.signal?.aborted) throw new CodeExecutionError('Code execution was cancelled');
      const message = (error as Error)?.message ?? String(error);
      // a file too big for the isolate (an unpacked wheel) ends in a failed ArrayBuffer allocation
      if (/memory limit|MemoryError|allocation failed/i.test(message) || isolate.isDisposed) throw this.memoryText();
      throw new CodeExecutionError(message);
    } finally {
      input.signal?.removeEventListener('abort', dispose);
      dispose();
    }
  }

  private readAnswer(answer: PythonAnswer, input: CodeRunnerInput): Item[] {
    for (const args of answer.prints) input.onConsole?.('log', args);
    if (answer.error) {
      if (answer.error.type === 'MemoryError') throw this.memoryText();
      throw new CodeExecutionError(answer.error.message, answer.error.line ?? undefined);
    }
    const { result } = answer;
    // the Code tool: any return value is the answer, with none of the Code node's return rules
    if (input.query !== undefined) return [{ json: { result } }];
    return input.mode === 'runOnceForEachItem'
      ? (result as DataObject[]).flatMap((value, index) =>
          value === null ? [] : normalizeResult(value, input.mode, index, PYTHON_RESULT_WORDING),
        )
      : normalizeResult(result, input.mode, undefined, PYTHON_RESULT_WORDING);
  }
}
