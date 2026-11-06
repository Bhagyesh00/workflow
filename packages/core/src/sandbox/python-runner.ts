/**
 * Runs user Python (Code node, Code tool) with Pyodide inside a V8 isolate. Stub until lane L8 (P4-06).
 */
import type { Item } from '@workflow/workflow';
import type { CodeRunner, CodeRunnerInput } from '../engine/services';

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

export class PyodideCodeRunner implements CodeRunner {
  constructor(readonly options: PyodideRunnerOptions) {}

  async run(_input: CodeRunnerInput): Promise<Item[]> {
    throw new Error('Python is not built yet');
  }
}
