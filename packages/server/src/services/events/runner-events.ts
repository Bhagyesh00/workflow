/**
 * P6-58 (S5 C0 stub, L1 fills it): `runner.task.requested` and `runner.response.received` around each Code node
 * task, by wrapping the run's code runner (C0d wraps `codeRunner` and `pythonRunner` in `buildServices`).
 */
import type { CodeRunner } from '@workflow/core';
import type { EventStream } from './stream';

/** stub (L1): PASSES: returns `runner` unchanged */
export function observeRunner(
  runner: CodeRunner,
  _run: { tenantId: string; executionId: string; workflowId?: string; events: EventStream },
): CodeRunner {
  return runner;
}
