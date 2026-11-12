/**
 * P6-58 (S5, L1): `runner.task.requested` and `runner.response.received` around each Code node task, by wrapping the
 * run's code runner (C0d wraps `codeRunner` and `pythonRunner` in `buildServices`). The payload names the task
 * (execution, workflow, node, a task id), never the code, the items or the result.
 */
import { randomUUID } from 'node:crypto';
import type { CodeRunner, CodeRunnerInput } from '@workflow/core';
import type { Item } from '@workflow/workflow';
import type { EventStream } from './stream';

/** returns a runner that reports each task to the event stream and then runs it on `runner` */
export function observeRunner(
  runner: CodeRunner,
  run: { tenantId: string; executionId: string; workflowId?: string; events: EventStream },
): CodeRunner {
  return {
    async run(input: CodeRunnerInput): Promise<Item[]> {
      const payload = {
        executionId: run.executionId,
        workflowId: run.workflowId ?? input.workflow.id ?? null,
        nodeName: input.nodeName,
        taskId: randomUUID(),
      };
      run.events.emit(run.tenantId, 'runner.task.requested', payload);
      try {
        return await runner.run(input);
      } finally {
        // a task that failed was answered too: the runner replied with an error
        run.events.emit(run.tenantId, 'runner.response.received', payload);
      }
    },
  };
}
